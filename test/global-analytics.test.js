'use strict';

// Global analytics data layer: UUID identity, retention setting, snapshot
// thinning, and the daily rollup.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const { dataPath } = require('../src/storage/pathGuard');
const ingest = require('../src/analytics/ingest');
const { playerKey, resolveSessionUuids } = require('../src/analytics/identity');
const { rebuildDaily, ensureBackfilled } = require('../src/analytics/rollup');
const { thinStatSnapshots } = require('../src/analytics/stats');
const settings = require('../src/services/settings');

let n = 0;
function seed() {
  n += 1;
  const id = `srv_ga${n}`;
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, status)
     VALUES (?, ?, 'PAPER', ?, ?, 'x', 1024, 1536, 'stopped')`,
    id,
    id,
    29100 + n * 2,
    29101 + n * 2
  );
  return id;
}
const sess = (id, player, start, end, uuid = null) =>
  db.run(
    'INSERT INTO player_sessions (server_id, player, started_at, ended_at, player_uuid) VALUES (?, ?, ?, ?, ?)',
    id,
    player,
    start,
    end,
    uuid
  );
const daily = (id) => db.all('SELECT * FROM player_daily WHERE server_id = ? ORDER BY player_key, day', id);

const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

test('playerKey prefers the lowercase uuid, else the lowercase name', () => {
  assert.equal(playerKey(UUID.toUpperCase(), 'Steve'), UUID);
  assert.equal(playerKey(null, 'Steve'), 'name:steve');
});

test('a UUID line before the join is attached to the new session', () => {
  const id = seed();
  ingest.handleLine(
    id,
    '2026-03-01T10:00:00.000Z [10:00:00] [User Authenticator #1/INFO]: UUID of player Alex is ' + UUID
  );
  ingest.handleLine(id, '2026-03-01T10:00:01.000Z [10:00:01] [Server thread/INFO]: Alex joined the game');
  const s = db.get('SELECT player_uuid FROM player_sessions WHERE server_id = ?', id);
  assert.equal(s.player_uuid, UUID);
  // The uuid line itself is not a timeline event.
  assert.equal(db.get("SELECT COUNT(*) n FROM player_events WHERE server_id = ? AND type = 'uuid'", id).n, 0);
});

test('a UUID line after the join fills the open session', () => {
  const id = seed();
  const other = '11111111-2222-3333-4444-555555555555';
  ingest.handleLine(id, '2026-03-01T10:00:01.000Z [10:00:01] [Server thread/INFO]: Bob joined the game');
  assert.equal(db.get('SELECT player_uuid FROM player_sessions WHERE server_id = ?', id).player_uuid, null);
  ingest.handleLine(id, '2026-03-01T10:00:02.000Z [10:00:02] [Server thread/INFO]: UUID of player Bob is ' + other);
  assert.equal(db.get('SELECT player_uuid FROM player_sessions WHERE server_id = ?', id).player_uuid, other);
});

test('resolveSessionUuids fills sessions from usercache.json and reports the earliest start', async () => {
  const id = seed();
  await fsp.mkdir(dataPath('servers', id), { recursive: true });
  await fsp.writeFile(
    dataPath('servers', id, 'usercache.json'),
    JSON.stringify([{ name: 'Carol', uuid: UUID.toUpperCase(), expiresOn: 'x' }])
  );
  sess(id, 'carol', '2026-02-02T00:00:00.000Z', '2026-02-02T01:00:00.000Z');
  sess(id, 'Carol', '2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z');
  sess(id, 'Nobody', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
  const first = await resolveSessionUuids(id);
  assert.equal(first, '2026-02-01T00:00:00.000Z');
  const rows = db.all('SELECT player, player_uuid FROM player_sessions WHERE server_id = ?', id);
  assert.equal(rows.filter((r) => r.player_uuid === UUID).length, 2);
  assert.equal(rows.find((r) => r.player === 'Nobody').player_uuid, null);
  assert.equal(await resolveSessionUuids(id), null); // nothing left to fill
});

test('event retention defaults to 90 and validates its choices', () => {
  assert.equal(settings.getEventRetentionDays(), 90);
  assert.equal(settings.setEventRetentionDays(30), 30);
  assert.equal(settings.setEventRetentionDays('365'), 365);
  assert.equal(settings.setEventRetentionDays('forever'), null);
  assert.equal(settings.getEventRetentionDays(), null);
  assert.throws(() => settings.setEventRetentionDays(45), { status: 400 });
  assert.throws(() => settings.setEventRetentionDays('soon'), { status: 400 });
  assert.equal(settings.getEventRetentionDays(), null); // rejected values are not stored
  settings.setEventRetentionDays(90);
});

test('thinStatSnapshots keeps the latest row per day and leaves recent rows alone', () => {
  const id = seed();
  const add = (uuid, ts) =>
    db.run(
      'INSERT INTO player_stat_snapshots (server_id, uuid, name, ts, stats_json) VALUES (?, ?, ?, ?, ?)',
      id,
      uuid,
      'x',
      ts,
      '{}'
    );
  add('u1', '2020-01-01T01:00:00.000Z');
  add('u1', '2020-01-01T09:00:00.000Z'); // kept: latest of that day
  add('u1', '2020-01-02T03:00:00.000Z'); // kept: only one that day
  add('u2', '2020-01-01T02:00:00.000Z'); // kept: other player
  const recent = new Date().toISOString();
  add('u1', recent);
  add('u1', recent);
  const removed = thinStatSnapshots(90);
  assert.equal(removed, 1);
  const left = db.all('SELECT uuid, ts FROM player_stat_snapshots WHERE server_id = ? ORDER BY id', id);
  assert.equal(left.length, 5);
  assert.ok(!left.some((r) => r.ts === '2020-01-01T01:00:00.000Z'));
  assert.equal(left.filter((r) => r.ts === recent).length, 2);
});

test('rebuildDaily splits a session across UTC midnight', () => {
  const id = seed();
  sess(id, 'Dave', '2026-03-01T23:00:00.000Z', '2026-03-02T01:30:00.000Z');
  rebuildDaily({ serverIds: [id] });
  const rows = daily(id);
  assert.deepEqual(
    rows.map((r) => [r.day, r.play_seconds, r.sessions, r.player_key]),
    [
      ['2026-03-01', 3600, 1, 'name:dave'],
      ['2026-03-02', 5400, 0, 'name:dave'],
    ]
  );
});

test('rebuildDaily counts an open session up to now and uses uuid keys', () => {
  const id = seed();
  const start = new Date(Date.now() - 600_000).toISOString();
  sess(id, 'Erin', start, null, UUID);
  rebuildDaily({ serverIds: [id] });
  const total = daily(id).reduce((sum, r) => sum + r.play_seconds, 0);
  assert.ok(total >= 595 && total <= 610, `total was ${total}`);
  assert.equal(daily(id)[0].player_key, UUID);
  assert.equal(daily(id)[0].player_uuid, UUID);
});

test('rebuildDaily ignores backwards intervals and keeps the latest name per day', () => {
  const id = seed();
  sess(id, 'Bad', '2026-03-05T10:00:00.000Z', '2026-03-05T09:00:00.000Z');
  sess(id, 'OldName', '2026-03-05T10:00:00.000Z', '2026-03-05T11:00:00.000Z', UUID);
  sess(id, 'NewName', '2026-03-05T12:00:00.000Z', '2026-03-05T12:30:00.000Z', UUID);
  rebuildDaily({ serverIds: [id] });
  const rows = daily(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].player_name, 'NewName');
  assert.equal(rows[0].play_seconds, 5400);
  assert.equal(rows[0].sessions, 2);
});

test('rebuildDaily with fromDay leaves earlier days and clips straddling sessions', () => {
  const id = seed();
  sess(id, 'Finn', '2026-03-09T23:00:00.000Z', '2026-03-10T01:00:00.000Z');
  sess(id, 'Finn', '2026-03-11T10:00:00.000Z', '2026-03-11T11:00:00.000Z');
  rebuildDaily({ serverIds: [id] });
  db.run("UPDATE player_daily SET play_seconds = 1 WHERE server_id = ? AND day = '2026-03-09'", id);
  db.run("UPDATE player_daily SET play_seconds = 1 WHERE server_id = ? AND day = '2026-03-11'", id);
  rebuildDaily({ fromDay: '2026-03-10', serverIds: [id] });
  const byDay = Object.fromEntries(daily(id).map((r) => [r.day, r]));
  assert.equal(byDay['2026-03-09'].play_seconds, 1); // untouched
  assert.equal(byDay['2026-03-10'].play_seconds, 3600);
  assert.equal(byDay['2026-03-10'].sessions, 0); // started before fromDay
  assert.equal(byDay['2026-03-11'].play_seconds, 3600); // recomputed
});

test('ensureBackfilled rebuilds only when the rollup is empty', () => {
  db.run('DELETE FROM player_daily');
  assert.equal(ensureBackfilled(), true);
  assert.ok(db.get('SELECT COUNT(*) n FROM player_daily').n > 0);
  assert.equal(ensureBackfilled(), false);
});
