'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const app = require('./helpers/app');
const db = require('../src/db');
const config = require('../src/config');
const packProfiles = require('../src/services/packProfiles');
const loader = require('../src/services/packProfiles/loader');
const { profile } = require('../src/services/packProfiles/schema');
const customizations = require('../src/services/customizations');

const SID = 'srv_profile_files';
const REL = 'config/incontrol/spawn.json';
const RULES = [{ mob: 'minecraft:zombie', mincount: 15, result: 'deny' }];
const OURS = `${JSON.stringify(RULES, null, 2)}\n`;
const OWNER = 'pack-profile:curseforge/files-pack/mob-caps';
let root;
let dir;
let adminCookie;

const live = (rel = REL) => path.join(root, rel);
const readLive = (rel = REL) => fs.readFileSync(live(rel), 'utf8');
const writeLive = (text, rel = REL) => {
  fs.mkdirSync(path.dirname(live(rel)), { recursive: true });
  fs.writeFileSync(live(rel), text);
};
const preset = () => packProfiles.presetsFor(SID).presets[0];
const fileState = () => preset().files[0];
const turn = (enabled) => packProfiles.savePresets(SID, [{ presetId: 'mob-caps', enabled }], { actor: 't' });

const goodProfile = (files) => ({
  id: 'curseforge/files-pack',
  platform: 'curseforge',
  slug: 'files-pack',
  name: 'Files Pack',
  presets: [{ id: 'mob-caps', title: 'Mob Caps', description: 'Caps mobs.', default: true, files }],
});
const jsonFile = (content, p = REL) => ({ path: p, format: 'json', content });

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  app.seedServer(SID);
  root = path.join(config.dataDir, 'servers', SID);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppf-'));
  fs.mkdirSync(path.join(dir, 'curseforge'));
  fs.writeFileSync(path.join(dir, 'curseforge', 'files-pack.json'), JSON.stringify(goodProfile([jsonFile(RULES)])));
  packProfiles.reloadProfiles(dir);
});

test.after(async () => {
  packProfiles.reloadProfiles(loader.DEFAULT_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  await app.stop();
});

async function fresh() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const t of ['server_customizations', 'server_profile_presets', 'server_profile_runs', 'server_profile_reviews'])
    db.run(`DELETE FROM ${t}`);
  db.run('DELETE FROM server_profile_file_backups');
  db.run('DELETE FROM events');
  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
  db.run(
    `INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name)
     VALUES (?, 'curseforge', 'files-pack', 'P', 'v1', '1.0')`,
    SID
  );
  db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
}

test('schema: accepts valid files and rejects unsafe or invalid ones', () => {
  const ok = (files) => profile.safeParse(goodProfile(files)).success;
  assert.equal(ok([jsonFile(RULES)]), true);
  assert.equal(ok([{ path: 'config/a.toml', content: 'a = 1\n' }]), true);
  assert.equal(ok([{ path: 'defaultconfigs/a.properties', content: '# c\nkey=1\n' }]), true);
  assert.equal(ok([jsonFile('[]')]), false, 'json content must be structured');
  assert.equal(ok([jsonFile(5)]), false);
  assert.equal(ok([jsonFile(null)]), false);
  assert.equal(ok([jsonFile(RULES, 'mods/x.json')]), false, 'wrong root');
  assert.equal(ok([jsonFile(RULES, 'world/serverconfig/x.json')]), false);
  assert.equal(ok([jsonFile(RULES, 'config/../x.json')]), false);
  assert.equal(ok([jsonFile(RULES, 'config/x.js')]), false);
  assert.equal(ok([jsonFile(RULES, 'config/kubejs/x.json')]), false);
  assert.equal(ok([{ path: 'config/a.toml', content: 'a = = 1' }]), false, 'bad toml');
  assert.equal(ok([{ path: 'config/a.properties', content: 'no separator here' }]), false);
  assert.equal(ok([{ path: 'config/a.toml', content: { a: 1 } }]), false, 'toml content is text');
  assert.equal(ok([{ path: REL, format: 'toml', content: 'a = 1' }]), false, 'format must match');
  assert.equal(ok([jsonFile(RULES), jsonFile(RULES)]), false, 'duplicate path');
  for (const key of ['command', 'commands', 'cmd', 'script', 'Command']) {
    assert.equal(ok([jsonFile([{ mob: 'x', nested: { [key]: 'op' } }])]), false, key);
  }
  assert.equal(ok([jsonFile([{ blob: 'x'.repeat(70 * 1024) }])]), false, 'size cap');
});

