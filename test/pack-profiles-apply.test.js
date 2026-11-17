'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./helpers/app');
const db = require('../src/db');
const config = require('../src/config');
const configPatch = require('../src/services/configPatch');
const packProfiles = require('../src/services/packProfiles');
const customizations = require('../src/services/customizations');
const servers = require('../src/services/servers');
const upgrade = require('../src/updates/upgrade');
const authService = require('../src/services/auth');

const SID = 'srv_profile1';
const FIXTURES = path.join(__dirname, 'fixtures', 'pack-profiles');
let root;
let adminCookie;
let viewerCookie;
let operatorCookie;

const eventsOfType = (type) => db.all('SELECT * FROM events WHERE server_id = ? AND type = ?', SID, type);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const setPack = (platform, ref, versionName) => {
  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
  db.run(
    `INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name)
     VALUES (?, ?, ?, 'P', 'v1', ?)`,
    SID,
    platform,
    ref,
    versionName
  );
};
const statuses = (out) => out.results.map((r) => `${r.file}#${r.op}:${r.status}`);

async function fresh({ optIn = true } = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'config', 'mekanism'), { recursive: true });
  write('config/mekanism/general.toml', '[general]\n# comment\nradiation = true\nmobCap = 70\n');
  db.run('DELETE FROM events');
  db.run('DELETE FROM server_customizations');
  db.run('DELETE FROM server_profile_presets');
  db.run('DELETE FROM server_profile_runs');
  db.run('DELETE FROM server_profile_reviews');
  db.run('UPDATE servers SET env_json = ? WHERE id = ?', '{}', SID);
  // A start with no pack opens a new start cycle (clears the restart guard).
  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
  await packProfiles.apply(SID, { trigger: 'pre-start' });
  setPack('curseforge', 'all-the-mods-10', '8.6');
  // Nothing applies until the user turns it on: the older tests turn the first preset on.
  if (optIn) {
    db.run(
      "INSERT INTO server_profile_presets (server_id, profile_id, preset_id, enabled) VALUES (?, 'curseforge/all-the-mods-10', 'fewer-mobs', 1)",
      SID
    );
  }
}

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  for (const [name, role] of [
    ['viewer_pp', 'viewer'],
    ['operator_pp', 'operator'],
  ]) {
    await authService.createUser({ username: name, password: `${name}-pass123`, role }, { actor: 'test' });
    const r = await app.req('POST', '/login', { body: { username: name, password: `${name}-pass123` } });
    const c = (r.setCookie || []).map((x) => x.split(';')[0]).join('; ');
    if (role === 'viewer') viewerCookie = c;
    else operatorCookie = c;
  }
  app.seedServer(SID);
  root = path.join(config.dataDir, 'servers', SID);
  packProfiles.reloadProfiles(FIXTURES);
});

test.after(async () => {
  packProfiles.reloadProfiles(require('../src/services/packProfiles/loader').DEFAULT_DIR);
  await app.stop();
});

test('matching: curseforge slug or project id, modrinth slug, version range', () => {
  const find = (platform, ref, v) =>
    packProfiles.findProfile({ platform, project_ref: ref, pinned_version_name: v })?.id || null;
  assert.equal(find('curseforge', 'all-the-mods-10', '8.6'), 'curseforge/all-the-mods-10');
  assert.equal(find('curseforge', 'All-The-Mods-10', '8.6'), 'curseforge/all-the-mods-10');
  assert.equal(find('curseforge', '925200', '8.6'), 'curseforge/all-the-mods-10');
  assert.equal(find('curseforge', 'all-the-mods-10', '9.1'), null);
  assert.equal(find('curseforge', 'all-the-mods-10', 'ATM10-8.6'), 'curseforge/all-the-mods-10');
  assert.equal(find('curseforge', 'all-the-mods-10', 'latest'), null);
  assert.equal(find('modrinth', 'fabulously-optimized', 'whatever'), 'modrinth/fabulously-optimized');
  assert.equal(find('modrinth', '1KVo5zza', '1.0'), 'modrinth/fabulously-optimized');
  assert.equal(find('curseforge', 'fabulously-optimized', '1.0'), null);
  assert.equal(find('ftb', '12', '1'), null);
  assert.equal(packProfiles.findProfile(null), null);
});

