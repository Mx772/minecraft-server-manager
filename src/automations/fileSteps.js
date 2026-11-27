'use strict';

// The Copy Files and Delete Files steps: path rules, the planner (which reads the
// disk but never writes it), and the runner (which acts on exactly the plan).
// Every path is inside the target server's own folder, resolved the way the Files
// tab resolves it. Links are never followed: a link anywhere along a path refuses
// the step, one inside a tree is left out, and every file operation checks again
// right before it happens, since a process in the container can swap a folder for
// a link between the plan and the run.

const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const httpError = require('../utils/httpError');
const db = require('../db');
const { recordEvent } = require('../events');
const { guardOp } = require('../services/opLock');
const logger = require('../logger')(path.basename(__filename));
const { compileGlob, GlobError } = require('./glob');

const MAX_COPY_FILES = 5000;
const MAX_COPY_BYTES = 2 * 1024 ** 3;
const MAX_DELETE_FILES = 5000;
// Files and folders one step may look at (a field so a test can lower it).
const LIMITS = { visited: 50_000 };
const MAX_PATH_LENGTH = 300;
const DIM_SUFFIXES = ['_nether', '_the_end'];
// Folders a pack install rewrites on every start.
const PACK_OWNED_FOLDERS = ['config', 'kubejs', 'defaultconfigs', 'mods'];
// Copies are written to a hidden temporary name beside the destination, then renamed
// over it, so a copy that is interrupted never costs the file already there.
const TEMP_NAME = /^\..+\.msm-[a-z0-9]+\.tmp$/;
const LABELS = { 'copy-files': 'Copy Files', 'delete-files': 'Delete Files' };

// ---------------------------------------------------------------------------
// Parameters

/** A folder-relative path: no `..`, not absolute, no NUL, short. Normalised to forward slashes; the folder itself is ''. */
const pathParam = z
  .string()
  .transform((raw) =>
    raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/\/$/, '')
  )
  .superRefine((p, ctx) => {
    const fail = (message) => ctx.addIssue({ code: 'custom', message });
    if (p.length > MAX_PATH_LENGTH) fail(`Paths can be up to ${MAX_PATH_LENGTH} characters.`);
    else if (p.includes('\0')) fail('A path cannot contain a null character.');
    else if (p.startsWith('/') || /^[a-zA-Z]:/.test(p))
      fail("A path must be inside the server's folder, not absolute.");
    else if (p.split('/').includes('..')) fail('A path cannot use ".." to leave its folder.');
  })
  .transform((p) => (p === '.' ? '' : p));

const globParam = z
  .string()
  .trim()
  .superRefine((g, ctx) => {
    try {
      compileGlob(g);
    } catch (err) {
      if (!(err instanceof GlobError)) throw err;
      ctx.addIssue({ code: 'custom', message: err.message });
    }
  });

const copyParams = z.object({
  from: pathParam,
  to: pathParam,
  mode: z.enum(['overwrite', 'skip-existing', 'only-if-newer']).default('overwrite'),
  include: globParam.default('**'),
});

const deleteParams = z.object({
  path: pathParam.refine((p) => p !== '', {
    message: 'Delete Files needs a folder inside the server, such as logs.',
  }),
  include: globParam,
});

// ---------------------------------------------------------------------------
// Protection

/** One path as comparable segments: lowercase, trailing dots and spaces trimmed (a false match is fine). */
const normSegments = (rel) =>
  String(rel)
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg
        .normalize('NFC')
        .toLowerCase()
        .replace(/[ .]+$/, '')
    );

/** True when `segs` is `prefix` or lies inside it. */
const isInside = (segs, prefix) => prefix.length <= segs.length && prefix.every((seg, i) => seg === segs[i]);

// How many entries of a folder are looked at when finding worlds: a folder with
// thousands of subfolders is a mods or plugins folder, not a saves folder.
const TOP_FOLDERS_LOOKED_AT = 1000;
const SUB_FOLDERS_LOOKED_AT = 200;

