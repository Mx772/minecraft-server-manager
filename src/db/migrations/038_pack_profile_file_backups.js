'use strict';

// The file a pack profile preset replaced (an empty default, or one the user chose to
// replace), kept so turning the preset off can put it back. Capped at 64 KB by the caller.

function up(db) {
  db.exec(`
    CREATE TABLE server_profile_file_backups (
      server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      path             TEXT NOT NULL,
      previous_content BLOB NOT NULL,
      saved_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (server_id, path)
    );
  `);
}

module.exports = { up };
