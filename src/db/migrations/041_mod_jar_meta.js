'use strict';

// Persistent cache of parsed mod/plugin jar metadata, keyed by server and the
// jar's path relative to the server folder. A row is valid while the jar's size
// and mtime still match, so unchanged jars are never reopened after a restart.

function up(db) {
  db.exec(`
    CREATE TABLE mod_jar_meta (
      server_id         TEXT NOT NULL,
      rel_path          TEXT NOT NULL,
      size              INTEGER NOT NULL,
      mtime_ms          INTEGER NOT NULL,
      meta_json         TEXT,
      descriptions_json TEXT,
      scanned_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (server_id, rel_path)
    );
  `);
}

module.exports = { up };