/** Names of up to `limit` subfolders, read entry by entry so a huge folder is never listed whole. */
async function listFolders(abs, limit) {
  const dir = await fsp.opendir(abs);
  const names = [];
  let seen = 0;
  try {
    for await (const e of dir) {
      if (e.isDirectory()) names.push(e.name);
      if (++seen >= limit) break;
    }
  } finally {
    await dir.close().catch(() => {}); // closed already when the loop ended early
  }
  return names;
}

/**
 * Paths no file step may touch, as segment lists: every folder that looks like a
 * world (a level.dat, level.dat_old or region folder, at the top or one level down), the configured level (which may be a
 * nested path), `world`, and each one's Nether and End folders.
 * @returns {Promise<string[][]>}
 */
async function worldPrefixes(serverId, base) {
  const names = new Set(['world']);
  const server = require('../services/servers').getServer(serverId);
  const level = server ? require('../services/worlds').activeLevelName(server) : '';
  if (level) names.add(String(level).replace(/\\/g, '/'));
  const exists = (p) =>
    fsp.stat(p).then(
      () => true,
      () => false
    );
  // A folder is a world when it holds a level.dat (or its backup copy) or a region
  // folder, at the top of the server folder or one level down (saves/old).
  const isWorld = async (dir) =>
    (await exists(path.join(dir, 'level.dat'))) ||
    (await exists(path.join(dir, 'level.dat_old'))) ||
    (await exists(path.join(dir, 'region')));
  try {
    for (const top of await listFolders(base, TOP_FOLDERS_LOOKED_AT)) {
      const topAbs = path.join(base, top);
      if (await isWorld(topAbs)) names.add(top);
      for (const sub of await listFolders(topAbs, SUB_FOLDERS_LOOKED_AT)) {
        if (await isWorld(path.join(topAbs, sub))) names.add(`${top}/${sub}`);
      }
    }
  } catch {
    /* no server folder yet, or one we cannot read */
  }
  const out = [];
  for (const name of names) {
    out.push(normSegments(name));
    for (const suffix of DIM_SUFFIXES) out.push(normSegments(name + suffix));
  }
  return out.filter((segs) => segs.length);
}

/** Context for one server: its root, what is protected, and the file helpers. Built once per plan, run, or dry run. */
async function contextFor(serverId) {
  if (!serverId) throw httpError(400, 'File steps need a server to act on.');
  const files = require('../services/files');
  const { base } = files.resolvePath(serverId, '');
  const worlds = await worldPrefixes(serverId, base);
  const tokens = require('../integrations/chatBridge').protectedLivePaths(serverId).map(normSegments);
  return {
    files,
    base,
    resolve: (rel) => files.resolvePath(serverId, rel),
    /** The path is, or lies inside, a world folder or a live bridge token file. */
    isProtected: (rel) => {
      const segs = normSegments(rel);
      return worlds.some((w) => isInside(segs, w)) || tokens.some((t) => isInside(segs, t));
    },
  };
}

const PROTECTED_MSG = (label) => `${label} can't touch a world folder or the panel's own files.`;

// ---------------------------------------------------------------------------
// Links and errors

/**
 * Refuse a path that goes through a link anywhere from the server folder down.
 * A part that does not exist yet is fine.
 */
async function assertNoLinks(base, rel, label) {
  let current = base;
  let walked = '';
  for (const seg of rel.split('/').filter(Boolean)) {
    current = path.join(current, seg);
    walked = walked ? `${walked}/${seg}` : seg;
    const st = await fsp.lstat(current).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) {
      throw httpError(
        400,
        `${label} can't use "${walked}", because it goes through a link, which automations don't follow.`
      );
    }
  }
}

const FS_PROBLEMS = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EROFS',
  'ENOSPC',
  'EMFILE',
  'EBUSY',
  'ELOOP',
]);

