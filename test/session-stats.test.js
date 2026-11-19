'use strict';

// Per-session gameplay stat attribution and its daily rollup sum.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const { attributeSessionStats, statDelta } = require('../src/analytics/sessionStats');
const { rebuildDaily } = require('../src/analytics/rollup');

const NOW = Date.parse('2026-05-01T12:00:00.000Z');
let n = 0;
function seed() {
  n += 1;
  const id = `srv_ss${n}`;
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, ?, 'PAPER', ?, ?, 'x', 1024, 1536)`,
    id,
    id,
    30100 + n * 2,
    30101 + n * 2
  );
  return { id, uuid: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` };
}
const snap = (id, uuid, ts, stats) =>
  db.run(
    'INSERT INTO player_stat_snapshots (server_id, uuid, name, ts, stats_json) VALUES (?, ?, ?, ?, ?)',
    id,
    uuid,
    'P',
    ts,
    JSON.stringify(stats)
  );
const sess = (id, uuid, start, end) =>
  Number(
    db.run(
      "INSERT INTO player_sessions (server_id, player, player_uuid, started_at, ended_at) VALUES (?, 'P', ?, ?, ?)",
      id,
      uuid,
      start,
      end
    ).lastInsertRowid
  );
const row = (sid) => db.get('SELECT stats_json, stats_state FROM player_sessions WHERE id = ?', sid);

test('statDelta drops zero keys and flags a reset', () => {
  assert.deepEqual(statDelta({ a: 1, b: 2 }, { a: 4, b: 2, c: 3 }), { a: 3, c: 3 });
  assert.equal(statDelta({ a: 5 }, { a: 2 }), null);
});

test('uses the snapshot before the start and the first one after the end', () => {
  const { id, uuid } = seed();
  snap(id, uuid, '2026-05-01T09:00:00.000Z', { deaths: 9, jumps: 1 }); // older than the latest-before
  snap(id, uuid, '2026-05-01T09:55:00.000Z', { deaths: 1, jumps: 10, mobKills: 0 });
  snap(id, uuid, '2026-05-01T11:03:00.000Z', { deaths: 3, jumps: 10, mobKills: 5 });
  snap(id, uuid, '2026-05-01T11:30:00.000Z', { deaths: 8, jumps: 99, mobKills: 9 }); // not the first after
  const sid = sess(id, uuid, '2026-05-01T10:00:00.000Z', '2026-05-01T11:00:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.deepEqual({ ...row(sid) }, { stats_json: JSON.stringify({ deaths: 2, mobKills: 5 }), stats_state: 'ok' });
});

test('the first session on a server uses a zero baseline; later ones without a before are unavailable', () => {
  const { id, uuid } = seed();
  snap(id, uuid, '2026-05-01T07:03:00.000Z', { deaths: 2 });
  snap(id, uuid, '2026-05-01T09:03:00.000Z', { deaths: 4 });
  const first = sess(id, uuid, '2026-05-01T06:00:00.000Z', '2026-05-01T07:00:00.000Z');
  const second = sess(id, uuid, '2026-05-01T08:00:00.000Z', '2026-05-01T09:00:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.deepEqual(JSON.parse(row(first).stats_json), { deaths: 2 });
  assert.equal(row(first).stats_state, 'ok');
  // Before the second session the latest snapshot is the 07:03 one, so it is attributed.
  assert.deepEqual(JSON.parse(row(second).stats_json), { deaths: 2 });
});

test('a later session with no snapshot before it is unavailable', () => {
  const { id, uuid } = seed();
  sess(id, uuid, '2026-05-01T01:00:00.000Z', '2026-05-01T02:00:00.000Z'); // earliest, never snapshotted
  snap(id, uuid, '2026-05-01T09:03:00.000Z', { deaths: 4 });
  const later = sess(id, uuid, '2026-05-01T08:00:00.000Z', '2026-05-01T09:00:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.equal(row(later).stats_state, 'unavailable');
  assert.equal(row(later).stats_json, null);
});

test('without an after snapshot a session stays pending, then becomes unavailable past 2 hours', () => {
  const { id, uuid } = seed();
  snap(id, uuid, '2026-05-01T09:00:00.000Z', { deaths: 1 });
  const recent = sess(id, uuid, '2026-05-01T10:00:00.000Z', '2026-05-01T11:50:00.000Z');
  const old = sess(id, uuid, '2026-05-01T05:00:00.000Z', '2026-05-01T06:00:00.000Z'); // nothing within 2h after
  const r = attributeSessionStats(id, { now: NOW });
  assert.equal(row(recent).stats_state, null);
  assert.equal(row(old).stats_state, 'unavailable');
  assert.equal(r.pending, 1);
  // Not settled yet at all: ended less than 6 minutes ago is not even looked at.
  const fresh = sess(id, uuid, '2026-05-01T11:00:00.000Z', '2026-05-01T11:57:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.equal(row(fresh).stats_state, null);
});

test('a negative delta (world reset) is unavailable', () => {
  const { id, uuid } = seed();
  snap(id, uuid, '2026-05-01T09:00:00.000Z', { deaths: 5 });
  snap(id, uuid, '2026-05-01T11:03:00.000Z', { deaths: 2 });
  const sid = sess(id, uuid, '2026-05-01T10:00:00.000Z', '2026-05-01T11:00:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.equal(row(sid).stats_state, 'unavailable');
});

test('sessions without a uuid are never touched', () => {
  const { id } = seed();
  const sid = sess(id, null, '2026-05-01T10:00:00.000Z', '2026-05-01T11:00:00.000Z');
  attributeSessionStats(id, { now: NOW });
  assert.equal(row(sid).stats_state, null);
});

test('rebuildDaily sums session deltas on the day each session started', () => {
  const { id, uuid } = seed();
  const a = sess(id, uuid, '2026-03-01T10:00:00.000Z', '2026-03-01T11:00:00.000Z');
  const b = sess(id, uuid, '2026-03-01T22:00:00.000Z', '2026-03-02T01:00:00.000Z'); // spans midnight
  db.run("UPDATE player_sessions SET stats_state = 'ok', stats_json = ? WHERE id = ?", '{"deaths":2,"jumps":5}', a);
  db.run("UPDATE player_sessions SET stats_state = 'ok', stats_json = ? WHERE id = ?", '{"deaths":1}', b);
  rebuildDaily({ serverIds: [id] });
  const days = db.all('SELECT day, stats_json FROM player_daily WHERE server_id = ? ORDER BY day', id);
  assert.deepEqual(JSON.parse(days[0].stats_json), { deaths: 3, jumps: 5 });
  assert.equal(days[1].stats_json, null);
});
