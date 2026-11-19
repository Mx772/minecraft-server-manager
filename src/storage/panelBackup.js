'use strict';

// Snapshots of the panel's own state: the SQLite database plus the two key
// files it can't be used without (`.secret-key` decrypts stored secrets,
// `.session-secret` keeps sessions valid). Server worlds and server backups are
// deliberately left out - they have their own backup system.
//
// Each snapshot is one folder under data/backups/_panel/:
//
//   2026-11-17-14-05-00-pre-upgrade/
//     panel.db  .secret-key  .session-secret  manifest.json
//
// Restoring is "stop the panel, copy those files back into the data folder,
// start the matching image" (docs/backups.md).
//
// Kinds:
//   pre-upgrade  taken automatically before database migrations run, so a bad
//                image update can be rolled back even when the user only did
//                `docker compose pull && up -d`
//   nightly      the daily maintenance snapshot
//   manual       `node scripts/panel-backup.js`

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const { dataPath } = require('./pathGuard');

const KEEP = { nightly: 14, 'pre-upgrade': 5, manual: 10 };
const KEY_FILES = ['.secret-key', '.session-secret'];
// The single-file snapshots the nightly job wrote before snapshots became folders.
const LEGACY_FILE = /^panel-.*\.db$/;
const SNAPSHOT_DIR = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(nightly|pre-upgrade|manual)$/;

function backupRoot() {
  return dataPath('backups', '_panel');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

function appVersion() {
  try {
    return require('../../package.json').version || null;
  } catch {
    return null;
  }
}

/** Escape a path for a single-quoted SQLite string literal (VACUUM INTO takes no bound parameter here). */
function sqlString(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

/** A free folder name for this snapshot (two in the same second get a suffix). */
function newSnapshotDir(kind) {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true });
  const base = `${stamp()}-${kind}`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(root, name)); i += 1) name = `${base}-${i}`;
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return { name, dir };
}

function copyKeys(dir) {
  for (const f of KEY_FILES) {
    const src = path.join(config.dataDir, f);
    if (!fs.existsSync(src)) continue; // SESSION_SECRET may come from the environment instead
    fs.copyFileSync(src, path.join(dir, f));
    fs.chmodSync(path.join(dir, f), 0o600);
  }
}

function writeManifest(dir, kind, extra) {
  const manifest = { kind, createdAt: new Date().toISOString(), appVersion: appVersion(), ...extra };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Synchronous snapshot through the panel's own DB connection. Used at boot,
 * before migrations, when nothing else is running yet - and by the manual
 * script, which opens its own connection.
 * @param {'pre-upgrade' | 'manual'} kind
 * @param {Record<string, unknown>} [extra] Extra manifest fields.
 * @returns {string} The snapshot folder name.
 */
function snapshotSync(kind, extra = {}) {
  const { name, dir } = newSnapshotDir(kind);
  try {
    db.exec(`VACUUM INTO ${sqlString(path.join(dir, 'panel.db'))}`);
    copyKeys(dir);
    writeManifest(dir, kind, extra);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true }); // never leave a half snapshot that looks restorable
    throw err;
  }
  prune(kind);
  return name;
}

/**
 * The nightly snapshot. The database copy runs in a worker thread so a large
 * DB can't stall the event loop.
 * @returns {Promise<{ name: string, blockedMs: number }>}
 */
async function snapshotNightly() {
  const { name, dir } = newSnapshotDir('nightly');
  let blockedMs;
  try {
    blockedMs = await db.backupTo(path.join(dir, 'panel.db'));
    copyKeys(dir);
    writeManifest(dir, 'nightly', {});
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  prune('nightly');
  return { name, blockedMs };
}

/** Keep the newest KEEP[kind] snapshots of one kind. Legacy single-file snapshots count as nightly. */
function prune(kind) {
  const root = backupRoot();
  const entries = fs.readdirSync(root).filter((f) => {
    const m = SNAPSHOT_DIR.exec(f.replace(/-\d+$/, ''));
    if (m) return m[1] === kind;
    return kind === 'nightly' && LEGACY_FILE.test(f);
  });
  // Folder names and legacy file names both embed a sortable timestamp, but at
  // different offsets, so order by modification time instead.
  const byAge = entries
    .map((f) => ({ f, t: fs.statSync(path.join(root, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map((e) => e.f);
  for (const f of byAge.slice(0, Math.max(0, byAge.length - KEEP[kind]))) {
    fs.rmSync(path.join(root, f), { recursive: true, force: true });
  }
}

/** @returns {Array<{ name: string, kind: string, createdAt: string | null, appVersion: string | null }>} newest first */
function list() {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((f) => SNAPSHOT_DIR.test(f.replace(/-\d+$/, '')))
    .map((name) => {
      let manifest = {};
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(root, name, 'manifest.json'), 'utf8'));
      } catch {
        /* a manifest-less folder still lists */
      }
      return {
        name,
        kind: manifest.kind || name.replace(/^[\d-]{19}-/, '').replace(/-\d+$/, ''),
        createdAt: manifest.createdAt || null,
        appVersion: manifest.appVersion || null,
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

module.exports = { snapshotSync, snapshotNightly, list, prune, KEEP };
