'use strict';

// Global analytics: a stable player identity on sessions, a per-day rollup that
// outlives session pruning, and the minimum needed to keep a deleted server's
// stats labelled and visible to the people who could see it.

function up(db) {
  db.exec(`
    ALTER TABLE player_sessions ADD COLUMN player_uuid TEXT;
    CREATE INDEX idx_sessions_uuid ON player_sessions(player_uuid);
    CREATE INDEX idx_sessions_started ON player_sessions(started_at);
    CREATE INDEX idx_sessions_ended ON player_sessions(ended_at);

    -- One row per server, player and UTC day. player_key is the lowercased
    -- dashed UUID when known, else 'name:' + the lowercased name.
    CREATE TABLE player_daily (
      server_id    TEXT NOT NULL,
      player_key   TEXT NOT NULL,
      player_uuid  TEXT,
      player_name  TEXT NOT NULL,
      day          TEXT NOT NULL,
      play_seconds INTEGER NOT NULL DEFAULT 0,
      sessions     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (server_id, player_key, day)
    );
    CREATE INDEX idx_player_daily_day ON player_daily(day);
    CREATE INDEX idx_player_daily_key ON player_daily(player_key);

    -- Just enough to label a server whose stats were kept after deletion.
    CREATE TABLE deleted_servers (
      id           TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      icon         TEXT,
      accent       TEXT,
      type         TEXT,
      mc_version   TEXT,
      created_at   TEXT,
      deleted_at   TEXT NOT NULL,
      deleted_by   TEXT
    );

    -- Who could see the server when it was deleted.
    CREATE TABLE deleted_server_viewers (
      server_id TEXT NOT NULL,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (server_id, user_id)
    );
  `);
}

module.exports = { up };
