'use strict';

// activityByHour: the weekday x hour matrix (panel time zone, DST, half-hour
// offsets, normalization, player scoping) and its pure helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const settings = require('../src/services/settings');
const analytics = require('../src/analytics/global');

const ADMIN = { id: 'u_admin', role: 'admin' };
const U1 = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const U2 = '11111111-2222-3333-4444-555555555555';
const S = 'srv_hr_a';
const GONE = 'srv_hr_gone';
let admin;
let viewer;

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
const z = (s) => Date.parse(s);

test.before(async () => {
  await app.start();
  admin = await app.adminCookie();
  app.seedServer(S);
  db.run(
    "INSERT INTO deleted_servers (id, display_name, icon, accent, type, mc_version, deleted_at) VALUES (?, 'Gone', 'grass', '#3fa62b', 'PAPER', '1.21', '2026-01-01T00:00:00.000Z')",
    GONE
  );
  await require('../src/services/auth').createUser(
    { username: 'hr_viewer', password: 'passw0rd-12345', role: 'viewer' },
    { actor: 'test' }
  );
  viewer = db.get("SELECT id, role FROM users WHERE username = 'hr_viewer'");
});
test.after(async () => {
  settings.setTimezone('auto');
  await app.stop();
});
test.beforeEach(() => {
  db.run('DELETE FROM player_sessions');
});

test('makeLocalizer maps UTC to local weekday and hour across DST and half-hour zones', () => {
  const ny = analytics.makeLocalizer('America/New_York');
  assert.deepEqual(ny(z('2026-03-08T06:59:59Z')), { day: 6, hour: 1 }); // Sun 01:59 EST
  assert.deepEqual(ny(z('2026-03-08T07:00:00Z')), { day: 6, hour: 3 }); // Sun 03:00 EDT
  const kol = analytics.makeLocalizer('Asia/Kolkata');
  assert.deepEqual(kol(z('2026-01-05T18:15:00Z')), { day: 0, hour: 23 }); // Mon 23:45
  assert.deepEqual(kol(z('2026-01-05T18:30:00Z')), { day: 1, hour: 0 }); // Tue 00:00
});

test('slotSecondsFor splits an interval across midnight and clips the ends', () => {
  const loc = analytics.makeLocalizer('America/New_York');
  const out = analytics.slotSecondsFor(
    [{ start: z('2026-01-06T04:30:00Z'), end: z('2026-01-06T05:30:00Z') }],
    0,
    Date.now(),
    loc
  );
  assert.equal(out[0 * 24 + 23], 1800); // Mon 23:30 to midnight
  assert.equal(out[1 * 24 + 0], 1800);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    3600
  );
  const clipped = analytics.slotSecondsFor(
    [{ start: z('2026-01-06T04:00:00Z'), end: z('2026-01-06T06:00:00Z') }],
    z('2026-01-06T04:20:00Z'),
    z('2026-01-06T05:10:00Z'),
    loc
  );
  assert.equal(
    clipped.reduce((a, b) => a + b, 0),
    3000
  );
});

test('normalizeActivity divides by slot occurrences and reports the peak', () => {
  const ps = new Array(168).fill(0);
  const ss = new Array(168).fill(7200);
  ps[1 * 24 + 20] = 3600;
  const r = analytics.normalizeActivity(ps, ss);
  assert.equal(r.cells[1][20], 0.5);
  assert.equal(r.max, 0.5);
  assert.deepEqual(r.peakCell, { day: 1, hour: 20, value: 0.5 });
  assert.equal(r.hours[20], 0.071); // 3600 / (7 * 7200)
  assert.equal(r.cells.length, 7);
  assert.equal(r.cells[0].length, 24);
});

