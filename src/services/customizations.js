'use strict';

// Customizations: the user's own versions of pack files, kept in
// <server>/customizations/ (mirroring the server layout) and copied over the
// server folder by the image on every start, after the modpack install. The
// files in that folder are the source of truth; server_customizations rows only
// remember what each file looked like when captured and from which pack version.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const httpError = require('../utils/httpError');
const db = require('../db');
const config = require('../config');
const { safeJoin } = require('../storage/pathGuard');
const { recordEvent } = require('../events');
const indexer = require('../storage/indexer');
const containers = require('../docker/containers');
const files = require('./files');
const servers = require('./servers');
const logger = require('../logger')(path.basename(__filename));

const DIR_NAME = 'customizations';
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 256 * 1024 ** 2;
const ENV_MARKER = 'COPY_CONFIG_SRC=/data/customizations';

const plural = (n) => `${n} file${n === 1 ? '' : 's'}`;

function mustServer(serverId) {
  const server = servers.getServer(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

const serverRoot = (serverId) => safeJoin(config.dataDir, 'servers', serverId);
const customDir = (serverId) => safeJoin(serverRoot(serverId), DIR_NAME);

/** Make sure the customizations folder exists (an empty one makes the image's sync a no-op). */
function ensureDir(serverId) {
  const dir = customDir(serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function sha256File(abs) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(abs)) hash.update(chunk);
  return hash.digest('hex');
}

/** Every regular file under `dirAbs` as server-relative-to-`dirAbs` paths. Symlinks are skipped. */
async function walkFiles(dirAbs, prefix = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(dirAbs, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dirAbs, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Top-level folder names that hold worlds (every dimension folder), which can never be customized. */
async function worldFolders(serverId) {
  const worlds = require('./worlds');
  const names = new Set();
  try {
    for (const w of await worlds.listServerWorlds(serverId)) for (const d of w.dims) names.add(d);
    names.add(worlds.activeLevelName(servers.getServer(serverId)));
  } catch (err) {
    logger.debug('Listing world folders for customizations failed.', { serverId, err: err.message });
  }
  return names;
}

/** @returns {Promise<{path: string, size: number, mtime: number, capturedAt: string|null, capturedPack: {id: string, name: string}|null, state: 'applied'|'pending'}[]>} */
async function list(serverId) {
  mustServer(serverId);
  const dir = ensureDir(serverId);
  const rows = new Map(
    db.all('SELECT * FROM server_customizations WHERE server_id = ?', serverId).map((r) => [r.path, r])
  );
  const onDisk = await walkFiles(dir);
  const present = new Set(onDisk);
  for (const p of rows.keys()) {
    if (!present.has(p)) db.run('DELETE FROM server_customizations WHERE server_id = ? AND path = ?', serverId, p);
  }
  const root = serverRoot(serverId);
  const out = [];
  for (const rel of onDisk.sort()) {
    const abs = path.join(dir, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const row = rows.get(rel);
    const live = await fsp.stat(path.join(root, rel)).catch(() => null);
    let state = 'pending';
    if (live && live.isFile() && live.size === st.size) {
      state = (await sha256File(abs)) === (await sha256File(path.join(root, rel))) ? 'applied' : 'pending';
    }
    out.push({
      path: rel,
      size: st.size,
      mtime: st.mtimeMs,
      capturedAt: row ? row.captured_at : null,
      capturedPack:
        row && row.captured_pack_version_id
          ? { id: row.captured_pack_version_id, name: row.captured_pack_version_name }
          : null,
      state,
    });
  }
  return out;
}

/** Server-relative paths that have a customization copy (no hashing; for the Files page badge). */
async function customizedPaths(serverId) {
  return new Set(await walkFiles(customDir(serverId)));
}

/** Throw 400 when a server-relative path may not be customized. */
function assertCustomizable(rel, worldNames) {
  if (rel === '') throw httpError(400, 'The server folder itself cannot be customized.');
  if (rel === DIR_NAME || rel.startsWith(`${DIR_NAME}/`)) {
    throw httpError(400, 'That is already in the customizations folder.');
  }
  const top = rel.split('/')[0];
  if (worldNames.has(top)) throw httpError(400, 'World folders cannot be customized.');
}

/**
 * Copy the current live version of each path (a file, or every file in a folder)
 * into customizations/, overwriting an earlier copy.
 * @returns {Promise<{results: object[], succeeded: number, failed: number, needsRebuild: boolean}>}
 */
async function add(serverId, paths, { actor = 'system' } = {}) {
  mustServer(serverId);
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'Select at least one file.');
  if (paths.length > MAX_FILES) throw httpError(400, `Select at most ${MAX_FILES} items at a time.`);
  const dir = ensureDir(serverId);
  const root = serverRoot(serverId);
  const worldNames = await worldFolders(serverId);

  // Pass 1: validate every item and expand folders, so the caps hold before any copy.
  const plan = [];
  let totalFiles = 0;
  let totalBytes = 0;
  const seen = new Set();
  for (const raw of paths) {
    const item = String(raw);
    if (seen.has(item)) continue;
    seen.add(item);
    try {
      const { rel } = files.resolvePath(serverId, item);
      assertCustomizable(rel, worldNames);
      const abs = path.join(root, rel);
      const lst = await fsp.lstat(abs).catch(() => null);
      if (!lst) throw httpError(404, 'Not found.');
      if (lst.isSymbolicLink()) throw httpError(400, 'Links cannot be customized.');
      let rels;
      if (lst.isDirectory()) {
        rels = (await walkFiles(abs)).map((r) => `${rel}/${r}`);
        if (!rels.length) throw httpError(400, 'That folder has no files in it.');
      } else if (lst.isFile()) {
        rels = [rel];
      } else {
        throw httpError(400, 'Only files and folders can be customized.');
      }
      for (const r of rels) totalBytes += (await fsp.stat(path.join(root, r)).catch(() => ({ size: 0 }))).size;
      totalFiles += rels.length;
      if (totalFiles > MAX_FILES) throw httpError(400, `That is more than ${MAX_FILES} files. Select fewer items.`);
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw httpError(413, `That is more than ${MAX_TOTAL_BYTES / 1024 ** 2} MB of files. Select fewer items.`);
      }
      plan.push({ item: rel, rels });
    } catch (err) {
      if (!err.status) throw err;
      if (err.status === 413 || /^That is more than \d+ files/.test(err.message)) throw err;
      plan.push({ item, error: err.message });
    }
  }

  // The copies live inside the server folder, so they count against its disk quota.
  files.assertRoom(serverId, totalBytes);
  await files.assertDiskFree(totalBytes);

  const pack = db.get('SELECT pinned_version_id, pinned_version_name FROM server_packs WHERE server_id = ?', serverId);
  const results = [];
  let fileCount = 0;
  for (const p of plan) {
    if (p.error) {
      results.push({ path: p.item, ok: false, error: p.error });
      continue;
    }
    try {
      for (const rel of p.rels) {
        const dest = safeJoin(dir, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(root, rel), dest);
        db.run(
          `INSERT INTO server_customizations
             (server_id, path, captured_sha256, captured_at, captured_pack_version_id, captured_pack_version_name)
           VALUES (?, ?, ?, datetime('now'), ?, ?)
           ON CONFLICT (server_id, path) DO UPDATE SET
             captured_sha256 = excluded.captured_sha256, captured_at = excluded.captured_at,
             captured_pack_version_id = excluded.captured_pack_version_id,
             captured_pack_version_name = excluded.captured_pack_version_name`,
          serverId,
          rel,
          await sha256File(dest),
          pack ? pack.pinned_version_id : null,
          pack ? pack.pinned_version_name : null
        );
        fileCount++;
      }
      results.push({ path: p.item, ok: true, count: p.rels.length });
    } catch (err) {
      logger.warn('Copying a file into customizations failed.', { serverId, err: err.message });
      results.push({ path: p.item, ok: false, error: 'Something went wrong with that item.' });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  let needsRebuild = false;
  if (succeeded > 0) {
    needsRebuild = await flagRebuildIfNeeded(serverId);
    const base = `Added ${plural(fileCount)} to customizations.`;
    recordEvent({
      serverId,
      actor,
      type: 'customizations-added',
      summary: failed > 0 ? `${base} ${failed} item${failed === 1 ? '' : 's'} could not be added.` : base,
      details: {
        count: fileCount,
        failed,
        paths: results
          .filter((r) => r.ok)
          .map((r) => r.path)
          .slice(0, 50),
      },
    });
    indexer.scheduleScan();
  }
  return { results, succeeded, failed, needsRebuild };
}

/**
 * An existing container only gets the customizations env at its next rebuild.
 * When the current container lacks it, queue a rebuild. No container: nothing to do.
 */
async function flagRebuildIfNeeded(serverId) {
  let env;
  try {
    env = await containers.containerEnv(serverId);
  } catch (err) {
    logger.warn('Could not read the container settings to check customizations.', { serverId, err: err.message });
    return false;
  }
  if (!env || env.includes(ENV_MARKER)) return false;
  db.run('UPDATE servers SET pending_recreate = 1 WHERE id = ?', serverId);
  return true;
}

/** Delete the customization copies (never the live files) and their rows. */
async function remove(serverId, paths, { actor = 'system' } = {}) {
  mustServer(serverId);
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'Select at least one file.');
  if (paths.length > MAX_FILES) throw httpError(400, `Select at most ${MAX_FILES} items at a time.`);
  const dir = ensureDir(serverId);
  const results = [];
  let fileCount = 0;
  const seen = new Set();
  for (const raw of paths) {
    const item = String(raw);
    if (seen.has(item)) continue;
    seen.add(item);
    try {
      const { rel } = files.resolvePath(serverId, item);
      if (rel === '' || rel === DIR_NAME || rel.startsWith(`${DIR_NAME}/`)) {
        throw httpError(400, 'Use a path in the server, not in the customizations folder.');
      }
      const abs = safeJoin(dir, rel);
      const lst = await fsp.lstat(abs).catch(() => null);
      if (!lst) throw httpError(404, 'That is not customized.');
      const rels = lst.isDirectory() ? (await walkFiles(abs)).map((r) => `${rel}/${r}`) : [rel];
      await fsp.rm(abs, { recursive: true, force: true });
      for (const r of rels) db.run('DELETE FROM server_customizations WHERE server_id = ? AND path = ?', serverId, r);
      await pruneEmptyDirs(dir, path.dirname(abs));
      fileCount += rels.length;
      results.push({ path: rel, ok: true, count: rels.length });
    } catch (err) {
      if (err.status) results.push({ path: item, ok: false, error: err.message });
      else {
        logger.warn('Removing a customization failed.', { serverId, err: err.message });
        results.push({ path: item, ok: false, error: 'Something went wrong with that item.' });
      }
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  if (succeeded > 0) {
    recordEvent({
      serverId,
      actor,
      type: 'customizations-removed',
      summary: `Removed ${plural(fileCount)} from customizations. The pack's versions return at the next pack update.`,
      details: {
        count: fileCount,
        failed,
        paths: results
          .filter((r) => r.ok)
          .map((r) => r.path)
          .slice(0, 50),
      },
    });
    indexer.scheduleScan();
  }
  return { results, succeeded, failed };
}

/** Remove now-empty folders from `start` up to (not including) the customizations root. */
async function pruneEmptyDirs(rootAbs, start) {
  let cur = start;
  while (cur !== rootAbs && cur.startsWith(rootAbs + path.sep)) {
    try {
      await fsp.rmdir(cur);
    } catch {
      return; // not empty (or gone)
    }
    cur = path.dirname(cur);
  }
}

module.exports = { list, add, remove, customizedPaths, ensureDir, DIR_NAME, MAX_FILES, MAX_TOTAL_BYTES };
