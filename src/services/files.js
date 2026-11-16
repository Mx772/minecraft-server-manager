// @ts-nocheck - dynamic Docker/NBT/HTTP-JSON interop; not yet under checkJs (incremental typing).
'use strict';

// Scoped file manager. serverId scopes every operation to
// ./data/servers/<id>; serverId = null is the global (admin) manager rooted at
// DATA_DIR itself. Every path resolves through the path guard - nothing can
// escape ./data, and server-scoped calls can't escape their server dir.

const httpError = require('../utils/httpError');
const { sumFileSizes } = require('../utils/statSizes');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const { safeJoin } = require('../storage/pathGuard');
const { recordEvent } = require('../events');
const indexer = require('../storage/indexer');
const servers = require('./servers');
const { serializeError } = require('../utils/logSanitize');
const logger = require('../logger')(path.basename(__filename));

const MAX_BULK_ITEMS = 500;
const MAX_BULK_DETAIL_PATHS = 50;
const MAX_ZIP_BYTES = 2 * 1024 ** 3; // one zip download of a selection
const MAX_TEXT_BYTES = 8 * 1024 * 1024; // editor cap
const MAX_TEXT_MB_LABEL = '8 MB';
// "find in files" limits - keep a search over a big modpack dir bounded.
const SEARCH_MAX_MATCHES = 300;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_FILES_SCANNED = 8000;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'cache', '.cache', 'libraries', 'versions', 'crash-reports']);
// Global scope: panel-internal files at the DATA_DIR root that must never be read,
// written, listed, or downloaded from the UI - the database (password hashes + the
// at-rest secret cipher) and the session secret (that cipher's key + the cookie
// signing key). Any other top-level dotfile is treated the same, defensively.
const PROTECTED_GLOBAL = new Set(['panel.db', 'panel.db-wal', 'panel.db-shm', 'panel.db-journal', '.session-secret']);

/** True for a DATA_DIR-root path that must be hidden/blocked in the global manager. */
function isProtectedGlobal(rel) {
  return PROTECTED_GLOBAL.has(rel) || /^\.[^/\\]+$/.test(rel);
}

/** Resolve a scope-relative path to {base, abs, rel}. Throws 400 on escape. */
function resolvePath(serverId, relPath = '') {
  const base = serverId ? safeJoin(config.dataDir, 'servers', serverId) : config.dataDir;
  const abs = safeJoin(base, String(relPath || '') || '.');
  const rel = path.relative(base, abs).split(path.sep).join('/');
  return { base, abs, rel };
}

const TOKEN_FILE_MSG =
  "This file holds the Discord bot token, so it can't be opened or changed here. Change the bridge from the Discord tab.";

// Lazy require (cycle-breaker): chatBridge -> mods/customizations -> files.
const liveConfigPaths = (serverId) => require('../integrations/chatBridge').protectedLivePaths(serverId);

/** Absolute paths of the live chat-bridge configs (they hold the real bot token) for a server scope. */
function tokenFileAbs(serverId) {
  if (!serverId) return new Set();
  const base = safeJoin(config.dataDir, 'servers', serverId);
  return new Set(liveConfigPaths(serverId).map((rel) => path.join(base, rel)));
}

/** True when `rel` is a folder that currently contains a live bridge config. */
function holdsTokenFile(serverId, rel) {
  if (!serverId || !rel) return false;
  return liveConfigPaths(serverId).some(
    (p) => p.startsWith(`${rel}/`) && fs.existsSync(safeJoin(config.dataDir, 'servers', serverId, p))
  );
}

function guardProtected(serverId, rel) {
  if (serverId && liveConfigPaths(serverId).includes(rel)) throw httpError(403, TOKEN_FILE_MSG);
  if (!serverId && isProtectedGlobal(rel)) {
    // Applies to read/download AND write - the DB holds password hashes and the
    // at-rest secret cipher, and .session-secret is that cipher's key, so neither
    // must ever leave (or change) via the file manager.
    throw httpError(403, 'That panel file is not accessible from the file manager.');
  }
}

