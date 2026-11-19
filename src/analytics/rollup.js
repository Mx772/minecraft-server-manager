'use strict';

// Daily play-time rollup: folds player_sessions into player_daily (one row per
// server, player and UTC day) so totals survive session history and are cheap
// to query. Rebuilds are idempotent: a rebuild deletes the affected days and
// recomputes them from sessions.

const path = require('node:path');
const db = require('../db');
const { playerKey, resolveSessionUuids } = require('./identity');
const { sumStats } = require('./sessionStats');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { makeFailureThrottle } = require('../logger');

const DAY_MS = 86_400_000;
const PAGE = 5000;
const HOURLY_MS = 60 * 60_000;

const throttle = makeFailureThrottle();
let timer = null;
let lastTodayRefresh = 0;

/** @param {number} ms */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Rebuild player_daily from sessions.
 * @param {{ fromDay?: string, serverIds?: string[] }} [opts] fromDay is YYYY-MM-DD (UTC); omit for everything
 * @returns {{ rows: number }}
 */
function rebuildDaily({ fromDay, serverIds } = {}) {
  const now = Date.now();
  const fromMs = fromDay ? Date.parse(`${fromDay}T00:00:00Z`) : -Infinity;
  if (fromDay && Number.isNaN(fromMs)) throw new TypeError('fromDay must be a YYYY-MM-DD date.');
  const scoped = Array.isArray(serverIds) && serverIds.length > 0;
  const scopeSql = scoped ? ` AND server_id IN (${serverIds.map(() => '?').join(',')})` : '';
  const scopeArgs = scoped ? serverIds : [];

  return db.transaction(() => {
    /** @type {Map<string, {serverId: string, key: string, uuid: string|null, name: string, nameAt: string, secs: number, sessions: number, stats: string[]}>} */
    const acc = new Map();
    const bump = (serverId, key, uuid, name, startedAt, day, secs, sessions, stats = null) => {
      const id = `${serverId}\0${key}\0${day}`;
      let row = acc.get(id);
      if (!row) {
        row = { serverId, key, uuid, name, nameAt: startedAt, secs: 0, sessions: 0, stats: [] };
        acc.set(id, row);
      }
      row.secs += secs;
      row.sessions += sessions;
      if (stats) row.stats.push(stats);
      if (startedAt >= row.nameAt) {
        row.name = name;
        row.nameAt = startedAt;
      }
      if (uuid && !row.uuid) row.uuid = uuid;
    };

    // Only sessions that can touch [fromDay, now]: still open, or ended on/after it.
    const fromIso = Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : '';
    let lastId = 0;
    for (;;) {
      const page = db.all(
        `SELECT id, server_id, player, player_uuid, started_at, ended_at, stats_json FROM player_sessions
          WHERE id > ? AND (ended_at IS NULL OR ended_at >= ?)${scopeSql}
          ORDER BY id LIMIT ${PAGE}`,
        lastId,
        fromIso,
        ...scopeArgs
      );
      for (const s of page) {
        lastId = s.id;
        const start = Date.parse(s.started_at);
        const end = s.ended_at ? Date.parse(s.ended_at) : now;
        if (Number.isNaN(start) || Number.isNaN(end) || end < start || start > now) continue;
        const key = playerKey(s.player_uuid, s.player);
        const clipEnd = Math.min(end, now);
        // Split across UTC midnights; only days at or after fromDay are written.
        let cursor = Math.max(start, fromMs);
        const startDay = dayOf(start);
        // Gameplay stats belong to the day the session started.
        if (start >= fromMs)
          bump(s.server_id, key, s.player_uuid, s.player, s.started_at, startDay, 0, 1, s.stats_json);
        while (cursor < clipEnd) {
          const nextMidnight = Math.floor(cursor / DAY_MS) * DAY_MS + DAY_MS;
          const segEnd = Math.min(clipEnd, nextMidnight);
          // Exact seconds here; rounded once per row so split sessions do not drift.
          const secs = (segEnd - cursor) / 1000;
          bump(s.server_id, key, s.player_uuid, s.player, s.started_at, dayOf(cursor), secs, 0);
          cursor = segEnd;
        }
      }
      if (page.length < PAGE) break;
    }

    db.run(`DELETE FROM player_daily WHERE day >= ?${scopeSql}`, fromDay || '', ...scopeArgs);
    for (const [id, r] of acc) {
      db.run(
        `INSERT INTO player_daily (server_id, player_key, player_uuid, player_name, day, play_seconds, sessions, stats_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, player_key, day) DO UPDATE SET
           player_uuid = excluded.player_uuid, player_name = excluded.player_name,
           play_seconds = excluded.play_seconds, sessions = excluded.sessions,
           stats_json = excluded.stats_json`,
        r.serverId,
        r.key,
        r.uuid,
        r.name,
        id.slice(id.lastIndexOf('\0') + 1),
        Math.round(r.secs),
        r.sessions,
        r.stats.length ? JSON.stringify(sumStats(r.stats)) : null
      );
    }
    return { rows: acc.size };
  });
}

/** Fill in session UUIDs from each live server's usercache, then rebuild recent days. */
async function refreshRecent() {
  const servers = db.all(
    'SELECT DISTINCT s.id FROM servers s JOIN player_sessions p ON p.server_id = s.id WHERE s.deleted_at IS NULL'
  );
  let earliest = null;
  for (const { id } of servers) {
    const first = await resolveSessionUuids(id);
    if (first && (!earliest || first < earliest)) earliest = first;
  }
  const yesterday = dayOf(Date.now() - DAY_MS);
  const from = earliest && earliest.slice(0, 10) < yesterday ? earliest.slice(0, 10) : yesterday;
  rebuildDaily({ fromDay: from });
  lastTodayRefresh = Date.now();
}

/** Full rebuild when the rollup is empty but sessions exist (first run after upgrade). */
function ensureBackfilled() {
  const hasDaily = db.get('SELECT 1 AS x FROM player_daily LIMIT 1');
  const hasSessions = db.get('SELECT 1 AS x FROM player_sessions LIMIT 1');
  if (!hasDaily && hasSessions) {
    const { rows } = rebuildDaily();
    logger.info('Backfilled the daily play-time rollup.', { rows });
    return true;
  }
  return false;
}

/** Rebuild just today when the last refresh is older than maxAgeMs. */
function refreshTodayIfStale(maxAgeMs = 5 * 60_000) {
  if (Date.now() - lastTodayRefresh < maxAgeMs) return false;
  rebuildDaily({ fromDay: dayOf(Date.now()) });
  lastTodayRefresh = Date.now();
  return true;
}

/** Backfill on boot, then refresh recent days every hour. */
function startRollup() {
  const onFail = (err) =>
    throttle.fail(logger.warn, 'The daily rollup failed.', { err: serializeError(err, { includeStack: false }) });
  const tick = () => refreshRecent().then(() => throttle.ok(logger.info, 'The daily rollup recovered.'), onFail);
  Promise.resolve()
    .then(() => ensureBackfilled())
    .then(tick, onFail);
  if (timer) clearInterval(timer);
  timer = setInterval(tick, HOURLY_MS);
  if (timer.unref) timer.unref();
}

function stopRollup() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { rebuildDaily, refreshRecent, ensureBackfilled, refreshTodayIfStale, startRollup, stopRollup };
