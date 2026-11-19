'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPatch } = require('../src/services/configPatch');

const NEO = `# Chat bridge config
[general]
\t#Radiation toggle
\tradiation = true # keep an eye on this
\tspawnCap = 70
\tratio = 1.5
\tname = "Hello"
\tlit = 'literal'
\t"quoted key" = 5
\tbig = 1_000

\tlimits.max = 3

[limits]
\t#Items
\tlist = [ "a", "b" ]
\ttall = [
\t\t"x",
\t\t"y",
\t]

[[guilds]]
\tchannel = "111"
\t[guilds.channelOverrides]
\t\tdeathsChannelId = "d1"

[[guilds]]
\tchannel = "222"
\t[guilds.channelOverrides]
\t\tdeathsChannelId = "d2"

[misc]
inline = { a = 1 }
ml = """
[notgeader]
"""
after = 1
`;

const crlf = (s) => s.replace(/\n/g, '\r\n');
const set = (path, value, extra = {}) => ({ op: 'set', path, value, ...extra });

function onlyChangedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length);
  return a.map((l, i) => (l === b[i] ? null : [i, l, b[i]])).filter(Boolean);
}

test('set bool, int, float, string keeps type and trailing comment', () => {
  const r = applyPatch(NEO, 'toml', [
    set(['general', 'radiation'], false),
    set(['general', 'spawnCap'], 40),
    set(['general', 'ratio'], 2),
    set(['general', 'name'], 'Bye "x"'),
    set(['general', 'lit'], 'new'),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    Array(5).fill('applied')
  );
  assert.ok(r.changed);
  assert.match(r.text, /\tradiation = false # keep an eye on this\n/);
  assert.match(r.text, /\tspawnCap = 40\n/);
  assert.match(r.text, /\tratio = 2\.0\n/);
  assert.match(r.text, /\tname = "Bye \\"x\\""\n/);
  assert.match(r.text, /\tlit = 'new'\n/);
  assert.equal(onlyChangedLines(NEO, r.text).length, 5);
});

test('quoted key, dotted key, underscored int', () => {
  const r = applyPatch(NEO, 'toml', [
    set(['general', 'quoted key'], 6),
    set(['general', 'limits', 'max'], 9),
    set(['general', 'big'], 2000),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['applied', 'applied', 'applied']
  );
  assert.match(r.text, /\t"quoted key" = 6\n/);
  assert.match(r.text, /\tlimits\.max = 9\n/);
  assert.match(r.text, /\tbig = 2000\n/);
});

test('array of tables and subtables by occurrence index', () => {
  const r = applyPatch(NEO, 'toml', [
    set(['guilds', 0, 'channel'], '999'),
    set(['guilds', 1, 'channelOverrides', 'deathsChannelId'], 'z'),
    set(['guilds', 0, 'channelOverrides', 'deathsChannelId'], 'y'),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['applied', 'applied', 'applied']
  );
  assert.match(r.text, /channel = "999"[\s\S]*deathsChannelId = "y"[\s\S]*channel = "222"[\s\S]*deathsChannelId = "z"/);
  assert.equal(onlyChangedLines(NEO, r.text).length, 3);
});

test('idempotent: second apply is unchanged and text identical', () => {
  const ops = [
    set(['general', 'spawnCap'], 40),
    { op: 'append', path: ['limits', 'list'], value: 'c' },
    set(['guilds', 1, 'channel'], 'q'),
  ];
  const one = applyPatch(NEO, 'toml', ops);
  const two = applyPatch(one.text, 'toml', ops);
  assert.deepEqual(
    two.results.map((x) => x.status),
    ['unchanged', 'unchanged', 'unchanged']
  );
  assert.equal(two.text, one.text);
  assert.equal(two.changed, false);
});

test('held-missing for a renamed key or index', () => {
  const r = applyPatch(NEO, 'toml', [
    set(['general', 'spawnLimit'], 1),
    set(['guilds', 5, 'channel'], 'x'),
    set(['nope', 'a'], 1),
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['held-missing', 'held-missing', 'held-missing']
  );
  assert.equal(r.text, NEO);
});

test('held-expect when the pack changed the value, unchanged when already target', () => {
  const r = applyPatch(NEO, 'toml', [
    set(['general', 'spawnCap'], 40, { expect: 100 }),
    set(['general', 'spawnCap'], 70, { expect: 100 }),
    set(['general', 'spawnCap'], 40, { expect: 70 }),
  ]);
  assert.equal(r.results[0].status, 'held-expect');
  assert.equal(r.results[0].current, 70);
  assert.equal(r.results[1].status, 'unchanged');
  assert.equal(r.results[2].status, 'applied');
  assert.match(r.text, /spawnCap = 40/);
});

test('every untouched line is byte-identical (LF and CRLF)', () => {
  for (const src of [NEO, crlf(NEO)]) {
    const r = applyPatch(src, 'toml', [set(['general', 'radiation'], false)]);
    const a = src.split(/(?<=\n)/);
    const b = r.text.split(/(?<=\n)/);
    assert.equal(a.length, b.length);
    const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    assert.equal(diff.length, 1);
    assert.equal(r.text.includes('\r\n'), src.includes('\r\n'));
    if (src.includes('\r\n')) assert.ok(!/[^\r]\n/.test(r.text));
  }
});

test('missing trailing newline is preserved', () => {
  const r = applyPatch('a = 1', 'toml', [set(['a'], 2)]);
  assert.equal(r.text, 'a = 2');
});

test('unparseable file: all error, text unchanged', () => {
  const bad = 'a = = 1\n[x\n';
  const r = applyPatch(bad, 'toml', [set(['a'], 2), set(['b'], 1)]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['error', 'error']
  );
  assert.equal(r.text, bad);
  assert.equal(r.changed, false);
});

test('single-line arrays: append, removeFrom, spacing kept', () => {
  let r = applyPatch(NEO, 'toml', [{ op: 'append', path: ['limits', 'list'], value: 'c' }]);
  assert.match(r.text, /\tlist = \[ "a", "b", "c" \]\n/);
  r = applyPatch(r.text, 'toml', [
    { op: 'removeFrom', path: ['limits', 'list'], value: 'a' },
    { op: 'removeFrom', path: ['limits', 'list'], value: 'zz' },
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['applied', 'unchanged']
  );
  assert.match(r.text, /\tlist = \[ "b", "c" \]\n/);
  r = applyPatch('l = ["a","b"]\n', 'toml', [{ op: 'append', path: ['l'], value: 'c' }]);
  assert.equal(r.text, 'l = ["a","b","c"]\n');
});

test('multi-line arrays: append and removeFrom keep indentation', () => {
  for (const src of [NEO, crlf(NEO)]) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    let r = applyPatch(src, 'toml', [{ op: 'append', path: ['limits', 'tall'], value: 'z' }]);
    assert.ok(r.text.includes(`\ttall = [${eol}\t\t"x",${eol}\t\t"y",${eol}\t\t"z",${eol}\t]${eol}`));
    r = applyPatch(r.text, 'toml', [{ op: 'removeFrom', path: ['limits', 'tall'], value: 'x' }]);
    assert.ok(r.text.includes(`\ttall = [${eol}\t\t"y",${eol}\t\t"z",${eol}\t]${eol}`));
  }
});

test('array set reuses raw text of unchanged elements and handles numbers', () => {
  const r = applyPatch('n = [1.0, 0x10, 3]\n', 'toml', [{ op: 'append', path: ['n'], value: 4 }]);
  assert.equal(r.text, 'n = [1.0, 0x10, 3, 4]\n');
  const s = applyPatch('l = ["a"]\n', 'toml', [set(['l'], ['x', 'y'])]);
  assert.equal(s.text, 'l = ["x", "y"]\n');
});

test('unsupported: inline tables, multi-line strings, inline targets, arrays with comments', () => {
  const r = applyPatch(NEO + '', 'toml', [
    set(['misc', 'inline'], 1),
    set(['misc', 'inline', 'a'], 2),
    set(['misc', 'ml'], 'x'),
    { op: 'append', path: ['general', 'spawnCap'], value: 1 },
  ]);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['held-unsupported', 'held-unsupported', 'held-unsupported', 'held-unsupported']
  );
  const c = applyPatch('l = [\n  "a", # why\n  "b"\n]\n', 'toml', [{ op: 'append', path: ['l'], value: 'c' }]);
  assert.equal(c.results[0].status, 'held-unsupported');
  const o = applyPatch(NEO, 'toml', [set(['misc', 'after'], 2), set(['general', 'name'], { a: 1 })]);
  assert.equal(o.results[0].status, 'applied');
  assert.equal(o.results[1].status, 'held-unsupported');
  assert.match(o.text, /\[notgeader\]\n"""\nafter = 2/);
});

test('type change writes the target type', () => {
  const r = applyPatch('a = 1\nb = "x"\n', 'toml', [set(['a'], 'one'), set(['b'], 5)]);
  assert.equal(r.text, 'a = "one"\nb = 5\n');
});

test('string escaping round-trips', () => {
  const v = 'a\\b "q"\nnl\ttab';
  const r = applyPatch('s = "x"\n', 'toml', [set(['s'], v)]);
  assert.equal(r.results[0].status, 'applied');
  assert.equal(require('smol-toml').parse(r.text).s, v);
});

test('minimal array edits keep every other byte identical', () => {
  const app = (src, v) => applyPatch(src, 'toml', [{ op: 'append', path: ['dims'], value: v }]).text;
  const rem = (src, v) => applyPatch(src, 'toml', [{ op: 'removeFrom', path: ['dims'], value: v }]).text;

  // first element on the bracket line, tabs
  const a = '\tdims = ["a",\n\t\t"b"]\n\tnext = 1\n';
  assert.equal(app(a, 'c'), '\tdims = ["a",\n\t\t"b",\n\t\t"c"]\n\tnext = 1\n');
  // bracket on its own line, spaces, with and without trailing comma
  const b = 'dims = [\n    "a",\n    "b"\n]\n';
  assert.equal(app(b, 'c'), 'dims = [\n    "a",\n    "b",\n    "c"\n]\n');
  const c = 'dims = [\n    "a",\n    "b",\n]\n';
  assert.equal(app(c, 'c'), 'dims = [\n    "a",\n    "b",\n    "c",\n]\n');
  assert.equal(app(crlf(c), 'c'), crlf('dims = [\n    "a",\n    "b",\n    "c",\n]\n'));
  // single line
  assert.equal(app('dims = [ "a",  "b" ] # c\n', 'c'), 'dims = [ "a",  "b",  "c" ] # c\n');
  assert.equal(app('dims = ["a", "b",]\n', 'c'), 'dims = ["a", "b", "c",]\n');

  // removeFrom first / middle / last
  assert.equal(rem(a, 'a'), '\tdims = ["b"]\n\tnext = 1\n');
  assert.equal(rem(a, 'b'), '\tdims = ["a"]\n\tnext = 1\n');
  assert.equal(rem(b, 'a'), 'dims = [\n    "b"\n]\n');
  assert.equal(rem(b, 'b'), 'dims = [\n    "a"\n]\n');
  const m = 'dims = [\n\t"a",\n\t"b",\n\t"c",\n]\n';
  assert.equal(rem(m, 'a'), 'dims = [\n\t"b",\n\t"c",\n]\n');
  assert.equal(rem(m, 'b'), 'dims = [\n\t"a",\n\t"c",\n]\n');
  assert.equal(rem(m, 'c'), 'dims = [\n\t"a",\n\t"b",\n]\n');
  assert.equal(rem('dims = [ "a", "b", "c" ]\n', 'b'), 'dims = [ "a", "c" ]\n');
  // sole element falls back to the rewrite
  assert.equal(rem('dims = ["a"]\n', 'a'), 'dims = []\n');
});
