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

const SECRET_MSG =
  'This customization fills in a secret when the server starts, so it can only be edited in the customizations folder.';

const OWNED_MSG = 'This file is managed by the Discord chat bridge. Change it from the Discord tab.';

/** Owner name (e.g. 'discord-chat-bridge') of a customization path, or null. Owned files are managed by a panel feature. */
function ownerOf(serverId, rel) {
  const row = db.get('SELECT owner FROM server_customizations WHERE server_id = ? AND path = ?', serverId, rel);
  return row && row.owner ? row.owner : null;
}

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

/**
 * applied: the live file is what the start-time sync produced or has the copy's content.
 * pending: the live file is gone or older than the copy, so the next start applies the
 * copy. changed: the live file differs and is newer than the copy.
 * Verified against the real image: the sync preserves the SOURCE file's mtime on the
 * destination exactly, so equal mtimes mean the file was synced from this copy. It also
 * substitutes ${CFG_*} placeholders, so a correctly applied file can differ in content
 * from its copy; mtime is therefore checked before content. A newer live file means
 * something rewrote it after the copy was taken (an upload, a mod rewriting its config,
 * an edit outside the editor).
 */
async function driftState(copyAbs, copySt, live) {
  if (!live || !live.st.isFile()) return 'pending';
  const diff = live.st.mtimeMs - copySt.mtimeMs;
  if (Math.abs(diff) < 1) return 'applied';
  if (live.st.size === copySt.size && (await sha256File(copyAbs)) === (await sha256File(live.abs))) return 'applied';
  return diff < 0 ? 'pending' : 'changed';
}

/**
 * True when copying the live file over the copy would replace a ${CFG_ placeholder with
 * a real (possibly secret) value: the copy holds a placeholder and the content differs.
 */
async function wouldLosePlaceholder(copyAbs, liveAbs) {
  const copy = await fsp.readFile(copyAbs).catch(() => null);
  if (!copy || !copy.includes('${CFG_')) return false;
  const live = await fsp.readFile(liveAbs).catch(() => null);
  return !live || !copy.equals(live);
}