/** Moving a folder that holds the live bridge config would put the token file at a path nothing guards. */
function guardMovingTokenFolder(serverId, rel) {
  if (holdsTokenFile(serverId, rel)) throw httpError(403, TOKEN_FILE_MSG);
}

/** List a directory: entries {name, dir, size, mtime, mtimeMs, path}, dirs first. */
async function list(serverId, relPath = '') {
  const { abs, rel } = resolvePath(serverId, relPath);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw httpError(404, 'Folder not found.');
  if (!st.isDirectory()) throw httpError(400, 'Not a folder.');

  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  // Batch the indexer lookups: one SELECT for every subdirectory, not a sizeOf()
  // query per entry (opening a world folder with many dimension trees used to
  // fan out a query per dir on every listing). mtime still needs a stat per dir.
  const dirSizes = indexer.sizeOfMany(
    dirents
      .filter((e) => e.isDirectory())
      .filter((e) => !(!serverId && isProtectedGlobal(rel ? `${rel}/${e.name}` : e.name)))
      .map((e) => path.relative(config.dataDir, path.join(abs, e.name)).split(path.sep).join('/'))
  );
  const entries = [];
  for (const e of dirents) {
    // Never surface panel-internal files (DB, session secret) in the global manager.
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (!serverId && isProtectedGlobal(childRel)) continue;
    const childAbs = path.join(abs, e.name);
    const isDir = e.isDirectory();
    let size = 0;
    let mtimeMs = 0;
    try {
      if (isDir) {
        // Use the background indexer's cached size instead of a live recursive
        // walk per folder on every listing - opening a folder with a multi-GB
        // world used to stat tens of thousands of files. Deep/not-yet-indexed
        // dirs read 0 until the next scan; that's the instant-lookup trade-off.
        const dataRel = path.relative(config.dataDir, childAbs).split(path.sep).join('/');
        size = dirSizes.get(dataRel) || 0;
        mtimeMs = (await fsp.stat(childAbs)).mtimeMs;
      } else {
        const cst = await fsp.stat(childAbs);
        size = cst.size;
        mtimeMs = cst.mtimeMs;
      }
    } catch {
      /* transient */
    }
    entries.push({
      name: e.name,
      dir: isDir,
      size,
      mtimeMs,
      mtime: formatWhen(mtimeMs),
      path: rel ? `${rel}/${e.name}` : e.name,
    });
  }
  entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: rel, entries };
}

/** Read a text file (≤ MAX_TEXT_BYTES; binary rejected by null-byte sniff). */
async function readText(serverId, relPath) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw httpError(404, 'File not found.');
  if (st.size > MAX_TEXT_BYTES) {
    throw httpError(
      413,
      `File is too large for the editor (${humanBytes(st.size)}, limit ${MAX_TEXT_MB_LABEL}). Download it instead.`
    );
  }
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) {
    throw httpError(415, 'This looks like a binary file. Download it instead of editing.');
  }
  return { content: buf.toString('utf8'), size: st.size };
}

