'use strict';

// Event triggers: what a definition may contain, which automations an event runs,
// the awaited before-start hook that can block a start, and the Discord step.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const automations = require('../src/automations');
const chat = require('../src/services/chat');
const discord = require('../src/integrations/discord');

const A = 'srv_ev_a';
const B = 'srv_ev_b';
test.before(() => {
  [A, B].forEach((id, i) =>
    db.run(
      `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
       VALUES (?, ?, 'PAPER', ?, ?, 'x', 1024, 1536)`,
      id,
      id,
      47300 + i,
      48300 + i
    )
  );
});
test.afterEach(() => {
  automations.configureHooks();
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
});
test.after(() => automations.stopAll());

const step = (action, params = {}, over = {}) => ({ offsetSec: 0, action, params, onFailure: 'stop', ...over });
const make = (event, steps, { targets = { kind: 'servers', serverIds: [A] }, name = 'Event' } = {}) =>
  automations.createAutomation({ name, targets, trigger: { type: 'event', event }, steps });
const bad = (fn, pattern) => assert.throws(fn, (err) => err.status === 400 && pattern.test(err.message));
const msg = step('message', { text: 'Hi.' });

test('an event automation validates, lists without a next time, and is never armed', () => {
  const a = make('after-start', [step('message', { text: 'Hi.' }, { offsetSec: 60 })]);
  assert.deepEqual(a.trigger, { type: 'event', event: 'after-start' });
  assert.equal(a.next, null);
  assert.equal(a.nextMs, null);
  assert.equal(a.cron, null);
});

test('event steps: offsets run 0 to 1 hour, and before-start runs right away', () => {
  bad(() => make('after-start', [{ ...msg, offsetSec: -5 }]), /cannot run before it/);
  bad(() => make('after-start', [{ ...msg, offsetSec: 3601 }]), /up to 1 hour/);
  assert.ok(make('after-start', [{ ...msg, offsetSec: 3600 }]));
  bad(() => make('before-start', [step('discord', { message: 'x' }, { offsetSec: 5 })]), /right away/);
  assert.ok(make('before-start', [step('discord', { message: 'x' })]));
});