/** A sentence for anything that went wrong on disk or in the path guard; other errors pass through. */
function friendly(err, label, base) {
  if (!err || typeof err !== 'object') return err;
  if (err.name === 'PathEscapeError') {
    return httpError(
      400,
      `${label} can't use "${String(err.attempted || '').slice(0, 80)}", because it leaves the server's folder.`
    );
  }
  if (typeof err.code === 'string' && FS_PROBLEMS.has(err.code)) {
    const rel = err.path && base ? path.relative(base, String(err.path)).split(path.sep).join('/') : '';
    const where = rel && !rel.startsWith('..') ? ` "${rel}"` : ' a file';
    const why =
      err.code === 'ENOSPC'
        ? 'the disk is full'
        : err.code === 'ENOENT'
          ? 'it is gone'
          : err.code === 'EEXIST'
            ? 'it appeared during the step'
            : err.code === 'ELOOP'
              ? "it is a link, which automations don't follow"
              : "the panel doesn't have permission";
    return httpError(400, `${label} can't use${where}, because ${why}.`);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Walking a tree (lstat, so a link is never followed)

/**
 * @typedef {{ rel: string, abs: string, size: number, mtimeMs: number, dev: number, ino: number }} FileEntry
 */

/** Counts what a step has looked at, so a huge tree that matches nothing cannot stall the panel. */
function makeBudget(label) {
  let visited = 0;
  return () => {
    if (++visited > LIMITS.visited) {
      throw httpError(
        400,
        `${label} looked at more than ${LIMITS.visited.toLocaleString('en-US')} files and folders, so it did not run. Pick a smaller folder.`
      );
    }
  };
}

/**
 * Every regular file under `startAbs`, as paths relative to it. Links, world
 * folders, and live token files are left out. Stops with a sentence once more
 * than `maxFiles` are found, before anything is written.
 * @returns {Promise<FileEntry[]>}
 */
async function walkFiles(ctx, startAbs, startRel, maxFiles, overCap, tick) {
  /** @type {FileEntry[]} */
  const out = [];
  async function visit(abs, rel) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      tick();
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const serverRel = startRel ? `${startRel}/${childRel}` : childRel;
      if (e.isSymbolicLink() || TEMP_NAME.test(e.name) || ctx.isProtected(serverRel)) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) await visit(childAbs, childRel);
      else if (e.isFile()) {
        const st = await fsp.stat(childAbs);
        out.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
        if (out.length > maxFiles) throw overCap();
      }
    }
  }
  await visit(startAbs, '');
  return out;
}

// ---------------------------------------------------------------------------
// Planning

/**
 * @typedef {object} FilePlan
 * @property {string} action
 * @property {Array<{ path: string, change: 'create' | 'overwrite' | 'skip' | 'delete' }>} files
 * @property {{ files: number, bytes: number, create: number, overwrite: number, skip: number, delete: number, folders: number }} totals
 */

const emptyTotals = () => ({ files: 0, bytes: 0, create: 0, overwrite: 0, skip: 0, delete: 0, folders: 0 });
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const statOrNull = (abs) => fsp.lstat(abs).catch(() => null);