/** Write a text file atomically (tmp + rename). Creates the file when missing. */
async function writeText(serverId, relPath, content, { actor = 'system' } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel);
  if (!rel) throw httpError(400, 'Cannot write the root.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TEXT_BYTES) throw httpError(413, `Content exceeds the ${MAX_TEXT_MB_LABEL} editor limit.`);
  assertRoom(serverId, bytes);

  const parent = path.dirname(abs);
  const pst = await fsp.stat(parent).catch(() => null);
  if (!pst || !pst.isDirectory()) throw httpError(404, 'Parent folder not found.');
  const existing = await fsp.stat(abs).catch(() => null);
  if (existing && existing.isDirectory()) throw httpError(400, 'That path is a folder.');

  // server.properties is the one file whose values the itzg image re-asserts
  // from env on every start. Route those writes through the server.properties
  // choke point so the matching env vars are un-set and the edit sticks - a
  // plain write would silently revert on the next restart.
  if (serverId && rel === 'server.properties' && servers.getServer(serverId)) {
    const result = servers.writeServerProperties(serverId, content, { actor });
    const customizationUpdated = await syncCustomization(serverId, rel);
    recordEvent({
      serverId,
      actor,
      type: 'file-written',
      summary: `File ${existing ? 'saved' : 'created'}: server.properties (${humanBytes(bytes)}).${customizationNote(customizationUpdated)}`,
      details: {
        ...(customizationUpdated ? { customizationUpdated } : {}),
        path: rel,
        sizeBytes: bytes,
        created: !existing,
        rebuildNeeded: result.rebuildNeeded,
        unlocked: result.unlocked,
      },
    });
    return {
      path: rel,
      size: bytes,
      rebuildNeeded: result.rebuildNeeded,
      unlocked: result.unlocked,
      ...(customizationUpdated ? { customizationUpdated } : {}),
    };
  }

  // Random suffix: two saves in the same millisecond (two tabs, a double
  // click) must not share one temp file. Clean it up if the write or the
  // rename fails, or it lingers in the user's folder.
  const tmp = path.join(parent, `.msm-write-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  const customizationUpdated = await syncCustomization(serverId, rel);
  recordEvent({
    serverId: serverId || null,
    actor,
    type: 'file-written',
    summary: `File ${existing ? 'saved' : 'created'}: ${rel} (${humanBytes(bytes)}).${customizationNote(customizationUpdated)}`,
    details: {
      path: rel,
      sizeBytes: bytes,
      created: !existing,
      ...(customizationUpdated ? { customizationUpdated } : {}),
    },
  });
  return { path: rel, size: bytes, ...(customizationUpdated ? { customizationUpdated } : {}) };
}

const customizationNote = (updated) => (updated ? ' Its customization was updated too.' : '');

/** Keep a customization copy in step with an editor save (server scope only). True when a copy was rewritten. */
async function syncCustomization(serverId, rel) {
  if (!serverId) return false;
  // Mid-function require: customizations already requires files (cycle-breaker).
  return require('./customizations').syncAfterWrite(serverId, rel);
}

async function mkdir(serverId, relPath, { actor = 'system' } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  if (!rel) throw httpError(400, 'Folder name cannot be empty.');
  guardProtected(serverId, rel);
  if (fs.existsSync(abs)) throw httpError(409, 'That name already exists.');
  await fsp.mkdir(abs, { recursive: true });
  recordEvent({
    serverId: serverId || null,
    actor,
    type: 'file-mkdir',
    summary: `Folder created: ${rel}.`,
    details: { path: rel },
  });
  return { path: rel };
}

/** Rename in place (newName must not contain path separators). */
async function rename(serverId, relPath, newName, { actor = 'system' } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel);
  guardMovingTokenFolder(serverId, rel);
  if (!rel) throw httpError(400, 'Cannot rename the root.');
  const clean = sanitizeName(newName);
  if (!fs.existsSync(abs)) throw httpError(404, 'Not found');
  const target = path.join(path.dirname(abs), clean);
  // Re-check containment (sanitizeName guarantees it, but stay paranoid), and
  // refuse to rename anything ONTO a protected panel file name either.
  const targetRel = resolvePath(serverId, path.posix.join(path.posix.dirname(rel), clean)).rel;
  guardProtected(serverId, targetRel);
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(abs)) {
    throw httpError(409, `"${clean}" already exists here.`);
  }
  await fsp.rename(abs, target);
  recordEvent({
    serverId: serverId || null,
    actor,
    type: 'file-renamed',
    summary: `Renamed: ${rel} → ${clean}.`,
    details: { from: rel, to: clean },
  });
  return { path: rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/'))}/${clean}` : clean };
}

