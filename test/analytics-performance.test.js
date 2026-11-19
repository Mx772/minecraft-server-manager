'use strict';

// GET /api/analytics/servers/:id/performance: bucketing, gaps, permissions.

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const analytics = require('../src/analytics/global');

const S = 'srv_perf_a';
let admin;
let hidden;

async function login(username, role) {
  await require('../src/services/auth').createUser({ username, password: 'passw0rd-12345', role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password: 'passw0rd-12345' } });
  return {
    cookie: (r.setCookie || []).map((c) => c.split(';')[0]).join('; '),
    id: db.get('SELECT id FROM users WHERE username = ?', username).id,
  };
}
const get = (cookie, path) => app.req('GET', `/api/analytics${path}`, { cookie });
const minute = (minAgo) => new Date(Math.floor((Date.now() - minAgo * 60_000) / 60_000) * 60_000).toISOString();

test.before(async () => {
  await app.start();
  admin = await app.adminCookie();
  app.seedServer(S);
  const u = await login('perf_hidden', 'viewer');
  hidden = u.cookie;
  require('../src/services/permissions').setGrant(u.id, S, [], { actor: 'test' });
  const put = (ts, p, tps, mem) =>
    db.run(
      'INSERT INTO server_samples (server_id, ts, players_online, tps, mspt, mem_bytes, mem_limit_bytes, cpu_pct) VALUES (?, ?, ?, ?, 10, ?, 1000, 5)',
      S,
      ts,
      p,
      tps,
      mem
    );
  put(minute(2), 4, 20, 500);
  put(minute(3), 2, 18, 700);
  put(minute(60), 1, 19, 300);
});
test.after(async () => {
  await app.stop();
});

test('24h range buckets raw samples to 5 minutes and leaves gaps as nulls', async () => {
  const r = await get(admin, `/servers/${S}/performance?range=24h`);
  assert.equal(r.status, 200);
  assert.equal(r.json.bucketMs, 300_000);
  assert.ok(r.json.points.length >= 288 && r.json.points.length <= 290);
  const filled = r.json.points.filter((p) => p.playersMax !== null);
  assert.ok(filled.length >= 2 && filled.length <= 3);
  assert.ok(r.json.points.some((p) => p.tpsAvg === null && p.memLimit === null));
  const p = filled.find((x) => x.playersMax === 4) || filled.find((x) => x.playersMax === 2);
  assert.equal(p.memLimit, 1000);
  assert.deepEqual(Object.keys(p).sort(), [
    'cpuAvg',
    'memAvg',
    'memLimit',
    'memMax',
    'msptAvg',
    'playersAvg',
    'playersMax',
    't',
    'tpsAvg',
    'tpsMin',
  ]);
  assert.equal(r.json.summary.playersMax, 4);
  assert.equal(r.json.summary.tpsMin, 18);
  assert.equal(r.json.summary.memMax, 700);
  assert.equal(r.json.summary.tpsAvg, 19);
});

test('30d range uses hourly rows (weighted) plus the not-yet-folded raw tail', async () => {
  const hour = new Date(Date.now() - 48 * 3_600_000);
  hour.setUTCMinutes(0, 0, 0);
  db.run(
    `INSERT INTO server_samples_hourly (server_id, hour, samples, players_avg, players_max, tps_avg, tps_min, mspt_avg, mem_avg, mem_max, cpu_avg, mem_limit)
     VALUES (?, ?, 60, 7, 9, 15, 12, 20, 400, 450, 8, 1000)`,
    S,
    hour.toISOString().replace('.000Z', 'Z')
  );
  const r = await get(admin, `/servers/${S}/performance?range=30d`);
  assert.equal(r.json.bucketMs, 6 * 3_600_000);
  assert.equal(r.json.summary.playersMax, 9);
  assert.equal(r.json.summary.tpsMin, 12);
  assert.ok(r.json.points.some((p) => p.playersMax === 9));
});

test('a user who cannot see the server gets a 404', async () => {
  assert.equal((await get(hidden, `/servers/${S}/performance`)).status, 404);
  assert.equal((await get(admin, '/servers/srv_nope/performance')).status, 404);
  assert.equal((await get(admin, `/servers/${S}/performance?range=bogus`)).status, 400);
});

test('serverRows tpsAvg follows the samples', () => {
  const admins = db.get("SELECT id, role FROM users WHERE role = 'admin'");
  const rows = analytics.serverRows(admins, { range: '24h' });
  assert.equal(rows.find((x) => x.id === S).tpsAvg, 19);
});
