'use strict';

// Attributes gameplay stat deltas to finished play sessions by comparing the
// stat snapshots taken just before a session started and just after it ended.

const path = require('node:path');
const db = require('../db');
const logger = require('../logger')(path.basename(__filename));

const SETTLE_MS = 6 * 60_000; // wait for the post-session snapshot (5 min cadence)
const AFTER_WINDOW_MS = 2 * 3_600_000;

/**
 * Number-only delta of two curated stat objects, zero keys dropped.
 * Returns null when any key went backwards (a world reset).
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 * @returns {Record<string, number>|null}
 */
function statDelta(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const prev = typeof before[k] === 'number' ? before[k] : 0;
    const d = v - prev;
    if (d < 0) return null;
    if (d > 0) out[k] = d;
  }
  for (const [k, v] of Object.entries(before)) {
    if (!(k in after) && typeof v === 'number' && v > 0) return null; // key vanished: reset
  }
  return out;
}

function parse(json) {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Resolve stats_state for a server's closed, UUID-known sessions that are still pending.
 * @param {string} serverId
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: number, unavailable: number, pending: number }}
 */
function attributeSessionStats(serverId, { now = Date.now() } = {}) {
  const cutoff = new Date(now - SETTLE_MS).toISOString();
  const sessions = db.all(
    `SELECT id, player_uuid, started_at, ended_at FROM player_sessions
      WHERE server_id = ? AND player_uuid IS NOT NULL AND stats_state IS NULL
        AND ended_at IS NOT NULL AND ended_at <= ? ORDER BY ended_at`,
    serverId,
    cutoff
  );
  const result = { ok: 0, unavailable: 0, pending: 0 };
  if (!sessions.length) return result;

  // One query per server: every snapshot for the involved players, then bisect in JS.
  const uuids = [...new Set(sessions.map((s) => s.player_uuid))];
  const snaps = new Map(); // uuid -> [{ ts, stats }] ascending
  const earliest = new Map(); // uuid -> earliest session started_at on this server
  const marks = uuids.map(() => '?').join(',');
  for (const r of db.all(
    `SELECT uuid, ts, stats_json FROM player_stat_snapshots
      WHERE server_id = ? AND uuid IN (${marks}) ORDER BY ts, id`,
    serverId,
    ...uuids
  )) {
    if (!snaps.has(r.uuid)) snaps.set(r.uuid, []);
    snaps.get(r.uuid).push({ ts: r.ts, json: r.stats_json });
  }
  for (const r of db.all(
    `SELECT player_uuid, MIN(started_at) AS first FROM player_sessions
      WHERE server_id = ? AND player_uuid IN (${marks}) GROUP BY player_uuid`,
    serverId,
    ...uuids
  )) {
    earliest.set(r.player_uuid, r.first);
  }

  const resolve = (id, state, delta) => {
    db.run(
      'UPDATE player_sessions SET stats_state = ?, stats_json = ? WHERE id = ?',
      state,
      delta ? JSON.stringify(delta) : null,
      id
    );
    result[state === 'ok' ? 'ok' : 'unavailable'] += 1;
  };

  db.transaction(() => {
    for (const s of sessions) {
      const list = snaps.get(s.player_uuid) || [];
      const endMs = Date.parse(s.ended_at);
      const afterLimit = new Date(endMs + AFTER_WINDOW_MS).toISOString();
      const after = list.find((x) => x.ts >= s.ended_at && x.ts <= afterLimit);
      if (!after) {
        if (now - endMs > AFTER_WINDOW_MS) resolve(s.id, 'unavailable', null);
        else result.pending += 1;
        continue;
      }
      let before = null;
      for (const x of list) {
        if (x.ts <= s.started_at) before = x;
        else break;
      }
      let baseline;
      if (before) baseline = parse(before.json);
      else if (earliest.get(s.player_uuid) === s.started_at) baseline = {};
      else {
        resolve(s.id, 'unavailable', null);
        continue;
      }
      const delta = statDelta(baseline, parse(after.json));
      if (delta === null) resolve(s.id, 'unavailable', null);
      else resolve(s.id, 'ok', delta);
    }
  });
  if (result.ok || result.unavailable) logger.debug('Attributed session stats.', { serverId, ...result });
  return result;
}

/** Sum a list of stat-delta JSON strings (or objects) into one object. */
function sumStats(list) {
  const out = {};
  for (const item of list) {
    if (!item) continue;
    const obj = typeof item === 'string' ? parse(item) : item;
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') out[k] = (out[k] || 0) + v;
  }
  return out;
}

module.exports = { attributeSessionStats, statDelta, sumStats };
