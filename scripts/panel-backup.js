'use strict';

// Take (or list) a snapshot of the panel's own state: the database plus the
// key files it needs. Server worlds are not included. Safe while the panel is
// running.
//
// Usage:
//   node scripts/panel-backup.js          take a snapshot
//   node scripts/panel-backup.js --list   list existing snapshots
//
// In Docker:
//   docker exec <panel container> node scripts/panel-backup.js

const panelBackup = require('../src/storage/panelBackup');

if (process.argv.includes('--list')) {
  const rows = panelBackup.list();
  if (!rows.length) console.log('No panel snapshots yet.');
  for (const r of rows) console.log(`${r.name}  (${r.kind}${r.appVersion ? `, v${r.appVersion}` : ''})`);
} else {
  const name = panelBackup.snapshotSync('manual');
  console.log(`Saved a panel snapshot to backups/_panel/${name} in the data folder.`);
}
