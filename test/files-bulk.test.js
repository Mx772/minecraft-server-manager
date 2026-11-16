'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const config = require('../src/config');
const files = require('../src/services/files');
const app = require('./helpers/app');
const { readZipIndex } = require('../src/utils/zip');

const SID = 'srv_filesbulk';
let root;

const eventsOfType = (type) => db.all('SELECT * FROM events WHERE type = ?', type);

function fresh() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'dest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dir', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(root, 'b.txt'), 'bbb');
  fs.writeFileSync(path.join(root, 'dir', 'inner', 'c.txt'), 'ccc');
  db.run('DELETE FROM events');
}

test.before(() => {
  db.run(
    `INSERT OR IGNORE INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, status)
     VALUES (?, 'Bulk', 'PAPER', 25681, 26681, 'x', 1024, 1536, 'stopped')`,
    SID
  );
  root = path.join(config.dataDir, 'servers', SID);
});

test('removeMany deletes everything, dedupes nested paths, records one event', async () => {
  fresh();
  const r = await files.removeMany(SID, ['a.txt', 'dir', 'dir/inner/c.txt', 'a.txt', './b.txt'], { actor: 'tester' });
  assert.equal(r.succeeded, 3);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.results.map((x) => x.path).sort(), ['a.txt', 'b.txt', 'dir']);
  assert.equal(r.freedBytes, 9);
  assert.equal(fs.existsSync(path.join(root, 'dir')), false);
  assert.equal(eventsOfType('files-bulk-deleted').length, 1);
  assert.equal(eventsOfType('file-deleted').length, 0);
  assert.match(eventsOfType('files-bulk-deleted')[0].summary, /^Deleted 3 items \(\d/);
  assert.match(eventsOfType('files-bulk-deleted')[0].summary, /\.$/);
});

test('partial failure is reported per item and the rest still run', async () => {
  fresh();
  const r = await files.removeMany(SID, ['a.txt', 'missing.txt', '../x', 'b.txt']);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.results.find((x) => x.path === 'missing.txt').ok, false);
  assert.equal(r.results.find((x) => x.path === '../x').ok, false);
  assert.equal(typeof r.results.find((x) => x.path === '../x').error, 'string');
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  assert.match(eventsOfType('files-bulk-deleted')[0].summary, /2 items could not be deleted\.$/);
});

test('moveMany moves, reports conflicts, and records one event', async () => {
  fresh();
  fs.writeFileSync(path.join(root, 'dest', 'b.txt'), 'existing');
  const r = await files.moveMany(SID, ['a.txt', 'b.txt'], 'dest', { actor: 'tester' });
  assert.equal(r.succeeded, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.results.find((x) => x.path === 'b.txt').ok, false);
  assert.ok(fs.existsSync(path.join(root, 'dest', 'a.txt')));
  assert.ok(fs.existsSync(path.join(root, 'b.txt')));
  const ev = eventsOfType('files-bulk-moved');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, 'Moved 1 item to dest/. 1 item could not be moved.');
  assert.equal(eventsOfType('file-moved').length, 0);
});

test('moveMany refuses to move a folder into itself for that item only', async () => {
  fresh();
  const r = await files.moveMany(SID, ['dir', 'a.txt'], 'dir/inner');
  assert.equal(r.results.find((x) => x.path === 'dir').ok, false);
  assert.equal(r.results.find((x) => x.path === 'a.txt').ok, true);
});

test('copyMany copies and records one event', async () => {
  fresh();
  const r = await files.copyMany(SID, ['a.txt', 'dir'], 'dest', { actor: 'tester' });
  assert.equal(r.succeeded, 2);
  assert.ok(fs.existsSync(path.join(root, 'dest', 'dir', 'inner', 'c.txt')));
  assert.ok(fs.existsSync(path.join(root, 'a.txt')));
  const ev = eventsOfType('files-bulk-copied');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, 'Copied 2 items to dest/.');
  assert.equal(eventsOfType('file-copied').length, 0);
});

