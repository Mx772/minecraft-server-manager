'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const panelBackup = require('../src/storage/panelBackup');

const root = path.join(config.dataDir, 'backups', '_panel');

function snapshots(kind) {
  return panelBackup.list().filter((s) => s.kind === kind);
}

test('a fresh install does not take a pre-upgrade snapshot', () => {
  migrate();
  assert.equal(snapshots('pre-upgrade').length, 0);
});

test('pending migrations on an existing DB snapshot the old schema first', () => {
  migrate();
  fs.writeFileSync(path.join(config.dataDir, '.secret-key'), 'k'.repeat(44));
  // Pretend the newest migration has not run yet.
  const newest = db.get('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').version;
  db.run('DELETE FROM schema_migrations WHERE version = ?', newest);
  db.run(
    "INSERT INTO settings (key, value_json) VALUES ('snapshot-probe', '\"before\"') ON CONFLICT(key) DO UPDATE SET value_json = '\"before\"'"
  );

  // A stub migrations folder whose only pending entry is `newest`, so nothing real re-runs.
  const dir = fs.mkdtempSync(path.join(config.dataDir, 'mig-'));
  for (const v of db.all('SELECT version FROM schema_migrations').map((r) => r.version)) {
    if (/^\d{3}_/.test(v)) fs.writeFileSync(path.join(dir, `${v}.js`), 'module.exports = { up() {} };');
  }
  fs.writeFileSync(
    path.join(dir, `${newest}.js`),
    "module.exports = { up(db) { db.run(\"UPDATE settings SET value_json = 'after' WHERE key = 'snapshot-probe'\"); } };"
  );
  assert.equal(migrate({ dir }), 1);

  const [snap] = snapshots('pre-upgrade');
  assert.ok(snap, 'a pre-upgrade snapshot exists');
  const snapDir = path.join(root, snap.name);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.pending, [newest]);
  assert.ok(fs.existsSync(path.join(snapDir, '.secret-key')), 'the encryption key travels with the DB');

  // The copy holds the state from before the migration ran.
  const copy = new DatabaseSync(path.join(snapDir, 'panel.db'), { readOnly: true });
  try {
    assert.equal(
      copy.prepare("SELECT value_json FROM settings WHERE key = 'snapshot-probe'").get().value_json,
      '"before"'
    );
  } finally {
    copy.close();
  }
  assert.equal(db.get("SELECT value_json FROM settings WHERE key = 'snapshot-probe'").value_json, 'after');
});

test('retention keeps only the newest snapshots of each kind', () => {
  for (let i = 0; i < panelBackup.KEEP.manual + 3; i += 1) panelBackup.snapshotSync('manual');
  assert.equal(snapshots('manual').length, panelBackup.KEEP.manual);
  assert.ok(snapshots('pre-upgrade').length >= 1, 'pruning manual snapshots leaves pre-upgrade ones alone');
});

test('nightly snapshots prune legacy single-file copies too', async () => {
  fs.mkdirSync(root, { recursive: true });
  const old = new Date(Date.now() - 86_400_000 * 30);
  for (let i = 0; i < panelBackup.KEEP.nightly; i += 1) {
    const f = path.join(root, `panel-2026-01-${String(i + 1).padStart(2, '0')}-00-00-00.db`);
    fs.writeFileSync(f, '');
    fs.utimesSync(f, old, old);
  }
  await panelBackup.snapshotNightly();
  const legacy = fs.readdirSync(root).filter((f) => /^panel-.*\.db$/.test(f));
  assert.equal(legacy.length, panelBackup.KEEP.nightly - 1, 'the oldest legacy copy made room');
  assert.equal(snapshots('nightly').length, 1);
});
