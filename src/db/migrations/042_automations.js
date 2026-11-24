'use strict';

// Automations replace the cron-only "schedules": a named automation has targets
// (one or more servers, every server, or the panel itself), a trigger, and an
// ordered list of steps with time offsets. Every existing schedule becomes a
// one-step automation, then the old table is kept (unused) for one release.

const LABELS = {
  restart: 'Restart Server',
  backup: 'Back Up Server',
  stop: 'Stop Server',
  start: 'Start Server',
  rcon: 'Run Command',
  'backup-all': 'Back Up All Servers',
  'restart-all': 'Restart All Running Servers',
  'update-check': 'Update Check',
  'storage-scan': 'Storage Re-Scan',
  'tmp-clean': 'Clear Temporary Files',
  'ban-expiry-sweep': 'Ban Expiry Sweep',
  'content-meta-backfill': 'Content Metadata Backfill',
};

/** A payload that will not parse becomes no parameters rather than failing the whole migration. */
function parsePayload(json) {
  try {
    return JSON.parse(json || '{}') || {};
  } catch {
    return {};
  }
}

function up(db) {
  db.exec(`
    CREATE TABLE automations (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      targets_json TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      steps_json   TEXT NOT NULL,
      created_by   TEXT,
      last_run_at  TEXT,
      last_status  TEXT,
      last_error   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE automation_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      server_id     TEXT,
      anchor_at     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      status        TEXT NOT NULL,
      steps_json    TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_automation_runs_automation ON automation_runs(automation_id, id DESC);
  `);

  for (const s of db.all('SELECT * FROM schedules')) {
    const params = parsePayload(s.payload_json);
    const action = s.task_type === 'rcon' ? 'command' : s.task_type;
    const targets = s.server_id ? { kind: 'servers', serverIds: [s.server_id] } : { kind: 'panel' };
    const id = `aut_${String(s.id).replace(/^sch_/, '')}`;
    db.run(
      `INSERT INTO automations (id, name, enabled, targets_json, trigger_json, steps_json, created_by, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, ?)`,
      id,
      LABELS[s.task_type] || s.task_type,
      s.enabled ? 1 : 0,
      JSON.stringify(targets),
      JSON.stringify({ type: 'schedule', cron: s.cron }),
      JSON.stringify([{ offsetSec: 0, action, params, onFailure: 'stop' }]),
      s.last_run_at || null,
      s.created_at
    );
  }

  db.exec('ALTER TABLE schedules RENAME TO schedules_legacy');
}

module.exports = { up };
