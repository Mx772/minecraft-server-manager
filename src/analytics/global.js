'use strict';

// Global (cross-server) analytics: read-only queries over player_sessions and
// the player_daily rollup, scoped to the servers a user may see. All SQL for
// /api/analytics lives here; the route only parses input and shapes responses.
//
// Data source rule (one place, `playStats`): ranges 24h and 7d are computed from
// sessions (clipped to the window); 30d, 90d and all come from player_daily.
// Peak-online and the online series always come from sessions (sweep line).

const db = require('../db');
const httpError = require('../utils/httpError');
const permissions = require('../services/permissions');
const settings = require('../services/settings');
const rollup = require('./rollup');
const { playerKey } = require('./identity');
const { sumStats } = require('./sessionStats');

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_BUCKETS = 1000;
const RANGES = ['24h', '7d', '30d', '90d', 'all'];
const RANGE_MS = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };
const SESSION_RANGES = new Set(['24h', '7d']);
const BUCKET_MS = { '24h': 15 * 60_000, '7d': HOUR_MS, '30d': 6 * HOUR_MS, '90d': DAY_MS };

// Must match identity.playerKey.
const KEY_SQL = "COALESCE(lower(player_uuid), 'name:' || lower(player))";

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const placeholders = (list) => list.map(() => '?').join(',');
const uuidOfKey = (key) => (key.startsWith('name:') ? null : key);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

const STEP_MS = 15 * 60_000;

/**
 * Build a fast UTC-ms -> local { day, hour } mapper for an IANA time zone.
 * day 0 = Monday. The zone's UTC offset is looked up once per UTC hour (via Intl)
 * and memoized, so a long walk in 15-minute steps never calls Intl per step.
 * Offsets only change on hour boundaries, so DST and half-hour zones both hold.
 * @param {string} timeZone
 * @returns {(ms: number) => { day: number, hour: number }}
 */
function makeLocalizer(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  /** @type {Map<number, number>} */
  const offsets = new Map();
  const offsetAt = (hourIdx) => {
    let off = offsets.get(hourIdx);
    if (off === undefined) {
      const t = hourIdx * HOUR_MS;
      /** @type {Record<string, number>} */
      const p = {};
      for (const part of fmt.formatToParts(t)) if (part.type !== 'literal') p[part.type] = Number(part.value);
      off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
      offsets.set(hourIdx, off);
    }
    return off;
  };
  return (ms) => {
    const local = ms + offsetAt(Math.floor(ms / HOUR_MS));
    const dayIdx = Math.floor(local / DAY_MS);
    return { day: (((dayIdx + 3) % 7) + 7) % 7, hour: Math.floor((local - dayIdx * DAY_MS) / HOUR_MS) };
  };
}

/**
 * Seconds inside each of the 7x24 local weekday-hour slots, clipped to [from, to],
 * walking in 15-minute UTC-aligned steps (first and last step clipped).
 * @param {{ start: number, end: number }[]} intervals
 * @returns {number[]} 168 entries, index day * 24 + hour
 */
