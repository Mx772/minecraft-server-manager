'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const config = require('../src/config');
const containers = require('../src/docker/containers');
const servers = require('../src/services/servers');
const customizations = require('../src/services/customizations');
const app = require('./helpers/app');

const SID = 'srv_custom';
let root;
const eventsOfType = (type) => db.all('SELECT * FROM events WHERE type = ?', type);
const cdir = () => path.join(root, 'customizations');

function fresh() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'config', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'world'), { recursive: true });
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'x');
  fs.writeFileSync(path.join(root, 'config', 'foo.toml'), 'a=1');
  fs.writeFileSync(path.join(root, 'config', 'sub', 'bar.toml'), 'b=2');
  fs.writeFileSync(path.join(root, 'config', 'sub', 'baz.toml'), 'c=3');
  db.run('DELETE FROM events');
  db.run('DELETE FROM server_customizations');
  db.run('DELETE FROM server_packs');
  db.run('UPDATE servers SET pending_recreate = 0 WHERE id = ?', SID);
}

test.before(() => {
  db.run(
    `INSERT OR IGNORE INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, status)
     VALUES (?, 'Custom', 'PAPER', 25691, 26691, 'x', 1024, 1536, 'stopped')`,
    SID
  );
  root = path.join(config.dataDir, 'servers', SID);
});

test('add copies the live content, records sha and the pinned pack version', async () => {
  fresh();
  db.run(
    `INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name)
     VALUES (?, 'modrinth', 'p', 'P', 'v1', '1.0.0')`,
    SID
  );
  const out = await customizations.add(SID, ['config/foo.toml'], { actor: 'tester' });
  assert.equal(out.succeeded, 1);
  assert.equal(fs.readFileSync(path.join(cdir(), 'config', 'foo.toml'), 'utf8'), 'a=1');
  const row = db.get('SELECT * FROM server_customizations WHERE server_id = ? AND path = ?', SID, 'config/foo.toml');
  assert.equal(row.captured_sha256, require('node:crypto').createHash('sha256').update('a=1').digest('hex'));
  assert.equal(row.captured_pack_version_id, 'v1');
  assert.equal(row.captured_pack_version_name, '1.0.0');
  const ev = eventsOfType('customizations-added');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, 'Added 1 file to customizations.');
});

test('adding a folder adds every file inside it', async () => {
  fresh();
  const out = await customizations.add(SID, ['config/sub']);
  assert.equal(out.results[0].count, 2);
  assert.ok(fs.existsSync(path.join(cdir(), 'config', 'sub', 'bar.toml')));
  assert.ok(fs.existsSync(path.join(cdir(), 'config', 'sub', 'baz.toml')));
  assert.equal(eventsOfType('customizations-added').length, 1);
});

test('add refuses customizations, the world, the root and escapes per item', async () => {
  fresh();
  fs.mkdirSync(cdir(), { recursive: true });
  fs.writeFileSync(path.join(cdir(), 'x.txt'), 'x');
  const out = await customizations.add(SID, [
    'customizations/x.txt',
    'world',
    'world/level.dat',
    '',
    '../../etc',
    'config/foo.toml',
  ]);
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 5);
  assert.ok(out.results.filter((r) => !r.ok).every((r) => r.error));
  assert.deepEqual(
    out.results.filter((r) => r.ok).map((r) => r.path),
    ['config/foo.toml']
  );
});

test('re-adding overwrites the earlier copy', async () => {
  fresh();
  await customizations.add(SID, ['config/foo.toml']);
  fs.writeFileSync(path.join(root, 'config', 'foo.toml'), 'a=2');
  await customizations.add(SID, ['config/foo.toml']);
  assert.equal(fs.readFileSync(path.join(cdir(), 'config', 'foo.toml'), 'utf8'), 'a=2');
});