/** @returns {Promise<{path: string, size: number, mtime: number, capturedAt: string|null, capturedPack: {id: string, name: string}|null, liveMtime: number|null, state: 'applied'|'pending'|'changed'|'managed', owner: string|null}[]>} */
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
    // A file owned by a panel feature is rewritten by that feature (or the mod it
    // configures) at will, which would otherwise read as drift.
    const owner = row && row.owner ? row.owner : null;
    const state = owner ? 'managed' : await driftState(abs, st, live ? { abs: path.join(root, rel), st: live } : null);
    out.push({
      path: rel,
      size: st.size,
      mtime: st.mtimeMs,
      liveMtime: live && live.isFile() ? live.mtimeMs : null,
      capturedAt: row ? row.captured_at : null,
      capturedPack:
        row && row.captured_pack_version_id
          ? { id: row.captured_pack_version_id, name: row.captured_pack_version_name }
          : null,
      state,
      owner,
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

/** Insert or refresh a row: what the copy looked like now and the pack version it was taken from. */
function recordRow(serverId, rel, sha, pack) {
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
    sha,
    pack ? pack.pinned_version_id : null,
    pack ? pack.pinned_version_name : null
  );
}

const packOf = (serverId) =>
  db.get('SELECT pinned_version_id, pinned_version_name FROM server_packs WHERE server_id = ?', serverId);

/**
 * Called by files.writeText after a successful editor save. Saving a live file that
 * has a copy rewrites the copy too (returns true); saving inside customizations/
 * edits only the copy, so just its row's sha is refreshed. Never throws: the save
 * itself already succeeded.
 */
async function syncAfterWrite(serverId, rel) {
  try {
    const dir = customDir(serverId);
    if (rel.startsWith(`${DIR_NAME}/`)) {
      const inner = rel.slice(DIR_NAME.length + 1);
      const row = db.get('SELECT 1 AS x FROM server_customizations WHERE server_id = ? AND path = ?', serverId, inner);
      if (row) {
        db.run(
          `UPDATE server_customizations SET captured_sha256 = ?, captured_at = datetime('now')
           WHERE server_id = ? AND path = ?`,
          await sha256File(safeJoin(dir, inner)),
          serverId,
          inner
        );
      }
      return false;
    }
    const dest = safeJoin(dir, rel);
    const lst = await fsp.lstat(dest).catch(() => null);
    if (!lst || !lst.isFile()) return false;
    if (ownerOf(serverId, rel)) return false; // the live copy may hold a real secret
    const liveAbs = path.join(serverRoot(serverId), rel);
    if (await wouldLosePlaceholder(dest, liveAbs)) return false;
    await fsp.copyFile(liveAbs, dest);
    recordRow(serverId, rel, await sha256File(dest), packOf(serverId));
    return true;
  } catch (err) {
    logger.warn('Updating a customization after a save failed.', { serverId, err: err.message });
    return false;
  }
}

/**
 * Walk the items of a keep-current / restore request. `fn(rel, copyAbs, liveAbs)` handles one
 * file. Each item must be customized (a copy file, or a copy folder holding files).
 */
async function eachCustomized(serverId, paths, fn) {
  mustServer(serverId);
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'Select at least one file.');
  if (paths.length > MAX_FILES) throw httpError(400, `Select at most ${MAX_FILES} items at a time.`);
  const dir = ensureDir(serverId);
  const root = serverRoot(serverId);
  const results = [];
  let fileCount = 0;
  const seen = new Set();
  for (const raw of paths) {
    const item = String(raw);
    if (seen.has(item)) continue;
    seen.add(item);
    try {
      const { rel } = files.resolvePath(serverId, item);
      const copyAbs = rel === '' || rel === DIR_NAME || rel.startsWith(`${DIR_NAME}/`) ? null : safeJoin(dir, rel);
      const lst = copyAbs ? await fsp.lstat(copyAbs).catch(() => null) : null;
      if (!lst || lst.isSymbolicLink() || !(lst.isFile() || lst.isDirectory())) {
        throw httpError(404, 'That file is not customized.');
      }
      const rels = lst.isDirectory() ? (await walkFiles(copyAbs)).map((r) => `${rel}/${r}`) : [rel];
      if (!rels.length) throw httpError(404, 'That file is not customized.');
      if (rels.some((r) => ownerOf(serverId, r))) throw httpError(400, OWNED_MSG);
      for (const r of rels) await fn(r, safeJoin(dir, r), safeJoin(root, r));
      fileCount += rels.length;
      results.push({ path: rel, ok: true, count: rels.length });
    } catch (err) {
      if (err.status) results.push({ path: item, ok: false, error: err.message });
      else {
        logger.warn('Updating a customization failed.', { serverId, err: err.message });
        results.push({ path: item, ok: false, error: 'Something went wrong with that item.' });
      }
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded, fileCount };
}

const okPaths = (results) =>
  results
    .filter((r) => r.ok)
    .map((r) => r.path)
    .slice(0, 50);

/** Replace each customization copy with the server's current version of the file. */
async function keepCurrent(serverId, paths, { actor = 'system' } = {}) {
  const pack = packOf(serverId);
  const out = await eachCustomized(serverId, paths, async (rel, copyAbs, liveAbs) => {
    const live = await fsp.lstat(liveAbs).catch(() => null);
    if (!live || !live.isFile()) throw httpError(404, 'That file is not on the server right now.');
    if (await wouldLosePlaceholder(copyAbs, liveAbs)) {
      throw httpError(400, SECRET_MSG);
    }
    await fsp.copyFile(liveAbs, copyAbs);
    recordRow(serverId, rel, await sha256File(copyAbs), pack);
  });
  if (out.succeeded > 0) {
    recordEvent({
      serverId,
      actor,
      type: 'customizations-updated',
      summary: `Updated ${plural(out.fileCount)} from the server's current version.`,
      details: { count: out.fileCount, failed: out.failed, paths: okPaths(out.results) },
    });
    indexer.scheduleScan();
  }
  return { results: out.results, succeeded: out.succeeded, failed: out.failed };
}

/**
 * Copy each customization copy over the live file right now. A running server may
 * rewrite a config it holds open, which is why the start-time sync still matters.
 */
async function restore(serverId, paths, { actor = 'system' } = {}) {
  const out = await eachCustomized(serverId, paths, async (rel, copyAbs, liveAbs) => {
    const live = await fsp.lstat(liveAbs).catch(() => null);
    if (live && !live.isFile()) throw httpError(400, 'That path on the server is not a regular file.');
    await fsp.mkdir(path.dirname(liveAbs), { recursive: true });
    await fsp.copyFile(copyAbs, liveAbs);
  });
  if (out.succeeded > 0) {
    recordEvent({
      serverId,
      actor,
      type: 'customizations-restored',
      summary: `Restored ${plural(out.fileCount)} over the server's current versions.`,
      details: { count: out.fileCount, failed: out.failed, paths: okPaths(out.results) },
    });
    indexer.scheduleScan();
  }
  return { results: out.results, succeeded: out.succeeded, failed: out.failed };
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
      if (rels.some((r) => ownerOf(serverId, r))) throw httpError(400, OWNED_MSG);
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

  const pack = packOf(serverId);
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
        if (await wouldLosePlaceholder(dest, path.join(root, rel))) throw httpError(400, SECRET_MSG);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(root, rel), dest);
        recordRow(serverId, rel, await sha256File(dest), pack);
        fileCount++;
      }
      results.push({ path: p.item, ok: true, count: p.rels.length });
    } catch (err) {
      if (err.status) {
        results.push({ path: p.item, ok: false, error: err.message });
        continue;
      }
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
      if (rels.some((r) => ownerOf(serverId, r))) throw httpError(400, OWNED_MSG);
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

/**
 * For feature owners (e.g. the Discord chat bridge): write `content` as the
 * customization copy of server-relative `rel` and mark the row as owned, so the
 * user's own actions and drift detection leave it alone. Path-guarded and
 * quota-checked. The caller is responsible for rebuilding when the container
 * lacks the customizations env (see flagRebuildIfNeeded).
 */
async function writeOwned(serverId, rel, content, owner) {
  mustServer(serverId);
  const clean = files.resolvePath(serverId, rel).rel;
  assertCustomizable(clean, await worldFolders(serverId));
  const existing = ownerOf(serverId, clean);
  if (existing && existing !== owner) throw httpError(400, 'That file is managed by another feature.');
  const dir = ensureDir(serverId);
  const dest = safeJoin(dir, clean);
  const lst = await fsp.lstat(dest).catch(() => null);
  if (lst && !lst.isFile()) throw httpError(400, 'That path is not a regular file.');
  const bytes = Buffer.byteLength(content, 'utf8');
  files.assertRoom(serverId, bytes);
  await files.assertDiskFree(bytes);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, content, { mode: 0o600 });
  await fsp.rename(tmp, dest);
  recordRow(serverId, clean, await sha256File(dest), packOf(serverId));
  db.run('UPDATE server_customizations SET owner = ? WHERE server_id = ? AND path = ?', owner, serverId, clean);
  indexer.scheduleScan();
  return { path: clean, needsRebuild: await flagRebuildIfNeeded(serverId) };
}