/** Move into a destination directory (keeps the base name). */
async function move(serverId, relPath, destRel, { actor = 'system', quiet = false } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel);
  guardMovingTokenFolder(serverId, rel);
  if (!rel) throw httpError(400, 'Cannot move the root.');
  const dest = resolvePath(serverId, destRel);
  const dst = await fsp.stat(dest.abs).catch(() => null);
  if (!fs.existsSync(abs)) throw httpError(404, 'Not found');
  if (!dst || !dst.isDirectory()) throw httpError(400, 'Destination folder not found.');
  if ((dest.abs + path.sep).startsWith(abs + path.sep)) throw httpError(400, 'Cannot move a folder into itself.');

  const target = path.join(dest.abs, path.basename(abs));
  guardProtected(serverId, dest.rel ? `${dest.rel}/${path.basename(abs)}` : path.basename(abs));
  if (fs.existsSync(target)) throw httpError(409, `"${path.basename(abs)}" already exists in the destination.`);
  await moveEntry(abs, target);
  const toRel = dest.rel ? `${dest.rel}/${path.basename(abs)}` : path.basename(abs);
  if (!quiet) {
    recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-moved',
      summary: `Moved: ${rel} → ${toRel}.`,
      details: { from: rel, to: toRel },
    });
    indexer.scheduleScan();
  }
  return { path: toRel };
}

/** Copy into a destination directory (recursive; quota-checked). */
async function copy(serverId, relPath, destRel, { actor = 'system', quiet = false } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  // Without this a copy of panel.db (or .session-secret) into any folder could
  // then be downloaded from there, which is exactly what the guard forbids.
  guardProtected(serverId, rel);
  if (!rel) throw httpError(400, 'Cannot copy the root.');
  const dest = resolvePath(serverId, destRel);
  const st = await fsp.stat(abs).catch(() => null);
  const dst = await fsp.stat(dest.abs).catch(() => null);
  if (!st) throw httpError(404, 'Not found');
  if (!dst || !dst.isDirectory()) throw httpError(400, 'Destination folder not found.');
  if ((dest.abs + path.sep).startsWith(abs + path.sep)) throw httpError(400, 'Cannot copy a folder into itself.');

  const bytes = st.isDirectory() ? await dirSize(abs) : st.size;
  assertRoom(serverId, bytes);
  await assertDiskFree(bytes);

  const target = path.join(dest.abs, path.basename(abs));
  guardProtected(serverId, dest.rel ? `${dest.rel}/${path.basename(abs)}` : path.basename(abs));
  if (fs.existsSync(target)) throw httpError(409, `"${path.basename(abs)}" already exists in the destination.`);
  const secret = tokenFileAbs(serverId);
  await fsp.cp(abs, target, { recursive: true, filter: (src) => !secret.has(src) });
  const toRel = dest.rel ? `${dest.rel}/${path.basename(abs)}` : path.basename(abs);
  if (!quiet) {
    recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-copied',
      summary: `Copied: ${rel} → ${toRel} (${humanBytes(bytes)}).`,
      details: { from: rel, to: toRel, sizeBytes: bytes },
    });
    indexer.scheduleScan();
  }
  return { path: toRel, sizeBytes: bytes };
}

/** Delete a file or folder (recursive). Returns freed bytes. */
async function remove(serverId, relPath, { actor = 'system', quiet = false } = {}) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel);
  if (!rel) throw httpError(400, 'Cannot delete the root folder.');
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw httpError(404, 'Not found');
  const freedBytes = st.isDirectory() ? await dirSize(abs) : st.size;
  await fsp.rm(abs, { recursive: true, force: true });
  if (!quiet) {
    recordEvent({
      serverId: serverId || null,
      actor,
      type: 'file-deleted',
      summary: `Deleted: ${rel} (${humanBytes(freedBytes)} freed).`,
      details: { path: rel, freedBytes },
    });
    indexer.scheduleScan();
  }
  return { freedBytes };
}

// ---- Bulk operations --------------------------------------------------------

/**
 * Validate a multi-select. Dedupes, drops any path nested inside another
 * selected path (a folder and its child = just the folder), and rejects an
 * empty / oversized list or the root. A path that escapes the scope is kept
 * as-is so the per-item call fails just that item.
 * @returns {string[]} scope-relative paths (or the raw string for an escape)
 */