test('a session across the New York spring-forward gap lands in the right local hours', () => {
  settings.setTimezone('America/New_York');
  // Sun 01:30 EST to 03:30 EDT: there is no 02:00 hour that night.
  sess(S, 'Alice', U1, '2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z');
  const r = analytics.activityByHour(ADMIN, { range: '7d', now: z('2026-03-09T12:00:00Z') });
  assert.equal(r.timezone, 'America/New_York');
  assert.equal(r.weekStartsOn, 'monday');
  assert.equal(r.cells[6][1], 0.5);
  assert.equal(r.cells[6][2], 0);
  assert.equal(r.cells[6][3], 0.5);
});

test('half-hour offsets (Asia/Kolkata) bucket into local hours', () => {
  settings.setTimezone('Asia/Kolkata');
  sess(S, 'Alice', U1, '2026-01-05T18:00:00.000Z', '2026-01-05T19:00:00.000Z'); // Mon 23:30 to Tue 00:30
  const r = analytics.activityByHour(ADMIN, { range: '7d', now: z('2026-01-10T00:00:00Z') });
  assert.equal(r.cells[0][23], 0.5);
  assert.equal(r.cells[1][0], 0.5);
});

test('every Monday 20:00 hour online gives 1.0 for a player and for the server', () => {
  settings.setTimezone('UTC');
  for (const d of ['05', '12', '19', '26'])
    sess(S, 'Alice', U1, `2026-01-${d}T20:00:00.000Z`, `2026-01-${d}T21:00:00.000Z`);
  // Two players on the first Tuesday only: 2 * 1h over four Tuesday 08:00 hours.
  sess(S, 'Alice', U1, '2026-01-06T08:00:00.000Z', '2026-01-06T09:00:00.000Z');
  sess(S, 'Bob', null, '2026-01-06T08:00:00.000Z', '2026-01-06T09:00:00.000Z');
  const now = z('2026-01-31T00:00:00Z');
  const server = analytics.activityByHour(ADMIN, { range: '30d', now });
  assert.equal(server.cells[0][20], 1);
  assert.equal(server.cells[1][8], 0.5);
  assert.deepEqual(server.peakCell, { day: 0, hour: 20, value: 1 });
  const mine = analytics.activityByHour(ADMIN, { range: '30d', now, player: U1 });
  assert.equal(mine.cells[0][20], 1);
  assert.equal(mine.cells[1][8], 0.25);
  const bob = analytics.activityByHour(ADMIN, { range: '30d', now, player: 'name:bob' });
  assert.equal(bob.cells[0][20], 0);
  assert.equal(bob.cells[1][8], 0.25);
});

test('an empty range returns zeros and no peak', () => {
  const r = analytics.activityByHour(ADMIN, { range: 'all', now: z('2026-01-31T00:00:00Z') });
  assert.equal(r.max, 0);
  assert.equal(r.peakCell, null);
  assert.equal(r.hours.length, 24);
});

test('player scoping follows permission: unlisted users get nothing for a deleted server', () => {
  settings.setTimezone('UTC');
  sess(GONE, 'Carol', U2, '2026-01-05T20:00:00.000Z', '2026-01-05T21:00:00.000Z');
  const now = z('2026-01-10T00:00:00Z');
  assert.ok(analytics.activityByHour(ADMIN, { range: '30d', now, player: U2 }).max > 0);
  assert.equal(analytics.activityByHour(viewer, { range: '30d', now, player: U2 }).max, 0);
  assert.equal(analytics.activityByHour(viewer, { range: '30d', now, deleted: true, servers: [GONE] }).max, 0);
});

test('GET /api/analytics/hours returns the matrix and validates the player key', async () => {
  settings.setTimezone('UTC');
  const ok = await app.req('GET', '/api/analytics/hours?range=7d', { cookie: admin });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.cells.length, 7);
  assert.equal(ok.json.hours.length, 24);
  assert.ok('peakCell' in ok.json);
  const bad = await app.req('GET', '/api/analytics/hours?player=nope!', { cookie: admin });
  assert.equal(bad.status, 400);
  const keyed = await app.req('GET', `/api/analytics/hours?player=${U1}`, { cookie: admin });
  assert.equal(keyed.status, 200);
});
