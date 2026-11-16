'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPatch, detectFormat, patchFile } = require('../src/services/configPatch');

const set = (p, value, extra = {}) => ({ op: 'set', path: p, value, ...extra });

test('detectFormat', () => {
  assert.equal(detectFormat('config/a.toml'), 'toml');
  assert.equal(detectFormat('server.properties'), 'properties');
  assert.equal(detectFormat('a/B.JSON'), 'json');
  assert.equal(detectFormat('a.yaml'), null);
});

test('programmer errors throw', () => {
  assert.throws(() => applyPatch('', 'yaml', []), TypeError);
  assert.throws(() => applyPatch('', 'json', [{ op: 'nuke', path: ['a'] }]), TypeError);
  assert.throws(() => applyPatch('', 'json', [{ op: 'set', path: [], value: 1 }]), TypeError);
});

test('results carry the op index', () => {
  const r = applyPatch('a=1\n', 'properties', [set(['a'], '1'), set(['b'], '2')]);
  assert.deepEqual(
    r.results.map((x) => [x.index, x.status]),
    [
      [0, 'unchanged'],
      [1, 'held-missing'],
    ]
  );
});

const PROPS =
  '#Minecraft server properties\r\n# comment\r\nmotd = Hello world\r\nview-distance:10\r\n! bang\r\nspawn-protection 16\r\nempty=\r\npvp=true';

test('properties: separators, comments and CRLF preserved', () => {
  const r = applyPatch(PROPS, 'properties', [
    set(['motd'], 'New'),
    set(['view-distance'], 6),
    set(['spawn-protection'], 0),
    set(['empty'], 'x'),
    set(['pvp'], false, { expect: true }),
    set(['gone'], 1),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['applied', 'applied', 'applied', 'applied', 'applied', 'held-missing']
  );
  assert.equal(
    r.text,
    '#Minecraft server properties\r\n# comment\r\nmotd = New\r\nview-distance:6\r\n! bang\r\nspawn-protection 0\r\nempty=x\r\npvp=false'
  );
});

test('properties: unchanged, held-expect, lists unsupported', () => {
  const r = applyPatch(PROPS, 'properties', [
    set(['pvp'], true, { expect: false }),
    set(['motd'], 'X', { expect: 'Other' }),
    { op: 'append', path: ['motd'], value: 'a' },
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['unchanged', 'held-expect', 'held-unsupported']
  );
  assert.equal(r.text, PROPS);
});

test('json: indentation and trailing newline preserved', () => {
  for (const [indent, nl] of [
    [2, '\n'],
    ['\t', '\n'],
    [4, ''],
    [undefined, '\n'],
    [undefined, ''],
  ]) {
    const src = JSON.stringify({ a: { b: 1, list: ['x'] }, c: true }, null, indent) + nl;
    const r = applyPatch(src, 'json', [set(['a', 'b'], 2), { op: 'append', path: ['a', 'list'], value: 'y' }]);
    assert.deepEqual(
      r.results.map((x) => x.status),
      ['applied', 'applied']
    );
    assert.equal(r.text, JSON.stringify({ a: { b: 2, list: ['x', 'y'] }, c: true }, null, indent) + nl);
  }
});

test('json: unchanged, held-missing, held-expect, removeFrom, array index', () => {
  const src = '{\n  "a": 1,\n  "g": [{"c": "x"}],\n  "l": ["p", "q"]\n}\n';
  const r = applyPatch(src, 'json', [
    set(['a'], 1),
    set(['zz'], 1),
    set(['a'], 2, { expect: 5 }),
    set(['g', 0, 'c'], 'y'),
    { op: 'removeFrom', path: ['l'], value: 'p' },
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['unchanged', 'held-missing', 'held-expect', 'applied', 'applied']
  );
  assert.deepEqual(JSON.parse(r.text), { a: 1, g: [{ c: 'y' }], l: ['q'] });
});

test('json: unparseable or commented files error and stay unchanged', () => {
  for (const bad of ['{ "a": 1, // c\n}', '{nope', '']) {
    const r = applyPatch(bad, 'json', [set(['a'], 2)]);
    assert.equal(r.results[0].status, 'error');
    assert.equal(r.text, bad);
    assert.equal(r.changed, false);
  }
});

test('patchFile writes only when changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgpatch-'));
  try {
    const f = path.join(dir, 'a.toml');
    fs.writeFileSync(f, '# hi\nx = 1\n');
    const r1 = await patchFile(f, { ops: [set(['x'], 2)] });
    assert.ok(r1.changed);
    assert.equal(fs.readFileSync(f, 'utf8'), '# hi\nx = 2\n');
    const before = fs.statSync(f).mtimeMs;
    const r2 = await patchFile(f, { ops: [set(['x'], 2)] });
    assert.equal(r2.changed, false);
    assert.equal(fs.statSync(f).mtimeMs, before);
    assert.deepEqual(fs.readdirSync(dir), ['a.toml']);
    const r3 = await patchFile(path.join(dir, 'missing.toml'), { ops: [set(['x'], 2)] });
    assert.equal(r3.results[0].status, 'held-missing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
