'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/app'); // migrate() + throwaway DATA_DIR via env.js (no Docker)
const db = require('../src/db');
const servers = require('../src/services/servers');
const containers = require('../src/docker/containers');

function seedServer(id) {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, ?, 'PAPER', 25599, 26599, 'x', 1024, 1536)`,
    id,
    'Test Server'
  );
  return id;
}

function seedBackup(id, serverId, sizeBytes = 1234) {
  db.run(
    "INSERT INTO backups (id, server_id, filename, rel_path, size_bytes, reason) VALUES (?, ?, ?, ?, ?, 'manual')",
    id,
    serverId,
    'world.tar.gz',
    `backups/${serverId}/world.tar.gz`,
    sizeBytes
  );
}

test('deleteServer keeps files and backups by default (no action needed to preserve them)', async (t) => {
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const id = seedServer('srv_delkeep');
  seedBackup('bk_keep', id, 777);

  const { freedBytes } = await servers.deleteServer(id);
  assert.ok(db.get('SELECT id FROM backups WHERE id = ?', 'bk_keep'), 'backup row survives a default delete');
  const kept = db.get('SELECT id FROM servers WHERE id = ? AND deleted_at IS NOT NULL', id);
  assert.ok(kept, 'server row is soft-deleted, not removed');
  assert.equal(freedBytes, 0);
});

test('deleteServer removes files and backups when explicitly requested', async (t) => {
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const id = seedServer('srv_deldrop');
  seedBackup('bk_drop', id, 5000);

  const { freedBytes } = await servers.deleteServer(id, { keepWorld: false, keepBackups: false });
  assert.equal(
    db.get('SELECT id FROM backups WHERE id = ?', 'bk_drop'),
    undefined,
    'backup row removed when explicitly deleted'
  );
  assert.equal(freedBytes, 5000);
});

function seedUser(id, role) {
  db.run("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)", id, id, role);
}
function seedStats(id) {
  db.run(
    "INSERT INTO player_events (server_id, ts, type, player) VALUES (?, '2026-01-01T00:00:00.000Z', 'join', 'A')",
    id
  );
  db.run(
    "INSERT INTO player_sessions (server_id, player, started_at, ended_at) VALUES (?, 'Old', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')",
    id
  );
  db.run(
    "INSERT INTO player_sessions (server_id, player, started_at) VALUES (?, 'Open', '2026-01-02T00:00:00.000Z')",
    id
  );
  db.run("INSERT INTO player_stat_snapshots (server_id, uuid, name, stats_json) VALUES (?, 'u1', 'Old', '{}')", id);
  db.run(
    "INSERT INTO player_daily (server_id, player_key, player_name, day, play_seconds, sessions) VALUES (?, 'name:old', 'Old', '2026-01-01', 3600, 1)",
    id
  );
}
const count = (table, col, id) => db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`, id).n;

test('deleteServer with keepPlayerStats keeps stats, labels the server and records who can view it', async (t) => {
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const id = seedServer('srv_delstats');
  seedStats(id);
  seedUser('u_ks_admin', 'admin');
  seedUser('u_ks_viewer', 'viewer');
  seedUser('u_ks_hidden', 'viewer');
  require('../src/services/permissions').setGrant('u_ks_hidden', id, [], { actor: 'test' });

  await servers.deleteServer(id, { actor: 'tester', keepPlayerStats: true });

  assert.equal(count('player_events', 'server_id', id), 0);
  assert.equal(count('player_sessions', 'server_id', id), 2);
  assert.equal(count('player_stat_snapshots', 'server_id', id), 1);
  assert.ok(count('player_daily', 'server_id', id) >= 1);
  assert.equal(
    count('player_sessions', 'server_id', id) -
      db.get('SELECT COUNT(*) n FROM player_sessions WHERE server_id = ? AND ended_at IS NOT NULL', id).n,
    0,
    'open sessions are closed'
  );

  const label = db.get('SELECT * FROM deleted_servers WHERE id = ?', id);
  assert.equal(label.display_name, 'Test Server');
  assert.equal(label.type, 'PAPER');
  assert.equal(label.icon, 'grass');
  assert.ok(label.accent && label.mc_version && label.created_at && label.deleted_at);
  assert.equal(label.deleted_by, 'tester');

  const viewers = db.all('SELECT user_id FROM deleted_server_viewers WHERE server_id = ?', id).map((r) => r.user_id);
  assert.deepEqual(viewers, ['u_ks_viewer']);
});

test('deleteServer without keepPlayerStats purges every stat table', async (t) => {
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const id = seedServer('srv_delnostats');
  seedStats(id);
  await servers.deleteServer(id);
  for (const table of ['player_events', 'player_sessions', 'player_stat_snapshots', 'player_daily']) {
    assert.equal(count(table, 'server_id', id), 0, table);
  }
  assert.equal(count('deleted_servers', 'id', id), 0);
});

test('purgeDeletedServerStats removes kept stats and 404s for an unknown id', async (t) => {
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const id = seedServer('srv_delpurge');
  seedStats(id);
  await servers.deleteServer(id, { keepPlayerStats: true });
  servers.purgeDeletedServerStats(id, { actor: 'tester' });
  for (const table of ['player_sessions', 'player_stat_snapshots', 'player_daily', 'deleted_server_viewers']) {
    assert.equal(count(table, 'server_id', id), 0, table);
  }
  assert.equal(count('deleted_servers', 'id', id), 0);
  const ev = db.get("SELECT summary FROM events WHERE server_id = ? AND summary LIKE 'Kept player stats%'", id);
  assert.equal(ev.summary, 'Kept player stats removed for Test Server.');
  assert.throws(() => servers.purgeDeletedServerStats('srv_nope'), { status: 404 });
});