test('opt-in semantics: a default-true preset is not enabled until the user turns it on', async () => {
  await fresh({ optIn: false });
  let { presets } = packProfiles.presetsFor(SID);
  assert.deepEqual(
    presets.map((p) => [p.id, p.default, p.enabled]),
    [
      ['fewer-mobs', true, false],
      ['world-rules', false, false],
      ['perf', true, false],
    ]
  );
  assert.equal(db.all('SELECT * FROM server_profile_presets').length, 0);
  packProfiles.setPresets(
    SID,
    [
      { presetId: 'fewer-mobs', enabled: false },
      { presetId: 'world-rules', enabled: true },
    ],
    { actor: 'tester' }
  );
  ({ presets } = packProfiles.presetsFor(SID));
  assert.deepEqual(
    presets.map((p) => p.enabled),
    [false, true, false]
  );
  assert.throws(() => packProfiles.setPresets(SID, [{ presetId: 'nope', enabled: true }]), { status: 400 });
});

test('nothing applies automatically: hooks and Apply Now change nothing until enabled', async () => {
  await fresh({ optIn: false });
  const before = read('config/mekanism/general.toml');
  for (const trigger of ['pre-start', 'post-upgrade', 'first-boot']) {
    const out = await packProfiles.apply(SID, { trigger });
    assert.equal(out.applied, 0);
    assert.deepEqual(out.changedFiles, []);
  }
  const out = await packProfiles.apply(SID, { trigger: 'manual', withSettings: true });
  assert.equal(out.applied, 0);
  assert.equal(out.settingsChanged, 0);
  assert.equal(read('config/mekanism/general.toml'), before);
  assert.deepEqual(servers.getServer(SID).env, {});
});

test('review: new, then enable applies and marks everything seen', async () => {
  await fresh({ optIn: false });
  let g = packProfiles.presetsFor(SID);
  assert.equal(g.review.state, 'new');
  assert.deepEqual(g.review.newPresetIds, ['fewer-mobs', 'world-rules', 'perf']);
  assert.ok(g.presets.every((p) => p.isNew));
  const r = await packProfiles.review(SID, ['fewer-mobs', 'perf'], { actor: 'tester' });
  assert.equal(r.out.applied, 2);
  assert.equal(r.out.settingsChanged, 2);
  assert.equal(r.review.state, 'reviewed');
  assert.deepEqual(
    r.presets.map((p) => [p.enabled, p.isNew]),
    [
      [true, false],
      [false, false],
      [true, false],
    ]
  );
  assert.equal(read('config/mekanism/general.toml'), '[general]\n# comment\nradiation = false\nmobCap = 40\n');
  assert.deepEqual(
    r.presets[2].settings.map((s) => [s.key, s.status]),
    [
      ['VIEW_DISTANCE', 'applied'],
      ['ALLOW_FLIGHT', 'applied'],
    ]
  );
  await assert.rejects(packProfiles.review(SID, ['nope']), { status: 400 });
});

test('review: Not Now marks seen and applies nothing', async () => {
  await fresh({ optIn: false });
  const r = await packProfiles.review(SID, [], { actor: 'tester' });
  assert.equal(r.out, null);
  assert.equal(r.review.state, 'reviewed');
  assert.equal(db.all('SELECT * FROM server_profile_presets').length, 0);
  assert.equal(read('config/mekanism/general.toml'), '[general]\n# comment\nradiation = true\nmobCap = 70\n');
  assert.deepEqual(servers.getServer(SID).env, {});
});

test('review: a profile that gains a preset prompts again with isNew', async () => {
  await fresh({ optIn: false });
  await packProfiles.review(SID, [], { actor: 'tester' });
  db.run('UPDATE server_profile_reviews SET seen_preset_ids = \'["fewer-mobs","world-rules"]\'');
  const g = packProfiles.presetsFor(SID);
  assert.equal(g.review.state, 'new-presets');
  assert.deepEqual(g.review.newPresetIds, ['perf']);
  assert.deepEqual(
    g.presets.map((p) => p.isNew),
    [false, false, true]
  );
});

test('checkForSuggestions notifies once per new preset set and applies nothing', async () => {
  await fresh({ optIn: false });
  const events = () => eventsOfType('profile-suggestions-available').sort((a, b) => a.id - b.id);
  assert.equal(packProfiles.checkForSuggestions(SID), 3);
  assert.equal(events().length, 1);
  assert.equal(events()[0].summary, 'Suggested settings are available for All the Mods 10.');
  assert.equal(packProfiles.checkForSuggestions(SID), 0);
  assert.equal(events().length, 1);
  // The profile gains presets later: one more event, counting only the new ones.
  db.run('UPDATE server_profile_reviews SET notified_preset_ids = \'["fewer-mobs"]\'');
  assert.equal(packProfiles.checkForSuggestions(SID), 2);
  assert.equal(events().length, 2);
  assert.equal(events()[1].summary, '2 new suggested settings are available for All the Mods 10.');
  assert.equal(packProfiles.checkForSuggestions(SID), 0);
  assert.equal(eventsOfType('profile-applied').length, 0);
  assert.equal(read('config/mekanism/general.toml'), '[general]\n# comment\nradiation = true\nmobCap = 70\n');
  // Answering the prompt means no later notice for what the user has seen.
  await packProfiles.review(SID, [], { actor: 'tester' });
  assert.equal(packProfiles.checkForSuggestions(SID), 0);
  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
  assert.equal(packProfiles.checkForSuggestions(SID), 0);
});

