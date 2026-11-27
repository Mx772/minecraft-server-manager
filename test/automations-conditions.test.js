'use strict';

// Step conditions: a step whose condition is not met is skipped with a sentence,
// never failed. Docker and the player list are stood in for.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const automations = require('../src/automations');
const servers = require('../src/services/servers');
const players = require('../src/services/players');
const containers = require('../src/docker/containers');

const SID = 'srv_cond';
test.before(() => {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Cond', 'PAPER', 47600, 48600, 'x', 1024, 1536)`,
    SID
  );
});
test.afterEach(() => {
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
});
test.after(() => automations.stopAll());

/** Run a restart step with a condition once; resolves with the step's recorded outcome. */
async function outcome(t, condition, { status = 'running', names = [], countFails = false } = {}) {
  t.mock.method(containers, 'inspectStatus', async () => ({ exists: true, status }));
  t.mock.method(players, 'listOnlineNames', async (id, opts) => {
    assert.equal(opts.throwOnError, true);
    if (countFails) throw new Error('rcon down');
    return names;
  });
  const restart = t.mock.method(servers, 'restartServer', async () => {});
  const a = automations.createAutomation({
    name: 'Cond',
    targets: { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'schedule', cron: '0 3 1 1 *' },
    steps: [{ offsetSec: 0, action: 'restart', condition }],
  });
  await automations.runNow(a.id).done;
  const run = automations.listRuns(a.id)[0];
  return { step: run.steps[0], run, ran: restart.mock.callCount() === 1 };
}

test('server-running runs on a running server and skips a stopped one', async (t) => {
  assert.equal((await outcome(t, { type: 'server-running' })).ran, true);
  const stopped = await outcome(t, { type: 'server-running' }, { status: 'stopped' });
  assert.equal(stopped.ran, false);
  assert.equal(stopped.step.status, 'skipped');
  assert.equal(stopped.step.detail, 'Skipped because the server is not running.');
  assert.equal(stopped.run.status, 'ok', 'a skipped step is not a failure');
});

test('players-online runs when enough players are on and skips otherwise', async (t) => {
  assert.equal((await outcome(t, { type: 'players-online', min: 2 }, { names: ['a', 'b'] })).ran, true);
  const none = await outcome(t, { type: 'players-online', min: 1 });
  assert.equal(none.step.detail, 'Skipped because no players were online.');
  const few = await outcome(t, { type: 'players-online', min: 3 }, { names: ['a'] });
  assert.equal(few.step.detail, 'Skipped because fewer than 3 players were online.');
  const off = await outcome(t, { type: 'players-online', min: 1 }, { status: 'stopped' });
  assert.equal(off.step.detail, 'Skipped because the server is not running.');
});

test('no-players runs on an empty server and skips when someone is on', async (t) => {
  assert.equal((await outcome(t, { type: 'no-players' })).ran, true);
  const busy = await outcome(t, { type: 'no-players' }, { names: ['a'] });
  assert.equal(busy.ran, false);
  assert.equal(busy.step.detail, 'Skipped because players were online.');
  const off = await outcome(t, { type: 'no-players' }, { status: 'stopped' });
  assert.equal(off.step.detail, 'Skipped because the server is not running.');
});

test('a player count that cannot be read skips the step', async (t) => {
  for (const type of ['no-players', 'players-online']) {
    const r = await outcome(t, { type }, { countFails: true });
    assert.equal(r.ran, false, type);
    assert.equal(r.step.detail, 'Skipped because the player count could not be read.');
  }
});

test('the schema rejects a condition on a panel action, and a bad minimum', () => {
  assert.throws(
    () =>
      automations.createAutomation({
        name: 'Panel',
        targets: { kind: 'panel' },
        trigger: { type: 'schedule', cron: '0 3 * * *' },
        steps: [{ offsetSec: 0, action: 'update-check', condition: { type: 'no-players' } }],
      }),
    (err) => err.status === 400 && /cannot have a condition/.test(err.message)
  );
  const server = (condition) => () =>
    automations.createAutomation({
      name: 'Bad',
      targets: { kind: 'servers', serverIds: [SID] },
      trigger: { type: 'schedule', cron: '0 3 * * *' },
      steps: [{ offsetSec: 0, action: 'restart', condition }],
    });
  assert.throws(server({ type: 'players-online', min: 0 }), (err) => err.status === 400);
  assert.throws(server({ type: 'players-online', min: 501 }), (err) => err.status === 400);
  assert.throws(server({ type: 'sometimes' }), (err) => err.status === 400);
  const ok = server({ type: 'players-online' })();
  assert.equal(ok.steps[0].condition.min, 1, 'min defaults to 1');
});