function normalizeSelection(serverId, paths) {
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'Select at least one item.');
  if (paths.length > MAX_BULK_ITEMS) throw httpError(400, `Select at most ${MAX_BULK_ITEMS} items at a time.`);
  const seen = new Set();
  const items = [];
  for (const raw of paths) {
    let rel;
    try {
      rel = resolvePath(serverId, String(raw)).rel;
    } catch {
      rel = null;
    }
    if (rel === '') throw httpError(400, 'The top folder cannot be selected.');
    const key = rel === null ? String(raw) : rel;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, resolved: rel !== null });
  }
  const resolved = items.filter((i) => i.resolved).map((i) => i.key);
  return items
    .filter((i) => !i.resolved || !resolved.some((other) => other !== i.key && i.key.startsWith(`${other}/`)))
    .map((i) => i.key);
}

const plural = (n, word = 'item') => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Run `fn` per item, sequentially, collecting per-item outcomes. */
async function runBulk(serverId, items, fn) {
  const results = [];
  for (const item of items) {
    try {
      const out = await fn(item);
      results.push({ ...out, path: item, ok: true });
    } catch (err) {
      if (err && err.status) {
        results.push({ path: item, ok: false, error: err.message });
      } else {
        logger.warn('A bulk file operation failed on one item.', {
          serverId: serverId || null,
          err: serializeError(err, { includeStack: false }),
        });
        results.push({ path: item, ok: false, error: 'Something went wrong with that item.' });
      }
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}

function bulkSummary(base, failed, verb) {
  return failed > 0 ? `${base} ${plural(failed)} could not be ${verb}.` : base;
}

function destLabel(serverId, dest) {
  return dest.rel ? `${dest.rel}/` : serverId ? 'the server folder' : 'the data folder';
}

function finishBulk(serverId, actor, type, summary, details, outcome) {
  if (outcome.succeeded > 0) {
    recordEvent({ serverId: serverId || null, actor, type, summary, details });
    indexer.scheduleScan();
  }
}

function detailPaths(results) {
  return results
    .filter((r) => r.ok)
    .map((r) => r.path)
    .slice(0, MAX_BULK_DETAIL_PATHS);
}

/** Delete many items. Returns { results, succeeded, failed, freedBytes }. */
async function removeMany(serverId, paths, { actor = 'system' } = {}) {
  const items = normalizeSelection(serverId, paths);
  const outcome = await runBulk(serverId, items, (item) => remove(serverId, item, { actor, quiet: true }));
  const freedBytes = outcome.results.reduce((n, r) => n + (r.ok ? r.freedBytes : 0), 0);
  finishBulk(
    serverId,
    actor,
    'files-bulk-deleted',
    bulkSummary(`Deleted ${plural(outcome.succeeded)} (${humanBytes(freedBytes)} freed).`, outcome.failed, 'deleted'),
    { count: outcome.succeeded, failed: outcome.failed, freedBytes, paths: detailPaths(outcome.results) },
    outcome
  );
  return { ...outcome, freedBytes };
}

/** Move many items into one destination folder. */
async function moveMany(serverId, paths, destRel, { actor = 'system' } = {}) {
  const items = normalizeSelection(serverId, paths);
  const dest = resolvePath(serverId, destRel);
  const outcome = await runBulk(serverId, items, (item) => move(serverId, item, destRel, { actor, quiet: true }));
  finishBulk(
    serverId,
    actor,
    'files-bulk-moved',
    bulkSummary(`Moved ${plural(outcome.succeeded)} to ${destLabel(serverId, dest)}.`, outcome.failed, 'moved'),
    { count: outcome.succeeded, failed: outcome.failed, to: dest.rel, paths: detailPaths(outcome.results) },
    outcome
  );
  return outcome;
}

/** Copy many items into one destination folder. */
async function copyMany(serverId, paths, destRel, { actor = 'system' } = {}) {
  const items = normalizeSelection(serverId, paths);
  const dest = resolvePath(serverId, destRel);
  const outcome = await runBulk(serverId, items, (item) => copy(serverId, item, destRel, { actor, quiet: true }));
  finishBulk(
    serverId,
    actor,
    'files-bulk-copied',
    bulkSummary(`Copied ${plural(outcome.succeeded)} to ${destLabel(serverId, dest)}.`, outcome.failed, 'copied'),
    { count: outcome.succeeded, failed: outcome.failed, to: dest.rel, paths: detailPaths(outcome.results) },
    outcome
  );
  return outcome;
}

/**
 * Validate a selection for a zip download and flatten it to files. Symlinks are
 * skipped (never followed out of the data folder), matching dirSize/copy.
 * @returns {Promise<{files: {abs: string, name: string}[], emptyDirs: string[], totalBytes: number}>}
 *   `name` is the zip entry path; each item keeps its base name as the top level.
 */
async function zipEntries(serverId, paths, { maxBytes = MAX_ZIP_BYTES } = {}) {
  const items = normalizeSelection(serverId, paths);
  const tooBig = () =>
    httpError(413, 'That selection is too large to download as one zip. Download fewer items at a time.');
  const filesOut = [];
  const emptyDirs = [];
  const taken = new Set();
  const secret = tokenFileAbs(serverId); // never zipped from inside a selected folder
  let totalBytes = 0;

  const walk = async (abs, name) => {
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    let any = false;
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childAbs = path.join(abs, e.name);
      const childName = `${name}/${e.name}`;
      if (e.isDirectory()) {
        any = true;
        await walk(childAbs, childName);
      } else if (e.isFile()) {
        if (secret.has(childAbs)) continue;
        any = true;
        const st = await fsp.stat(childAbs).catch(() => null);
        if (!st) continue;
        totalBytes += st.size;
        if (totalBytes > maxBytes) throw tooBig();
        filesOut.push({ abs: childAbs, name: childName });
      }
    }
    if (!any) emptyDirs.push(name);
  };

  for (const item of items) {
    const { abs, rel } = resolvePath(serverId, item);
    guardProtected(serverId, rel);
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) throw httpError(404, 'One of the selected items was not found.');
    if (st.isSymbolicLink()) continue;
    // Two selected items can share a base name (a/x.txt and b/x.txt): keep both.
    const base = path.basename(abs);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    taken.add(name);
    if (st.isDirectory()) {
      await walk(abs, name);
    } else {
      totalBytes += st.size;
      if (totalBytes > maxBytes) throw tooBig();
      filesOut.push({ abs, name });
    }
  }
  if (!filesOut.length && !emptyDirs.length) throw httpError(400, 'There is nothing to download in that selection.');
  return { files: filesOut, emptyDirs, totalBytes };
}

