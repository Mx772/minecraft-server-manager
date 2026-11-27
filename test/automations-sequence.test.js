'use strict';

// How a firing plays out: steps wait for anchor + offset, one sequence per
// target server runs in parallel and fails on its own, onFailure decides
// whether a failed step ends the sequence, and a message to a stopped server
// is skipped rather than failed.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const automations = require('../src/automations');
const servers = require('../src/services/servers');
const chat = require('../src/services/chat');
const containers = require('../src/docker/containers');
const httpError = require('../src/utils/httpError');

const A = 'srv_seq_a';
const B = 'srv_seq_b';
test.before(() => {
  [A, B].forEach((id, i) =>
    db.run(
      `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
       VALUES (?, ?, 'PAPER', ?, ?, 'x', 1024, 1536)`,
      id,
      id,
      47000 + i,
      48000 + i
    )
  );
});
test.afterEach(() => {
  automations.configureEngine();
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
});
test.after(() => automations.stopAll());

const FAR_CRON = '0 3 1 1 *'; // never fires by itself during a test
const make = (serverIds, steps, name = 'Seq') =>
  automations.createAutomation({
    name,
    targets: { kind: 'servers', serverIds },
    trigger: { type: 'schedule', cron: FAR_CRON },
    steps,
  });
const step = (offsetSec, action, params = {}, onFailure = 'stop') => ({ offsetSec, action, params, onFailure });

test('targets run in parallel and one failing does not stop the other', async (t) => {
  let releaseA;
  const aHeld = new Promise((r) => (releaseA = r));
  const order = [];
  t.mock.method(servers, 'restartServer', async (id) => {
    order.push(`start ${id}`);
    if (id === A) {
      await aHeld;
      order.push('fail A');
      throw new Error('A is stuck');
    }
    order.push('done B');
  });
  const a = make([A, B], [step(0, 'restart')]);
  const { done } = automations.runNow(a.id);
  while (!order.includes('done B')) await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [`start ${A}`, `start ${B}`, 'done B'], 'B finished while A was still running');
  releaseA();
  await done;
  const after = automations.getAutomation(a.id);
  assert.equal(after.lastStatus, 'partial');
  assert.match(after.lastError, /A is stuck/);
  const runs = automations.listRuns(a.id);
  assert.deepEqual(Object.fromEntries(runs.map((r) => [r.serverId, r.status])), { [A]: 'failed', [B]: 'ok' });
  const failed = db.all("SELECT server_id, summary FROM events WHERE type = 'automation-failed'");
  assert.deepEqual(
    failed.map((e) => e.server_id),
    [A]
  );
  assert.equal(failed[0].summary, 'Automation Seq failed at Restart server: A is stuck.');
});

test("an 'all' target resolves the server list when it fires", async (t) => {
  const seen = [];
  t.mock.method(servers, 'restartServer', async (id) => seen.push(id));
  const a = automations.createAutomation({
    name: 'Everyone',
    targets: { kind: 'all' },
    trigger: { type: 'schedule', cron: FAR_CRON },
    steps: [step(0, 'restart')],
  });
  await automations.runNow(a.id).done;
  assert.ok(seen.includes(A) && seen.includes(B));
});

test("onFailure 'stop' ends the sequence at a failed step", async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  t.mock.method(containers, 'execCapture', async () => {
    throw new Error('rcon down');
  });
  const a = make([A], [step(0, 'command', { command: 'save-all' }, 'stop'), step(0, 'message', { text: 'Done.' })]);
  await automations.runNow(a.id).done;
  assert.equal(sent.mock.callCount(), 0);
  assert.deepEqual(
    automations.listRuns(a.id)[0].steps.map((s) => s.status),
    ['failed']
  );
});

test("onFailure 'continue' goes on to the next step, and the run still counts as failed", async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  t.mock.method(containers, 'execCapture', async () => {
    throw new Error('rcon down');
  });
  const a = make([A], [step(0, 'command', { command: 'save-all' }, 'continue'), step(0, 'message', { text: 'Done.' })]);
  await automations.runNow(a.id).done;
  assert.equal(sent.mock.callCount(), 1);
  const run = automations.listRuns(a.id)[0];
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ['failed', 'ok']
  );
  assert.equal(run.status, 'failed');
});

test('a message to a stopped server is skipped, not failed', async (t) => {
  t.mock.method(chat, 'sendChat', async () => {
    throw httpError(409, 'Start the server before sending chat.');
  });
  const failedBefore = db.all("SELECT 1 FROM events WHERE type = 'automation-failed'").length;
  const a = make([A], [step(0, 'message', { text: 'Hello.' })]);
  await automations.runNow(a.id).done;
  const run = automations.listRuns(a.id)[0];
  assert.equal(run.status, 'ok');
  assert.equal(run.steps[0].status, 'skipped');
  assert.equal(automations.getAutomation(a.id).lastStatus, 'ok');
  assert.equal(db.all("SELECT 1 FROM events WHERE type = 'automation-failed'").length, failedBefore);
});