test('enable writes the owned copy and the live file; second apply is unchanged', async () => {
  await fresh();
  assert.equal(fileState().status, null);
  const { out } = await turn(true);
  assert.equal(out.fileResults[0].status, 'applied');
  assert.equal(readLive(), OURS);
  assert.equal(await customizations.readOwned(SID, REL, OWNER), OURS);
  assert.ok(customizations.ownedPaths(SID).has(REL));
  assert.deepEqual(out.changedFiles, [REL]);
  assert.equal(fileState().status, 'applied');
  assert.equal(fileState().size, Buffer.byteLength(OURS));
  assert.equal(fileState().preview, OURS);
  const again = await packProfiles.apply(SID, { trigger: 'manual', withSettings: true });
  assert.equal(again.fileResults[0].status, 'unchanged');
  assert.deepEqual(again.changedFiles, []);
  const row = (await customizations.list(SID)).find((f) => f.path === REL);
  assert.equal(row.owner, OWNER);
  assert.equal(row.state, 'managed');
});

test('nothing is written until the preset is turned on, and hooks never add files', async () => {
  await fresh();
  await packProfiles.apply(SID, { trigger: 'pre-start' });
  await packProfiles.apply(SID, { trigger: 'manual', withSettings: true });
  assert.equal(fs.existsSync(live()), false);
});

test('a user customization is skipped', async () => {
  await fresh();
  fs.mkdirSync(path.join(root, 'customizations', 'config', 'incontrol'), { recursive: true });
  fs.writeFileSync(path.join(root, 'customizations', REL), '[1]');
  const { out } = await turn(true);
  assert.equal(out.fileResults[0].status, 'skipped-customized');
  assert.equal(fs.existsSync(live()), false);
  assert.equal(fs.readFileSync(path.join(root, 'customizations', REL), 'utf8'), '[1]');
});

test('empty defaults are replaced and backed up, in every format', async () => {
  const cases = [
    ['config/e.json', 'json', '[]', RULES],
    ['config/e.json', 'json', ' {} \n', RULES],
    ['config/e.json', 'json', '', RULES],
    ['config/e.toml', 'toml', '# nothing here\n\n', 'a = 1\n'],
    ['config/e.properties', 'properties', '# c\n! d\n', 'a=1\n'],
  ];
  for (const [rel, format, current, content] of cases) {
    await fresh();
    fs.writeFileSync(
      path.join(dir, 'curseforge', 'files-pack.json'),
      JSON.stringify(goodProfile([{ path: rel, format, content }]))
    );
    packProfiles.reloadProfiles(dir);
    writeLive(current, rel);
    const { out } = await turn(true);
    assert.equal(out.fileResults[0].status, 'applied', `${format} ${JSON.stringify(current)}`);
    assert.equal(out.fileResults[0].message, 'Replaced the empty default file.');
    assert.equal(readLive(rel), format === 'json' ? `${JSON.stringify(content, null, 2)}\n` : content);
    assert.equal(
      Buffer.from(
        db.get('SELECT previous_content AS c FROM server_profile_file_backups WHERE path = ?', rel).c
      ).toString(),
      current
    );
    assert.equal(fileState().hasBackup, true);
    await turn(false);
    assert.equal(readLive(rel), current, 'disable restores the exact bytes');
    assert.equal(db.all('SELECT * FROM server_profile_file_backups').length, 0);
  }
  fs.writeFileSync(path.join(dir, 'curseforge', 'files-pack.json'), JSON.stringify(goodProfile([jsonFile(RULES)])));
  packProfiles.reloadProfiles(dir);
});

test('real content is held, never overwritten; an identical pack file is left alone', async () => {
  await fresh();
  writeLive('[{"mob":"minecraft:pig","result":"deny"}]');
  const { out } = await turn(true);
  assert.equal(out.fileResults[0].status, 'held-exists');
  assert.match(out.fileResults[0].message, /already has its own rules/);
  assert.equal(readLive(), '[{"mob":"minecraft:pig","result":"deny"}]');
  assert.equal(customizations.ownedPaths(SID).size, 0);
  assert.equal(fileState().status, 'held-exists');
  assert.equal(fileState().currentPreview, '[{"mob":"minecraft:pig","result":"deny"}]');
  assert.deepEqual(out.changedFiles, []);

  await fresh();
  writeLive(OURS);
  const same = (await turn(true)).out;
  assert.equal(same.fileResults[0].status, 'unchanged');
  assert.equal(customizations.ownedPaths(SID).size, 0);
});