test('list reports applied vs pending', async () => {
  fresh();
  await customizations.add(SID, ['config/foo.toml', 'config/sub/bar.toml']);
  fs.writeFileSync(path.join(root, 'config', 'foo.toml'), 'pack update');
  const list = await customizations.list(SID);
  const byPath = Object.fromEntries(list.map((c) => [c.path, c]));
  assert.equal(byPath['config/foo.toml'].state, 'pending');
  assert.equal(byPath['config/sub/bar.toml'].state, 'applied');
  fs.rmSync(path.join(root, 'config', 'sub', 'bar.toml'));
  assert.equal((await customizations.list(SID)).find((c) => c.path === 'config/sub/bar.toml').state, 'pending');
  assert.deepEqual([...(await customizations.customizedPaths(SID))].sort(), ['config/foo.toml', 'config/sub/bar.toml']);
});

test('remove deletes only the copy and prunes empty folders', async () => {
  fresh();
  await customizations.add(SID, ['config/sub/bar.toml']);
  const out = await customizations.remove(SID, ['config/sub/bar.toml', 'config/nope.toml']);
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 1);
  assert.ok(fs.existsSync(path.join(root, 'config', 'sub', 'bar.toml')));
  assert.ok(!fs.existsSync(path.join(cdir(), 'config')));
  assert.equal(db.all('SELECT * FROM server_customizations WHERE server_id = ?', SID).length, 0);
  const ev = eventsOfType('customizations-removed');
  assert.equal(ev.length, 1);
  assert.match(ev[0].summary, /^Removed 1 file from customizations\./);
});

test('a vanished customization file is pruned from the database on list', async () => {
  fresh();
  await customizations.add(SID, ['config/foo.toml']);
  fs.rmSync(path.join(cdir(), 'config', 'foo.toml'));
  assert.deepEqual(await customizations.list(SID), []);
  assert.equal(db.all('SELECT * FROM server_customizations WHERE server_id = ?', SID).length, 0);
});

test('assembleEnv sets the customization env and overrides user values', () => {
  const server = {
    ...servers.getServer(SID),
    env: { COPY_CONFIG_SRC: '/x', COPY_CONFIG_DEST: '/y', SYNC_SKIP_NEWER_IN_DESTINATION: 'true' },
  };
  const env = servers.assembleEnv(server);
  assert.equal(env.COPY_CONFIG_SRC, '/data/customizations');
  assert.equal(env.COPY_CONFIG_DEST, '/data');
  assert.equal(env.SYNC_SKIP_NEWER_IN_DESTINATION, 'false');
});

test('needsRebuild depends on the current container env', async (t) => {
  const original = containers.containerEnv;
  t.after(() => {
    containers.containerEnv = original;
  });
  const pending = () => db.get('SELECT pending_recreate AS p FROM servers WHERE id = ?', SID).p;

  fresh();
  containers.containerEnv = async () => null; // no container
  assert.equal((await customizations.add(SID, ['config/foo.toml'])).needsRebuild, false);
  assert.equal(pending(), 0);

  fresh();
  containers.containerEnv = async () => ['TYPE=PAPER']; // old container
  assert.equal((await customizations.add(SID, ['config/foo.toml'])).needsRebuild, true);
  assert.equal(pending(), 1);

  fresh();
  containers.containerEnv = async () => ['COPY_CONFIG_SRC=/data/customizations'];
  assert.equal((await customizations.add(SID, ['config/foo.toml'])).needsRebuild, false);
  assert.equal(pending(), 0);
});

test('routes list, add and remove', async (t) => {
  fresh();
  const original = containers.containerEnv;
  containers.containerEnv = async () => null;
  await app.start();
  t.after(async () => {
    containers.containerEnv = original;
    await app.stop();
  });
  const cookie = await app.adminCookie();
  const url = `/api/servers/${SID}/customizations`;
  const add = await app.req('POST', `${url}/add`, { cookie, body: { paths: ['config/foo.toml'] } });
  assert.equal(add.status, 200);
  assert.equal(add.json.succeeded, 1);
  const bad = await app.req('POST', `${url}/add`, { cookie, body: { paths: [] } });
  assert.equal(bad.status, 400);
  const list = await app.req('GET', url, { cookie });
  assert.equal(list.json.customizations[0].path, 'config/foo.toml');
  const rm = await app.req('POST', `${url}/remove`, { cookie, body: { paths: ['config/foo.toml'] } });
  assert.equal(rm.json.succeeded, 1);
});
