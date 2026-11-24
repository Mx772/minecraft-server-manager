'use strict';

// A backup refused only because its server is busy with another action retries
// instead of losing the run; restart and stop don't retry (a collided restart
// has effectively happened); an automation turned off while waiting stops
// retrying; any other failure is final.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const backups = require('../src/services/backups');
const servers = require('../src/services/servers');
const httpError = require('../src/utils/httpError');
const automations = require('../src/automations');

// Cases that end by themselves get a budget they can never run out of: a short
// wall-clock budget made them give up early whenever a slow runner took longer
// than it over the first try. Only the cases about giving up keep a small one.
const NO_GIVE_UP_MS = 60_000;

// The redundant-backup check inspects the container; keep it off the real Docker daemon.
test.mock.method(backups, 'isScheduledBackupRedundant', async () => false);

// What guardOp throws when the server is busy: a 409 with code BUSY.
const busyErr = (message) => Object.assign(httpError(409, message), { code: 'BUSY' });
const busy = () => busyErr('Cannot backup: a backup cleanup operation is already in progress for this server');

const SID = 'srv_busy';
test.before(() => {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 's', 'PAPER', 47900, 48900, 'x', 1024, 1536)`,
    SID
  );
});
test.afterEach(() => {
  automations.configureEngine();
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
});
test.after(() => automations.stopAll());

/** An enabled automation with one step, on a cron far enough off that it never fires by itself. */
function make(action) {
  return automations.createAutomation({
    name: `Busy ${action}`,
    targets: { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'schedule', cron: '0 3 1 1 *' },
    steps: [{ offsetSec: 0, action }],
  });
}
const go = (a, retry) => {
  automations.configureEngine(retry);
  return automations.runNow(a.id).done;
};

test('a backup refused because the server is busy retries, then runs', async (t) => {
  const a = make('backup');
  let calls = 0;
  t.mock.method(backups, 'createBackup', async () => {
    calls++;
    if (calls < 3) throw busy();
    return { id: 'bk_test' };
  });
  t.mock.method(backups, 'verifyBackup', async () => {});
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(calls, 3);
  assert.equal(automations.getAutomation(a.id).lastStatus, 'ok');
});

test('a server that stays busy fails once the wait runs out', async (t) => {
  const a = make('backup');
  const spy = t.mock.method(backups, 'createBackup', async () => {
    throw busy();
  });
  await go(a, { retryMs: 1, maxWaitMs: 500 });
  assert.ok(spy.mock.callCount() > 1, `${spy.mock.callCount()} tries`); // retried, then gave up
  const after = automations.getAutomation(a.id);
  assert.equal(after.lastStatus, 'failed');
  assert.match(after.lastError, /already in progress/);
});

test('a scheduled start that finds the server busy retries too (a start is safe to repeat)', async (t) => {
  const a = make('start');
  let calls = 0;
  t.mock.method(servers, 'startServer', async () => {
    calls++;
    if (calls < 2) throw busyErr('Cannot start: a backup cleanup operation is already in progress for this server');
  });
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(calls, 2);
});

test('a scheduled restart or stop that collides does not run again later', async (t) => {
  for (const [action, method] of [
    ['restart', 'restartServer'],
    ['stop', 'stopServer'],
  ]) {
    const a = make(action);
    const spy = t.mock.method(servers, method, async () => {
      throw busyErr(`Cannot ${action}: another operation is already in progress for this server`);
    });
    await go(a, { retryMs: 1, maxWaitMs: 50 });
    assert.equal(spy.mock.callCount(), 1, action);
    assert.equal(automations.getAutomation(a.id).lastStatus, 'failed');
    automations.deleteAutomation(a.id);
  }
});

test('an automation turned off while waiting stops retrying', async (t) => {
  const a = make('backup');
  const spy = t.mock.method(backups, 'createBackup', async () => {
    automations.setEnabled(a.id, false); // someone disables it meanwhile
    throw busy();
  });
  // runNow of an automation that is on keeps honouring the switch.
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(spy.mock.callCount(), 1);
});

test('an automation deleted while waiting stops retrying', async (t) => {
  const a = make('backup');
  const spy = t.mock.method(backups, 'createBackup', async () => {
    automations.deleteAutomation(a.id);
    throw busy();
  });
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(spy.mock.callCount(), 1);
});

test('any other failure is final at once', async (t) => {
  const a = make('backup');
  const spy = t.mock.method(backups, 'createBackup', async () => {
    throw httpError(507, 'Not enough disk space');
  });
  await go(a, { retryMs: 1, maxWaitMs: 50 });
  assert.equal(spy.mock.callCount(), 1);
  assert.match(automations.getAutomation(a.id).lastError, /disk space/);
});

test('an automation whose last run is still waiting to retry will not start a second run', async (t) => {
  const a = make('backup');
  let calls = 0;
  let firstWaiting;
  const waiting = new Promise((r) => (firstWaiting = r));
  t.mock.method(backups, 'createBackup', async () => {
    calls++;
    if (calls === 1) {
      firstWaiting();
      throw busy(); // the first run now waits to retry
    }
    return { id: 'bk_test' };
  });
  t.mock.method(backups, 'verifyBackup', async () => {});
  automations.configureEngine({ retryMs: 30, maxWaitMs: NO_GIVE_UP_MS });
  const first = automations.runNow(a.id);
  await waiting;
  await new Promise((r) => setImmediate(r));
  assert.throws(
    () => automations.runNow(a.id),
    (err) => err.status === 409
  );
  assert.equal(calls, 1, 'the second run did not start');
  await first.done;
});

test('a scheduled start that waited is dropped if someone stopped the server meanwhile', async (t) => {
  const a = make('start');
  let calls = 0;
  t.mock.method(servers, 'startServer', async () => {
    calls++;
    // A person presses Stop while the backup that blocks this start runs.
    require('../src/events').recordEvent({
      serverId: SID,
      type: 'stop-requested',
      summary: 'Graceful stop requested.',
    });
    throw busyErr('Cannot start: a backup operation is already in progress for this server');
  });
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(calls, 1, 'not retried after the Stop');
  assert.equal(automations.listRuns(a.id)[0].steps[0].status, 'skipped');
});

test('a Stop pressed just before a scheduled start fires still counts', async (t) => {
  const a = make('start');
  // Stop pressed 2 s before the firing; its graceful stop is still running.
  db.run(
    "INSERT INTO events (server_id, actor, type, summary, created_at) VALUES (?, 'admin', 'stop-requested', 'Graceful stop requested.', datetime('now', '-2 seconds'))",
    SID
  );
  let calls = 0;
  t.mock.method(servers, 'startServer', async () => {
    calls++;
    // The stop finishes after the firing.
    require('../src/events').recordEvent({ serverId: SID, type: 'stopped', summary: 'Server stopped gracefully.' });
    throw busyErr('Cannot start: a stop operation is already in progress for this server');
  });
  await go(a, { retryMs: 1, maxWaitMs: NO_GIVE_UP_MS });
  assert.equal(calls, 1, 'not started again after the Stop');
});