/** Move an uploaded tmp file into a target directory (used by the upload routes). */
async function acceptUpload(serverId, destRel, tmpAbs, originalName, { actor = 'system' } = {}) {
  const dest = resolvePath(serverId, destRel);
  const dst = await fsp.stat(dest.abs).catch(() => null);
  if (!dst || !dst.isDirectory()) throw httpError(400, 'Destination folder not found.');
  const filename = sanitizeName(originalName || 'upload.bin');
  // An upload lands with rename(), which overwrites: one named panel.db-wal or
  // .session-secret at the data root would corrupt the database or replace the
  // secrets key.
  guardProtected(serverId, dest.rel ? `${dest.rel}/${filename}` : filename);
  const size = (await fsp.stat(tmpAbs)).size;
  assertRoom(serverId, size);

  const target = path.join(dest.abs, filename);
  await moveEntry(tmpAbs, target);
  const rel = dest.rel ? `${dest.rel}/${filename}` : filename;
  recordEvent({
    serverId: serverId || null,
    actor,
    type: 'file-uploaded',
    summary: `Uploaded: ${rel} (${humanBytes(size)}).`,
    details: { path: rel, sizeBytes: size },
  });
  indexer.scheduleScan();
  return { path: rel, name: filename, size };
}

/** Absolute path + stat for downloads (files only). */
async function statFile(serverId, relPath) {
  const { abs, rel } = resolvePath(serverId, relPath);
  guardProtected(serverId, rel); // no downloading panel.db either
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw httpError(404, 'File not found.');
  return { abs, rel, size: st.size, name: path.basename(abs) };
}

