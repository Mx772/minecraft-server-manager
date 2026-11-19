'use strict';

// Pack profiles (recommended per-pack config changes). server_profile_presets
// holds only the user's own choices: a preset with no row follows the profile's
// own default. server_profile_runs keeps the last apply's per-op results so the
// panel can show what was applied, held back, or skipped. Both cascade away
// with the server.

function up(db) {
  db.exec(`
    CREATE TABLE server_profile_presets (
      server_id  TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      profile_id TEXT    NOT NULL,
      preset_id  TEXT    NOT NULL,
      enabled    INTEGER NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (server_id, profile_id, preset_id)
    );
    CREATE TABLE server_profile_runs (
      server_id    TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      profile_id   TEXT NOT NULL,
      ran_at       TEXT NOT NULL DEFAULT (datetime('now')),
      trigger      TEXT NOT NULL,
      results_json TEXT NOT NULL
    );
  `);
}

module.exports = { up };