/** @returns {Promise<{ plan: FilePlan, ops: any[] }>} */
async function buildCopyPlan(serverId, params, ctx) {
  const label = LABELS['copy-files'];
  for (const rel of [params.from, params.to]) await assertNoLinks(ctx.base, rel, label);
  const from = ctx.resolve(params.from);
  const to = ctx.resolve(params.to);
  for (const r of [from, to]) if (ctx.isProtected(r.rel)) throw httpError(400, PROTECTED_MSG(label));
  const srcStat = await statOrNull(from.abs);
  if (!srcStat) throw httpError(400, `Copy Files can't find "${params.from || '.'}" in the server folder.`);
  const overCap = () =>
    httpError(
      400,
      `Copy Files would copy more than ${MAX_COPY_FILES.toLocaleString('en-US')} files, so it did not run. Pick a smaller folder or narrow the include pattern.`
    );
  const tick = makeBudget(label);

  /** @type {Array<{ srcRel: string, srcAbs: string, size: number, mtimeMs: number, dev: number, ino: number, destRel: string }>} */
  const items = [];
  const matcher = compileGlob(params.include);
  if (srcStat.isDirectory()) {
    if (from.rel === '' || to.rel === from.rel || `${to.rel}/`.startsWith(`${from.rel}/`)) {
      throw httpError(400, "Copy Files can't copy a folder into itself.");
    }
    const found = await walkFiles(ctx, from.abs, from.rel, Infinity, overCap, tick);
    for (const f of found) {
      if (!matcher.test(f.rel)) continue;
      items.push({
        srcRel: from.rel ? `${from.rel}/${f.rel}` : f.rel,
        srcAbs: f.abs,
        size: f.size,
        mtimeMs: f.mtimeMs,
        dev: f.dev,
        ino: f.ino,
        destRel: to.rel ? `${to.rel}/${f.rel}` : f.rel,
      });
      if (items.length > MAX_COPY_FILES) throw overCap();
    }
  } else if (srcStat.isFile()) {
    const name = path.posix.basename(from.rel);
    if (matcher.test(name)) {
      const toStat = await statOrNull(to.abs);
      const destRel = toStat && toStat.isDirectory() ? (to.rel ? `${to.rel}/${name}` : name) : to.rel;
      if (!destRel) throw httpError(400, "Copy Files can't copy a file over the server folder.");
      items.push({
        srcRel: from.rel,
        srcAbs: from.abs,
        size: srcStat.size,
        mtimeMs: srcStat.mtimeMs,
        dev: srcStat.dev,
        ino: srcStat.ino,
        destRel,
      });
    }
  }

  const totals = emptyTotals();
  for (const item of items) totals.bytes += item.size;
  if (totals.bytes > MAX_COPY_BYTES) {
    throw httpError(
      400,
      'Copy Files would copy more than 2 GB, so it did not run. Pick a smaller folder or narrow the include pattern.'
    );
  }

  const plan = { action: 'copy-files', files: [], totals };
  const ops = [];
  for (const item of items) {
    if (ctx.isProtected(item.destRel)) throw httpError(400, PROTECTED_MSG(label));
    const dest = ctx.resolve(item.destRel); // a link that leaves the server folder is refused here
    const existing = await statOrNull(dest.abs);
    if (existing && !existing.isFile())
      throw httpError(400, `Copy Files can't replace "${item.destRel}", since it is not a file.`);
    /** @type {'create' | 'overwrite' | 'skip'} */
    let change = 'create';
    if (existing) {
      if (params.mode === 'skip-existing') change = 'skip';
      else if (params.mode === 'only-if-newer') change = item.mtimeMs > existing.mtimeMs ? 'overwrite' : 'skip';
      else change = 'overwrite';
    }
    plan.files.push({ path: dest.rel, change });
    totals[change]++;
    totals.files++;
    if (change !== 'skip')
      ops.push({
        kind: 'copy',
        srcRel: item.srcRel,
        srcAbs: item.srcAbs,
        ident: { dev: item.dev, ino: item.ino },
        destRel: dest.rel,
        destAbs: dest.abs,
      });
  }
  return { plan, ops };
}