// ---------------------------------------------------------------------------

function assertRoom(serverId, aboutToAddBytes) {
  if (!serverId) return;
  const server = db.get('SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL', serverId);
  if (server) indexer.assertUnderQuota(server, aboutToAddBytes);
}

async function assertDiskFree(bytes) {
  const { free } = await indexer.diskFree().catch(() => ({ free: Infinity }));
  if (free < bytes * 1.1) throw httpError(507, `Not enough disk space (~${humanBytes(bytes)} needed).`);
}

async function dirSize(abs) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  const files = [];
  for (const e of entries) {
    const child = path.join(abs, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += await dirSize(child);
    else if (e.isFile()) files.push(child);
  }
  return total + (await sumFileSizes(files));
}

async function moveEntry(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\0]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 180);
  if (!clean || clean === '.' || clean === '..') throw httpError(400, 'Invalid name');
  return clean;
}

function formatWhen(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function humanBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Grep for a plain substring across text files under the scope. Bounded on every
 * axis (files scanned, per-file size, total matches) so a search over a big
 * modpack tree can't run away. Returns { query, matches:[{path,line,col,text}],
 * truncated, filesScanned }.
 */
async function searchFiles(serverId, query, { caseSensitive = false, subdir = '' } = {}) {
  const needle = String(query || '');
  if (needle.length < 2) throw httpError(400, 'Enter at least 2 characters to search for.');
  if (needle.length > 200) throw httpError(400, 'Search text is too long.');
  const { abs: rootAbs, rel: rootRel } = resolvePath(serverId, subdir);
  const rootStat = await fsp.stat(rootAbs).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) throw httpError(404, 'Folder not found.');

  const secret = tokenFileAbs(serverId);
  const hay = caseSensitive ? null : needle.toLowerCase();
  const matches = [];
  let filesScanned = 0;
  let truncated = false;

  const walk = async (dirAbs, dirRel) => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (!serverId && isProtectedGlobal(childRel)) continue;
      const childAbs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        await walk(childAbs, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (secret.has(childAbs)) continue;
      if (++filesScanned > SEARCH_MAX_FILES_SCANNED) {
        truncated = true;
        return;
      }
      let st;
      try {
        st = await fsp.stat(childAbs);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > SEARCH_MAX_FILE_BYTES) continue;
      let buf;
      try {
        buf = await fsp.readFile(childAbs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const idx = caseSensitive ? line.indexOf(needle) : line.toLowerCase().indexOf(hay);
        if (idx === -1) continue;
        matches.push({
          // path is relative to the manager's root, so the client can open it directly
          path: rootRel ? `${rootRel}/${childRel}`.replace(/^\/+/, '') : childRel,
          line: i + 1,
          col: idx + 1,
          text: line.length > 300 ? `${line.slice(0, 300)}…` : line,
        });
        if (matches.length >= SEARCH_MAX_MATCHES) {
          truncated = true;
          return;
        }
        break; // one hit per line is enough for a results list
      }
    }
  };

  await walk(rootAbs, '');
  return { query: needle, matches, truncated, filesScanned };
}

module.exports = {
  list,
  readText,
  writeText,
  searchFiles,
  mkdir,
  rename,
  move,
  copy,
  remove,
  removeMany,
  moveMany,
  copyMany,
  zipEntries,
  MAX_BULK_ITEMS,
  MAX_ZIP_BYTES,
  acceptUpload,
  statFile,
  resolvePath,
  assertRoom,
  assertDiskFree,
};
