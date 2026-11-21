'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const app = require('./helpers/app');
const config = require('../src/config');
const mods = require('../src/services/mods');
const modConfigs = require('../src/services/modConfigs');
const { jarBuffer } = require('./helpers/zipfix');

const SID = 'srv_mod_configs';
const configFile = 'config/example-mod.toml';
const lithiumConfig = 'config/lithium.properties';
let adminCookie;
let absoluteFile;
let fixtureListContent;
const originalListContent = mods.listContent;

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  app.seedServer(SID);
  absoluteFile = path.join(config.dataDir, 'servers', SID, configFile);
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.writeFileSync(absoluteFile, '[general]\nenabled = true\n');
  const jarPath = path.join(config.dataDir, 'servers', SID, 'mods', 'example-mod.jar');
  fs.mkdirSync(path.dirname(jarPath), { recursive: true });
  fs.writeFileSync(
    jarPath,
    await jarBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'example_mod', name: 'Example Mod', version: '1.0' }) })
  );
  const lithiumJar = path.join(config.dataDir, 'servers', SID, 'mods', 'lithium.jar');
  fs.writeFileSync(
    lithiumJar,
    await jarBuffer({
      'fabric.mod.json': JSON.stringify({ id: 'lithium', name: 'Lithium', version: '0.15.4' }),
      'lithium-fabric-mixin-config.md':
        '# Lithium options\n### `mixin.ai.pathing`\n(default: false)\nImproves path-finding node checks and chunk access.\n\nRequirements:\n- `mixin.util.chunk_access=true`\n\n### `mixin.ai.poi`\n(default: true)\nImplements a faster POI search.\n',
    })
  );
  fs.writeFileSync(path.join(config.dataDir, 'servers', SID, lithiumConfig), 'mixin.ai.pathing=false\n');
  fixtureListContent = async () => [
    { kind: 'mod', file: 'example-mod.jar', name: 'Example Mod', enabled: true, version: '1.0' },
    { kind: 'mod', file: 'lithium.jar', name: 'Lithium', enabled: true, version: '0.15.4' },
  ];
  mods.listContent = fixtureListContent;
});

test.after(async () => {
  mods.listContent = originalListContent;
  await app.stop();
});

test('Configs groups confidently matched files by detected mod and separates unmatched files', async () => {
  const unmatchedPath = path.join(config.dataDir, 'servers', SID, 'config', 'common.toml');
  fs.writeFileSync(unmatchedPath, 'enabled = false\n');

  const listing = await modConfigs.list(SID);
  assert.equal(listing.groups.length, 2);
  const example = listing.groups.find((group) => group.name === 'Example Mod');
  assert.deepEqual(
    example.files.map((file) => file.path),
    [configFile]
  );
  const lithium = listing.groups.find((group) => group.name === 'Lithium');
  assert.deepEqual(
    lithium.files.map((file) => file.path),
    [lithiumConfig]
  );
  assert.match(lithium.descriptions['mixin.ai.pathing'], /path-finding node checks/);
  assert.deepEqual(
    listing.unassigned.map((file) => file.path),
    ['config/common.toml']
  );
});

test('a cold listing never reads whole jars and a warm listing does not open them, even without in-memory state', async () => {
  const db = require('../src/db');
  const yauzl = require('yauzl');
  const originalReadFile = fsp.readFile;
  const originalOpen = yauzl.open;
  let jarReads = 0;
  let opens = 0;
  fsp.readFile = async (...args) => {
    if (String(args[0]).endsWith('.jar')) jarReads += 1;
    return originalReadFile(...args);
  };
  yauzl.open = (...args) => {
    opens += 1;
    return originalOpen(...args);
  };
  try {
    db.run('DELETE FROM mod_jar_meta WHERE server_id = ?', SID);
    await modConfigs.list(SID);
    assert.equal(jarReads, 0);
    assert.equal(opens, 2);
    assert.equal(db.all('SELECT * FROM mod_jar_meta WHERE server_id = ?', SID).length, 2);

    opens = 0;
    const warm = await modConfigs.list(SID);
    assert.equal(opens, 0);
    assert.equal(jarReads, 0);
    assert.match(warm.groups.find((g) => g.name === 'Lithium').descriptions['mixin.ai.poi'], /POI search/);
  } finally {
    fsp.readFile = originalReadFile;
    yauzl.open = originalOpen;
  }
});

