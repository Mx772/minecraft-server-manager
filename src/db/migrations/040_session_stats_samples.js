'use strict';

// Per-session gameplay stat deltas (stats_json, resolved by stats_state) and the
// per-day sum of them, plus raw and hourly server samples (players, TPS, memory,
// CPU) for the performance charts.

function up(db) {
  db.exec(`
    -- stats_state: NULL = pending, 'ok', or 'unavailable'.
    ALTER TABLE player_sessions ADD COLUMN stats_json TEXT;
    ALTER TABLE player_sessions ADD COLUMN stats_state TEXT;
    ALTER TABLE player_daily ADD COLUMN stats_json TEXT;

    CREATE TABLE server_samples (
      server_id       TEXT NOT NULL,
      ts              TEXT NOT NULL,
      players_online  INTEGER,
      tps             REAL,
      mspt            REAL,
      mem_bytes       INTEGER,
      mem_limit_bytes INTEGER,
      cpu_pct         REAL,
      PRIMARY KEY (server_id, ts)
    );

    CREATE TABLE server_samples_hourly (
      server_id   TEXT NOT NULL,
      hour        TEXT NOT NULL,
      samples     INTEGER NOT NULL,
      players_avg REAL,
      players_max INTEGER,
      tps_avg     REAL,
      tps_min     REAL,
      mspt_avg    REAL,
      mem_avg     INTEGER,
      mem_max     INTEGER,
      cpu_avg     REAL,
      mem_limit   INTEGER,
      PRIMARY KEY (server_id, hour)
    );
  `);
}

module.exports = { up };