test('each event allows only its own actions, with a plain-words refusal', () => {
  bad(
    () => make('before-start', [msg]),
    /Send Message can't run before the server starts, because the server isn't running yet\./
  );
  bad(() => make('before-start', [step('backup')]), /Backup can't run before the server starts/);
  bad(() => make('after-stop', [msg]), /Send Message can't run after the server stops/);
  bad(() => make('on-crash', [step('command', { command: 'list' })]), /Run Command can't run after the server crashes/);
  for (const event of ['after-start', 'after-pack-install']) {
    assert.ok(
      make(event, [msg, step('command', { command: 'list' }), step('backup'), step('discord', { message: 'x' })])
    );
  }
  assert.ok(make('after-stop', [step('backup'), step('discord', { message: 'x' })]));
  assert.ok(make('on-crash', [step('backup'), step('discord', { message: 'x' })]));
});

test('lifecycle actions and panel actions are refused on every event, and panel targets too', () => {
  for (const event of ['before-start', 'after-start', 'after-stop', 'on-crash', 'after-pack-install']) {
    for (const action of ['restart', 'stop', 'start']) {
      bad(() => make(event, [step(action)]), /could trigger the same event again/);
    }
    bad(() => make(event, [step('update-check')], { targets: { kind: 'panel' } }), /event runs for a server/);
    bad(() => make(event, [step('update-check')]), /whole panel/);
  }
});

test('the discord step is allowed on a schedule trigger too', () => {
  const a = automations.createAutomation({
    name: 'Nightly ping',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [step('discord', { message: 'Good morning.' })],
  });
  assert.ok(a.nextMs);
  bad(() => make('after-start', [step('discord', { message: '' })]), /step 1/);
});

test('templates and import files accept event triggers, and export them unchanged', () => {
  const def = {
    name: 'On crash',
    description: 'Tells Discord.',
    targetsKind: 'servers',
    trigger: { type: 'event', event: 'on-crash' },
    steps: [step('discord', { message: 'Down.' })],
  };
  const file = automations.exportTemplate(automations.validateTemplate(def));
  assert.deepEqual(file.trigger, { type: 'event', event: 'on-crash' });
  assert.deepEqual(automations.parseImport(JSON.parse(JSON.stringify(file))).trigger, def.trigger);
  bad(
    () => automations.parseImport({ ...file, trigger: { type: 'event', event: 'on-crash', cron: '* * * * *' } }),
    /./
  );
  bad(() => automations.validateTemplate({ ...def, targetsKind: 'panel' }), /event runs for a server/);
  for (const name of ['Notify Discord On Crash', 'Back Up After Stop', 'Welcome Back Message']) {
    assert.ok(
      automations.listTemplates().find((t) => t.name === name && t.trigger.type === 'event'),
      name
    );
  }
});

test('emit runs only the matching enabled automations for that server, including all-server ones', async (t) => {
  const sent = [];
  t.mock.method(chat, 'sendChat', async (id, o) => sent.push([id, o.text]));
  make('after-start', [{ ...msg, params: { text: 'mine' } }], { name: 'Mine' });
  make('after-start', [{ ...msg, params: { text: 'other' } }], {
    name: 'Other',
    targets: { kind: 'servers', serverIds: [B] },
  });
  make('after-start', [{ ...msg, params: { text: 'everyone' } }], { name: 'Everyone', targets: { kind: 'all' } });
  const off = make('after-start', [{ ...msg, params: { text: 'off' } }], { name: 'Off' });
  automations.setEnabled(off.id, false);
  make('after-stop', [step('discord', { message: 'x' })], { name: 'Wrong event' });

  await automations.emit('after-start', A);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent.map((s) => s[1]).sort(), ['everyone', 'mine']);
  assert.ok(sent.every(([id]) => id === A));
  const fired = db.all("SELECT summary, server_id FROM events WHERE type = 'automation-fired'");
  assert.ok(fired.some((e) => e.summary === 'Automation fired after the server started: Mine.' && e.server_id === A));
  const mine = automations.listAutomations().find((a) => a.name === 'Mine');
  assert.equal(mine.lastStatus, 'ok');
  assert.equal(automations.listRuns(mine.id)[0].serverId, A);
});

test('the same automation is not run twice at once for the same server', async (t) => {
  let release;
  const held = new Promise((r) => (release = r));
  const send = t.mock.method(chat, 'sendChat', () => held);
  const a = make('after-start', [msg]);
  await automations.emit('after-start', A);
  await automations.emit('after-start', A);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(send.mock.callCount(), 1, 'the second event found the first still running');
  release();
  await new Promise((r) => setTimeout(r, 50));
  await automations.emit('after-start', A);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(send.mock.callCount(), 2, 'free again once it finished');
  assert.ok(a);
});

test('a non-start event returns at once and never throws, even when its steps fail', async (t) => {
  t.mock.method(discord, 'isConfigured', () => true);
  t.mock.method(discord, 'notify', async () => false);
  make('on-crash', [step('discord', { message: 'x' })]);
  await automations.emit('on-crash', A);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(automations.listAutomations()[0].lastStatus, 'failed');
});

test('before-start is awaited: the steps have finished when emit returns', async (t) => {
  let done = false;
  t.mock.method(discord, 'isConfigured', () => true);
  t.mock.method(discord, 'notify', async () => {
    await new Promise((r) => setTimeout(r, 30));
    done = true;
    return true;
  });
  make('before-start', [step('discord', { message: 'Starting.' })]);
  await automations.emit('before-start', A);
  assert.equal(done, true);
});

test("before-start: a failing 'stop' step blocks the start with a friendly 409; 'continue' does not", async (t) => {
  t.mock.method(discord, 'isConfigured', () => false);
  const blocker = make('before-start', [step('discord', { message: 'x' })], { name: 'Gatekeeper' });
  await assert.rejects(
    () => automations.emit('before-start', A),
    (err) =>
      err.status === 409 &&
      err.message ===
        'The automation "Gatekeeper" failed before the start, so the server was not started: Discord notifications are not set up for this server.'
  );
  automations.deleteAutomation(blocker.id);
  make('before-start', [step('discord', { message: 'x' }, { onFailure: 'continue' })], { name: 'Relaxed' });
  await automations.emit('before-start', A); // does not throw
  assert.equal(automations.listAutomations()[0].lastStatus, 'failed', 'still recorded as failed');
});

test('before-start: running out of the time limit blocks the start', async (t) => {
  automations.configureHooks({ beforeStartTimeoutMs: 40 });
  t.mock.method(discord, 'isConfigured', () => true);
  t.mock.method(discord, 'notify', () => new Promise((r) => setTimeout(() => r(true), 400).unref()));
  make('before-start', [step('discord', { message: 'x' })], { name: 'Slow' });
  await assert.rejects(
    () => automations.emit('before-start', A),
    (err) => err.status === 409 && /"Slow" failed before the start, so the server was not started/.test(err.message)
  );
});

test('before-start with nothing set up changes nothing', async () => {
  await automations.emit('before-start', A);
});

test('runNow on an event automation runs it once for each target server, ignoring the event', async (t) => {
  const sent = t.mock.method(chat, 'sendChat', async () => {});
  const a = make('after-start', [msg], { targets: { kind: 'servers', serverIds: [A, B] } });
  await automations.runNow(a.id).done;
  assert.equal(sent.mock.callCount(), 2);
});

test('the discord step: not set up fails, a refused post fails, a sent one succeeds', async (t) => {
  const configured = t.mock.method(discord, 'isConfigured', () => false);
  const notify = t.mock.method(discord, 'notify', async () => true);
  const a = automations.createAutomation({
    name: 'Ping',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [step('discord', { message: 'Hello there.' })],
  });
  const lastRun = async () => {
    await automations.runNow(a.id).done;
    return automations.listRuns(a.id)[0];
  };
  let run = await lastRun();
  assert.equal(run.steps[0].detail, 'Discord notifications are not set up for this server.');
  assert.equal(notify.mock.callCount(), 0);

  configured.mock.mockImplementation(() => true);
  notify.mock.mockImplementation(async () => false);
  run = await lastRun();
  assert.equal(run.steps[0].detail, 'Discord did not accept the notification.');

  notify.mock.mockImplementation(async () => true);
  run = await lastRun();
  assert.equal(run.steps[0].status, 'ok');
  assert.deepEqual(notify.mock.calls.at(-1).arguments, [A, 'alert', { title: 'Ping', description: 'Hello there.' }]);
});
