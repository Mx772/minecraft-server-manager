'use strict';

// Persistent jar metadata cache. Parsed mod/plugin metadata (and Lithium's
// option descriptions) are stored in mod_jar_meta keyed by server + jar path,
// and stay valid while the jar's size and mtime are unchanged. Jars are read
// by central-directory walk (never loaded whole), a few at a time.

const fsp = require('node:fs/promises');
const db = require('../db');
const { dataPath, safeJoin } = require('../storage/pathGuard');
const modIdentify = require('./modIdentify');

const MAX_JAR_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 4;
const LITHIUM_DOC = 'lithium-fabric-mixin-config.md';

/**
 * @typedef {{ meta: any, descriptions: Record<string, string> | null }} JarInfo
 * @typedef {{ folder: string, file: string }} JarRef
 */

/** @type {Map<string, Promise<JarInfo>>} */
const inFlight = new Map();

/** @param {string} markdown @returns {Record<string, string>} */
function parseLithiumDescriptions(markdown) {
  /** @type {Record<string, string>} */
  const descriptions = {};
  const sections = /###\s+`([^`]+)`[^\n]*\n([\s\S]*?)(?=\n###\s+`|$)/g;
  for (const match of markdown.matchAll(sections)) {
    const text = match[2]
      .replace(/^\s*\(default:[^\n]*\)\s*/i, '')
      .split(/\n\s*(?:Requirements:|Sub-options:|Incompatibilities:)/i)[0]
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[`*_>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) descriptions[match[1]] = text.slice(0, 600);
  }
  return descriptions;
}

/** @param {string} abs @returns {Promise<JarInfo>} */
async function readJar(abs) {
  const { meta, extras } = await modIdentify.inspectJarFile(abs, [LITHIUM_DOC]);
  const doc = extras.get(LITHIUM_DOC);
  const descriptions = meta?.modId === 'lithium' && doc ? parseLithiumDescriptions(doc) : null;
  return { meta, descriptions };
}

/** @param {string | null | undefined} json */
function parseJson(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Metadata for many jars. Results are keyed by `${folder}/${file}`; jars that
 * are missing, symlinked, not regular files, or over 64 MB are left out.
 * Cache rows for jars no longer in `entries` are pruned.
 * @param {string} serverId
 * @param {JarRef[]} entries
 * @returns {Promise<Map<string, JarInfo>>}
 */
async function getMany(serverId, entries) {
  /** @type {Map<string, JarInfo>} */
  const result = new Map();
  const cached = new Map(
    db.all('SELECT * FROM mod_jar_meta WHERE server_id = ?', serverId).map((row) => [row.rel_path, row])
  );
  const serverRoot = dataPath('servers', serverId);
  /** @type {{ rel: string, size: number, mtimeMs: number }[]} */
  const upserts = [];

  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const { folder, file } = entries[next++];
      const rel = `${folder}/${file}`;
      let abs;
      let stat;
      try {
        abs = safeJoin(serverRoot, rel);
        stat = await fsp.lstat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JAR_BYTES) continue;
      const mtimeMs = Math.floor(stat.mtimeMs);
      const row = cached.get(rel);
      if (row && row.size === stat.size && row.mtime_ms === mtimeMs) {
        result.set(rel, { meta: parseJson(row.meta_json), descriptions: parseJson(row.descriptions_json) });
        continue;
      }
      const key = `${serverId}|${rel}|${stat.size}|${mtimeMs}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = readJar(abs).catch(() => ({ meta: null, descriptions: null }));
        inFlight.set(key, pending);
        pending.finally(() => inFlight.delete(key)).catch(() => {});
      }
      const info = await pending;
      result.set(rel, info);
      upserts.push({ rel, size: stat.size, mtimeMs });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));

  const stale = [...cached.keys()].filter((rel) => !result.has(rel));
  if (upserts.length || stale.length) {
    db.transaction(() => {
      for (const { rel, size, mtimeMs } of upserts) {
        const info = result.get(rel);
        db.run(
          `INSERT INTO mod_jar_meta (server_id, rel_path, size, mtime_ms, meta_json, descriptions_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (server_id, rel_path) DO UPDATE SET
             size = excluded.size, mtime_ms = excluded.mtime_ms, meta_json = excluded.meta_json,
             descriptions_json = excluded.descriptions_json, scanned_at = datetime('now')`,
          serverId,
          rel,
          size,
          mtimeMs,
          info?.meta ? JSON.stringify(info.meta) : null,
          info?.descriptions ? JSON.stringify(info.descriptions) : null
        );
      }
      for (const rel of stale) db.run('DELETE FROM mod_jar_meta WHERE server_id = ? AND rel_path = ?', serverId, rel);
    });
  }
  return result;
}

/**
 * Every cached jar for a server, straight from the database with no jar reads.
 * @param {string} serverId
 * @returns {{ rel: string, meta: any, descriptions: Record<string, string> | null }[]}
 */
function cachedForServer(serverId) {
  return db
    .all('SELECT rel_path, meta_json, descriptions_json FROM mod_jar_meta WHERE server_id = ?', serverId)
    .map((row) => ({
      rel: row.rel_path,
      meta: parseJson(row.meta_json),
      descriptions: parseJson(row.descriptions_json),
    }));
}

module.exports = { getMany, cachedForServer };
