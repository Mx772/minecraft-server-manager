'use strict';

// Minute samples from an injected live-cache reader, the hourly fold and prune,
// and sample cleanup on server delete.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const samples = require('../src/analytics/samples');

const NOW = Date.parse('2026-05-10T12:34:56.000Z');
const snap = (over = {}) => ({
  players: { online: 3, max: 20, names: [], at: NOW },
  perf: { tps1: 19.8, mspt: 12.5, at: NOW },
  stats: { cpuPct: 41.5, memUsedBytes: 2_000_000, memLimitBytes: 4_000_000, at: NOW },
  ...over,
});
const count = (t, id) => db.get(`SELECT COUNT(*) n FROM ${t} WHERE server_id = ?`, id).n;

test('sampleOnce stores one row per live server, truncated to the minute, with NULL for unknowns', () => {
  const read = () => ({
    srv_sm1: snap(),
    srv_sm2: snap({ perf: null, players: null }),
    srv_sm3: snap({ perf: { tps1: 20, at: NOW - 10 * 60_000 }, players: null, stats: null }), // stale perf
  });
  assert.equal(samples.sampleOnce({ read, now: NOW }), 2);
  const a = db.get('SELECT * FROM server_samples WHERE server_id = ?', 'srv_sm1');
  assert.equal(a.ts, '2026-05-10T12:34:00.000Z');
  assert.deepEqual(
    [a.players_online, a.tps, a.mspt, a.mem_bytes, a.mem_limit_bytes, a.cpu_pct],
    [3, 19.8, 12.5, 2_000_000, 4_000_000, 41.5]
  );
  const b = db.get('SELECT * FROM server_samples WHERE server_id = ?', 'srv_sm2');
  assert.equal(b.players_online, null);
  assert.equal(b.tps, null);
  assert.equal(b.mem_bytes, 2_000_000);
  assert.equal(count('server_samples', 'srv_sm3'), 0); // nothing fresh to record
  assert.equal(samples.sampleOnce({ read, now: NOW + 1000 }), 0); // same minute: ignored
});

test('rollupHourly folds completed hours idempotently and leaves the open hour raw', () => {
  const id = 'srv_sm_fold';
  const put = (ts, p, tps, mem) =>
    db.run(
      'INSERT INTO server_samples (server_id, ts, players_online, tps, mem_bytes, mem_limit_bytes) VALUES (?, ?, ?, ?, ?, 100)',
      id,
      ts,
      p,
      tps,
      mem
    );
  put('2026-05-10T10:05:00.000Z', 2, 20, 100);
  put('2026-05-10T10:35:00.000Z', 4, 18, 300);
  put('2026-05-10T12:05:00.000Z', 9, 10, 900); // the open hour at NOW
  samples.rollupHourly({ now: NOW });
  samples.rollupHourly({ now: NOW });
  const hours = db.all('SELECT * FROM server_samples_hourly WHERE server_id = ?', id);
  assert.equal(hours.length, 1);
  assert.deepEqual(
    [
      hours[0].hour,
      hours[0].samples,
      hours[0].players_avg,
      hours[0].players_max,
      hours[0].tps_avg,
      hours[0].tps_min,
      hours[0].mem_avg,
      hours[0].mem_max,
      hours[0].mem_limit,
    ],
    ['2026-05-10T10:00:00Z', 2, 3, 4, 19, 18, 200, 300, 100]
  );
  assert.equal(count('server_samples', id), 3); // young raw rows are kept
});

test('raw samples older than 30 days are pruned once rolled up; newer and open-hour rows stay', () => {
  const id = 'srv_sm_prune';
  const put = (ts) => db.run('INSERT INTO server_samples (server_id, ts, players_online) VALUES (?, ?, 1)', id, ts);
  put('2026-03-01T00:05:00.000Z'); // ~70 days old
  put('2026-04-20T00:05:00.000Z'); // 20 days old
  put('2026-05-10T12:10:00.000Z'); // open hour
  const r = samples.rollupHourly({ now: NOW });
  assert.ok(r.pruned >= 1);
  assert.equal(count('server_samples', id), 2);
  assert.equal(
    db.get("SELECT COUNT(*) n FROM server_samples_hourly WHERE server_id = ? AND hour = '2026-03-01T00:00:00Z'", id).n,
    1
  );
  assert.equal(
    db.get("SELECT COUNT(*) n FROM server_samples_hourly WHERE server_id = ? AND hour = '2026-05-10T12:00:00Z'", id).n,
    0
  );
});

test('deleting a server removes its samples even when player stats are kept', async (t) => {
  const containers = require('../src/docker/containers');
  t.mock.method(containers, 'stopContainer', async () => {});
  t.mock.method(containers, 'removeContainer', async () => {});
  const servers = require('../src/services/servers');
  const id = 'srv_sm_del';
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Del', 'PAPER', 30301, 30302, 'x', 1024, 1536)`,
    id
  );
  db.run("INSERT INTO server_samples (server_id, ts, players_online) VALUES (?, '2026-05-01T00:00:00.000Z', 1)", id);
  db.run("INSERT INTO server_samples_hourly (server_id, hour, samples) VALUES (?, '2026-05-01T00:00:00Z', 1)", id);
  await servers.deleteServer(id, { keepPlayerStats: true });
  assert.equal(count('server_samples', id), 0);
  assert.equal(count('server_samples_hourly', id), 0);
});