test('applyPack notifies about suggestions', async () => {
  await fresh({ optIn: false });
  const packs = require('../src/services/packs');
  await packs.applyPack(
    SID,
    {
      platform: 'curseforge',
      projectRef: 'all-the-mods-10',
      projectName: 'All the Mods 10',
      versionId: 'v2',
      versionName: '8.6',
      env: {},
    },
    { force: true }
  );
  assert.equal(eventsOfType('profile-suggestions-available').length, 1);
  db.run("UPDATE servers SET pending_recreate = 0, env_json = '{}' WHERE id = ?", SID);
});

test('settings presets: apply through updateServer, flag a rebuild, report unchanged on rerun', async () => {
  await fresh({ optIn: false });
  packProfiles.setPresets(SID, [{ presetId: 'perf', enabled: true }]);
  // Hooks never apply settings.
  await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.deepEqual(servers.getServer(SID).env, {});
  const out = await packProfiles.apply(SID, { trigger: 'manual', actor: 'tester', withSettings: true });
  assert.equal(out.settingsChanged, 2);
  assert.equal(out.rebuildNeeded, true);
  assert.deepEqual(servers.getServer(SID).env, { VIEW_DISTANCE: '6', ALLOW_FLIGHT: 'true' });
  assert.equal(servers.getServer(SID).pending_recreate, 1);
  const shown = packProfiles.presetsFor(SID).presets[2].settings;
  assert.deepEqual(
    shown.map((s) => [s.key, s.label, s.value, s.status]),
    [
      ['VIEW_DISTANCE', 'View distance', 6, 'applied'],
      ['ALLOW_FLIGHT', 'Allow Flight', true, 'applied'],
    ]
  );
  // A hook run keeps the last settings results.
  await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.equal(packProfiles.presetsFor(SID).presets[2].settings[0].status, 'applied');
  const again = await packProfiles.apply(SID, { trigger: 'manual', withSettings: true });
  assert.equal(again.settingsChanged, 0);
  assert.equal(again.rebuildNeeded, false);
  assert.deepEqual(
    again.settingResults.map((s) => s.status),
    ['unchanged', 'unchanged']
  );
  assert.equal(packProfiles.presetsFor(SID).presets[2].settings[0].status, 'unchanged');
  db.run("UPDATE servers SET pending_recreate = 0, env_json = '{}' WHERE id = ?", SID);
});

test('apply: applied, held-expect, missing file; one event, none on a no-op rerun', async () => {
  await fresh();
  const out = await packProfiles.apply(SID, { trigger: 'manual', actor: 'tester' });
  assert.deepEqual(statuses(out), [
    'config/mekanism/general.toml#0:applied',
    'config/mekanism/general.toml#1:applied',
    'config/late.toml#0:held-missing',
  ]);
  assert.equal(out.applied, 2);
  assert.equal(out.held, 1);
  assert.deepEqual(out.changedFiles, ['config/mekanism/general.toml']);
  assert.equal(read('config/mekanism/general.toml'), '[general]\n# comment\nradiation = false\nmobCap = 40\n');
  const events = eventsOfType('profile-applied');
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Applied 2 recommended settings from the All the Mods 10 profile.');
  const again = await packProfiles.apply(SID, { trigger: 'manual' });
  assert.deepEqual(again.changedFiles, []);
  assert.equal(again.applied, 0);
  assert.equal(eventsOfType('profile-applied').length, 1);
  // The held file appears later: applies, and the held set changed.
  write('config/late.toml', '[late]\nx = 0\n');
  const late = await packProfiles.apply(SID, { trigger: 'first-boot' });
  assert.deepEqual(late.changedFiles, ['config/late.toml']);
  assert.equal(eventsOfType('profile-applied').length, 2);
});

