'use strict';

// The Mod Configs form view (public/js/lib/configForm.js): turning a config
// into fields and writing edits back without disturbing the rest of the file.
// This file runs that browser module itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** @type {any} */
let lib;
test.before(async () => {
  // A .js file in a CommonJS package: a data: URL makes Node parse it as ESM.
  const src = fs.readFileSync(path.join(__dirname, '../public/js/lib/configForm.js'), 'utf8');
  lib = await import(`data:text/javascript,${encodeURIComponent(src)}`);
});

// Trimmed from FTB Chunks' world/serverconfig/ftbchunks-world.snbt.
const FTB = `# Server-specific configuration for FTB Chunks
# Modpack defaults should be defined in <instance>/config/ftbchunks-world.snbt

{
\t# Forced modes won't let players change their ally settings
\t# Default: "default"
\t# Valid values: "default", "forced_all", "forced_none"
\tally_mode: "default"
\t
\t# Disables all land protection.
\t# Default: false
\tdisable_protection: false
\t
\t# Dimension ID's where the no_wilderness rule is enforced.
\t# Default: []
\tno_wilderness_dimensions: [ ]
\tclaiming: {
\t\t# Max claimed chunks.
\t\t# Default: 500
\t\t# Range: -∞ ~ +∞
\t\tmax_claimed_chunks: 500
\t\t
\t\t# Default: 0.0
\t\tmax_idle_days_before_unclaim: 0.0d
\t}
\tlisted: [
\t\t"minecraft:the_end"
\t\t{ nested: 1 }
\t]
\tforce_loading: {
\t\t# Valid values: "default", "always", "never"
\t\tforce_load_mode: "always"
\t\t"quoted key": "say \\"hi\\""
\t}
}
`;

const byKey = (parsed) => Object.fromEntries(parsed.fields.map((f) => [f.key, f]));
const valuesOf = (parsed) => parsed.fields.map((f) => f.value);

test('SNBT configs render as grouped, typed fields', () => {
  const parsed = lib.parseConfig(FTB, '.snbt');
  assert.ok(parsed);
  const f = byKey(parsed);
  assert.deepEqual(Object.keys(f), [
    'ally_mode',
    'disable_protection',
    'no_wilderness_dimensions',
    'max_claimed_chunks',
    'max_idle_days_before_unclaim',
    'force_load_mode',
    'quoted key',
  ]);
  assert.equal(f.ally_mode.type, 'string');
  assert.equal(f.ally_mode.group, 'General');
  assert.deepEqual(f.ally_mode.options, ['default', 'forced_all', 'forced_none']);
  assert.match(f.ally_mode.description, /Forced modes/);
  assert.doesNotMatch(f.ally_mode.description, /Valid values/);
  assert.equal(f.disable_protection.type, 'boolean');
  assert.equal(f.disable_protection.value, false);
  assert.equal(f.no_wilderness_dimensions.type, 'raw');
  assert.equal(f.max_claimed_chunks.group, 'claiming');
  assert.equal(f.max_claimed_chunks.type, 'number');
  assert.equal(f.max_idle_days_before_unclaim.value, '0.0');
  assert.equal(f.force_load_mode.group, 'force_loading');
  assert.equal(f['quoted key'].value, 'say "hi"');
});

test('an unchanged SNBT form saves the file byte for byte', () => {
  const parsed = lib.parseConfig(FTB, '.snbt');
  assert.equal(lib.serialize(parsed, valuesOf(parsed)), FTB);
});

test('SNBT edits change only their own lines and keep number suffixes and quoting', () => {
  const parsed = lib.parseConfig(FTB, '.snbt');
  const keys = parsed.fields.map((f) => f.key);
  const values = valuesOf(parsed);
  values[keys.indexOf('ally_mode')] = 'forced_all';
  values[keys.indexOf('disable_protection')] = true;
  values[keys.indexOf('max_idle_days_before_unclaim')] = '7.5';
  values[keys.indexOf('max_claimed_chunks')] = ''; // cleared: keeps the file's value
  values[keys.indexOf('quoted key')] = 'a "b" \\ c';
  values[keys.indexOf('no_wilderness_dimensions')] = '[ "minecraft:the_nether" ]';
  const out = lib.serialize(parsed, values);
  const expected = FTB.replace('ally_mode: "default"', 'ally_mode: "forced_all"')
    .replace('disable_protection: false', 'disable_protection: true')
    .replace('max_idle_days_before_unclaim: 0.0d', 'max_idle_days_before_unclaim: 7.5d')
    .replace('"quoted key": "say \\"hi\\""', '"quoted key": "a \\"b\\" \\\\ c"')
    .replace('no_wilderness_dimensions: [ ]', 'no_wilderness_dimensions: [ "minecraft:the_nether" ]');
  assert.equal(out, expected);
});

test('a file with no recognizable settings has no form', () => {
  assert.equal(lib.parseConfig('{\n}\n', '.snbt'), null);
  assert.equal(lib.parseConfig('anything', '.yaml'), null);
});

test('TOML and JSON forms still round-trip', () => {
  const toml = '[general]\n# Turn it on\nenabled = true\ncount = 3\n';
  const t = lib.parseConfig(toml, '.toml');
  assert.equal(lib.serialize(t, valuesOf(t)), toml);
  assert.equal(lib.serialize(t, [false, '4']), '[general]\n# Turn it on\nenabled = false\ncount = 4\n');

  const j = lib.parseConfig('{"a":{"b":1,"c":"x"},"d":true}', '.json');
  assert.equal(byKey(j).b.group, 'a');
  assert.equal(lib.serialize(j, ['2', 'y', false]), '{\n  "a": {\n    "b": 2,\n    "c": "y"\n  },\n  "d": false\n}\n');
});
