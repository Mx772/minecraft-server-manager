'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const app = require('./helpers/app');
const db = require('../src/db');
const { dataPath } = require('../src/storage/pathGuard');

const SID = 'srv_crash01';
let cookie;

function seedCrash(id, filename, { viewed = 0, withFile = true } = {}) {
  db.run(
    `INSERT INTO crash_reports (id, server_id, filename, file_mtime, size_bytes, summary, exception, suspected_json, viewed)
     VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z', 10, 'Boom', 'java.lang.Boom', '[]', ?)`,
    id,
    SID,
    filename,
    viewed
  );
  if (withFile) {
    const dir = dataPath('servers', SID, 'crash-reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dataPath('servers', SID, 'crash-reports', filename), '---- Minecraft Crash Report ----\n');
  }
}

const unread = () => db.get('SELECT COUNT(*) AS n FROM crash_reports WHERE server_id = ? AND viewed = 0', SID).n;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
  seedCrash('cr_present1', 'crash-present.txt');
  seedCrash('cr_missing1', 'crash-missing.txt', { withFile: false });
  seedCrash('cr_other001', 'crash-other.txt');
});

test.after(async () => {
  await app.stop();
});

test('opening a report whose file is gone is a friendly 404 that still marks it read', async () => {
  const r = await app.req('GET', `/api/servers/${SID}/crashes/cr_missing1/text`, { cookie });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /no longer in the server folder/);
  assert.equal(db.get('SELECT viewed FROM crash_reports WHERE id = ?', 'cr_missing1').viewed, 1);
});

test('opening a present report returns its text and marks it read', async () => {
  const r = await app.req('GET', `/api/servers/${SID}/crashes/cr_present1/text`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(db.get('SELECT viewed FROM crash_reports WHERE id = ?', 'cr_present1').viewed, 1);
});

test('POST /viewed marks every unread report for the server as read', async () => {
  assert.equal(unread(), 1);
  const r = await app.req('POST', `/api/servers/${SID}/crashes/viewed`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.marked, 1);
  assert.equal(unread(), 0);
});