test('removing a jar prunes its cached metadata on the next listing', async () => {
  const db = require('../src/db');
  const extra = path.join(config.dataDir, 'servers', SID, 'mods', 'extra.jar');
  fs.writeFileSync(extra, await jarBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'extra', name: 'Extra' }) }));
  const withExtra = mods.listContent;
  mods.listContent = async () => [
    ...(await fixtureListContent()),
    { kind: 'mod', file: 'extra.jar', name: 'Extra', enabled: true, version: '1' },
  ];
  try {
    await modConfigs.list(SID);
    assert.ok(db.get('SELECT 1 AS x FROM mod_jar_meta WHERE server_id = ? AND rel_path = ?', SID, 'mods/extra.jar'));
    fs.rmSync(extra);
    await modConfigs.list(SID);
    assert.equal(
      db.get('SELECT 1 AS x FROM mod_jar_meta WHERE server_id = ? AND rel_path = ?', SID, 'mods/extra.jar'),
      undefined
    );
  } finally {
    mods.listContent = withExtra;
  }
});

test('the Configs tab shows mod groups and unassigned configs without a file explorer', async () => {
  const page = await app.req('GET', `/servers/${SID}/configs`, {
    cookie: adminCookie,
    headers: { Accept: 'text/html' },
  });
  assert.equal(page.status, 200);
  assert.match(page.text, /Mod Configs/);
  assert.match(page.text, /Example Mod/);
  assert.match(page.text, /Unassigned Configs/);
  assert.match(page.text, /data-open-mod-config/);
  assert.match(page.text, /\/js\/pages\/configs\.js/);
  assert.doesNotMatch(page.text, /assetVersion/);
  assert.doesNotMatch(page.text, /Open File Manager|data-files-server/);

  const modsPage = await app.req('GET', `/servers/${SID}/mods`, {
    cookie: adminCookie,
    headers: { Accept: 'text/html' },
  });
  assert.equal(modsPage.status, 200);
  assert.match(modsPage.text, new RegExp(`/servers/${SID}/configs`));
});

test('config API reads and writes only plain text configs, without a prior listing', async () => {
  mods.listContent = async () => {
    throw new Error('read and write must not rescan mod jars');
  };
  try {
    const read = await app.req('GET', `/api/servers/${SID}/configs/file?path=${encodeURIComponent(configFile)}`, {
      cookie: adminCookie,
    });
    assert.equal(read.status, 200);
    assert.match(read.json.content, /enabled = true/);

    const described = await app.req(
      'GET',
      `/api/servers/${SID}/configs/file?path=${encodeURIComponent(lithiumConfig)}`,
      {
        cookie: adminCookie,
      }
    );
    assert.equal(described.status, 200);
    assert.match(described.json.descriptions['mixin.ai.pathing'], /path-finding node checks/);

    const write = await app.req('PUT', `/api/servers/${SID}/configs/file`, {
      cookie: adminCookie,
      body: { path: configFile, content: '[general]\nenabled = false\n' },
    });
    assert.equal(write.status, 200);
    assert.equal(fs.readFileSync(absoluteFile, 'utf8'), '[general]\nenabled = false\n');

    const largerContent = `# Large config preview\n${'x'.repeat(300_000)}\n`;
    const largerWrite = await app.req('PUT', `/api/servers/${SID}/configs/file`, {
      cookie: adminCookie,
      body: { path: configFile, content: largerContent },
    });
    assert.equal(largerWrite.status, 200);
    assert.equal(fs.readFileSync(absoluteFile, 'utf8'), largerContent);

    const rejected = await app.req('PUT', `/api/servers/${SID}/configs/file`, {
      cookie: adminCookie,
      body: { path: 'server.properties', content: 'motd=wrong scope' },
    });
    assert.equal(rejected.status, 404);
  } finally {
    mods.listContent = fixtureListContent;
  }
});

