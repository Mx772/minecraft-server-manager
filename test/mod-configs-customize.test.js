'use strict';

// The Mod Configs editor tells each file's customization state and can add a
// saved config to the server's customizations (opt-in), so a pack update does
// not undo the edit.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./helpers/app');
const config = require('../src/config');
const db = require('../src/db');
const mods = require('../src/services/mods');
const containers = require('../src/docker/containers');

const PACK = 'srv_cfg_pack';
const PLAIN = 'srv_cfg_plain';
const packConfig = 'config/ftbchunks-world.snbt';
const worldConfig = 'world/serverconfig/ftbchunks-world.snbt';
let cookie;
const originals = { listContent: mods.listContent, containerEnv: containers.containerEnv };

const live = (sid, rel) => path.join(config.dataDir, 'servers', sid, rel);
const copy = (sid, rel) => path.join(config.dataDir, 'servers', sid, 'customizations', rel);
function seedFile(sid, rel, text) {
  fs.mkdirSync(path.dirname(live(sid, rel)), { recursive: true });
  fs.writeFileSync(live(sid, rel), text);
}
const readConfig = (sid, rel) =>
  app.req('GET', `/api/servers/${sid}/configs/file?path=${encodeURIComponent(rel)}`, { cookie });
const saveConfig = (sid, body) => app.req('PUT', `/api/servers/${sid}/configs/file`, { cookie, body });

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(PACK);
  db.run(`UPDATE servers SET port_game = 25598, port_rcon = 26598 WHERE id = ?`, PACK);
  app.seedServer(PLAIN);
  db.run(
    `INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name)
     VALUES (?, 'curseforge', 'ftb', 'FTB Pack', '1', 'v1')`,
    PACK
  );
  for (const sid of [PACK, PLAIN]) {
    seedFile(sid, packConfig, '{\n\tally_mode: "default"\n}\n');
    seedFile(sid, worldConfig, '{\n\tally_mode: "default"\n}\n');
  }
  mods.listContent = async () => [];
  containers.containerEnv = async () => null; // no container yet, so nothing to rebuild
});

test.after(async () => {
  mods.listContent = originals.listContent;
  containers.containerEnv = originals.containerEnv;
  await app.stop();
});

test('a config reports whether a pack update could overwrite it', async () => {
  assert.equal((await readConfig(PACK, packConfig)).json.customization, 'available');
  assert.equal((await readConfig(PACK, worldConfig)).json.customization, 'world');
  assert.equal((await readConfig(PLAIN, packConfig)).json.customization, 'none');
});

test('a plain save does not add the file to customizations', async () => {
  const res = await saveConfig(PACK, { path: packConfig, content: '{\n\tally_mode: "forced_all"\n}\n' });
  assert.equal(res.status, 200);
  assert.equal(res.json.customized, undefined);
  assert.equal(fs.existsSync(copy(PACK, packConfig)), false);
});

test('saving with customize adds the file, and later saves keep the copy in step', async () => {
  const first = await saveConfig(PACK, {
    path: packConfig,
    content: '{\n\tally_mode: "forced_none"\n}\n',
    customize: true,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.customized, true);
  assert.equal(first.json.needsRebuild, false);
  assert.match(fs.readFileSync(copy(PACK, packConfig), 'utf8'), /forced_none/);
  assert.equal((await readConfig(PACK, packConfig)).json.customization, 'customized');

  const listing = await app.req('GET', `/api/servers/${PACK}/configs`, { cookie });
  const listed = listing.json.unassigned.find((f) => f.path === packConfig);
  assert.equal(listed.customized, true);
  assert.equal(listing.json.unassigned.find((f) => f.path === worldConfig).customized, false);

  const page = await app.req('GET', `/servers/${PACK}/configs`, { cookie });
  assert.match(page.text, /data-customized-badge/);

  const second = await saveConfig(PACK, { path: packConfig, content: '{\n\tally_mode: "default"\n}\n' });
  assert.equal(second.json.customizationUpdated, true);
  assert.match(fs.readFileSync(copy(PACK, packConfig), 'utf8'), /"default"/);

  const event = db.get(
    "SELECT summary FROM events WHERE server_id = ? AND type = 'customizations-added' ORDER BY id DESC LIMIT 1",
    PACK
  );
  assert.equal(event.summary, 'Added 1 file to customizations.');
});

test('customize is ignored for files a pack update leaves alone', async () => {
  const world = await saveConfig(PACK, { path: worldConfig, content: '{\n\tpvp_mode: "never"\n}\n', customize: true });
  assert.equal(world.status, 200);
  assert.equal(world.json.customized, undefined);
  assert.equal(fs.existsSync(copy(PACK, worldConfig)), false);
  assert.match(fs.readFileSync(live(PACK, worldConfig), 'utf8'), /never/);

  const plain = await saveConfig(PLAIN, { path: packConfig, content: '{}\n', customize: true });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.customized, undefined);
  assert.equal(fs.existsSync(copy(PLAIN, packConfig)), false);
});