test('replace-file backs up, writes, and is refused when not held; disable restores', async () => {
  await fresh();
  const base = `/api/servers/${SID}/profile/replace-file`;
  const body = { presetId: 'mob-caps', path: REL };
  // Preset not enabled yet.
  assert.equal((await app.req('POST', base, { cookie: adminCookie, body })).status, 400);
  writeLive('[{"mob":"minecraft:pig","result":"deny"}]');
  await turn(true);
  db.run("UPDATE servers SET status = 'running' WHERE id = ?", SID);
  const r = await app.req('POST', base, { cookie: adminCookie, body });
  assert.equal(r.status, 200);
  assert.equal(r.json.restartNeeded, true);
  assert.equal(r.json.presets[0].files[0].status, 'applied');
  assert.equal(r.json.presets[0].files[0].hasBackup, true);
  assert.equal(readLive(), OURS);
  assert.equal(await customizations.readOwned(SID, REL, OWNER), OURS);
  assert.equal(db.all("SELECT * FROM events WHERE type = 'profile-file-replaced'").length, 1);
  // No longer held.
  assert.equal((await app.req('POST', base, { cookie: adminCookie, body })).status, 409);
  // Unknown preset or file.
  assert.equal(
    (await app.req('POST', base, { cookie: adminCookie, body: { ...body, path: 'config/x.json' } })).status,
    400
  );
  await turn(false);
  assert.equal(readLive(), '[{"mob":"minecraft:pig","result":"deny"}]');
  assert.equal(await customizations.readOwned(SID, REL, OWNER), null);
  assert.equal(customizations.ownedPaths(SID).size, 0);
  db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
});

test('replace-file refuses a file too large to back up', async () => {
  await fresh();
  writeLive(JSON.stringify([{ blob: 'x'.repeat(70 * 1024) }]));
  await turn(true);
  assert.equal(fileState().status, 'held-exists');
  const r = await app.req('POST', `/api/servers/${SID}/profile/replace-file`, {
    cookie: adminCookie,
    body: { presetId: 'mob-caps', path: REL },
  });
  assert.equal(r.status, 413);
  assert.equal(readLive().length > 70 * 1024, true);
});

test('disable deletes the file when no backup exists, and leaves a changed file alone', async () => {
  await fresh();
  await turn(true);
  const off = (await turn(false)).out;
  assert.equal(fs.existsSync(live()), false);
  assert.equal(await customizations.readOwned(SID, REL, OWNER), null);
  assert.equal(customizations.ownedPaths(SID).size, 0);
  assert.deepEqual(off.changedFiles, [REL]);
  assert.equal(fileState().status, null);

  await fresh();
  await turn(true);
  writeLive('[]');
  const left = (await turn(false)).out;
  assert.equal(readLive(), '[]');
  assert.deepEqual(left, null);
  assert.equal(customizations.ownedPaths(SID).size, 0);
});

test('a changed live file with a backup keeps the backup row', async () => {
  await fresh();
  writeLive('[]');
  await turn(true);
  writeLive('[{"edited":true}]');
  await turn(false);
  assert.equal(readLive(), '[{"edited":true}]');
  assert.equal(db.all('SELECT * FROM server_profile_file_backups').length, 1);
});

test('owner-aware refusal messages', async () => {
  await fresh();
  await turn(true);
  for (const action of ['remove', 'keepCurrent', 'restore', 'add']) {
    const res = await customizations[action](SID, [REL]);
    assert.equal(res.results[0].error, customizations.PROFILE_OWNED_MSG, action);
  }
  assert.equal(
    customizations.PROFILE_OWNED_MSG,
    'This file is managed by Recommended Setup. Change it from the Mods tab.'
  );
  assert.equal(
    customizations.OWNED_MSG,
    'This file is managed by the Discord chat bridge. Change it from the Discord tab.'
  );
  db.run("UPDATE server_customizations SET owner = 'discord-chat-bridge' WHERE path = ?", REL);
  assert.equal((await customizations.remove(SID, [REL])).results[0].error, customizations.OWNED_MSG);
});

test('the bundled All the Mods 10 profile has the mob caps preset and nothing applies until enabled', async () => {
  const { profiles, invalid } = loader.loadDir(loader.DEFAULT_DIR);
  assert.deepEqual(invalid, []);
  const atm = profiles.find((p) => p.id === 'curseforge/all-the-mods-10');
  assert.deepEqual(
    atm.presets.map((p) => p.id),
    ['server-pack-settings', 'server-pack-mob-caps', 'no-computer-internet', 'no-mekanism-radiation']
  );
  const caps = atm.presets[1];
  assert.equal(caps.default, true);
  assert.equal(caps.files[0].path, REL);
  assert.deepEqual(caps.files[0].content[0], { mob: 'minecraft:zombie', mincount: 15, result: 'deny' });
  assert.deepEqual(caps.files[0].content[1], { mob: 'minecraft:bat', mincount: 5, result: 'deny' });
  assert.equal(caps.files[0].content.length, 13);

  packProfiles.reloadProfiles(loader.DEFAULT_DIR);
  try {
    await fresh();
    db.run(
      "UPDATE server_packs SET project_ref = 'all-the-mods-10', pinned_version_name = '8.6' WHERE server_id = ?",
      SID
    );
    await packProfiles.apply(SID, { trigger: 'pre-start' });
    await packProfiles.apply(SID, { trigger: 'manual', withSettings: true });
    assert.equal(fs.existsSync(live()), false);
    assert.equal(
      packProfiles.presetsFor(SID).presets.every((p) => !p.enabled),
      true
    );
  } finally {
    packProfiles.reloadProfiles(dir);
  }
});
