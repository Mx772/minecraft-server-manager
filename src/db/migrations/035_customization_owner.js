'use strict';

// A customization row can be owned by a panel feature (e.g. the Discord chat
// bridge) that writes and rewrites its own file. Owned rows are never shown as
// drifted and the user's add/remove/keep/restore actions refuse them.

function up(db) {
  db.exec(`ALTER TABLE server_customizations ADD COLUMN owner TEXT;`);
}

module.exports = { up };
