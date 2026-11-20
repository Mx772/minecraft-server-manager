'use strict';

// Custom domains per server (e.g. atm10.example.com) plus the DNS check result
// last seen for each one. dns_providers is scaffolding for automatic SRV record
// management (an API token per provider, stored encrypted); nothing creates a
// provider yet, so server_domains.dns_provider_id stays NULL for now.

function up(db) {
  db.exec(`
    CREATE TABLE dns_providers (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      label         TEXT NOT NULL,
      config_cipher TEXT NOT NULL,   -- encrypted JSON (API token); never returned by the API
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE server_domains (
      server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      domain          TEXT NOT NULL,
      is_primary      INTEGER NOT NULL DEFAULT 0,
      last_state      TEXT,
      last_check_json TEXT,
      last_checked_at TEXT,
      dns_provider_id TEXT REFERENCES dns_providers(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (server_id, domain)
    );
  `);
}

module.exports = { up };
