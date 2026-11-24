'use strict';

// 042: every schedules row becomes a one-step automation, then the old table is
// renamed out of the way.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const { up } = require('../src/db/migrations/042_automations');

test('schedules rows convert to automations and the table is renamed', () => {
  // Put the pre-042 shape back so the migration can run again over it.
  db.exec('DROP TABLE automation_runs; DROP TABLE automations; DROP TABLE schedules_legacy;');
  db.exec(`CREATE TABLE schedules (
    id TEXT PRIMARY KEY, server_id TEXT, task_type TEXT NOT NULL, cron TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(
    `INSERT INTO schedules (id, server_id, task_type, cron, payload_json, enabled, last_run_at) VALUES
       ('sch_aaaa1111', 'srv_m', 'rcon', '0 5 * * *', '{"command":"say hi"}', 1, '2026-01-02 03:04:05'),
       ('sch_bbbb2222', NULL, 'update-check', '0 3 * * *', '{}', 0, NULL),
       ('sch_cccc3333', 'srv_m', 'backup', '30 2 * * *', '{"shrink":true}', 1, NULL)`
  );

  up(db);

  const rows = db.all('SELECT * FROM automations ORDER BY id');
  assert.deepEqual(
    rows.map((r) => r.id),
    ['aut_aaaa1111', 'aut_bbbb2222', 'aut_cccc3333']
  );
  const [command, global, backup] = rows;
  assert.equal(command.name, 'Run Command');
  assert.deepEqual(JSON.parse(command.targets_json), { kind: 'servers', serverIds: ['srv_m'] });
  assert.deepEqual(JSON.parse(command.trigger_json), { type: 'schedule', cron: '0 5 * * *' });
  assert.deepEqual(JSON.parse(command.steps_json), [
    { offsetSec: 0, action: 'command', params: { command: 'say hi' }, onFailure: 'stop' },
  ]);
  assert.equal(command.last_run_at, '2026-01-02 03:04:05');
  assert.equal(command.enabled, 1);

  assert.deepEqual(JSON.parse(global.targets_json), { kind: 'panel' });
  assert.equal(JSON.parse(global.steps_json)[0].action, 'update-check');
  assert.equal(global.enabled, 0);
  assert.equal(global.last_run_at, null);

  assert.deepEqual(JSON.parse(backup.steps_json)[0].params, { shrink: true });

  assert.equal(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schedules'"), undefined);
  assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schedules_legacy'"));
  assert.equal(db.all('SELECT * FROM schedules_legacy').length, 3);
});
