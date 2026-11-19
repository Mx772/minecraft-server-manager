'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');
const loader = require('../src/services/packProfiles/loader');
const { profile } = require('../src/services/packProfiles/schema');
const version = require('../src/services/packProfiles/version');

const FIXTURES = path.join(__dirname, 'fixtures', 'pack-profiles');
const good = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'curseforge', 'all-the-mods-10.json'), 'utf8'));
const withFile = (file) => {
  const p = good();
  p.presets[0].patches[0].file = file;
  return p;
};

test('fixture profiles load and the bundled folder is valid', () => {
  const { profiles, invalid } = loader.loadDir(FIXTURES);
  assert.deepEqual(invalid, []);
  assert.deepEqual(profiles.map((p) => p.id).sort(), ['curseforge/all-the-mods-10', 'modrinth/fabulously-optimized']);
  assert.deepEqual(loader.loadDir(loader.DEFAULT_DIR).invalid, []);
});

test('schema.json matches the zod schema', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pack-profiles', 'schema.json'), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(z.toJSONSchema(profile))));
});

test('trust rules reject unsafe or unsupported file paths', () => {
  for (const file of [
    'kubejs/server_scripts/x.json',
    'config/kubejs/x.json',
    'config/scripts/x.json',
    'config/../mods/x.json',
    '../config/x.json',
    '/etc/passwd.json',
    'C:/config/x.json',
    'config\\x.json',
    'mods/x.json',
    'config/x.js',
    'config/x.zs',
    'config/x.jar',
    'config/x.cfg',
    'world/level.json',
    'config//x.json',
  ]) {
    assert.equal(profile.safeParse(withFile(file)).success, false, file);
  }
  for (const file of ['config/a/b.toml', 'defaultconfigs/x.json', 'world/serverconfig/y.toml', 'config/z.properties']) {
    assert.equal(profile.safeParse(withFile(file)).success, true, file);
  }
});

test('schema is strict about keys, values, ids and ranges', () => {
  const bad = (mutate) => {
    const p = good();
    mutate(p);
    return profile.safeParse(p).success;
  };
  assert.equal(
    bad((p) => (p.extra = 1)),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].extra = 1)),
    false
  );
  assert.equal(
    bad((p) => (p.id = 'curseforge/other')),
    false
  );
  assert.equal(
    bad((p) => (p.versions = '>=abc')),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].patches[0].ops[0].value = { a: 1 })),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].patches[0].ops[0].value = [[1]])),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].patches[0].ops[0].op = 'remove')),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].patches[0].format = 'json')),
    false
  );
  assert.equal(
    bad((p) => p.presets.push(structuredClone(p.presets[0]))),
    false
  );
  assert.equal(
    bad((p) => (p.presets[0].patches[0].ops[0].value = ['a', 2, true])),
    true
  );
});

test('invalid profiles are skipped with a reason and listed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  try {
    fs.mkdirSync(path.join(dir, 'curseforge'));
    fs.writeFileSync(path.join(dir, 'curseforge', 'all-the-mods-10.json'), JSON.stringify(good()));
    fs.writeFileSync(path.join(dir, 'curseforge', 'evil.json'), JSON.stringify(withFile('kubejs/x.json')));
    fs.writeFileSync(path.join(dir, 'curseforge', 'broken.json'), '{nope');
    const wrongPlace = good();
    wrongPlace.slug = 'other';
    wrongPlace.id = 'curseforge/other';
    fs.writeFileSync(path.join(dir, 'curseforge', 'misplaced.json'), JSON.stringify(wrongPlace));
    const { profiles, invalid } = loader.loadDir(dir);
    assert.deepEqual(
      profiles.map((p) => p.id),
      ['curseforge/all-the-mods-10']
    );
    assert.deepEqual(invalid.map((i) => i.file).sort(), [
      'curseforge/broken.json',
      'curseforge/evil.json',
      'curseforge/misplaced.json',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('version comparator handles dotted numbers and ranges', () => {
  const s = version.satisfies;
  assert.equal(s('8.6', '>=8.0 <9'), true);
  assert.equal(s('9.0', '>=8.0 <9'), false);
  assert.equal(s('8.0', '>8.0'), false);
  assert.equal(s('8.0.1', '>8.0'), true);
  assert.equal(s('2.7.4', '=2.7.4'), true);
  assert.equal(s('2.7', '=2.7.0'), true);
  assert.equal(s('2.10', '>2.9'), true);
  assert.equal(s('2.7.4', '<=2.7.4'), true);
  assert.equal(s('v1.2', '>=1.2'), true);
  assert.equal(s('8.6', undefined), true);
  assert.equal(s('beta-1', undefined), true);
  assert.equal(s('beta-1', '>=1'), false);
  assert.equal(s('1.0', 'garbage'), false);
  assert.equal(version.isValidRange('>=1 <2'), true);
  assert.equal(version.isValidRange('~1'), false);
});

test('extractVersion pulls the last dotted number out of a pinned name', () => {
  const x = version.extractVersion;
  assert.equal(x('ATM10-8.6'), '8.6');
  assert.equal(x('All the Mods 10-8.6.zip'), '8.6');
  assert.equal(x('v2.7.4'), '2.7.4');
  assert.equal(x('1.21.1-8.6.1'), '8.6.1');
  assert.equal(x('8'), '8');
  assert.equal(x('ATM10'), null);
  assert.equal(x('latest'), null);
  assert.equal(version.satisfies('1.21.1-8.6.1', '>=8.0 <9'), true);
  assert.equal(version.satisfies('ATM10-8.6', '>=8'), true);
  assert.equal(version.satisfies('latest', '>=1'), false);
  assert.equal(version.satisfies('latest', undefined), true);
});

test('settings presets: allowlisted keys with catalog-valid values only', () => {
  const withSettings = (settings, patches) => {
    const p = good();
    p.presets = [{ id: 'x', title: 'X', description: 'D.', default: true, ...(patches ? { patches } : {}), settings }];
    return profile.safeParse(p);
  };
  assert.ok(withSettings({ VIEW_DISTANCE: 8, MAX_TICK_TIME: -1, USE_AIKAR_FLAGS: true }).success);
  assert.ok(!withSettings({ MOTD: 'hi' }).success);
  assert.ok(!withSettings({ VIEW_DISTANCE: 99 }).success);
  assert.ok(!withSettings({ VIEW_DISTANCE: 8.5 }).success);
  assert.ok(!withSettings({ ALLOW_FLIGHT: 'true' }).success);
  assert.ok(!withSettings({ MAX_TICK_TIME: -5 }).success);
  assert.ok(!withSettings({}).success);
});

test('the bundled All the Mods 10 profile loads with its settings preset', () => {
  const { profiles, invalid } = loader.loadDir(loader.DEFAULT_DIR);
  assert.deepEqual(invalid, []);
  const atm = profiles.find((p) => p.id === 'curseforge/all-the-mods-10');
  const preset = atm.presets.find((p) => p.id === 'server-pack-settings');
  assert.equal(preset.default, true);
  assert.deepEqual(preset.settings, {
    VIEW_DISTANCE: 8,
    SIMULATION_DISTANCE: 5,
    ALLOW_FLIGHT: true,
    MAX_TICK_TIME: 180000,
    USE_AIKAR_FLAGS: true,
  });
});
