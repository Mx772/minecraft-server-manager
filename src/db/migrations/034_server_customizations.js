'use strict';

// Per-server "customizations": the user's own versions of pack files (configs,
// scripts, ...) kept in <server>/customizations/ and re-applied over the pack's
// files on every start. These rows are metadata only (what the file looked like
// when captured, and which pack version it came from); the files in the folder
// are the source of truth. Rows cascade away with the server.

function up(db) {
  db.exec(`
    CREATE TABLE server_customizations (
      server_id                  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      path                       TEXT NOT NULL,   -- server-relative, e.g. config/foo.toml
      captured_sha256            TEXT NOT NULL,
      captured_at                TEXT NOT NULL DEFAULT (datetime('now')),
      captured_pack_version_id   TEXT,
      captured_pack_version_name TEXT,
      PRIMARY KEY (server_id, path)
    );
  `);
}

module.exports = { up };