function slotSecondsFor(intervals, from, to, localize) {
  const out = new Array(168).fill(0);
  for (const iv of intervals) {
    const a = Math.max(iv.start, from);
    const b = Math.min(iv.end, to);
    for (let t = Math.floor(a / STEP_MS) * STEP_MS; t < b; t += STEP_MS) {
      const ms = Math.min(b, t + STEP_MS) - Math.max(a, t);
      if (ms <= 0) continue;
      const { day, hour } = localize(Math.max(a, t));
      out[day * 24 + hour] += ms / 1000;
    }
  }
  return out;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Normalize player-seconds per slot by how long each weekday-hour occurs in the window.
 * @param {number[]} playerSecs 168 entries
 * @param {number[]} slotSecs 168 entries
 */
function normalizeActivity(playerSecs, slotSecs) {
  const cells = [];
  let max = 0;
  let peakCell = null;
  for (let d = 0; d < 7; d++) {
    const row = [];
    for (let h = 0; h < 24; h++) {
      const i = d * 24 + h;
      const v = slotSecs[i] > 0 ? round3(playerSecs[i] / slotSecs[i]) : 0;
      row.push(v);
      if (v > max) {
        max = v;
        peakCell = { day: d, hour: h, value: v };
      }
    }
    cells.push(row);
  }
  const hours = [];
  for (let h = 0; h < 24; h++) {
    let ps = 0;
    let ss = 0;
    for (let d = 0; d < 7; d++) {
      ps += playerSecs[d * 24 + h];
      ss += slotSecs[d * 24 + h];
    }
    hours.push(ss > 0 ? round3(ps / ss) : 0);
  }
  return { cells, max, peakCell, hours };
}

/**
 * Peak concurrency of [start, end] ms intervals.
 * @param {{ start: number, end: number }[]} intervals
 * @returns {{ peak: number, peakAt: number|null }}
 */
function sweepPeak(intervals) {
  const events = [];
  for (const i of intervals) {
    events.push([i.start, 1], [i.end, -1]);
  }
  // Ends sort before starts at the same instant so back-to-back sessions don't overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  let peakAt = null;
  for (const [t, d] of events) {
    cur += d;
    if (cur > peak) {
      peak = cur;
      peakAt = t;
    }
  }
  return { peak, peakAt };
}

/**
 * Maximum concurrent intervals inside each bucket [start + i*bucketMs, +bucketMs).
 * @param {{ start: number, end: number }[]} intervals
 * @param {number} start
 * @param {number} bucketMs
 * @param {number} count
 * @returns {number[]}
 */
function bucketMax(intervals, start, bucketMs, count) {
  const events = [];
  for (const i of intervals) events.push([i.start, 1], [i.end, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let cur = 0;
  let e = 0;
  for (let b = 0; b < count; b++) {
    const bs = start + b * bucketMs;
    const be = bs + bucketMs;
    while (e < events.length && events[e][0] <= bs) cur += events[e++][1];
    let max = cur;
    while (e < events.length && events[e][0] < be) {
      cur += events[e++][1];
      if (cur > max) max = cur;
    }
    out.push(max);
  }
  return out;
}

/**
 * Pick the bucket size for a range, grown so the bucket count stays near MAX_BUCKETS.
 * @param {string} range
 * @param {number} spanMs window length (used for 'all')
 */
function chooseBucketMs(range, spanMs) {
  let ms = BUCKET_MS[range] || (spanMs <= 400 * DAY_MS ? DAY_MS : 7 * DAY_MS);
  if (spanMs / ms > MAX_BUCKETS) ms = Math.ceil(spanMs / MAX_BUCKETS / ms) * ms;
  return ms;
}

// ---------------------------------------------------------------------------
// Scope

/**
 * @typedef {{ id: string, name: string, icon: string|null, accent: string|null, type: string|null, deleted: boolean, deletedAt?: string }} ServerMeta
 */

/**
 * The servers a user may see analytics for.
 * @param {{ id: string, role: string }} user
 * @param {{ servers?: string[], deleted?: boolean }} [opts]
 * @returns {{ ids: string[], meta: Map<string, ServerMeta> }}
 */
function scope(user, { servers, deleted = false } = {}) {
  /** @type {Map<string, ServerMeta>} */
  const meta = new Map();
  const visible = permissions.visibleServerIds(user);
  for (const r of db.all(
    'SELECT id, display_name, icon, accent, type FROM servers WHERE deleted_at IS NULL ORDER BY display_name COLLATE NOCASE'
  )) {
    if (visible.has(r.id)) {
      meta.set(r.id, { id: r.id, name: r.display_name, icon: r.icon, accent: r.accent, type: r.type, deleted: false });
    }
  }
  if (deleted) {
    for (const m of deletedMeta(user)) meta.set(m.id, m);
  }
  if (servers && servers.length) {
    const wanted = new Set(servers);
    for (const id of [...meta.keys()]) if (!wanted.has(id)) meta.delete(id);
  }
  return { ids: [...meta.keys()], meta };
}

/** Deleted-with-kept-stats servers this user may see (admins: all). */
function deletedMeta(user, onlyId) {
  const isAdmin = user.role === 'admin';
  const rows = isAdmin
    ? db.all(
        'SELECT * FROM deleted_servers' + (onlyId ? ' WHERE id = ?' : ' ORDER BY display_name COLLATE NOCASE'),
        ...(onlyId ? [onlyId] : [])
      )
    : db.all(
        `SELECT d.* FROM deleted_servers d
           JOIN deleted_server_viewers v ON v.server_id = d.id AND v.user_id = ?
          ${onlyId ? 'WHERE d.id = ?' : ''} ORDER BY d.display_name COLLATE NOCASE`,
        user.id,
        ...(onlyId ? [onlyId] : [])
      );
  return rows.map((r) => ({
    id: r.id,
    name: r.display_name,
    icon: r.icon,
    accent: r.accent,
    type: r.type,
    deleted: true,
    deletedAt: r.deleted_at,
  }));
}

/** Meta for one server the user may see (live, or deleted with kept stats), else null. */
function visibleMeta(user, id) {
  const live = db.get(
    'SELECT id, display_name, icon, accent, type FROM servers WHERE id = ? AND deleted_at IS NULL',
    id
  );
  if (live) {
    if (!permissions.visibleServerIds(user).has(id)) return null;
    return { id, name: live.display_name, icon: live.icon, accent: live.accent, type: live.type, deleted: false };
  }
  return deletedMeta(user, id)[0] || null;
}

/** True for live servers the user may view and deleted ones they may still see. */
function canSeeServer(user, id) {
  return visibleMeta(user, id) !== null;
}

// ---------------------------------------------------------------------------
// Data access

/** Window start in ms (null = all time) for a range. */
function rangeFrom(range, now) {
  return RANGE_MS[range] ? now - RANGE_MS[range] : null;
}

/** First UTC day (YYYY-MM-DD) covered by a daily-sourced range; '' = all time. */
function rangeStartDay(range, now) {
  if (!RANGE_MS[range]) return '';
  return dayOf(now - (RANGE_MS[range] / DAY_MS - 1) * DAY_MS);
}

/**
 * Sessions overlapping [fromMs, now] with parsed bounds (open sessions end at now).
 * @returns {{ serverId: string, key: string, uuid: string|null, name: string, start: number, end: number, startedAt: string }[]}
 */
function loadSessions(ids, fromMs, now, key) {
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT server_id, player, player_uuid, started_at, ended_at FROM player_sessions
      WHERE server_id IN (${placeholders(ids)}) AND started_at <= ?
        AND (ended_at IS NULL OR ended_at >= ?)${key ? ` AND ${KEY_SQL} = ?` : ''}`,
    ...ids,
    new Date(now).toISOString(),
    fromMs === null ? '' : new Date(fromMs).toISOString(),
    ...(key ? [key] : [])
  );
  const out = [];
  for (const r of rows) {
    const start = Date.parse(r.started_at);
    const end = r.ended_at ? Date.parse(r.ended_at) : now;
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
    const k = playerKey(r.player_uuid, r.player);
    out.push({
      serverId: r.server_id,
      key: k,
      uuid: uuidOfKey(k),
      name: r.player,
      start,
      end,
      startedAt: r.started_at,
    });
  }
  return out;
}

/**
 * Per (server, player) play time and session counts for a range. This is the
 * single place that decides sessions vs the daily rollup.
 * @returns {{ serverId: string, key: string, uuid: string|null, name: string, nameAt: string, secs: number, sessions: number }[]}
 */
function playStats(ids, range, now, key) {
  if (!ids.length) return [];
  if (SESSION_RANGES.has(range)) {
    const from = rangeFrom(range, now);
    const acc = new Map();
    for (const s of loadSessions(ids, from, now, key)) {
      const ms = Math.min(s.end, now) - Math.max(s.start, from);
      const id = `${s.serverId}\0${s.key}`;
      let e = acc.get(id);
      if (!e) {
        e = { serverId: s.serverId, key: s.key, uuid: s.uuid, name: s.name, nameAt: s.startedAt, ms: 0, sessions: 0 };
        acc.set(id, e);
      }
      if (ms > 0) e.ms += ms;
      if (s.start >= from) e.sessions += 1;
      if (s.startedAt >= e.nameAt) {
        e.name = s.name;
        e.nameAt = s.startedAt;
      }
    }
    return [...acc.values()]
      .filter((e) => e.ms > 0 || e.sessions > 0)
      .map((e) => ({
        serverId: e.serverId,
        key: e.key,
        uuid: e.uuid,
        name: e.name,
        nameAt: e.nameAt,
        secs: Math.round(e.ms / 1000),
        sessions: e.sessions,
      }));
  }
  rollup.refreshTodayIfStale();
  // One MAX() aggregate, so SQLite returns player_name from the newest day's row.
  return db
    .all(
      `SELECT server_id, player_key, player_name, MAX(day) AS last_day, SUM(play_seconds) AS secs, SUM(sessions) AS sessions
         FROM player_daily
        WHERE server_id IN (${placeholders(ids)}) AND day >= ?${key ? ' AND player_key = ?' : ''}
        GROUP BY server_id, player_key`,
      ...ids,
      rangeStartDay(range, now),
      ...(key ? [key] : [])
    )
    .map((r) => ({
      serverId: r.server_id,
      key: r.player_key,
      uuid: uuidOfKey(r.player_key),
      name: r.player_name,
      nameAt: r.last_day,
      secs: Number(r.secs),
      sessions: Number(r.sessions),
    }));
}

/** All-time first/last activity per (server, player). Map key `${serverId}\0${key}`. */
function seenStats(ids, now, key) {
  const out = new Map();
  if (!ids.length) return out;
  for (const r of db.all(
    `SELECT server_id, ${KEY_SQL} AS k, MIN(started_at) AS first_at, MAX(COALESCE(ended_at, ?)) AS last_at,
            MAX(ended_at IS NULL) AS open
       FROM player_sessions
      WHERE server_id IN (${placeholders(ids)})${key ? ` AND ${KEY_SQL} = ?` : ''}
      GROUP BY server_id, k`,
    new Date(now).toISOString(),
    ...ids,
    ...(key ? [key] : [])
  )) {
    out.set(`${r.server_id}\0${r.k}`, {
      serverId: r.server_id,
      key: r.k,
      firstSeen: r.first_at,
      lastSeen: r.last_at,
      online: Boolean(r.open),
    });
  }
  return out;
}

/**
 * Gameplay stat totals per (server, player) for a range. Session ranges sum the
 * sessions' own deltas (sessions that started in the window); longer ranges sum
 * the daily rollup. Map key `${serverId}\0${key}`, value `{ statKey: total }`.
 */
function gameplayStats(ids, range, now, key) {
  const lists = new Map();
  const push = (serverId, k, json) => {
    const id = `${serverId}\0${k}`;
    if (!lists.has(id)) lists.set(id, []);
    lists.get(id).push(json);
  };
  if (ids.length && SESSION_RANGES.has(range)) {
    const from = new Date(rangeFrom(range, now)).toISOString();
    for (const r of db.all(
      `SELECT server_id, player, player_uuid, stats_json FROM player_sessions
        WHERE server_id IN (${placeholders(ids)}) AND started_at >= ? AND stats_json IS NOT NULL${
          key ? ` AND ${KEY_SQL} = ?` : ''
        }`,
      ...ids,
      from,
      ...(key ? [key] : [])
    )) {
      push(r.server_id, playerKey(r.player_uuid, r.player), r.stats_json);
    }
  } else if (ids.length) {
    rollup.refreshTodayIfStale();
    for (const r of db.all(
      `SELECT server_id, player_key, stats_json FROM player_daily
        WHERE server_id IN (${placeholders(ids)}) AND day >= ? AND stats_json IS NOT NULL${
          key ? ' AND player_key = ?' : ''
        }`,
      ...ids,
      rangeStartDay(range, now),
      ...(key ? [key] : [])
    )) {
      push(r.server_id, r.player_key, r.stats_json);
    }
  }
  return new Map([...lists].map(([id, list]) => [id, sumStats(list)]));
}

/**
 * Collapse per-server entries to one record per player, newest name wins. The
 * all-time last-seen time breaks ties the day-level rollup can't.
 */
function groupByPlayer(entries, seen) {
  const byKey = new Map();
  for (const e of entries) {
    let p = byKey.get(e.key);
    if (!p) {
      p = {
        key: e.key,
        uuid: e.uuid,
        name: e.name,
        nameAt: '',
        playSeconds: 0,
        sessions: 0,
        serverIds: new Set(),
      };
      byKey.set(e.key, p);
    }
    p.playSeconds += e.secs;
    p.sessions += e.sessions;
    p.serverIds.add(e.serverId);
    const at = (seen && seen.get(`${e.serverId}\0${e.key}`)?.lastSeen) || e.nameAt;
    if (at >= p.nameAt) {
      p.name = e.name;
      p.nameAt = at;
    }
  }
  return byKey;
}

const maxStr = (a, b) => (a && a > b ? a : b);

function normRange(range) {
  return RANGES.includes(range) ? range : '30d';
}

// ---------------------------------------------------------------------------
// Public queries

/**
 * @param {{ id: string, role: string }} user
 * @param {{ servers?: string[], deleted?: boolean, range?: string }} opts
 */
function summary(user, opts = {}) {
  const range = normRange(opts.range);
  const { ids, meta } = scope(user, opts);
  const now = Date.now();
  const empty = {
    playSeconds: 0,
    uniquePlayers: 0,
    sessions: 0,
    peakOnline: 0,
    peakAt: null,
    busiestServer: null,
    serverCount: ids.length,
  };
  if (!ids.length) return empty;
  const entries = playStats(ids, range, now);
  const perServer = new Map();
  const players = new Set();
  let playSeconds = 0;
  let sessions = 0;
  for (const e of entries) {
    playSeconds += e.secs;
    sessions += e.sessions;
    players.add(e.key);
    perServer.set(e.serverId, (perServer.get(e.serverId) || 0) + e.secs);
  }
  let busiest = null;
  for (const [id, secs] of perServer) {
    if (secs > 0 && (!busiest || secs > busiest.playSeconds))
      busiest = { id, name: meta.get(id).name, playSeconds: secs };
  }
  const from = rangeFrom(range, now);
  const clipped = loadSessions(ids, from, now).map((s) => ({
    start: from === null ? s.start : Math.max(s.start, from),
    end: Math.min(s.end, now),
  }));
  const { peak, peakAt } = sweepPeak(clipped);
  return {
    playSeconds,
    uniquePlayers: players.size,
    sessions,
    peakOnline: peak,
    peakAt: peakAt === null ? null : new Date(peakAt).toISOString(),
    busiestServer: busiest,
    serverCount: ids.length,
  };
}

/**
 * Concurrent-players time series.
 * @returns {{ bucketMs: number, start: string, buckets: string[], series: { serverId: string|null, name: string, values: number[] }[] }}
 */
function onlineSeries(user, opts = {}) {
  const range = normRange(opts.range);
  const { ids, meta } = scope(user, opts);
  const now = Date.now();
  let from = rangeFrom(range, now);
  const sessions = loadSessions(ids, from, now);
  if (from === null) from = sessions.length ? Math.min(...sessions.map((s) => s.start)) : now - DAY_MS;
  const bucketMs = chooseBucketMs(range, now - from);
  const start = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(1, Math.ceil((now - start) / bucketMs));
  const clipped = sessions.map((s) => ({
    serverId: s.serverId,
    start: Math.max(s.start, start),
    end: Math.min(s.end, now),
  }));
  const buckets = Array.from({ length: count }, (_, i) => new Date(start + i * bucketMs).toISOString());
  let series;
  if (opts.split) {
    const by = new Map(ids.map((id) => [id, []]));
    for (const s of clipped) by.get(s.serverId).push(s);
    series = ids.map((id) => ({
      serverId: id,
      name: meta.get(id).name,
      values: bucketMax(by.get(id), start, bucketMs, count),
    }));
  } else {
    series = [{ serverId: null, name: 'All servers', values: bucketMax(clipped, start, bucketMs, count) }];
  }
  return { bucketMs, start: new Date(start).toISOString(), buckets, series };
}

/** One row per in-scope server (including idle ones). */
function serverRows(user, opts = {}) {
  const range = normRange(opts.range);
  const { ids, meta } = scope(user, opts);
  if (!ids.length) return [];
  const now = Date.now();
  const rows = new Map(
    ids.map((id) => [
      id,
      {
        ...meta.get(id),
        playSeconds: 0,
        players: 0,
        sessions: 0,
        peakOnline: 0,
        lastActive: null,
        online: false,
        tpsAvg: null,
      },
    ])
  );
  for (const e of playStats(ids, range, now)) {
    const r = rows.get(e.serverId);
    r.playSeconds += e.secs;
    r.sessions += e.sessions;
    r.players += 1;
  }
  const from = rangeFrom(range, now);
  const byServer = new Map(ids.map((id) => [id, []]));
  for (const s of loadSessions(ids, from, now)) {
    byServer
      .get(s.serverId)
      .push({ start: from === null ? s.start : Math.max(s.start, from), end: Math.min(s.end, now) });
  }
  for (const [id, list] of byServer) rows.get(id).peakOnline = sweepPeak(list).peak;
  for (const s of seenStats(ids, now).values()) {
    const r = rows.get(s.serverId);
    r.lastActive = maxStr(s.lastSeen, r.lastActive || '') || null;
    if (s.online) r.online = true;
  }
  for (const [id, tps] of avgTps(ids, range, now)) rows.get(id).tpsAvg = tps;
  const list = [...rows.values()];
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const sorters = {
    playtime: (a, b) => b.playSeconds - a.playSeconds || byName(a, b),
    players: (a, b) => b.players - a.players || byName(a, b),
    peak: (a, b) => b.peakOnline - a.peakOnline || byName(a, b),
    lastActive: (a, b) => (b.lastActive || '').localeCompare(a.lastActive || '') || byName(a, b),
    name: byName,
  };
  return list.sort(sorters[opts.sort] || sorters.playtime);
}

/** Per-player and per-day breakdown of one server. 404 unless the user may see it. */
/** @param {{ range?: string }} [opts] */
function serverDetail(user, id, opts = {}) {
  const r = normRange(opts.range);
  const server = visibleMeta(user, id);
  if (!server) throw httpError(404, 'That server was not found.');
  const now = Date.now();
  const seen = seenStats([id], now);
  const gameplay = gameplayStats([id], r, now);
  const players = [...groupByPlayer(playStats([id], r, now), seen).values()]
    .map((p) => ({
      key: p.key,
      uuid: p.uuid,
      name: p.name,
      playSeconds: p.playSeconds,
      sessions: p.sessions,
      gameplay: gameplay.get(`${id}\0${p.key}`) || {},
      lastSeen: seen.get(`${id}\0${p.key}`)?.lastSeen || null,
      online: Boolean(seen.get(`${id}\0${p.key}`)?.online),
    }))
    .sort((a, b) => b.playSeconds - a.playSeconds || a.name.localeCompare(b.name));
  rollup.refreshTodayIfStale();
  const daily = db
    .all(
      'SELECT day, SUM(play_seconds) AS secs FROM player_daily WHERE server_id = ? AND day >= ? GROUP BY day ORDER BY day',
      id,
      rangeStartDay(r, now)
    )
    .map((d) => ({ day: d.day, playSeconds: Number(d.secs) }));
  return { server, players, daily };
}

/** Paged, searchable player list across the scoped servers. */
function playerRows(user, opts = {}) {
  const range = normRange(opts.range);
  const { ids, meta } = scope(user, opts);
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(opts.limit)) || 50));
  const offset = Math.max(0, Math.trunc(Number(opts.cursor)) || 0);
  if (!ids.length) return { rows: [], total: 0, nextCursor: null };
  const now = Date.now();
  const seen = seenStats(ids, now);
  let players = [...groupByPlayer(playStats(ids, range, now), seen).values()];
  const q = String(opts.q || '')
    .trim()
    .toLowerCase();
  if (q) players = players.filter((p) => p.name.toLowerCase().includes(q) || p.key.startsWith(q));
  const lastSeenOf = (p) => {
    let last = '';
    for (const id of p.serverIds) last = maxStr(seen.get(`${id}\0${p.key}`)?.lastSeen, last);
    return last;
  };
  const onlineOf = (p) => [...p.serverIds].some((id) => seen.get(`${id}\0${p.key}`)?.online);
  const decorated = players.map((p) => ({ p, last: lastSeenOf(p), online: onlineOf(p) }));
  const byName = (a, b) => a.p.name.localeCompare(b.p.name, undefined, { sensitivity: 'base' });
  const sorters = {
    playtime: (a, b) => b.p.playSeconds - a.p.playSeconds || byName(a, b),
    lastSeen: (a, b) => b.last.localeCompare(a.last) || byName(a, b),
    name: byName,
    serverCount: (a, b) => b.p.serverIds.size - a.p.serverIds.size || b.p.playSeconds - a.p.playSeconds || byName(a, b),
  };
  decorated.sort(sorters[opts.sort] || sorters.playtime);
  const page = decorated.slice(offset, offset + limit).map(({ p, last, online }) => {
    let first = '';
    for (const id of p.serverIds) {
      const f = seen.get(`${id}\0${p.key}`)?.firstSeen;
      if (f && (!first || f < first)) first = f;
    }
    return {
      key: p.key,
      uuid: p.uuid,
      name: p.name,
      playSeconds: p.playSeconds,
      sessions: p.sessions,
      lastSeen: last || null,
      online,
      firstSeen: first || null,
      servers: [...p.serverIds].map((id) => ({ id, name: meta.get(id).name, deleted: meta.get(id).deleted })),
    };
  });
  const next = offset + limit;
  return { rows: page, total: decorated.length, nextCursor: next < decorated.length ? next : null };
}

/** One player across every server the user may see (deleted ones included). */
/** @param {{ range?: string }} [opts] */
function playerDetail(user, key, opts = {}) {
  const r = normRange(opts.range);
  const { ids, meta } = scope(user, { deleted: true });
  const now = Date.now();
  const seen = seenStats(ids, now, key);
  if (!seen.size) throw httpError(404, 'That player was not found.');
  const stats = new Map(playStats(ids, r, now, key).map((e) => [e.serverId, e]));
  const gameplay = gameplayStats(ids, r, now, key);
  const servers = [...seen.values()]
    .map((s) => ({
      id: s.serverId,
      name: meta.get(s.serverId).name,
      deleted: meta.get(s.serverId).deleted,
      playSeconds: stats.get(s.serverId)?.secs || 0,
      sessions: stats.get(s.serverId)?.sessions || 0,
      gameplay: gameplay.get(`${s.serverId}\0${key}`) || {},
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      online: s.online,
    }))
    .sort((a, b) => b.playSeconds - a.playSeconds || a.name.localeCompare(b.name));
  const recent = db.all(
    `SELECT server_id, player, started_at, ended_at, stats_json, stats_state FROM player_sessions
      WHERE server_id IN (${placeholders(ids)}) AND ${KEY_SQL} = ? ORDER BY started_at DESC LIMIT 20`,
    ...ids,
    key
  );
  rollup.refreshTodayIfStale();
  const days = new Map();
  for (const d of db.all(
    `SELECT day, server_id, SUM(play_seconds) AS secs FROM player_daily
      WHERE server_id IN (${placeholders(ids)}) AND player_key = ? AND day >= ? GROUP BY day, server_id ORDER BY day`,
    ...ids,
    key,
    rangeStartDay(r, now)
  )) {
    if (!days.has(d.day)) days.set(d.day, {});
    days.get(d.day)[d.server_id] = Number(d.secs);
  }
  return {
    player: { key, uuid: uuidOfKey(key), name: recent[0] ? recent[0].player : key.replace(/^name:/, '') },
    servers,
    gameplay: sumStats([...gameplay.values()]),
    daily: [...days].map(([day, byServer]) => ({ day, byServer })),
    recentSessions: recent.map((s) => ({
      serverId: s.server_id,
      serverName: meta.get(s.server_id).name,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      stats: s.stats_json ? JSON.parse(s.stats_json) : null,
      statsState: s.stats_state || null,
    })),
  };
}

/**
 * Average activity per weekday and hour, in the panel time zone. Computed from
 * sessions (open ones run to now), clipped to the window. Without `player` the
 * value is the average number of players online in that slot; with a player key
 * it is the share (0-1) of that slot they were online. Monday-first.
 * @param {{ id: string, role: string }} user
 * @param {{ servers?: string[], deleted?: boolean, range?: string, player?: string, now?: number }} [opts]
 */
function activityByHour(user, opts = {}) {
  const range = normRange(opts.range);
  const now = opts.now || Date.now();
  const timezone = settings.getTimezone();
  const { ids } = opts.player ? scope(user, { deleted: true }) : scope(user, opts);
  let from = rangeFrom(range, now);
  const sessions = loadSessions(ids, from, now, opts.player);
  if (from === null) from = sessions.length ? Math.min(...sessions.map((s) => s.start)) : now;
  const localize = makeLocalizer(timezone);
  const playerSecs = slotSecondsFor(
    sessions.map((s) => ({ start: s.start, end: s.end })),
    from,
    now,
    localize
  );
  const slotSecs = slotSecondsFor([{ start: from, end: now }], from, now, localize);
  return { timezone, weekStartsOn: 'monday', ...normalizeActivity(playerSecs, slotSecs) };
}

// ---------------------------------------------------------------------------
// Performance samples

const PERF_BUCKET_MS = { '24h': 5 * 60_000, '7d': HOUR_MS, '30d': 6 * HOUR_MS, '90d': DAY_MS, all: DAY_MS };
const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

/** Mean TPS per server over the range (null when no samples). Map serverId -> number. */
function avgTps(ids, range, now) {
  const out = new Map();
  if (!ids.length) return out;
  const from = rangeFrom(range, now);
  const rows = SESSION_RANGES.has(range)
    ? db.all(
        `SELECT server_id, AVG(tps) AS tps FROM server_samples
          WHERE server_id IN (${placeholders(ids)}) AND ts >= ? AND tps IS NOT NULL GROUP BY server_id`,
        ...ids,
        new Date(from).toISOString()
      )
    : db.all(
        `SELECT server_id, SUM(tps_avg * samples) / SUM(samples) AS tps FROM server_samples_hourly
          WHERE server_id IN (${placeholders(ids)}) AND hour >= ? AND tps_avg IS NOT NULL GROUP BY server_id`,
        ...ids,
        from === null ? '' : new Date(from).toISOString()
      );
  for (const r of rows) if (r.tps !== null) out.set(r.server_id, round2(Number(r.tps)));
  return out;
}

/**
 * Samples for one server as weighted rows: raw rows (weight 1) for 24h/7d; hourly
 * rows plus any raw rows not yet folded (the open hour) for longer ranges.
 * @returns {{ t: number, w: number, pAvg: number|null, pMax: number|null, tAvg: number|null, tMin: number|null, mAvg: number|null, mMax: number|null, memAvg: number|null, memMax: number|null, limit: number|null, cpu: number|null }[]}
 */
function loadSampleRows(id, range, now) {
  const from = rangeFrom(range, now);
  const fromIso = from === null ? '' : new Date(from).toISOString();
  const raw = (sinceIso) =>
    db
      .all(
        `SELECT ts, players_online, tps, mspt, mem_bytes, mem_limit_bytes, cpu_pct FROM server_samples
          WHERE server_id = ? AND ts >= ? ORDER BY ts`,
        id,
        sinceIso
      )
      .map((r) => ({
        t: Date.parse(r.ts),
        w: 1,
        pAvg: r.players_online,
        pMax: r.players_online,
        tAvg: r.tps,
        tMin: r.tps,
        mAvg: r.mspt,
        mMax: r.mspt,
        memAvg: r.mem_bytes,
        memMax: r.mem_bytes,
        limit: r.mem_limit_bytes,
        cpu: r.cpu_pct,
      }));
  if (SESSION_RANGES.has(range)) return raw(fromIso);
  const hourly = db
    .all(
      `SELECT hour, samples, players_avg, players_max, tps_avg, tps_min, mspt_avg, mem_avg, mem_max, cpu_avg, mem_limit
         FROM server_samples_hourly WHERE server_id = ? AND hour >= ? ORDER BY hour`,
      id,
      fromIso
    )
    .map((r) => ({
      t: Date.parse(r.hour),
      w: r.samples,
      pAvg: r.players_avg,
      pMax: r.players_max,
      tAvg: r.tps_avg,
      tMin: r.tps_min,
      mAvg: r.mspt_avg,
      mMax: r.mspt_avg,
      memAvg: r.mem_avg,
      memMax: r.mem_max,
      limit: r.mem_limit,
      cpu: r.cpu_avg,
    }));
  const last = db.get('SELECT MAX(hour) AS h FROM server_samples_hourly WHERE server_id = ?', id).h;
  const tail = last ? new Date(Date.parse(last) + HOUR_MS).toISOString() : fromIso;
  return hourly.concat(raw(tail > fromIso ? tail : fromIso));
}

/** Weighted mean of a field over rows, ignoring nulls (null when none). */
function wmean(rows, f) {
  let sum = 0;
  let w = 0;
  for (const r of rows) {
    if (r[f] === null || r[f] === undefined) continue;
    sum += r[f] * r.w;
    w += r.w;
  }
  return w ? sum / w : null;
}
function extreme(rows, f, fn) {
  let out = null;
  for (const r of rows) if (r[f] !== null && r[f] !== undefined) out = out === null ? r[f] : fn(out, r[f]);
  return out;
}

/**
 * Players, TPS, memory and CPU over time for one server. Empty buckets are
 * all-null so charts show gaps. 404 unless the user may see the server.
 * @param {{ id: string, role: string }} user
 * @param {string} id
 * @param {{ range?: string }} [opts]
 */
function performance(user, id, opts = {}) {
  const range = normRange(opts.range);
  if (!canSeeServer(user, id)) throw httpError(404, 'That server was not found.');
  const now = Date.now();
  const rows = loadSampleRows(id, range, now);
  let from = rangeFrom(range, now);
  if (from === null) from = rows.length ? rows[0].t : now - DAY_MS;
  let bucketMs = PERF_BUCKET_MS[range];
  if ((now - from) / bucketMs > MAX_BUCKETS) bucketMs = Math.ceil((now - from) / MAX_BUCKETS / bucketMs) * bucketMs;
  const start = Math.floor(from / bucketMs) * bucketMs;
  const count = Math.max(1, Math.ceil((now - start) / bucketMs));
  const groups = Array.from({ length: count }, () => []);
  for (const r of rows) {
    const i = Math.floor((r.t - start) / bucketMs);
    if (i >= 0 && i < count) groups[i].push(r);
  }
  const points = groups.map((g, i) => {
    const t = new Date(start + i * bucketMs).toISOString();
    if (!g.length) {
      return {
        t,
        playersAvg: null,
        playersMax: null,
        tpsAvg: null,
        tpsMin: null,
        msptAvg: null,
        memAvg: null,
        memMax: null,
        memLimit: null,
        cpuAvg: null,
      };
    }
    const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
    const m = (f) => wmean(g, f);
    return {
      t,
      playersAvg: r2(m('pAvg')),
      playersMax: extreme(g, 'pMax', Math.max),
      tpsAvg: r2(m('tAvg')),
      tpsMin: extreme(g, 'tMin', Math.min),
      msptAvg: r2(m('mAvg')),
      memAvg: m('memAvg') === null ? null : Math.round(m('memAvg')),
      memMax: extreme(g, 'memMax', Math.max),
      memLimit: extreme(g, 'limit', Math.max),
      cpuAvg: r2(m('cpu')),
    };
  });
  return {
    bucketMs,
    points,
    summary: {
      tpsAvg: round2(wmean(rows, 'tAvg')),
      tpsMin: extreme(rows, 'tMin', Math.min),
      playersMax: extreme(rows, 'pMax', Math.max),
      memMax: extreme(rows, 'memMax', Math.max),
    },
  };
}

module.exports = {
  performance,
  activityByHour,
  makeLocalizer,
  slotSecondsFor,
  normalizeActivity,
  RANGES,
  scope,
  canSeeServer,
  summary,
  onlineSeries,
  serverRows,
  serverDetail,
  playerRows,
  playerDetail,
  sweepPeak,
  bucketMax,
  chooseBucketMs,
};
