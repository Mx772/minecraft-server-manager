'use strict';

// What an automation firing actually does: every action dispatches to the right
// service, each firing is a history event, a failing action is recorded (and
// does not kill the automation), and the redundant-backup shortcut is honoured.
// Runs through runNow against stubbed services.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const automations = require('../src/automations');

const servers = require('../src/services/servers');
const backups = require('../src/services/backups');
const containers = require('../src/docker/containers');
const checker = require('../src/updates/checker');
const upgrade = require('../src/updates/upgrade');
const indexer = require('../src/storage/indexer');
const dataRoot = require('../src/storage/dataRoot');
const authService = require('../src/services/auth');
const players = require('../src/services/players');
const contentIcons = require('../src/services/contentIcons');

const calls = [];
const rec =
  (name, ret) =>
  async (...args) => {
    calls.push([name, ...args]);
    return typeof ret === 'function' ? ret(...args) : ret;
  };

servers.restartServer = rec('restart');
servers.stopServer = rec('stop');
servers.startServer = rec('start');
backups.createBackup = rec('backup', { id: 'bk_sched' });
backups.verifyBackup = rec('verify', { ok: true });
let redundant = false;
backups.isScheduledBackupRedundant = rec('redundant?', () => redundant);
containers.execCapture = rec('rcon', 'There are 0 players');
checker.checkAll = rec('checkAll');
upgrade.runAutoUpgrades = rec('autoUpgrades');
indexer.scan = rec('scan');
indexer.enforceStrictQuotas = rec('quotas');
dataRoot.cleanTmp = (o) => calls.push(['cleanTmp', o]);
authService.pruneExpiredSessions = () => calls.push(['prune']);
players.sweepExpiredBans = rec('banSweep');
contentIcons.backfillContentMeta = rec('backfill');