/** Delete an owned copy and its row (never the live file). A no-op when absent. */
async function removeOwned(serverId, rel, owner) {
  mustServer(serverId);
  const clean = files.resolvePath(serverId, rel).rel;
  const existing = ownerOf(serverId, clean);
  if (existing && existing !== owner) throw httpError(400, 'That file is managed by another feature.');
  const dir = ensureDir(serverId);
  const abs = safeJoin(dir, clean);
  await fsp.rm(abs, { force: true });
  db.run('DELETE FROM server_customizations WHERE server_id = ? AND path = ?', serverId, clean);
  await pruneEmptyDirs(dir, path.dirname(abs));
  indexer.scheduleScan();
}

/** Read an owned copy's text, or null when absent. */
async function readOwned(serverId, rel, owner) {
  const clean = files.resolvePath(serverId, rel).rel;
  if (ownerOf(serverId, clean) !== owner) return null;
  return fsp.readFile(safeJoin(customDir(serverId), clean), 'utf8').catch(() => null);
}

/** Server-relative paths of every file owned by a panel feature (for exports that must skip them). */
function ownedPaths(serverId) {
  return new Set(
    db
      .all('SELECT path FROM server_customizations WHERE server_id = ? AND owner IS NOT NULL', serverId)
      .map((r) => r.path)
  );
}

module.exports = {
  writeOwned,
  removeOwned,
  readOwned,
  ownedPaths,
  OWNED_MSG,
  list,
  add,
  remove,
  keepCurrent,
  restore,
  syncAfterWrite,
  customizedPaths,
  ensureDir,
  DIR_NAME,
  MAX_FILES,
  MAX_TOTAL_BYTES,
};