test('a message step sends the text with the chosen mode as the automation', async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  const a = make([A], [step(0, 'message', { text: 'Restarting in 5 minutes.', mode: 'say' })]);
  await automations.runNow(a.id).done;
  assert.deepEqual(sent.mock.calls[0].arguments, [
    A,
    { text: 'Restarting in 5 minutes.', mode: 'say', actor: 'automation' },
  ]);
});

test('steps wait until anchor + offset: negative offsets run back to back, later ones wait', async (t) => {
  const order = [];
  t.mock.method(chat, 'sendChat', async (id, o) => order.push(o.text));
  t.mock.method(servers, 'restartServer', async () => order.push('restart'));
  const waits = [];
  automations.configureEngine({
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const a = make(
    [A],
    [
      step(-300, 'message', { text: 'five' }),
      step(-60, 'message', { text: 'one' }),
      step(0, 'restart'),
      step(30, 'message', { text: 'after' }),
    ]
  );
  await automations.runNow(a.id).done;
  assert.deepEqual(order, ['five', 'one', 'restart', 'after']);
  assert.equal(waits.length, 1, 'only the +30 s step has to wait');
  assert.ok(waits[0] > 29_000 && waits[0] <= 30_000, `${waits[0]} ms`);
});

test('an automation deleted mid-run does not run its later steps', async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  const restart = t.mock.method(servers, 'restartServer', async () => {});
  const a = make([A], [step(0, 'restart'), step(30, 'message', { text: 'after' })]);
  automations.configureEngine({
    sleep: async () => {
      automations.deleteAutomation(a.id); // gone while waiting for the +30 s step
    },
  });
  await automations.runNow(a.id).done;
  assert.equal(restart.mock.callCount(), 1);
  assert.equal(sent.mock.callCount(), 0);
});

test('an automation turned off mid-run does not run its later steps', async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  t.mock.method(servers, 'restartServer', async () => {});
  const a = make([A], [step(0, 'restart'), step(30, 'message', { text: 'after' })]);
  automations.configureEngine({ sleep: async () => automations.setEnabled(a.id, false) });
  await automations.runNow(a.id).done;
  assert.equal(sent.mock.callCount(), 0);
});

test('runNow runs a disabled automation, and refuses a second run while one is going', async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  const restart = t.mock.method(servers, 'restartServer', () => held);
  const a = make([A], [step(0, 'restart')]);
  automations.setEnabled(a.id, false);
  const first = automations.runNow(a.id);
  assert.throws(
    () => automations.runNow(a.id),
    (err) => err.status === 409
  );
  release();
  await first.done;
  assert.equal(restart.mock.callCount(), 1);
  assert.throws(
    () => automations.runNow('aut_gone'),
    (err) => err.status === 404
  );
});

test('an enabled automation fires on its own cron timer', async (t) => {
  const restart = t.mock.method(servers, 'restartServer', async () => {});
  const a = automations.createAutomation({
    name: 'Every second',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron: '* * * * * *' },
    steps: [step(0, 'restart')],
  });
  const t0 = Date.now();
  while (!restart.mock.callCount() && Date.now() - t0 < 3500) await new Promise((r) => setTimeout(r, 50));
  automations.deleteAutomation(a.id);
  assert.ok(restart.mock.callCount() >= 1);
  assert.ok(db.get("SELECT 1 AS x FROM events WHERE type = 'automation-fired'"));
});

test('armed inside the lead window, the anchor still fires; warnings long past are skipped', async (t) => {
  const sent = [];
  t.mock.method(chat, 'sendChat', async (id, o) => sent.push(o.text));
  const restart = t.mock.method(servers, 'restartServer', async () => {});
  // Next cron time is ~3 minutes away, but the first step is 5 minutes ahead of it.
  const soon = new Date(Date.now() + 3 * 60_000);
  const cron = `${soon.getUTCMinutes()} ${soon.getUTCHours()} * * *`;
  const tz = require('../src/services/settings');
  tz.setTimezone('UTC');
  t.after(() => tz.setTimezone('auto'));
  automations.configureEngine({ sleep: async () => {} });
  const a = automations.createAutomation({
    name: 'Late',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron },
    steps: [step(-300, 'message', { text: 'five' }), step(-60, 'message', { text: 'one' }), step(0, 'restart')],
  });
  const t0 = Date.now();
  while (!restart.mock.callCount() && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  automations.deleteAutomation(a.id);
  assert.equal(restart.mock.callCount(), 1, 'fired immediately for that anchor');
  assert.deepEqual(sent, ['one']);
});

test('the anchor that just fired is not fired again when re-armed', async (t) => {
  const restart = t.mock.method(servers, 'restartServer', async () => {});
  const a = automations.createAutomation({
    name: 'Once',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron: '* * * * * *' },
    steps: [step(0, 'restart')],
  });
  const t0 = Date.now();
  while (!restart.mock.callCount() && Date.now() - t0 < 3500) await new Promise((r) => setTimeout(r, 20));
  automations.rearmAll();
  automations.rearmAll();
  await new Promise((r) => setTimeout(r, 300));
  automations.deleteAutomation(a.id);
  const runs = db.all('SELECT anchor_at FROM automation_runs WHERE automation_id = ?', a.id);
  const anchors = runs.map((r) => r.anchor_at);
  assert.equal(new Set(anchors).size, anchors.length, 'no anchor ran twice');
});
