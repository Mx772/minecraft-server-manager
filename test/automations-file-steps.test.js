'use strict';

// Copy Files and Delete Files: the glob matcher, parameter rules, the planner
// for every mode, the caps, protected paths, and what the runner changes on disk.
// Uses a real temp data directory; no Docker.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const config = require('../src/config');
const automations = require('../src/automations');
const fileSteps = require('../src/automations/fileSteps');

const SID = 'srv_files';
const root = () => path.join(config.dataDir, 'servers', SID);
const put = (rel, text = 'x', mtime) => {
  const abs = path.join(root(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
};
const read = (rel) => fs.readFileSync(path.join(root(), rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(root(), rel));
const copy = (params) => ({ action: 'copy-files', params: fileSteps.copyParams.parse(params) });
const del = (params) => ({ action: 'delete-files', params: fileSteps.deleteParams.parse(params) });
const changes = (plan) => Object.fromEntries(plan.files.map((f) => [f.path, f.change]));
const refused = (promise, pattern) => assert.rejects(promise, (err) => err.status === 400 && pattern.test(err.message));

test.before(() => {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Files', 'PAPER', 47500, 48500, 'x', 1024, 1536)`,
    SID
  );
});
test.beforeEach(() => {
  fs.rmSync(root(), { recursive: true, force: true });
  fs.mkdirSync(root(), { recursive: true });
});
test.after(() => {
  automations.stopAll();
  fs.rmSync(root(), { recursive: true, force: true });
});

test('glob: * stays in a folder, ** crosses folders, ? is one character, braces choose', () => {
  const m = fileSteps.matchesGlob;
  assert.ok(m('a.json', '*.json') && !m('dir/a.json', '*.json'));
  assert.ok(m('dir/a.json', '**/*.json') && m('a.json', '**/*.json') && m('x/y/z.json', '**/*.json'));
  assert.ok(m('anything/at/all.txt', '**') && m('a', '**'));
  assert.ok(m('a1.txt', 'a?.txt') && !m('a12.txt', 'a?.txt') && !m('a/.txt', 'a?.txt'));
  assert.ok(m('a.js', '*.{js,ts}') && m('a.ts', '*.{js,ts}') && !m('a.css', '*.{js,ts}'));
  assert.ok(m('a.b', 'a.b') && !m('axb', 'a.b'), 'a dot is a dot');
  assert.ok(!m('A.JSON', '*.json'), 'case matters');
  assert.ok(m('a/b', 'a/**') && !m('a', 'a/**'), 'a/** is everything below a');
  const { compileGlob } = require('../src/automations/glob');
  assert.throws(() => compileGlob('{a,b'));
});

test('glob: hostile patterns are refused or finish at once (no regex backtracking)', () => {
  const { compileGlob } = require('../src/automations/glob');
  const paths = Array.from({ length: 1000 }, (_, i) => `mods/${'a'.repeat(40)}/${i}`);
  for (const pattern of ['**a**a**a**a**a**a**a**ab', '**?**?**?**?!', '?*?*?*?*!', '*a*a*a*a*a*a*a*b']) {
    const started = Date.now();
    const glob = compileGlob(pattern);
    for (const p of paths) glob.test(p);
    assert.ok(Date.now() - started < 1000, `${pattern} took ${Date.now() - started} ms`);
  }
  // Past the wildcard cap a pattern is refused when saved.
  for (const bad of [
    '**a'.repeat(10) + 'b',
    '?'.repeat(9),
    'x'.repeat(201),
    '{a,b,c}{d,e,f}',
    '{a,{b,c}}',
    '{a',
    'a}',
  ]) {
    assert.equal(fileSteps.copyParams.safeParse({ from: 'a', to: 'b', include: bad }).success, false, bad);
  }
  assert.equal(fileSteps.copyParams.safeParse({ from: 'a', to: 'b', include: '*.{js,ts}' }).success, true);
  assert.equal(compileGlob('***.json').test('a.json'), true, 'a run of stars is one wildcard');
});

test('parameters: paths are normalised and anything that could leave the folder is refused', () => {
  const ok = fileSteps.copyParams.parse({ from: './custom\\kubejs/', to: 'kubejs' });
  assert.deepEqual({ ...ok }, { from: 'custom/kubejs', to: 'kubejs', mode: 'overwrite', include: '**' });
  assert.equal(fileSteps.copyParams.parse({ from: '.', to: 'a' }).from, '');
  const bad = (p) => assert.equal(fileSteps.copyParams.safeParse({ from: p, to: 'a' }).success, false, p);
  bad('../x');
  bad('a/../../x');
  bad('/etc/passwd');
  bad('C:/Windows');
  bad('a\0b');
  bad('x'.repeat(301));
  assert.equal(fileSteps.deleteParams.safeParse({ path: 'a' }).success, false, 'delete needs an include');
  assert.equal(fileSteps.deleteParams.safeParse({ path: 'a', include: '' }).success, false);
  assert.equal(fileSteps.deleteParams.safeParse({ path: 'a', include: '{x' }).success, false);
});

test('saving refuses a path that leaves the folder, with a sentence that says so', () => {
  assert.throws(
    () =>
      automations.validateAutomation({
        name: 'Escape',
        targets: { kind: 'servers', serverIds: [SID] },
        trigger: { type: 'event', event: 'after-stop' },
        steps: [{ offsetSec: 0, action: 'copy-files', params: { from: '../other', to: 'x' } }],
      }),
    (err) => err.status === 400 && /cannot use "\.\."/.test(err.message)
  );
});

test('copy: a folder tree is mirrored into the destination', async () => {
  put('custom/kubejs/a.js', 'A');
  put('custom/kubejs/sub/b.js', 'B');
  const plan = await fileSteps.planFileStep(SID, copy({ from: 'custom/kubejs', to: 'kubejs' }));
  assert.deepEqual(changes(plan), { 'kubejs/a.js': 'create', 'kubejs/sub/b.js': 'create' });
  assert.equal(plan.totals.files, 2);
  assert.ok(!has('kubejs'), 'planning writes nothing');
  await fileSteps.runFileStep(SID, copy({ from: 'custom/kubejs', to: 'kubejs' }), { automationName: 'Restore KubeJS' });
  assert.equal(read('kubejs/sub/b.js'), 'B');
  const ev = db.get("SELECT * FROM events WHERE type = 'automation-files-copied' ORDER BY id DESC");
  assert.equal(ev.summary, 'Automation Restore KubeJS copied 2 files.');
  assert.equal(ev.server_id, SID);
});

test('copy modes: overwrite, skip-existing, and only-if-newer by modified time', async () => {
  const old = new Date('2020-01-01');
  const recent = new Date('2025-01-01');
  put('from/new.txt', 'src', recent);
  put('from/both-newer-src.txt', 'src', recent);
  put('from/both-older-src.txt', 'src', old);
  put('to/both-newer-src.txt', 'dest', old);
  put('to/both-older-src.txt', 'dest', recent);
  put('to/new.txt', 'dest', old);
  const planOf = async (mode) => changes(await fileSteps.planFileStep(SID, copy({ from: 'from', to: 'to', mode })));
  assert.deepEqual(await planOf('overwrite'), {
    'to/new.txt': 'overwrite',
    'to/both-newer-src.txt': 'overwrite',
    'to/both-older-src.txt': 'overwrite',
  });
  assert.deepEqual(await planOf('skip-existing'), {
    'to/new.txt': 'skip',
    'to/both-newer-src.txt': 'skip',
    'to/both-older-src.txt': 'skip',
  });
  assert.deepEqual(await planOf('only-if-newer'), {
    'to/new.txt': 'overwrite',
    'to/both-newer-src.txt': 'overwrite',
    'to/both-older-src.txt': 'skip',
  });
  await fileSteps.runFileStep(SID, copy({ from: 'from', to: 'to', mode: 'only-if-newer' }), { automationName: 'M' });
  assert.equal(read('to/both-newer-src.txt'), 'src');
  assert.equal(read('to/both-older-src.txt'), 'dest', 'a skipped file is untouched');
});

test('copy: include picks files by path relative to the source folder; a single file can be copied', async () => {
  put('src/a.json', 'a');
  put('src/deep/b.json', 'b');
  put('src/c.txt', 'c');
  const flat = await fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out', include: '*.json' }));
  assert.deepEqual(Object.keys(changes(flat)), ['out/a.json']);
  const deep = await fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out', include: '**/*.json' }));
  assert.deepEqual(Object.keys(changes(deep)).sort(), ['out/a.json', 'out/deep/b.json']);
  await fileSteps.runFileStep(SID, copy({ from: 'src/c.txt', to: 'out/renamed.txt' }), { automationName: 'One' });
  assert.equal(read('out/renamed.txt'), 'c');
  fs.mkdirSync(path.join(root(), 'dir'));
  await fileSteps.runFileStep(SID, copy({ from: 'src/c.txt', to: 'dir' }), { automationName: 'One' });
  assert.equal(read('dir/c.txt'), 'c', 'into an existing folder keeps the name');
});

test('copy: a missing source, a folder into itself, and the world folders are refused', async () => {
  await refused(fileSteps.planFileStep(SID, copy({ from: 'nope', to: 'x' })), /can't find "nope"/);
  put('a/f.txt');
  await refused(fileSteps.planFileStep(SID, copy({ from: 'a', to: 'a/b' })), /into itself/);
  await refused(fileSteps.planFileStep(SID, copy({ from: 'a', to: 'world/data' })), /world folder/);
  put('world/level.dat');
  await refused(fileSteps.planFileStep(SID, copy({ from: 'world', to: 'x' })), /world folder/);
  // A whole-folder copy leaves world folders out.
  put('keep.txt');
  const plan = await fileSteps.planFileStep(SID, copy({ from: 'a', to: 'b' }));
  assert.ok(plan.files.every((f) => !f.path.startsWith('world')));
});

test('copy never follows a symlink: not one inside the tree, not one that leads out as the destination', async () => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    put('src/real.txt', 'r');
    fs.symlinkSync(outside, path.join(root(), 'src', 'link'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root(), 'src', 'filelink.txt'));
    const plan = await fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out' }));
    assert.deepEqual(Object.keys(changes(plan)), ['out/real.txt'], 'links in the tree are skipped');

    fs.symlinkSync(outside, path.join(root(), 'escape'));
    await assert.rejects(
      fileSteps.planFileStep(SID, copy({ from: 'src', to: 'escape/x' })),
      (err) => err.status === 400
    );
    await assert.rejects(fileSteps.planFileStep(SID, copy({ from: 'escape', to: 'x' })), (err) => err.status === 400);
    assert.ok(!fs.existsSync(path.join(outside, 'x')));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('copy: over the file cap it fails before writing anything', async () => {
  const dir = path.join(root(), 'many');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= fileSteps.MAX_COPY_FILES; i++) fs.writeFileSync(path.join(dir, `f${i}`), '');
  await refused(
    fileSteps.runFileStep(SID, copy({ from: 'many', to: 'out' }), { automationName: 'Big' }),
    /more than 5,000 files/
  );
  assert.ok(!has('out'));
  const narrowed = await fileSteps.planFileStep(SID, copy({ from: 'many', to: 'out', include: 'f1?' }));
  assert.equal(narrowed.totals.files, 10, 'a narrower include fits under the cap');
});

test('delete: removes matching files, and only the folders this step emptied', async () => {
  put('cfg/a.tmp');
  put('cfg/keep.json');
  put('cfg/sub/b.tmp');
  put('cfg/sub/deeper/c.tmp');
  put('cfg/mixed/d.tmp');
  put('cfg/mixed/e.json');
  fs.mkdirSync(path.join(root(), 'cfg', 'was-empty'));
  const step = del({ path: 'cfg', include: '**/*.tmp' });
  const plan = await fileSteps.planFileStep(SID, step);
  assert.equal(plan.totals.delete, 4);
  assert.deepEqual(
    plan.files
      .filter((f) => f.path.endsWith('/'))
      .map((f) => f.path)
      .sort(),
    ['cfg/sub/', 'cfg/sub/deeper/']
  );
  assert.ok(has('cfg/a.tmp'), 'planning deletes nothing');
  await fileSteps.runFileStep(SID, step, { automationName: 'Tidy' });
  assert.ok(!has('cfg/a.tmp') && !has('cfg/sub') && !has('cfg/mixed/d.tmp'));
  assert.ok(has('cfg/keep.json') && has('cfg/mixed/e.json'));
  assert.ok(has('cfg/was-empty'), 'a folder that was already empty stays');
  assert.ok(has('cfg'), 'the folder named in the step stays');
  assert.equal(
    db.get("SELECT summary FROM events WHERE type = 'automation-files-deleted' ORDER BY id DESC").summary,
    'Automation Tidy deleted 4 files.'
  );
});

test('delete: a single file path, and a path that is not there', async () => {
  put('one.log');
  await fileSteps.runFileStep(SID, del({ path: 'one.log', include: '*.log' }), { automationName: 'One' });
  assert.ok(!has('one.log'));
  assert.equal((await fileSteps.planFileStep(SID, del({ path: 'gone', include: '**' }))).totals.files, 0);
});

test('delete needs a folder inside the server: the root is refused whatever the pattern', () => {
  for (const include of ['**', '*', '**/?*', '**/*.properties']) {
    for (const p of ['', '.', './']) {
      assert.equal(fileSteps.deleteParams.safeParse({ path: p, include }).success, false, `${p} ${include}`);
    }
  }
  assert.throws(
    () =>
      automations.validateAutomation({
        name: 'Root',
        targets: { kind: 'servers', serverIds: [SID] },
        trigger: { type: 'event', event: 'after-stop' },
        steps: [{ offsetSec: 0, action: 'delete-files', params: { path: '', include: '*' } }],
      }),
    (err) => err.status === 400 && /needs a folder inside the server, such as logs/.test(err.message)
  );
});

test('delete refuses world folders', async () => {
  await refused(fileSteps.planFileStep(SID, del({ path: 'world', include: '**' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, del({ path: 'world_nether/DIM-1', include: '**' })), /world folder/);
});

test('delete refuses paths that escape, and leaves symlinks and what they point at alone', async () => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'keep.tmp'), 'k');
    put('cfg/a.tmp');
    fs.symlinkSync(outside, path.join(root(), 'cfg', 'link'));
    await fileSteps.runFileStep(SID, del({ path: 'cfg', include: '**/*.tmp' }), { automationName: 'Links' });
    assert.ok(!has('cfg/a.tmp'));
    assert.ok(fs.existsSync(path.join(outside, 'keep.tmp')), 'the target of a link is never reached');
    fs.symlinkSync(outside, path.join(root(), 'escape'));
    await assert.rejects(
      fileSteps.planFileStep(SID, del({ path: 'escape', include: '**' })),
      (err) => err.status === 400
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('delete: over the cap fails before deleting anything', async () => {
  const dir = path.join(root(), 'many');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= fileSteps.MAX_DELETE_FILES; i++) fs.writeFileSync(path.join(dir, `f${i}.tmp`), '');
  await refused(
    fileSteps.runFileStep(SID, del({ path: 'many', include: '*.tmp' }), { automationName: 'Big' }),
    /more than 5,000 files/
  );
  assert.equal(fs.readdirSync(dir).length, fileSteps.MAX_DELETE_FILES + 1);
});

test('file steps run through the engine as steps of an automation', async () => {
  put('src/a.txt', 'A');
  const a = automations.createAutomation({
    name: 'Engine copy',
    enabled: false,
    targets: { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [
      { offsetSec: 0, action: 'copy-files', params: { from: 'src', to: 'dst' } },
      { offsetSec: 0, action: 'delete-files', params: { path: 'src', include: '*.txt' } },
    ],
  });
  await automations.runNow(a.id).done;
  assert.equal(read('dst/a.txt'), 'A');
  assert.ok(!has('src/a.txt'));
  assert.equal(automations.getAutomation(a.id).lastStatus, 'ok');
  automations.deleteAutomation(a.id);
});

test('the built-in Restore Files Before Boot template is a before-start copy', () => {
  const t = automations.listTemplates().find((x) => x.name === 'Restore Files Before Boot');
  assert.equal(t.trigger.event, 'before-start');
  assert.deepEqual(t.steps[0].params, { from: 'custom/kubejs', to: 'kubejs', mode: 'overwrite', include: '**' });
});

test('pack warning: a before-start copy into a pack-owned folder on a pack server only', () => {
  db.run(
    "INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name) VALUES (?, 'modrinth', 'p', 'P', 'v1', '1.0')",
    SID
  );
  const plain = 'srv_plain';
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Plain', 'PAPER', 47501, 48501, 'x', 1024, 1536)`,
    plain
  );
  const def = (event, to) => ({
    trigger: { type: 'event', event },
    steps: [{ offsetSec: 0, action: 'copy-files', params: { from: 'custom', to } }],
  });
  const text = (f) =>
    `Pack installs overwrite ${f} when the server starts, so this copy may be undone. Use After A Pack Update, or add the files to Customizations instead.`;
  for (const f of ['config', 'kubejs', 'defaultconfigs', 'mods']) {
    assert.deepEqual(automations.fileStepWarnings(def('before-start', `${f}/x`), [SID]), [text(f)], f);
  }
  assert.deepEqual(automations.fileStepWarnings(def('before-start', 'kubejs'), [plain]), [], 'not a pack server');
  assert.deepEqual(automations.fileStepWarnings(def('before-start', 'scripts'), [SID]), []);
  assert.deepEqual(automations.fileStepWarnings(def('after-pack-install', 'kubejs'), [SID]), [], 'only before a start');
  db.run('DELETE FROM server_packs WHERE server_id = ?', SID);
});

test('worlds: any folder with a level.dat is protected, however it is named or cased', async () => {
  put('survival/level.dat');
  put('survival/region/r.0.0.mca');
  put('survival_nether/DIM-1/x.mca');
  put('WORLD/level.dat');
  put('logs/a.tmp');
  put('src/f.txt');
  for (const p of [
    'survival',
    'survival/region',
    'survival_nether',
    'SURVIVAL',
    'Survival/',
    'world',
    'World.',
    'WORLD /x',
  ]) {
    await refused(fileSteps.planFileStep(SID, del({ path: p, include: '**' })), /world folder/);
  }
  await refused(fileSteps.planFileStep(SID, copy({ from: 'src', to: 'survival/data' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, copy({ from: 'src', to: 'Survival_The_End/x' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, copy({ from: 'survival', to: 'out' })), /world folder/);
  // Walking a wider folder skips the worlds instead of failing.
  put('top/keep.tmp');
  const plan = await fileSteps.planFileStep(SID, copy({ from: 'logs', to: 'copy' }));
  assert.deepEqual(Object.keys(changes(plan)), ['copy/a.tmp']);
});

test('worlds: a nested level-name is protected as a whole path, and a parent walk skips it', async () => {
  fs.writeFileSync(path.join(root(), 'server.properties'), 'level-name=saves/Survival\n');
  put('saves/Survival/region/r.mca');
  put('saves/Survival/old.tmp');
  put('saves/other/x.tmp');
  put('saves/y.tmp');
  await refused(fileSteps.planFileStep(SID, del({ path: 'saves/survival', include: '**' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, del({ path: 'saves/Survival/region', include: '**' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, copy({ from: 'saves/other', to: 'saves/SURVIVAL.' })), /world folder/);
  await refused(fileSteps.planFileStep(SID, del({ path: 'saves/survival_nether', include: '**' })), /world folder/);
  const plan = await fileSteps.planFileStep(SID, del({ path: 'saves', include: '**/*.tmp' }));
  assert.deepEqual(Object.keys(changes(plan)).sort(), ['saves/other/', 'saves/other/x.tmp', 'saves/y.tmp']);
  await fileSteps.runFileStep(SID, del({ path: 'saves', include: '**' }), { automationName: 'Parent' });
  assert.ok(has('saves/Survival/region/r.mca') && has('saves/Survival/old.tmp'), 'the world below survived');
  assert.ok(!has('saves/y.tmp'));
});

test('links: a link in the middle of a path refuses the step, for every path it takes', async () => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.mkdirSync(path.join(outside, 'sub'));
    fs.writeFileSync(path.join(outside, 'sub', 'f.tmp'), 'out');
    put('real/f.txt');
    fs.symlinkSync(outside, path.join(root(), 'mid'));
    fs.symlinkSync(path.join(root(), 'real'), path.join(root(), 'inner')); // a link that stays inside is refused too
    const linked = /goes through a link, which automations don't follow/;
    await refused(fileSteps.planFileStep(SID, copy({ from: 'mid/sub', to: 'out' })), linked);
    await refused(fileSteps.planFileStep(SID, copy({ from: 'real', to: 'mid/sub' })), linked);
    await refused(fileSteps.planFileStep(SID, copy({ from: 'inner', to: 'out' })), linked);
    await refused(fileSteps.planFileStep(SID, del({ path: 'mid/sub', include: '**' })), linked);
    await refused(fileSteps.runFileStep(SID, del({ path: 'mid/sub', include: '**' }), { automationName: 'L' }), linked);
    assert.ok(fs.existsSync(path.join(outside, 'sub', 'f.tmp')));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

/** Run `swap` after the plan is made and before the first file is written. */
function swapAfterPlan(t, swap) {
  fileSteps.hooks.afterPlan = swap;
  t.after(() => (fileSteps.hooks.afterPlan = null));
}

test('races: a folder swapped for a link after the plan is caught before each copy', async (t) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    put('src/a.txt', 'A');
    put('out/old.txt', 'old');
    swapAfterPlan(t, () => {
      fs.rmSync(path.join(root(), 'out'), { recursive: true });
      fs.symlinkSync(outside, path.join(root(), 'out'));
    });
    await refused(
      fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Race' }),
      /goes through a link/
    );
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('races: a destination file swapped for a link is never written through', async (t) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'target.txt'), 'precious');
    put('src/a.txt', 'A');
    put('out/a.txt', 'old');
    swapAfterPlan(t, () => {
      fs.rmSync(path.join(root(), 'out', 'a.txt'));
      fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root(), 'out', 'a.txt'));
    });
    await refused(
      fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Race' }),
      /not a file/
    );
    assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'precious');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('races: a folder swapped for a link after the plan is never deleted through', async (t) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'a.tmp'), 'precious');
    put('cfg/a.tmp');
    swapAfterPlan(t, () => {
      fs.rmSync(path.join(root(), 'cfg'), { recursive: true });
      fs.symlinkSync(outside, path.join(root(), 'cfg'));
    });
    await refused(
      fileSteps.runFileStep(SID, del({ path: 'cfg', include: '**/*.tmp' }), { automationName: 'Race' }),
      /could not finish 1 file/
    );
    assert.equal(fs.readFileSync(path.join(outside, 'a.tmp'), 'utf8'), 'precious');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('races: a source that grew past the size cap stops the whole step, not just that file', async (t) => {
  for (const f of ['a', 'b', 'c']) put(`src/${f}.txt`, 'small');
  const attempted = [];
  fileSteps.hooks.beforeOp = (op) => attempted.push(op.destRel);
  t.after(() => (fileSteps.hooks.beforeOp = null));
  swapAfterPlan(t, () => {
    for (const f of ['a', 'b', 'c'])
      fs.truncateSync(path.join(root(), 'src', `${f}.txt`), fileSteps.MAX_COPY_BYTES + 10);
  });
  await assert.rejects(
    fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Grew' }),
    (err) => err.status === 400 && /^Copy Files grew past 2 GB/.test(err.message)
  );
  assert.equal(attempted.length, 1, 'the files after the capped one were not attempted');
  assert.ok(!has('out/a.txt') && !has('out/b.txt') && !has('out/c.txt'));
});

test('races: a copy source swapped for a link after the check is refused, never read through the link', async (t) => {
  const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret'), 'panel secret');
    put('src/a.txt', 'A');
    fileSteps.hooks.afterCheck = () => {
      fs.rmSync(path.join(root(), 'src', 'a.txt'));
      fs.symlinkSync(path.join(outside, 'secret'), path.join(root(), 'src', 'a.txt'));
    };
    t.after(() => (fileSteps.hooks.afterCheck = null));
    await refused(fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Swap' }), /link/);
    assert.ok(!has('out/a.txt'), 'the secret was not copied into the server folder');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test(
  'races: a folder above the copy source swapped for a link after the check is refused',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const outside = fs.mkdtempSync(path.join(path.dirname(config.dataDir), 'outside-'));
    try {
      fs.mkdirSync(path.join(outside, 'src'));
      fs.writeFileSync(path.join(outside, 'src', 'a.txt'), 'panel secret');
      put('src/a.txt', 'A');
      fileSteps.hooks.afterCheck = () => {
        fs.rmSync(path.join(root(), 'src'), { recursive: true });
        fs.symlinkSync(path.join(outside, 'src'), path.join(root(), 'src'));
      };
      t.after(() => (fileSteps.hooks.afterCheck = null));
      await refused(
        fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Swap' }),
        /goes through a link/
      );
      assert.ok(!has('out/a.txt'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
);

test('a copy keeps the original modified time and leaves no half file when stopped', async (t) => {
  const when = new Date('2021-05-05T00:00:00Z');
  put('src/a.txt', 'A', when);
  await fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Time' });
  assert.equal(
    Math.floor(fs.statSync(path.join(root(), 'out', 'a.txt')).mtimeMs / 1000),
    Math.floor(when.getTime() / 1000)
  );
  const controller = new AbortController();
  fileSteps.hooks.beforeOp = () => controller.abort('the test said so');
  t.after(() => (fileSteps.hooks.beforeOp = null));
  await assert.rejects(
    fileSteps.runFileStep(SID, copy({ from: 'src', to: 'again', mode: 'overwrite' }), {
      automationName: 'Stop',
      signal: controller.signal,
    }),
    (err) => err.status === 409 && err.message === 'Copy Files stopped before it finished, because the test said so.'
  );
  assert.ok(!has('again/a.txt'));
});

test('a before-start step that outlasts the time limit is stopped, and the start fails only after it has stopped', async (t) => {
  for (let i = 0; i < 10; i++) put(`src/f${i}.txt`, 'x');
  const attempted = [];
  fileSteps.hooks.beforeOp = async (op) => {
    attempted.push(op.destRel);
    await new Promise((r) => setTimeout(r, 40));
  };
  t.after(() => {
    fileSteps.hooks.beforeOp = null;
    automations.configureHooks();
  });
  automations.configureHooks({ beforeStartTimeoutMs: 100 });
  const a = automations.createAutomation({
    name: 'Slow restore',
    targets: { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'event', event: 'before-start' },
    steps: [{ offsetSec: 0, action: 'copy-files', params: { from: 'src', to: 'out' } }],
  });
  await assert.rejects(
    automations.emit('before-start', SID),
    (err) => err.status === 409 && /"Slow restore" failed before the start/.test(err.message)
  );
  const run = automations.listRuns(a.id)[0];
  assert.ok(run.finishedAt, 'the run had already finished when the start was failed');
  assert.equal(run.steps[0].status, 'failed');
  assert.match(run.steps[0].detail, /stopped before it finished, because the start took too long/);
  const attemptedAtReject = attempted.length;
  const filesAtReject = fs.readdirSync(path.join(root(), 'out')).length;
  assert.ok(attemptedAtReject < 10);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(attempted.length, attemptedAtReject, 'no file operation after the start failed');
  assert.equal(fs.readdirSync(path.join(root(), 'out')).length, filesAtReject);
  automations.deleteAutomation(a.id);
});

test('worlds: a level.dat_old or a region folder marks a world too, one level down as well, in any Unicode form', async () => {
  put('old-world/level.dat_old');
  put('backup1/region/r.0.0.mca');
  put('saves/archive/level.dat');
  put('saves/just-a-folder/f.txt');
  const nfd = 'cafe\u0301'; // "café" written with a combining accent
  put(`${nfd}/level.dat`);
  for (const p of [
    'old-world',
    'backup1/region',
    'saves/archive',
    'saves/Archive/x',
    'caf\u00e9',
    'CAF\u00c9/region',
  ]) {
    await refused(fileSteps.planFileStep(SID, del({ path: p, include: '**' })), /world folder/);
  }
  const ok = await fileSteps.planFileStep(SID, del({ path: 'saves/just-a-folder', include: '**' }));
  assert.equal(ok.totals.delete, 1, 'a plain folder is not a world');
  const walk = await fileSteps.planFileStep(SID, copy({ from: 'saves', to: 'out' }));
  assert.deepEqual(Object.keys(changes(walk)), ['out/just-a-folder/f.txt']);
});

test('file steps wait for a restore-like operation on the server, but not inside a start', async () => {
  const { guardOp } = require('../src/services/opLock');
  put('src/a.txt', 'A');
  let release;
  const held = new Promise((r) => (release = r));
  const restoring = guardOp('restore', () => held)(SID);
  await assert.rejects(
    fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Busy' }),
    (err) => err.code === 'BUSY' && err.status === 409
  );
  assert.ok(!has('out/a.txt'));
  // A before-start step is already inside the start's lock.
  await fileSteps.runFileStep(SID, copy({ from: 'src', to: 'inside' }), {
    automationName: 'Start',
    insideStartLock: true,
  });
  assert.equal(read('inside/a.txt'), 'A');

  // Through the engine the step retries until the operation is done.
  automations.configureEngine({ retryMs: 5, maxWaitMs: 60_000 });
  const a = automations.createAutomation({
    name: 'Waits',
    enabled: false,
    targets: { kind: 'servers', serverIds: [SID] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [{ offsetSec: 0, action: 'copy-files', params: { from: 'src', to: 'waited' } }],
  });
  const run = automations.runNow(a.id);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!has('waited/a.txt'), 'still waiting while the restore holds the server');
  release();
  await restoring;
  await run.done;
  automations.configureEngine();
  assert.equal(read('waited/a.txt'), 'A');
  assert.equal(automations.getAutomation(a.id).lastStatus, 'ok');
  automations.deleteAutomation(a.id);
});

test('errors: disk and path-guard problems become sentences, and a file step needs a server', async (t) => {
  put('src/a.txt');
  const fsp = require('node:fs/promises');
  const real = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (dir, opts) => {
    if (String(dir).endsWith(path.join('servers', SID, 'src'))) {
      throw Object.assign(new Error("EACCES: permission denied, scandir '/secret/path'"), {
        code: 'EACCES',
        path: path.join(root(), 'src', 'locked'),
      });
    }
    return real(dir, opts);
  });
  await assert.rejects(fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out' })), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /^Copy Files can't use "src\/locked", because the panel doesn't have permission\.$/);
    return true;
  });
  t.mock.restoreAll();

  const files = require('../src/services/files');
  const { PathEscapeError } = require('../src/storage/pathGuard');
  t.mock.method(files, 'resolvePath', (id, rel) => {
    if (rel === 'src') throw new PathEscapeError('../../etc');
    return { base: root(), abs: path.join(root(), rel), rel };
  });
  await assert.rejects(fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out' })), (err) => {
    assert.ok(!/panel data directory/.test(err.message), err.message);
    assert.match(err.message, /leaves the server's folder/);
    return true;
  });
  t.mock.restoreAll();

  await assert.rejects(fileSteps.planFileStep(null, copy({ from: 'src', to: 'out' })), (err) => err.status === 400);
  await assert.rejects(
    fileSteps.runFileStep(null, copy({ from: 'src', to: 'out' }), { automationName: 'x' }),
    (err) => err.status === 400
  );
});

test('a step that would look at too many files and folders stops before acting', async () => {
  const before = fileSteps.LIMITS.visited;
  fileSteps.LIMITS.visited = 20;
  try {
    for (let i = 0; i < 30; i++) put(`many/f${i}.tmp`);
    await refused(
      fileSteps.planFileStep(SID, del({ path: 'many', include: '*.nomatch' })),
      /looked at more than 20 files and folders/
    );
    await refused(
      fileSteps.planFileStep(SID, copy({ from: 'many', to: 'out', include: '*.nomatch' })),
      /looked at more than 20/
    );
  } finally {
    fileSteps.LIMITS.visited = before;
  }
});

test('an interrupted overwrite keeps the original file, and leaves no temporary file behind', async (t) => {
  put('src/a.txt', 'NEW');
  put('src/b.txt', 'NEW');
  put('out/a.txt', 'ORIGINAL A');
  put('out/b.txt', 'ORIGINAL B');
  const controller = new AbortController();
  // Aborts while the first copy is open and its temporary file exists.
  fileSteps.hooks.afterCheck = () => controller.abort('the test said so');
  t.after(() => (fileSteps.hooks.afterCheck = null));
  await assert.rejects(
    fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), {
      automationName: 'Abort',
      signal: controller.signal,
    }),
    (err) => err.aborted === true
  );
  assert.equal(read('out/a.txt'), 'ORIGINAL A');
  assert.equal(read('out/b.txt'), 'ORIGINAL B');
  assert.deepEqual(fs.readdirSync(path.join(root(), 'out')).sort(), ['a.txt', 'b.txt'], 'no temporary file');
});

test('a copy that hits the size cap keeps the original file and leaves no temporary file', async (t) => {
  put('src/a.txt', 'small');
  put('out/a.txt', 'ORIGINAL');
  swapAfterPlan(t, () => fs.truncateSync(path.join(root(), 'src', 'a.txt'), fileSteps.MAX_COPY_BYTES + 10));
  await refused(
    fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'Cap' }),
    /grew past 2 GB/
  );
  assert.equal(read('out/a.txt'), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(path.join(root(), 'out')), ['a.txt']);
});

test('a completed overwrite replaces the file, and skip-existing and only-if-newer still leave it alone', async () => {
  put('src/a.txt', 'NEW', new Date('2020-01-01'));
  put('out/a.txt', 'ORIGINAL', new Date('2025-01-01'));
  await fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out', mode: 'skip-existing' }), { automationName: 'S' });
  await fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out', mode: 'only-if-newer' }), { automationName: 'N' });
  assert.equal(read('out/a.txt'), 'ORIGINAL');
  await fileSteps.runFileStep(SID, copy({ from: 'src', to: 'out' }), { automationName: 'O' });
  assert.equal(read('out/a.txt'), 'NEW');
  assert.deepEqual(fs.readdirSync(path.join(root(), 'out')), ['a.txt']);
});

test('temporary copies are invisible to plans and caps, and a stale one from a crash is ignored', async () => {
  put('src/a.txt', 'A');
  put('src/.a.txt.msm-deadbeef0000.tmp', 'stale');
  put('cfg/x.tmp');
  put('cfg/.x.txt.msm-abc123.tmp', 'stale');
  const copyPlan = await fileSteps.planFileStep(SID, copy({ from: 'src', to: 'out' }));
  assert.deepEqual(Object.keys(changes(copyPlan)), ['out/a.txt']);
  assert.equal(copyPlan.totals.files, 1);
  const delPlan = await fileSteps.planFileStep(SID, del({ path: 'cfg', include: '**' }));
  assert.deepEqual(Object.keys(changes(delPlan)), ['cfg/x.tmp'], 'the leftover is neither listed nor deleted');
});

test('world detection reads a folder entry by entry and stops after its limit', async () => {
  // 1,200 subfolders, with the world last: beyond the 200 looked at, so it is not seen as a world.
  const dir = path.join(root(), 'plugins');
  for (let i = 0; i < 1200; i++) fs.mkdirSync(path.join(dir, `p${String(i).padStart(4, '0')}`), { recursive: true });
  put('plugins/zzz/level.dat');
  const ctx = await fileSteps.fileContext(SID);
  assert.equal(ctx.isProtected('plugins/p0000'), false);
  put('saves/old/level.dat');
  const again = await fileSteps.fileContext(SID);
  assert.equal(again.isProtected('saves/old/region'), true);
});
