'use strict';

// Minute samples of each live server's player count, tick performance and
// container usage, read from the in-memory live cache (no Docker or RCON calls
// of its own). Completed hours are folded into server_samples_hourly, and raw
// samples older than RAW_KEEP_DAYS are pruned once their hour is rolled up.

const path = require('node:path');
const db = require('../db');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { makeFailureThrottle } = require('../logger');

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const STALE_MS = 3 * MINUTE_MS; // a cached reading older than this is treated as unknown
const RAW_KEEP_DAYS = 30;

const sampleThrottle = makeFailureThrottle();
const foldThrottle = makeFailureThrottle();
let sampleTimer = null;
let foldTimer = null;

/** The live cache's per-server snapshots, keyed by server id. */
function defaultRead() {
  return require('../services/liveCache').getAll();
}

const fresh = (entry, now) => entry && (!entry.at || now - entry.at <= STALE_MS);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Record one sample per live server. `read` returns liveCache.getAll()-shaped data.
 * @param {{ read?: () => Record<string, any>, now?: number }} [opts]
 * @returns {number} rows inserted
 */
function sampleOnce({ read = defaultRead, now = Date.now() } = {}) {
  const ts = new Date(Math.floor(now / MINUTE_MS) * MINUTE_MS).toISOString();
  let inserted = 0;
  for (const [serverId, snap] of Object.entries(read() || {})) {
    const players = fresh(snap.players, now) ? num(snap.players && snap.players.online) : null;
    const perf = fresh(snap.perf, now) ? snap.perf : null;
    const stats = fresh(snap.stats, now) ? snap.stats : null;
    const tps = perf ? (num(perf.tps1) ?? num(perf.tps5)) : null;
    const mspt = perf ? num(perf.mspt) : null;
    const mem = stats ? num(stats.memUsedBytes) : null;
    const limit = stats ? num(stats.memLimitBytes) : null;
    const cpu = stats ? num(stats.cpuPct) : null;
    if ([players, tps, mspt, mem, cpu].every((v) => v === null)) continue;
    inserted += Number(
      db.run(
        `INSERT OR IGNORE INTO server_samples
           (server_id, ts, players_online, tps, mspt, mem_bytes, mem_limit_bytes, cpu_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        serverId,
        ts,
        players,
        tps,
        mspt,
        mem,
        limit,
        cpu
      ).changes
    );
  }
  return inserted;
}

/**
 * Fold completed hours of raw samples into server_samples_hourly (idempotent),
 * then prune raw samples older than 30 days whose hour is already rolled up.
 * @param {{ now?: number }} [opts]
 * @returns {{ folded: number, pruned: number }}
 */
function rollupHourly({ now = Date.now() } = {}) {
  const hourStart = new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
  // Aligned to an hour so a partly-pruned hour can never be re-folded from fewer rows.
  const cutoff = new Date(Math.floor((now - RAW_KEEP_DAYS * 86_400_000) / HOUR_MS) * HOUR_MS).toISOString();
  return db.transaction(() => {
    const folded = Number(
      db.run(
        `INSERT INTO server_samples_hourly
           (server_id, hour, samples, players_avg, players_max, tps_avg, tps_min, mspt_avg, mem_avg, mem_max, cpu_avg, mem_limit)
         SELECT server_id, substr(ts, 1, 13) || ':00:00Z', COUNT(*), AVG(players_online), MAX(players_online),
                AVG(tps), MIN(tps), AVG(mspt), CAST(ROUND(AVG(mem_bytes)) AS INTEGER), MAX(mem_bytes),
                AVG(cpu_pct), MAX(mem_limit_bytes)
           FROM server_samples WHERE ts < ?
          GROUP BY server_id, substr(ts, 1, 13)
         ON CONFLICT(server_id, hour) DO UPDATE SET
           samples = excluded.samples, players_avg = excluded.players_avg, players_max = excluded.players_max,
           tps_avg = excluded.tps_avg, tps_min = excluded.tps_min, mspt_avg = excluded.mspt_avg,
           mem_avg = excluded.mem_avg, mem_max = excluded.mem_max, cpu_avg = excluded.cpu_avg,
           mem_limit = excluded.mem_limit`,
        hourStart
      ).changes
    );
    const pruned = Number(
      db.run(
        `DELETE FROM server_samples
          WHERE ts < ? AND EXISTS (
            SELECT 1 FROM server_samples_hourly h
             WHERE h.server_id = server_samples.server_id AND h.hour = substr(server_samples.ts, 1, 13) || ':00:00Z')`,
        cutoff
      ).changes
    );
    return { folded, pruned };
  });
}

/** Sample every minute. */
function startSampler() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = setInterval(() => {
    try {
      sampleOnce();
      sampleThrottle.ok(logger.info, 'Server sampling recovered.');
    } catch (err) {
      sampleThrottle.fail(logger.warn, 'Sampling the servers failed.', {
        err: serializeError(err, { includeStack: false }),
      });
    }
  }, MINUTE_MS);
  if (sampleTimer.unref) sampleTimer.unref();
}

function stopSampler() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  if (foldTimer) clearInterval(foldTimer);
  foldTimer = null;
}

/** Fold completed hours now (boot), then every hour. */
function startSampleRollup() {
  const run = () => {
    try {
      rollupHourly();
      foldThrottle.ok(logger.info, 'The hourly sample rollup recovered.');
    } catch (err) {
      foldThrottle.fail(logger.warn, 'The hourly sample rollup failed.', {
        err: serializeError(err, { includeStack: false }),
      });
    }
  };
  run();
  if (foldTimer) clearInterval(foldTimer);
  foldTimer = setInterval(run, HOUR_MS);
  if (foldTimer.unref) foldTimer.unref();
}

module.exports = { sampleOnce, rollupHourly, startSampler, startSampleRollup, stopSampler };