/** @returns {Promise<{ plan: FilePlan, ops: any[] }>} */
async function buildDeletePlan(serverId, params, ctx) {
  const label = LABELS['delete-files'];
  if (params.path === '') throw httpError(400, 'Delete Files needs a folder inside the server, such as logs.');
  await assertNoLinks(ctx.base, params.path, label);
  const target = ctx.resolve(params.path);
  if (ctx.isProtected(target.rel)) throw httpError(400, PROTECTED_MSG(label));
  const overCap = () =>
    httpError(
      400,
      `Delete Files would delete more than ${MAX_DELETE_FILES.toLocaleString('en-US')} files, so it did not run. Pick a smaller folder or narrow the include pattern.`
    );
  const tick = makeBudget(label);
  const stat = await statOrNull(target.abs);
  const plan = { action: 'delete-files', files: [], totals: emptyTotals() };
  const ops = [];
  if (!stat) return { plan, ops }; // nothing there, nothing to delete
  const matcher = compileGlob(params.include);

  if (stat.isFile()) {
    if (matcher.test(path.posix.basename(target.rel))) {
      plan.files.push({ path: target.rel, change: 'delete' });
      plan.totals.delete = plan.totals.files = 1;
      plan.totals.bytes = stat.size;
      ops.push({ kind: 'delete', rel: target.rel, abs: target.abs });
    }
    return { plan, ops };
  }

  let deleted = 0;
  /** Returns how many entries stay in the folder after this step, and how many files went. */
  async function visit(abs, rel) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    let remaining = 0;
    let removedHere = 0;
    for (const e of entries) {
      tick();
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const serverRel = `${target.rel}/${childRel}`;
      const childAbs = path.join(abs, e.name);
      if (TEMP_NAME.test(e.name)) {
        remaining++; // a leftover temporary copy is not ours to count or delete
      } else if (e.isSymbolicLink() || ctx.isProtected(serverRel)) {
        remaining++;
      } else if (e.isDirectory()) {
        const sub = await visit(childAbs, childRel);
        removedHere += sub.removed;
        // A folder goes only when this step emptied it, never one that was empty already.
        if (sub.remaining === 0 && sub.removed > 0) {
          plan.files.push({ path: `${serverRel}/`, change: 'delete' });
          plan.totals.folders++;
          ops.push({ kind: 'rmdir', rel: serverRel, abs: childAbs });
        } else remaining++;
      } else if (e.isFile() && matcher.test(childRel)) {
        const st = await fsp.stat(childAbs);
        plan.files.push({ path: serverRel, change: 'delete' });
        plan.totals.bytes += st.size;
        ops.push({ kind: 'delete', rel: serverRel, abs: childAbs });
        removedHere++;
        deleted++;
        if (deleted > MAX_DELETE_FILES) throw overCap();
      } else remaining++;
    }
    return { remaining, removed: removedHere };
  }
  await visit(target.abs, '');
  plan.totals.delete = plan.totals.files = deleted;
  // Files before the folders they emptied, so a folder is only removed once it is bare.
  ops.sort((a, b) => (a.kind === 'rmdir' ? 1 : 0) - (b.kind === 'rmdir' ? 1 : 0));
  return { plan, ops };
}

/** @param {string} serverId @param {{ action: string, params: any }} step */
async function buildPlan(serverId, step, existingCtx) {
  const label = LABELS[step.action];
  if (!label) throw httpError(400, 'That is not a file step.');
  try {
    const ctx = existingCtx || (await contextFor(serverId));
    return step.action === 'copy-files'
      ? await buildCopyPlan(serverId, copyParams.parse(step.params ?? {}), ctx)
      : await buildDeletePlan(serverId, deleteParams.parse(step.params ?? {}), ctx);
  } catch (err) {
    throw friendly(err, label, serverId ? safeBase(serverId) : '');
  }
}

function safeBase(serverId) {
  try {
    return require('../services/files').resolvePath(serverId, '').base;
  } catch {
    return '';
  }
}

/**
 * What a file step would do on a server, without touching the disk.
 * @param {string} serverId
 * @param {{ action: string, params: any }} step
 * @param {Awaited<ReturnType<typeof contextFor>>} [ctx] from `fileContext`, to plan several steps from one read of the server folder
 * @returns {Promise<FilePlan>}
 */
async function planFileStep(serverId, step, ctx) {
  if (!serverId) throw httpError(400, 'File steps need a server to act on.');
  return (await buildPlan(serverId, step, ctx)).plan;
}

/** The protection context for a server (worlds, token files), to share between plans. */
const fileContext = (serverId) => contextFor(serverId);

// ---------------------------------------------------------------------------
// Running

/**
 * Seams for tests: `beforeOp(op)` runs before each file operation (to slow a step
 * down), `afterPlan()` between the plan and the first write, and `afterCheck(op)` between a copy's last link check and the open of its
 * source (to swap something in that gap).
 * @type {{ beforeOp: null | ((op: any) => Promise<void> | void), afterCheck: null | ((op: any) => Promise<void> | void), afterPlan: null | (() => Promise<void> | void) }}
 */
const hooks = { beforeOp: null, afterCheck: null, afterPlan: null };

const CHUNK_BYTES = 1024 * 1024;