test('apply: expect mismatch is held for review and mentioned in the event', async () => {
  await fresh();
  write('config/mekanism/general.toml', '[general]\nradiation = 5\nmobCap = 70\n');
  const out = await packProfiles.apply(SID, { trigger: 'manual' });
  assert.equal(out.results[0].status, 'held-expect');
  assert.equal(out.results[1].status, 'applied');
  assert.equal(
    eventsOfType('profile-applied')[0].summary,
    'Applied 1 recommended setting from the All the Mods 10 profile. 1 needs review.'
  );
  const view = packProfiles.presetsFor(SID);
  assert.equal(view.presets[0].patches[0].ops[0].status, 'held-expect');
  assert.equal(view.presets[0].patches[0].ops[1].status, 'applied');
  assert.equal(view.presets[1].patches[0].ops[0].status, null);
  assert.equal(view.lastRun.trigger, 'manual');
});

test('apply: a customized or owned file is skipped so the user version wins', async () => {
  await fresh();
  write('customizations/config/mekanism/general.toml', '[general]\nradiation = true\n');
  let out = await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.equal(out.results[0].status, 'skipped-customized');
  assert.equal(out.results[0].message, 'You customized this file, so your version wins.');
  assert.equal(out.applied, 0);
  assert.equal(read('config/mekanism/general.toml').includes('radiation = true'), true);

  fs.rmSync(path.join(root, 'customizations'), { recursive: true, force: true });
  db.run(
    "INSERT INTO server_customizations (server_id, path, captured_sha256, owner) VALUES (?, 'config/mekanism/general.toml', 'x', 'discord')",
    SID
  );
  assert.deepEqual([...customizations.ownedPaths(SID)], ['config/mekanism/general.toml']);
  out = await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.equal(out.results[0].status, 'skipped-customized');
});

test('apply: world/ resolves to the active level name', async () => {
  await fresh();
  packProfiles.setPresets(SID, [{ presetId: 'world-rules', enabled: true }], { actor: 't' });
  write('config/late.toml', '[late]\nx = 0\n');
  write('world/serverconfig/ftbchunks.toml', 'max_chunks = 1\n');
  write('survival/serverconfig/ftbchunks.toml', 'max_chunks = 1\n');
  db.run('UPDATE servers SET env_json = ? WHERE id = ?', JSON.stringify({ LEVEL: 'survival' }), SID);
  const out = await packProfiles.apply(SID, { trigger: 'manual' });
  assert.equal(out.results.at(-1).status, 'applied');
  assert.equal(read('survival/serverconfig/ftbchunks.toml'), 'max_chunks = 25\n');
  assert.equal(read('world/serverconfig/ftbchunks.toml'), 'max_chunks = 1\n');
  assert.ok(out.changedFiles.includes('survival/serverconfig/ftbchunks.toml'));
});

test('apply: an unexpected patch error becomes an error status, never a throw', async (t) => {
  await fresh();
  t.mock.method(configPatch, 'patchFile', async () => {
    throw new Error('disk on fire');
  });
  const out = await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.equal(
    out.results.some((r) => r.status === 'error'),
    true
  );
  assert.equal(out.applied, 0);
});

test('pre-start hook runs before the container starts and never fails a start', async (t) => {
  await fresh();
  const containers = require('../src/docker/containers');
  const order = [];
  t.mock.method(containers, 'inspectStatus', async () => ({ exists: true, status: 'exited' }));
  t.mock.method(containers, 'startContainer', async () => order.push('start'));
  t.mock.method(packProfiles, 'apply', async () => {
    order.push('apply');
    throw new Error('boom');
  });
  await servers.startServer(SID, { actor: 'tester' });
  assert.deepEqual(order, ['apply', 'start']);
});

test('restartOnce is limited to one automatic restart per start cycle', async () => {
  await fresh();
  let restarts = 0;
  const restart = async () => {
    restarts += 1;
  };
  assert.equal(await packProfiles.restartOnce(SID, { restart }), true);
  assert.equal(await packProfiles.restartOnce(SID, { restart }), false);
  assert.equal(restarts, 1);
  // A fresh start (pre-start not triggered by us) opens a new cycle.
  await packProfiles.apply(SID, { trigger: 'pre-start' });
  assert.equal(await packProfiles.restartOnce(SID, { restart }), true);
  assert.equal(restarts, 2);
});

test('first boot: held-missing files re-apply on healthy and restart once', async () => {
  await fresh();
  await packProfiles.apply(SID, { trigger: 'pre-start' }); // late.toml is missing
  write('config/late.toml', '[late]\nx = 0\n');
  let restarts = 0;
  await packProfiles.onHealthy(SID, { restart: async () => (restarts += 1) });
  assert.equal(restarts, 1);
  assert.equal(read('config/late.toml'), '[late]\nx = 1\n');
  await packProfiles.onHealthy(SID, { restart: async () => (restarts += 1) });
  assert.equal(restarts, 1);
});

