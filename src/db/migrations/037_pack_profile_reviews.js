'use strict';

// Pack profile review state. A matching profile's suggested presets never apply
// on their own: the panel prompts once, and only presets the user turns on are
// applied. seen_preset_ids are the preset ids the user has been shown (so a
// profile that later gains a preset prompts again); notified_preset_ids are the
// ones already announced in the history log (so the notice happens once).
// reviewed_at stays NULL until the user answers the prompt.

function up(db) {
  db.exec(`
    CREATE TABLE server_profile_reviews (
      server_id           TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      profile_id          TEXT NOT NULL,
      seen_preset_ids     TEXT NOT NULL DEFAULT '[]',
      reviewed_at         TEXT,
      notified_preset_ids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (server_id, profile_id)
    );
  `);
}

module.exports = { up };