const SID = 'srv_aut_a';
test.before(() => {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, ?, 'PAPER', 25700, 26700, 'x', 1024, 1536)`,
    SID,
    SID
  );
});
test.after(() => automations.stopAll());

/** Create a disabled one-step automation (so no timer arms) and run it now. */
async function fireOnce(action, params = {}, { panel = false } = {}) {
  calls.length = 0;
  const a = automations.createAutomation({
    name: `Test ${action}`,
    enabled: false,
    targets: panel ? { kind: 'panel' } : { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'schedule', cron: '0 3 * * *' },
    steps: [{ offsetSec: 0, action, params }],
  });
  await automations.runNow(a.id).done;
  automations.deleteAutomation(a.id);
  return a;
}

test('server actions dispatch to the matching service with the automation as actor', async () => {
  for (const name of ['restart', 'stop', 'start']) {
    await fireOnce(name);
    assert.deepEqual(calls[0], [name, SID, { actor: 'automation' }]);
  }
});

test('a backup creates a scheduled backup and forwards the shrink option', async () => {
  redundant = false;
  await fireOnce('backup', { shrink: true });
  const call = calls.find((c) => c[0] === 'backup');
  const { task, ...rest } = call[2];
  assert.deepEqual(rest, { reason: 'scheduled', actor: 'automation', shrinkAfter: true });
  assert.equal(typeof task.step, 'function', 'the backup reports progress into a tray task');
});

test('a scheduled backup is verified right after it is created', async () => {
  redundant = false;
  await fireOnce('backup');
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf('verify') > names.indexOf('backup'));
  assert.deepEqual(calls.find((c) => c[0] === 'verify').slice(0, 2), ['verify', 'bk_sched']);
  assert.equal(calls.find((c) => c[0] === 'verify')[2].actor, 'automation');
});

test('a scheduled backup is skipped when the server is stopped and already backed up', async () => {
  redundant = true;
  await fireOnce('backup');
  redundant = false;
  assert.ok(calls.some((c) => c[0] === 'redundant?'));
  assert.ok(!calls.some((c) => c[0] === 'backup'));
  assert.ok(!calls.some((c) => c[0] === 'verify'));
});

test('a command runs rcon-cli with the words split, defaults to "list", and records the output', async () => {
  await fireOnce('command', { command: 'say hello world' });
  assert.deepEqual(calls[0], ['rcon', SID, ['rcon-cli', '--', 'say', 'hello', 'world']]);
  await fireOnce('command');
  assert.deepEqual(calls[0][2], ['rcon-cli', '--', 'list']);
  assert.ok(db.get("SELECT * FROM events WHERE server_id = ? AND type = 'rcon'", SID));
});

test('a command with a leading slash drops it, and one starting with a dash is not parsed as a flag', async () => {
  await fireOnce('command', { command: '/say hi' });
  assert.deepEqual(calls[0][2], ['rcon-cli', '--', 'say', 'hi']);
  await fireOnce('command', { command: '-h' });
  assert.deepEqual(calls[0][2], ['rcon-cli', '--', '-h']);
});

test('panel maintenance actions dispatch to their services', async () => {
  await fireOnce('update-check', {}, { panel: true });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['checkAll', 'autoUpgrades']
  );
  await fireOnce('storage-scan', {}, { panel: true });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['scan', 'quotas']
  );
  await fireOnce('tmp-clean', {}, { panel: true });
  assert.deepEqual(calls, [['cleanTmp', { olderThanMs: 24 * 60 * 60 * 1000 }], ['prune']]);
  await fireOnce('ban-expiry-sweep', {}, { panel: true });
  assert.equal(calls[0][0], 'banSweep');
  await fireOnce('content-meta-backfill', {}, { panel: true });
  assert.equal(calls[0][0], 'backfill');
});

test('every firing is recorded, last_run_at is stamped, and the run is saved', async () => {
  const a = await fireOnce('ban-expiry-sweep', {}, { panel: true });
  const fired = db.all("SELECT summary FROM events WHERE type = 'automation-fired'");
  assert.ok(fired.some((e) => e.summary === 'Automation fired: Test ban-expiry-sweep.'));
  // The row is gone with the automation; fire again and keep it to read it back.
  const kept = automations.createAutomation({
    name: 'Keep',
    enabled: false,
    targets: { kind: 'panel' },
    trigger: { type: 'schedule', cron: '0 3 * * *' },
    steps: [{ offsetSec: 0, action: 'ban-expiry-sweep' }],
  });
  await automations.runNow(kept.id).done;
  const row = db.get('SELECT last_run_at, last_status FROM automations WHERE id = ?', kept.id);
  assert.ok(row.last_run_at, 'last_run_at stamped');
  assert.equal(row.last_status, 'ok');
  const [run] = automations.listRuns(kept.id);
  assert.equal(run.status, 'ok');
  assert.equal(run.serverId, null);
  assert.deepEqual(
    run.steps.map((s) => [s.action, s.status]),
    [['ban-expiry-sweep', 'ok']]
  );
  assert.ok(a.id);
});

test('a failing action is recorded as automation-failed and does not throw out of the run', async () => {
  const real = players.sweepExpiredBans;
  players.sweepExpiredBans = async () => {
    throw new Error('db locked');
  };
  const a = automations.createAutomation({
    name: 'Fails',
    enabled: false,
    targets: { kind: 'panel' },
    trigger: { type: 'schedule', cron: '0 3 * * *' },
    steps: [{ offsetSec: 0, action: 'ban-expiry-sweep' }],
  });
  await automations.runNow(a.id).done;
  players.sweepExpiredBans = real;
  const failed = db.all("SELECT summary FROM events WHERE type = 'automation-failed'");
  assert.ok(failed.some((e) => /Automation Fails failed at Ban expiry sweep: db locked\./.test(e.summary)));
  const row = db.get('SELECT last_status, last_error FROM automations WHERE id = ?', a.id);
  assert.deepEqual({ ...row }, { last_status: 'failed', last_error: 'db locked' });
});

test('runs are trimmed to the newest 50 per automation', async () => {
  const a = automations.createAutomation({
    name: 'Many',
    enabled: false,
    targets: { kind: 'panel' },
    trigger: { type: 'schedule', cron: '0 3 * * *' },
    steps: [{ offsetSec: 0, action: 'ban-expiry-sweep' }],
  });
  for (let i = 0; i < 53; i++) await automations.runNow(a.id).done;
  assert.equal(automations.listRuns(a.id, 100).length, 50);
});