test('post-upgrade: restarts once only when files changed', async (t) => {
  await fresh();
  const steps = [];
  const calls = [];
  t.mock.method(servers, 'restartServer', async (id) => calls.push(id));
  await upgrade.applyProfileAfterUpgrade(SID, { actor: 't', step: (s) => steps.push(s) });
  assert.deepEqual(steps, ['profile', 'profile-restart']);
  assert.deepEqual(calls, [SID]);
  // Nothing left to change: no restart step.
  steps.length = 0;
  await upgrade.applyProfileAfterUpgrade(SID, { actor: 't', step: (s) => steps.push(s) });
  assert.deepEqual(steps, ['profile']);
  assert.equal(calls.length, 1);
});

test('post-upgrade never throws', async (t) => {
  await fresh();
  t.mock.method(packProfiles, 'apply', async () => {
    throw new Error('boom');
  });
  await assert.doesNotReject(upgrade.applyProfileAfterUpgrade(SID, { actor: 't', step: () => {} }));
});

test('routes: GET shape, presets, manual apply with restartNeeded, permissions', async () => {
  await fresh();
  const base = `/api/servers/${SID}/profile`;
  let r = await app.req('GET', base, { cookie: viewerCookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.profile, { id: 'curseforge/all-the-mods-10', name: 'All the Mods 10', notes: null });
  assert.equal(r.json.lastRun, null);
  assert.equal(r.json.presets[0].enabled, true);
  assert.equal(r.json.review.state, 'new');
  assert.deepEqual(Object.keys(r.json.presets[0].patches[0].ops[0]).sort(), [
    'current',
    'expect',
    'message',
    'op',
    'path',
    'status',
    'value',
  ]);

  assert.equal((await app.req('POST', `${base}/apply`, { cookie: viewerCookie })).status, 403);
  assert.equal((await app.req('POST', `${base}/presets`, { cookie: viewerCookie, body: { changes: [] } })).status, 403);

  db.run("UPDATE servers SET status = 'running' WHERE id = ?", SID);
  r = await app.req('POST', `${base}/presets`, {
    cookie: operatorCookie,
    body: { changes: [{ presetId: 'world-rules', enabled: true }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.presets[1].enabled, true);
  // Turning a preset on applies it now.
  assert.equal(r.json.applied, 2);
  assert.equal(r.json.restartNeeded, true);
  assert.deepEqual(r.json.changedFiles, ['config/mekanism/general.toml']);
  assert.equal(
    (await app.req('POST', `${base}/presets`, { cookie: adminCookie, body: { changes: [{}] } })).status,
    400
  );

  r = await app.req('POST', `${base}/apply`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.lastRun.trigger, 'manual');
  r = await app.req('POST', `${base}/apply`, { cookie: adminCookie });
  assert.equal(r.json.restartNeeded, false);

  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
  r = await app.req('GET', base, { cookie: adminCookie });
  assert.equal(r.json.profile, null);
  assert.deepEqual(r.json.presets, []);
  assert.equal((await app.req('POST', `${base}/apply`, { cookie: adminCookie })).status, 404);
  db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
});

test('onHealthy swallows a throwing apply', async (t) => {
  await fresh();
  await packProfiles.apply(SID, { trigger: 'pre-start' }); // late.toml missing: queued for first boot
  t.mock.method(configPatch, 'patchFile', async () => {
    throw new Error('boom');
  });
  t.mock.method(packProfiles, 'apply', async () => {
    throw new Error('boom');
  });
  await assert.doesNotReject(packProfiles.onHealthy(SID, { restart: async () => {} }));
});

test('routes: review prompt applies only what was turned on and reports rebuildNeeded', async () => {
  await fresh({ optIn: false });
  const base = `/api/servers/${SID}/profile`;
  assert.equal((await app.req('POST', `${base}/review`, { cookie: viewerCookie, body: { enable: [] } })).status, 403);
  assert.equal(
    (await app.req('POST', `${base}/review`, { cookie: adminCookie, body: { enable: ['nope'] } })).status,
    400
  );
  let r = await app.req('POST', `${base}/review`, { cookie: adminCookie, body: { enable: ['perf'] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.rebuildNeeded, true);
  assert.equal(r.json.settingsChanged, 2);
  assert.equal(r.json.review.state, 'reviewed');
  assert.deepEqual(
    r.json.presets.map((p) => p.enabled),
    [false, false, true]
  );
  assert.equal(r.json.presets[2].settings[0].status, 'applied');
  r = await app.req('GET', base, { cookie: viewerCookie });
  assert.equal(r.json.review.state, 'reviewed');
  db.run("UPDATE servers SET pending_recreate = 0, env_json = '{}' WHERE id = ?", SID);
});
