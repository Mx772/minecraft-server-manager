'use strict';

// Fleet actions ("Back up all servers", "Restart all running servers"): they
// visit every eligible server in turn, isolate per-server failures, report the
// failures at the end, and are registered admin-only. (Who may create one is a
// route concern, covered with the routes.)

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/app');
const db = require('../src/db');
const automations = require('../src/automations');
const servers = require('../src/services/servers');
const backups = require('../src/services/backups');

const calls = [];
let backupFails = new Set();
let restartFails = new Set();
let redundant = new Set();

servers.restartServer = async (id, opts) => {
  calls.push(['restart', id, opts.actor]);
  if (restartFails.has(id)) throw new Error('boom');
};
backups.isScheduledBackupRedundant = async (id) => redundant.has(id);
backups.createBackup = async (id, opts) => {
  calls.push(['backup', id, opts.reason, opts.shrinkAfter]);
  if (backupFails.has(id)) throw new Error('disk full');
  return { id: `bk_${id}` };
};
backups.verifyBackup = async (backupId) => {
  calls.push(['verify', backupId]);
};

function setStatuses(map) {
  for (const [id, status] of Object.entries(map)) db.run('UPDATE servers SET status = ? WHERE id = ?', status, id);
}

test.before(async () => {
  for (const id of ['srv_fa', 'srv_fb', 'srv_fc', 'srv_fd', 'srv_fe']) {
    db.run(
      `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
       VALUES (?, 'Test Server', 'PAPER', ?, ?, 'x', 1024, 1536)`,
      id,
      25000 + id.charCodeAt(5),
      26000 + id.charCodeAt(5)
    );
  }
});
test.after(() => automations.stopAll());

test.beforeEach(() => {
  calls.length = 0;
  backupFails = new Set();
  restartFails = new Set();
  redundant = new Set();
});

/** Run a fleet action once through the engine; resolves with the saved run's outcome. */
async function run(action, params = {}) {
  const a = automations.createAutomation({
    name: `Fleet ${action}`,
    enabled: false,
    targets: { kind: 'panel' },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [{ offsetSec: 0, action, params }],
  });
  await automations.runNow(a.id).done;
  const row = db.get('SELECT last_status, last_error FROM automations WHERE id = ?', a.id);
  automations.deleteAutomation(a.id);
  return row;
}

test('backup-all backs up and verifies each server, skipping redundant ones', async () => {
  setStatuses({ srv_fa: 'running', srv_fb: 'stopped', srv_fc: 'stopped', srv_fd: 'stopped', srv_fe: 'stopped' });
  redundant = new Set(['srv_fb', 'srv_fc', 'srv_fd', 'srv_fe']);
  await run('backup-all');
  assert.deepEqual(calls, [
    ['backup', 'srv_fa', 'scheduled', false],
    ['verify', 'bk_srv_fa'],
  ]);
});

test('backup-all passes the shrink option through', async () => {
  redundant = new Set(['srv_fb', 'srv_fc', 'srv_fd', 'srv_fe']);
  await run('backup-all', { shrink: true });
  assert.deepEqual(calls[0], ['backup', 'srv_fa', 'scheduled', true]);
});

test('backup-all keeps going after one server fails, then fails the run naming it', async () => {
  redundant = new Set(['srv_fd', 'srv_fe']);
  backupFails = new Set(['srv_fa']);
  const row = await run('backup-all');
  assert.equal(row.last_status, 'failed');
  assert.match(row.last_error, /Backing up failed for 1 of 5 servers: Test Server\./);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'backup').map((c) => c[1]),
    ['srv_fa', 'srv_fb', 'srv_fc']
  );
  // The failed server was never verified; the others were.
  assert.deepEqual(
    calls.filter((c) => c[0] === 'verify').map((c) => c[1]),
    ['bk_srv_fb', 'bk_srv_fc']
  );
});

test('restart-all restarts only running and unhealthy servers', async () => {
  setStatuses({ srv_fa: 'running', srv_fb: 'unhealthy', srv_fc: 'starting', srv_fd: 'stalled', srv_fe: 'stopped' });
  await run('restart-all');
  assert.deepEqual(calls, [
    ['restart', 'srv_fa', 'automation'],
    ['restart', 'srv_fb', 'automation'],
  ]);
});

test('restart-all isolates a failing server and reports it at the end', async () => {
  setStatuses({ srv_fa: 'running', srv_fb: 'running', srv_fc: 'running', srv_fd: 'stopped', srv_fe: 'stopped' });
  restartFails = new Set(['srv_fa']);
  const row = await run('restart-all');
  assert.match(row.last_error, /Restarting failed for 1 of 3 servers/);
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['srv_fa', 'srv_fb', 'srv_fc']
  );
});

test('restart-all with nothing running is a quiet no-op', async () => {
  setStatuses({ srv_fa: 'stopped', srv_fb: 'stopped', srv_fc: 'stopped', srv_fd: 'stopped', srv_fe: 'stopped' });
  const row = await run('restart-all');
  assert.equal(row.last_status, 'ok');
  assert.deepEqual(calls, []);
});

test('fleet actions are registered as admin-only and panel-wide', () => {
  for (const type of ['backup-all', 'restart-all']) {
    assert.equal(automations.ACTIONS[type].adminOnly, true, type);
    assert.equal(automations.ACTIONS[type].scope, 'panel', type);
  }
});