test('a symlinked config root is refused', async () => {
  const serverRoot = path.join(config.dataDir, 'servers', SID);
  const configRoot = path.join(serverRoot, 'config');
  const savedRoot = path.join(serverRoot, 'config-test-backup');
  const externalRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mod-config-link-'));
  fs.renameSync(configRoot, savedRoot);
  try {
    fs.symlinkSync(externalRoot, configRoot, 'junction');
    await assert.rejects(modConfigs.list(SID), /Path escapes the panel data directory/);
  } finally {
    fs.rmSync(configRoot, { recursive: true, force: true });
    fs.renameSync(savedRoot, configRoot);
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('a symlink inside config is skipped without hiding the other configs', async () => {
  const configRoot = path.join(config.dataDir, 'servers', SID, 'config');
  const linkedRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mod-config-entry-link-'));
  const linkedPath = path.join(configRoot, 'external');
  fs.writeFileSync(path.join(linkedRoot, 'outside.toml'), 'enabled = true\n');
  try {
    fs.symlinkSync(linkedRoot, linkedPath, 'junction');
    const listing = await modConfigs.list(SID);
    const matchedPaths = listing.groups.flatMap((group) => group.files.map((file) => file.path));
    assert.ok(matchedPaths.includes(configFile), `Expected ${configFile} to remain listed after skipping the symlink.`);
    assert.ok(!matchedPaths.some((file) => file.startsWith('config/external/')));
    assert.ok(!listing.unassigned.some((file) => file.path === 'config/external/outside.toml'));
  } finally {
    fs.rmSync(linkedPath, { recursive: true, force: true });
    fs.rmSync(linkedRoot, { recursive: true, force: true });
  }
});

test('read and write refuse hidden segments, symlinks, and paths outside the config roots', async () => {
  const dir = path.join(config.dataDir, 'servers', SID, 'config');
  fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hidden', 'x.toml'), 'a = 1\n');
  for (const bad of [
    'config/.hidden/x.toml',
    'config/../server.properties',
    'mods/example-mod.jar',
    'config/nope.toml',
  ]) {
    await assert.rejects(modConfigs.read(SID, bad), (err) => err.status === 404 || /escapes/.test(err.message));
  }
});

test('a big pack lists quickly cold and warm with correct grouping', async () => {
  const BIG = 'srv_mod_configs_big';
  app.seedServer(BIG);
  const root = path.join(config.dataDir, 'servers', BIG);
  fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
  const entries = [];
  for (let i = 0; i < 400; i++) {
    const id = `modx${i}`;
    const buf = await jarBuffer({ 'fabric.mod.json': JSON.stringify({ id, name: `Mod X ${i}`, version: '1' }) });
    fs.writeFileSync(path.join(root, 'mods', `${id}-1.0.jar`), buf);
    entries.push({ kind: 'mod', file: `${id}-1.0.jar`, name: `Mod X ${i}`, enabled: true, version: '1' });
  }
  for (let i = 0; i < 1500; i++) {
    const sub = path.join(root, 'config', `group${i % 10}`);
    fs.mkdirSync(sub, { recursive: true });
    const name = i % 2 === 0 ? `modx${i % 400}-common.toml` : `plain-${i}.toml`;
    fs.writeFileSync(path.join(sub, name.replace('.toml', `-${i}.toml`)), 'a = 1\n');
  }
  mods.listContent = async () => entries;
  try {
    let t = Date.now();
    const cold = await modConfigs.list(BIG);
    const coldMs = Date.now() - t;
    t = Date.now();
    const warm = await modConfigs.list(BIG);
    const warmMs = Date.now() - t;
    console.log(`scale: cold ${coldMs} ms, warm ${warmMs} ms`);
    assert.ok(coldMs < 5000, `cold ${coldMs} ms`);
    assert.ok(warmMs < 1000, `warm ${warmMs} ms`);
    assert.equal(cold.groups.length, 400);
    assert.deepEqual(warm, cold);
    const g = cold.groups.find((x) => x.id === 'modx10');
    assert.ok(g.files.some((f) => f.path === 'config/group0/modx10-common-10.toml'));
    assert.equal(cold.unassigned.length, 750);
    assert.ok(cold.unassigned.every((f) => /plain-\d+/.test(f.path)));
  } finally {
    mods.listContent = fixtureListContent;
  }
});