const capError = () =>
  Object.assign(
    httpError(
      400,
      'Copy Files grew past 2 GB while copying, so it stopped. Pick a smaller folder or narrow the include pattern.'
    ),
    { capHit: true }
  );

/** The step was told to stop (a start ran out of time, or the server is being stopped). */
function abortError(label, signal) {
  const why = typeof signal.reason === 'string' && signal.reason ? signal.reason : 'it was cancelled';
  return Object.assign(httpError(409, `${label} stopped before it finished, because ${why}.`), { aborted: true });
}

const linkError = (label, rel) =>
  httpError(400, `${label} can't use "${rel}", because it goes through a link, which automations don't follow.`);

/** True when `real` is inside (not equal to) `realBase`. */
function isInsideReal(real, realBase) {
  const rel = path.relative(realBase, real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Check, after a file is open, that it is the file we meant: a regular file that
 * really lives inside the server folder. On Linux the open descriptor's own path
 * answers that for every folder along the way; elsewhere the file must be the very
 * one the plan saw, and no part of its path may be a link.
 */
async function verifyOpened(handle, st, { base, realBase, rel, ident, label }) {
  if (!st.isFile()) throw httpError(400, `${label} can't use "${rel}", since it is no longer a file.`);
  if (process.platform === 'linux') {
    let real = null;
    try {
      real = fs.realpathSync(`/proc/self/fd/${handle.fd}`);
    } catch {
      /* no /proc: use the fallback */
    }
    if (real) {
      if (!isInsideReal(real, realBase)) throw linkError(label, rel);
      return;
    }
  }
  if (ident && (st.dev !== ident.dev || st.ino !== ident.ino)) throw linkError(label, rel);
  await assertNoLinks(base, rel, label);
}

/** Copy one file, checking just now that nothing along either path has turned into a link. */
async function copyOne(env, op, budget) {
  const { base, realBase, label, signal } = env;
  await assertNoLinks(base, op.srcRel, label);
  const planned = await fsp.lstat(op.srcAbs);
  if (!planned.isFile()) throw httpError(400, `${label} can't copy "${op.srcRel}", since it is no longer a file.`);
  if (hooks.afterCheck) await hooks.afterCheck(op);

  // O_NOFOLLOW refuses a link as the file itself; the open descriptor is then checked for the rest.
  const src = await fsp.open(op.srcAbs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let dest = null;
  /** @type {string | null} */
  let tempAbs = null;
  try {
    const st = await src.stat();
    await verifyOpened(src, st, { base, realBase, rel: op.srcRel, ident: op.ident, label });
    if (budget.bytes + st.size > MAX_COPY_BYTES) throw capError(); // a file that grew since the plan

    const parent = path.posix.dirname(op.destRel);
    const checkParent = async () => {
      if (parent !== '.') await assertNoLinks(base, parent, label);
      await assertParentInside(env, op.destAbs, op.destRel);
    };
    if (parent !== '.') await assertNoLinks(base, parent, label);
    await fsp.mkdir(path.dirname(op.destAbs), { recursive: true });
    await checkParent();
    const existing = await statOrNull(op.destAbs);
    if (existing && !existing.isFile()) {
      throw httpError(400, `${label} can't replace "${op.destRel}", since it is not a file.`);
    }
    // Written beside the destination under a temporary name ('wx' creates it or
    // fails: it will not write through a link planted there), then renamed over it.
    tempAbs = path.join(
      path.dirname(op.destAbs),
      `.${path.basename(op.destAbs)}.msm-${randomBytes(6).toString('hex')}.tmp`
    );
    dest = await fsp.open(tempAbs, 'wx');
    // Residual (not Linux): the descriptor check falls back to the link check on the
    // folders above, so a swap in the instant after the open is not caught there.
    await verifyOpened(dest, await dest.stat(), { base, realBase, rel: op.destRel, ident: null, label });

    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let position = 0; ; position += CHUNK_BYTES) {
      if (signal && signal.aborted) throw abortError(label, signal);
      const { bytesRead } = await src.read(buffer, 0, CHUNK_BYTES, position);
      if (!bytesRead) break;
      budget.bytes += bytesRead;
      if (budget.bytes > MAX_COPY_BYTES) throw capError();
      await dest.write(buffer, 0, bytesRead);
    }
    await dest.utimes(st.atime, st.mtime); // the copy keeps the original's modified time
    await dest.close();
    dest = null;
    await checkParent();
    const now = await statOrNull(op.destAbs);
    if (now && !now.isFile()) throw httpError(400, `${label} can't replace "${op.destRel}", since it is not a file.`);
    // rename replaces the destination entry itself (even a link), never what it points at.
    await fsp.rename(tempAbs, op.destAbs);
    tempAbs = null;
  } finally {
    await src.close().catch(() => {});
    if (dest) await dest.close().catch(() => {});
    if (tempAbs) {
      // Only the temporary copy goes, and only if its folder is still ours.
      await assertParentInside(env, tempAbs, op.destRel)
        .then(() => fsp.unlink(tempAbs))
        .catch(() => {});
    }
  }
}

/** The folder holding `abs` still really lives inside the server folder. */
async function assertParentInside(env, abs, rel) {
  let real;
  try {
    real = await fsp.realpath(path.dirname(abs));
  } catch {
    return; // gone: the delete finds nothing to do
  }
  if (real !== env.realBase && !isInsideReal(real, env.realBase)) throw linkError(env.label, rel);
}

async function deleteOne(env, op) {
  const { base, label } = env;
  await assertNoLinks(base, op.rel, label);
  await assertParentInside(env, op.abs, op.rel);
  const st = await fsp.lstat(op.abs).catch(() => null);
  if (!st) return; // already gone
  if (op.kind === 'delete') {
    if (!st.isFile()) throw httpError(400, `${label} won't delete "${op.rel}", since it is no longer a file.`);
    await fsp.unlink(op.abs); // removes a link itself, never what it points at
  } else {
    if (!st.isDirectory()) throw httpError(400, `${label} won't remove "${op.rel}", since it is no longer a folder.`);
    await fsp.rmdir(op.abs).catch((err) => {
      if (err.code !== 'ENOTEMPTY') throw err; // something new landed in it: leave it
    });
  }
}

const guardedRun = guardOp('change files', (_serverId, work) => work());

/** File steps holding a server's lock right now, so Stop and Kill can ask them to finish early. @type {Map<string, { controller: AbortController, settled: Promise<void> }>} */
const activeSteps = new Map();

/**
 * Ask the file step running on a server (not one inside a start) to stop at its
 * next file, and wait until it has let go of the server's lock.
 * @param {string} serverId
 * @param {string} reason a clause after "because", e.g. "the server is being stopped"
 * @param {number} [waitMs]
 * @returns {Promise<boolean>} whether a step was running and has now released the lock
 */
async function cancelFileStep(serverId, reason, waitMs = 15_000) {
  const entry = activeSteps.get(serverId);
  if (!entry) return false;
  entry.controller.abort(reason);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  await Promise.race([
    entry.settled,
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  await new Promise((resolve) => setImmediate(resolve)); // let the lock's holder return
  return !activeSteps.has(serverId);
}

/**
 * Plan a file step, then do exactly what the plan says, and record it. Runs
 * under the server's operation lock (so a restore or backup cleanup never has
 * its folder changed under it) unless the caller is a start that holds it. Stops
 * at the next file when `signal` aborts, or when Stop or Kill asks it to.
 * @param {string} serverId
 * @param {{ action: string, params: any }} step
 * @param {{ actor?: string, automationName: string, insideStartLock?: boolean, signal?: AbortSignal }} opts
 */
async function runFileStep(serverId, step, { actor = 'automation', automationName, insideStartLock = false, signal }) {
  if (!serverId) throw httpError(400, 'File steps need a server to act on.');
  if (insideStartLock) return executeFileStep(serverId, step, { actor, automationName, signal });
  return guardedRun(serverId, async () => {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    /** @type {() => void} */
    let release = () => {};
    const settled = new Promise((resolve) => (release = () => resolve(undefined)));
    activeSteps.set(serverId, { controller, settled });
    try {
      return await executeFileStep(serverId, step, { actor, automationName, signal: controller.signal });
    } finally {
      activeSteps.delete(serverId);
      release();
    }
  });
}

async function executeFileStep(serverId, step, { actor, automationName, signal }) {
  const label = LABELS[step.action];
  const ctx = await contextFor(serverId);
  const { plan, ops } = await buildPlan(serverId, step, ctx);
  if (hooks.afterPlan) await hooks.afterPlan();
  const { files, base } = ctx;
  const env = { base, realBase: fs.realpathSync(base), label, signal };
  const copied = step.action === 'copy-files';
  const failures = [];
  let done = 0;
  try {
    if (copied) {
      files.assertRoom(serverId, plan.totals.bytes);
      await files.assertDiskFree(plan.totals.bytes);
    }
    const budget = { bytes: 0 };
    for (const op of ops) {
      if (signal && signal.aborted) throw abortError(label, signal);
      if (hooks.beforeOp) await hooks.beforeOp(op);
      if (signal && signal.aborted) throw abortError(label, signal);
      try {
        if (op.kind === 'copy') await copyOne(env, op, budget);
        else await deleteOne(env, op);
        if (op.kind !== 'rmdir') done++;
      } catch (err) {
        if (err.capHit || err.aborted) throw err; // the whole step stops
        failures.push(friendly(err, label, base).message);
      }
    }
  } finally {
    if (done > 0) {
      recordEvent({
        serverId,
        actor,
        type: copied ? 'automation-files-copied' : 'automation-files-deleted',
        summary: `Automation ${automationName} ${copied ? 'copied' : 'deleted'} ${plural(done, 'file')}.`,
        details: { skipped: plan.totals.skip, bytes: plan.totals.bytes, failed: failures.length },
      });
      require('../storage/indexer').scheduleScan();
    }
  }
  logger.info('A file step finished.', { serverId, action: step.action, files: done, failed: failures.length });
  if (failures.length) {
    const first = failures[0].replace(/[.!?]+$/, '');
    throw httpError(
      400,
      `${label} could not finish ${plural(failures.length, 'file')} (${plural(done, 'file')} done): ${first}.`
    );
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Pack warning

/**
 * Sentences about file steps that a modpack server would undo, for the editor.
 * @param {{ trigger?: any, steps: Array<{ action: string, params?: any }> }} definition
 * @param {string[]} serverIds
 * @returns {string[]}
 */
function fileStepWarnings(definition, serverIds) {
  if (!definition.trigger || definition.trigger.type !== 'event' || definition.trigger.event !== 'before-start') {
    return [];
  }
  const packs = require('../services/packs');
  if (!serverIds.some((id) => packs.getPack(id))) return [];
  const out = new Set();
  for (const step of definition.steps) {
    if (step.action !== 'copy-files') continue;
    const parsed = copyParams.safeParse(step.params ?? {});
    if (!parsed.success) continue;
    const folder = parsed.data.to.split('/')[0];
    if (PACK_OWNED_FOLDERS.includes(folder)) {
      out.add(
        `Pack installs overwrite ${folder} when the server starts, so this copy may be undone. Use After A Pack Update, or add the files to Customizations instead.`
      );
    }
  }
  return [...out];
}

/** Ids of the existing servers a definition acts on. */
function targetServerIds(definition) {
  const t = definition.targets;
  if (!t || t.kind === 'panel') return [];
  if (t.kind === 'all') return db.all('SELECT id FROM servers WHERE deleted_at IS NULL').map((r) => r.id);
  return t.serverIds || [];
}

module.exports = {
  copyParams,
  deleteParams,
  planFileStep,
  fileContext,
  runFileStep,
  cancelFileStep,
  hooks,
  fileStepWarnings,
  targetServerIds,
  matchesGlob: (relPath, glob) => compileGlob(glob).test(relPath),
  LIMITS,
  MAX_COPY_FILES,
  MAX_COPY_BYTES,
  MAX_DELETE_FILES,
};
