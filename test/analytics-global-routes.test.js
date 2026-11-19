'use strict';

// /api/analytics: scoping (live, granted, deleted-with-kept-stats), grouping by
// player key, summary/series/list/detail shapes, and the admin-only purge.

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const analytics = require('../src/analytics/global');
const rollup = require('../src/analytics/rollup');

const U1 = '069a79f4-44e9-4726-a5be-fca90e38aaf5'; // Alice, later renamed Alicia
const U2 = '11111111-2222-3333-4444-555555555555'; // Carol (deleted server only)
const A = 'srv_ga_a';
const B = 'srv_ga_b';
const D = 'srv_ga_d';

let admin;
let granted;
let other;
const NOW = Date.now();
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

async function login(username, role) {
  await require('../src/services/auth').createUser({ username, password: 'passw0rd-12345', role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password: 'passw0rd-12345' } });
  const cookie = (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  return { cookie, id: db.get('SELECT id FROM users WHERE username = ?', username).id };
}
const get = (cookie, path) => app.req('GET', `/api/analytics${path}`, { cookie });

function seedServer(id, name, n, deletedAt = null) {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, deleted_at)
     VALUES (?, ?, 'PAPER', ?, ?, 'x', 1024, 1536, ?)`,
    id,
    name,
    29500 + n * 2,
    29501 + n * 2,
    deletedAt
  );
}
function sess(server, player, uuid, start, end) {
  db.run(
    'INSERT INTO player_sessions (server_id, player, player_uuid, started_at, ended_at) VALUES (?, ?, ?, ?, ?)',
    server,
    player,
    uuid,
    start,
    end
  );
}

test.before(async () => {
  await app.start();
  await app.adminCookie().then((c) => (admin = c));
  seedServer(A, 'Alpha', 1);
  seedServer(B, 'Beta', 2);
  seedServer(D, 'Gamma', 3, '2026-01-01 00:00:00');
  db.run(
    "INSERT INTO deleted_servers (id, display_name, icon, accent, type, mc_version, deleted_at) VALUES (?, 'Gamma', 'grass', '#3fa62b', 'PAPER', '1.21', '2026-01-01T00:00:00.000Z')",
    D
  );
  granted = await login('ga_granted', 'viewer');
  other = await login('ga_other', 'viewer');
  const perms = require('../src/services/permissions');
  perms.setGrant(granted.id, A, ['view'], { actor: 'test' });
  perms.setGrant(granted.id, B, [], { actor: 'test' });
  db.run('INSERT INTO deleted_server_viewers (server_id, user_id) VALUES (?, ?)', D, granted.id);

  sess(A, 'Alice', U1, iso(10), iso(9));
  sess(A, 'Alicia', U1, iso(3), iso(2)); // renamed, same uuid
  sess(A, 'Bob', null, iso(3.5), iso(2.5)); // overlaps Alicia
  sess(B, 'Alice', U1, iso(6), iso(5));
  sess(D, 'Carol', U2, iso(4), iso(3)); // ends exactly when Alicia starts
  rollup.rebuildDaily();
});
test.after(async () => {
  await app.stop();
});

const ids = (rows) => rows.map((r) => r.id).sort();

test('admin sees live servers by default and the deleted one with deleted=1', async () => {
  assert.deepEqual(ids((await get(admin, '/servers')).json.servers), [A, B]);
  const all = (await get(admin, '/servers?deleted=1')).json.servers;
  assert.deepEqual(ids(all), [A, B, D]);
  assert.equal(all.find((s) => s.id === D).deleted, true);
});

test('a granted user sees their server plus the deleted one they could view', async () => {
  assert.deepEqual(ids((await get(granted.cookie, '/servers')).json.servers), [A]);
  assert.deepEqual(ids((await get(granted.cookie, '/servers?deleted=1')).json.servers), [A, D]);
  assert.equal((await get(granted.cookie, `/servers/${D}`)).status, 200);
});

test('an unlisted user never sees the deleted server', async () => {
  assert.deepEqual(ids((await get(other.cookie, '/servers?deleted=1')).json.servers), [A, B]);
  assert.equal((await get(other.cookie, `/servers/${D}`)).status, 404);
  const s = (await get(other.cookie, `/summary?deleted=1&servers=${D}`)).json.summary;
  assert.equal(s.serverCount, 0);
  assert.equal(s.playSeconds, 0);
});

test('summary totals agree between session-sourced (7d) and daily-sourced (30d) ranges', async () => {
  for (const range of ['7d', '30d']) {
    const s = (await get(admin, `/summary?deleted=1&range=${range}`)).json.summary;
    assert.equal(s.playSeconds, 5 * 3600, range);
    assert.equal(s.uniquePlayers, 3, range);
    assert.equal(s.sessions, 5, range);
    assert.equal(s.peakOnline, 2, range); // Carol ends as Alicia starts: no overlap
    assert.equal(s.busiestServer.id, A);
    assert.equal(s.serverCount, 3);
  }
  const live = (await get(admin, '/summary?range=7d')).json.summary;
  assert.equal(live.playSeconds, 4 * 3600);
  assert.equal(live.uniquePlayers, 2);
});

test('online series reports the concurrent peak, combined or split per server', async () => {
  const one = (await get(admin, '/online?range=24h')).json;
  assert.equal(one.bucketMs, 900_000);
  assert.equal(one.series.length, 1);
  assert.equal(one.series[0].serverId, null);
  assert.equal(one.series[0].values.length, one.buckets.length);
  assert.equal(Math.max(...one.series[0].values), 2);
  const split = (await get(admin, '/online?range=24h&split=1&deleted=1')).json;
  assert.equal(split.series.length, 3);
  assert.equal(Math.max(...split.series.find((s) => s.serverId === A).values), 2);
  assert.equal(Math.max(...split.series.find((s) => s.serverId === B).values), 1);
});

test('players group a renamed uuid player under one key with the newest name', async () => {
  const r = (await get(admin, '/players?deleted=1&sort=name')).json;
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.rows.map((p) => p.name),
    ['Alicia', 'Bob', 'Carol']
  );
  const alice = r.rows[0];
  assert.equal(alice.key, U1);
  assert.equal(alice.uuid, U1);
  assert.equal(alice.playSeconds, 3 * 3600);
  assert.deepEqual(alice.servers.map((s) => s.id).sort(), [A, B]);
  assert.ok(alice.firstSeen && alice.lastSeen);
  assert.equal(r.rows[1].uuid, null);
});

test('players endpoint searches, sorts and paginates', async () => {
  const q = (await get(admin, '/players?deleted=1&q=BO')).json;
  assert.deepEqual(
    q.rows.map((p) => p.name),
    ['Bob']
  );
  const byUuid = (await get(admin, `/players?deleted=1&q=${U1.slice(0, 8)}`)).json;
  assert.deepEqual(
    byUuid.rows.map((p) => p.key),
    [U1]
  );
  const byPlay = (await get(admin, '/players?deleted=1&sort=playtime')).json;
  assert.equal(byPlay.rows[0].key, U1);
  const p1 = (await get(admin, '/players?deleted=1&sort=name&limit=2')).json;
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.nextCursor, 2);
  const p2 = (await get(admin, `/players?deleted=1&sort=name&limit=2&cursor=${p1.nextCursor}`)).json;
  assert.deepEqual(
    p2.rows.map((p) => p.name),
    ['Carol']
  );
  assert.equal(p2.nextCursor, null);
  assert.equal((await get(admin, '/players?limit=500')).status, 400);
});

test('server detail lists players by play time and a daily series', async () => {
  const r = (await get(admin, `/servers/${A}?range=30d`)).json;
  assert.equal(r.server.name, 'Alpha');
  assert.deepEqual(
    r.players.map((p) => p.name),
    ['Alicia', 'Bob']
  ); // 2h then 1h
  assert.equal(r.players[0].playSeconds, 7200);
  assert.equal(
    r.daily.reduce((n, d) => n + d.playSeconds, 0),
    3 * 3600
  );
});

test('player detail covers deleted servers the user may see, and 404s otherwise', async () => {
  const r = (await get(admin, `/players/${U1}`)).json;
  assert.equal(r.player.name, 'Alicia');
  assert.deepEqual(r.servers.map((s) => s.id).sort(), [A, B]);
  assert.equal(r.recentSessions.length, 3);
  assert.ok(r.daily.length >= 1);
  const carol = await get(granted.cookie, `/players/${U2}`);
  assert.equal(carol.status, 200);
  assert.equal(carol.json.servers[0].deleted, true);
  assert.equal((await get(other.cookie, `/players/${U2}`)).status, 404);
  assert.equal((await get(admin, `/players/${encodeURIComponent('name:bob')}`)).status, 200);
  assert.equal((await get(admin, '/players/not-a-key')).status, 400);
});

test('the /analytics page renders for admins and viewers, scoped to what each may see', async () => {
  for (const cookie of [admin, granted.cookie]) {
    const r = await app.req('GET', '/analytics', { cookie });
    assert.equal(r.status, 200);
    for (const label of ['ANALYTICS', 'Overview', 'Servers', 'Players', 'Include Deleted Servers', 'Split by Server']) {
      assert.ok(r.text.includes(label), `page has ${label}`);
    }
    assert.ok(r.text.includes('/js/pages/analytics-global.js'));
    assert.ok(r.text.includes('href="/analytics"'), 'sidebar links to the page');
  }
  const adminHtml = (await app.req('GET', '/analytics', { cookie: admin })).text;
  assert.match(adminHtml, /data-admin="1"/);
  assert.ok(adminHtml.includes('Alpha') && adminHtml.includes('Gamma'));
  const viewerHtml = (await app.req('GET', '/analytics', { cookie: other.cookie })).text;
  assert.match(viewerHtml, /data-admin="0"/);
  assert.ok(!viewerHtml.includes('Gamma'), 'an unlisted user never sees the deleted server');
});

test('purging kept stats is admin only, removes the data, then 404s', async () => {
  assert.equal(
    (await app.req('DELETE', `/api/analytics/deleted-servers/${D}`, { cookie: granted.cookie })).status,
    403
  );
  assert.equal((await app.req('DELETE', `/api/analytics/deleted-servers/${D}`, { cookie: admin })).status, 200);
  assert.equal((await app.req('DELETE', `/api/analytics/deleted-servers/${D}`, { cookie: admin })).status, 404);
  assert.deepEqual(ids((await get(admin, '/servers?deleted=1')).json.servers), [A, B]);
  assert.equal(db.get('SELECT COUNT(*) n FROM player_sessions WHERE server_id = ?', D).n, 0);
});

test('sweepPeak does not overlap back-to-back intervals', () => {
  assert.deepEqual(analytics.sweepPeak([]), { peak: 0, peakAt: null });
  assert.equal(
    analytics.sweepPeak([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]).peak,
    1
  );
  const r = analytics.sweepPeak([
    { start: 0, end: 10 },
    { start: 5, end: 15 },
  ]);
  assert.deepEqual(r, { peak: 2, peakAt: 5 });
});

test('bucketMax takes the maximum concurrency inside each bucket', () => {
  const v = analytics.bucketMax(
    [
      { start: 0, end: 25 },
      { start: 12, end: 14 },
    ],
    0,
    10,
    4
  );
  assert.deepEqual(v, [1, 2, 1, 0]);
});

test('chooseBucketMs follows the range and caps the bucket count', () => {
  const day = 86_400_000;
  assert.equal(analytics.chooseBucketMs('7d', 7 * day), 3_600_000);
  assert.equal(analytics.chooseBucketMs('all', 100 * day), day);
  assert.equal(analytics.chooseBucketMs('all', 800 * day), 7 * day);
  assert.ok((3000 * day) / analytics.chooseBucketMs('all', 3000 * day) <= 1000);
});

test('gameplay totals and per-session stats appear in player and server detail', async () => {
  db.run(
    "UPDATE player_sessions SET stats_state = 'ok', stats_json = ? WHERE server_id = ? AND player = 'Alice'",
    '{"deaths":2}',
    A
  );
  db.run(
    "UPDATE player_sessions SET stats_state = 'ok', stats_json = ? WHERE server_id = ? AND player = 'Alicia'",
    '{"deaths":1,"jumps":10}',
    A
  );
  rollup.rebuildDaily();
  for (const range of ['7d', '30d']) {
    const r = (await get(admin, `/players/${U1}?range=${range}`)).json;
    assert.deepEqual(r.gameplay, { deaths: 3, jumps: 10 }, range);
    assert.deepEqual(r.servers.find((s) => s.id === A).gameplay, { deaths: 3, jumps: 10 }, range);
    assert.deepEqual(r.servers.find((s) => s.id === B).gameplay, {}, range);
    const rec = r.recentSessions.find((s) => s.serverId === A && s.stats && s.stats.jumps);
    assert.equal(rec.statsState, 'ok');
    assert.ok(r.recentSessions.some((s) => s.stats === null && s.statsState === null));
    const sd = (await get(admin, `/servers/${A}?range=${range}`)).json;
    assert.deepEqual(sd.players.find((p) => p.key === U1).gameplay, { deaths: 3, jumps: 10 }, range);
    assert.deepEqual(sd.players.find((p) => p.name === 'Bob').gameplay, {}, range);
  }
});