test('no event is recorded when every item fails', async () => {
  fresh();
  const r = await files.removeMany(SID, ['nope']);
  assert.equal(r.succeeded, 0);
  assert.equal(eventsOfType('files-bulk-deleted').length, 0);
});

test('selection validation: empty, too many, root', async () => {
  await assert.rejects(files.removeMany(SID, []), { status: 400 });
  const many = Array.from({ length: files.MAX_BULK_ITEMS + 1 }, (_, i) => `f${i}`);
  await assert.rejects(files.removeMany(SID, many), { status: 400, message: 'Select at most 500 items at a time.' });
  await assert.rejects(files.removeMany(SID, ['']), { status: 400 });
  await assert.rejects(files.moveMany(SID, ['.'], 'dest'), { status: 400 });
});

test('global scope rejects protected panel files per item', async () => {
  const r = await files.copyMany(null, ['panel.db', '.session-secret'], 'tmp');
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 2);
  assert.ok(r.results.every((x) => !x.ok));
  await assert.rejects(files.zipEntries(null, ['panel.db']), { status: 403 });
});

test('zipEntries flattens folders, 404s on missing, and enforces the size cap', async () => {
  fresh();
  const z = await files.zipEntries(SID, ['a.txt', 'dir']);
  assert.deepEqual(z.files.map((f) => f.name).sort(), ['a.txt', 'dir/inner/c.txt']);
  assert.equal(z.totalBytes, 6);
  await assert.rejects(files.zipEntries(SID, ['a.txt', 'gone']), { status: 404 });
  await assert.rejects(files.zipEntries(SID, ['dir'], { maxBytes: 2 }), { status: 413 });
  await assert.rejects(files.zipEntries(SID, ['../x']), { status: 400 });
});

test('zipEntries skips symlinks', async (t) => {
  fresh();
  try {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'dir', 'link'));
  } catch {
    return t.skip('symlinks unavailable');
  }
  const z = await files.zipEntries(SID, ['dir']);
  assert.deepEqual(
    z.files.map((f) => f.name),
    ['dir/inner/c.txt']
  );
});

test('routes: bulk delete and download-zip', async (t) => {
  fresh();
  const base = await app.start();
  t.after(() => app.stop());
  const cookie = await app.adminCookie();
  const url = `/api/servers/${SID}/files`;

  const z = await fetch(base + `${url}/download-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams([
      ['paths', 'a.txt'],
      ['paths', 'dir'],
    ]),
  });
  assert.equal(z.status, 200);
  assert.match(z.headers.get('content-type'), /application\/zip/);
  assert.match(z.headers.get('content-disposition'), /Bulk-files\.zip/);
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msm-zip-')), 'out.zip');
  fs.writeFileSync(zipPath, Buffer.from(await z.arrayBuffer()));
  const idx = await readZipIndex(zipPath);
  const names = idx.entries.map((e) => e.name);
  assert.ok(names.includes('a.txt'));
  assert.ok(names.includes('dir/inner/c.txt'));

  const single = await fetch(base + `${url}/download-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ paths: 'a.txt' }),
  });
  assert.equal(single.status, 200);
  await single.arrayBuffer();

  const bad = await app.req('POST', `${url}/download-zip`, { cookie, body: { paths: ['nope'] } });
  assert.equal(bad.status, 404);

  const r = await app.req('POST', `${url}/bulk/delete`, { cookie, body: { paths: ['a.txt', 'nope'] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.succeeded, 1);
  assert.equal(r.json.failed, 1);
  assert.equal(r.json.results.length, 2);

  const m = await app.req('POST', `${url}/bulk/move`, { cookie, body: { paths: ['b.txt'], dest: 'dest' } });
  assert.equal(m.json.ok, true);
  const bad2 = await app.req('POST', `${url}/bulk/copy`, { cookie, body: { paths: [], dest: '' } });
  assert.equal(bad2.status, 400);
});
