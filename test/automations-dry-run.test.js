'use strict';

// POST /api/automations/dry-run and /warnings through the real Express app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('./helpers/app');
const authService = require('../src/services/auth');
const config = require('../src/config');
const db = require('../src/db');
const automations = require('../src/automations');

const A = 'srv_dry_a';
const B = 'srv_dry_b';
let admin;
let operator;
let viewer;
let operatorId;

async function login(username, password, role) {
  const user = await authService.createUser({ username, password, role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password } });
  return { id: user.id, cookie: (r.setCookie || []).map((c) => c.split(';')[0]).join('; ') };
}
const post = (cookie, p, body) => app.req('POST', `/api/automations${p}`, { cookie, body });
const root = (id) => path.join(config.dataDir, 'servers', id);

const def = (over = {}) => ({
  name: 'Restore',
  targets: { kind: 'servers', serverIds: [A] },
  trigger: { type: 'event', event: 'before-start' },
  steps: [
    { offsetSec: 0, action: 'copy-files', params: { from: 'custom', to: 'kubejs' } },
    { offsetSec: 0, action: 'discord', params: { message: 'Restored.' } },
  ],
  ...over,
});

test.before(async () => {
  await app.start();
  admin = await app.adminCookie();
  const o = await login('dry_op', 'operatorpass123', 'operator');
  operator = o.cookie;
  operatorId = o.id;
  viewer = (await login('dry_viewer', 'viewerpass1234', 'viewer')).cookie;
  app.seedServer(A);
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Bravo', 'PAPER', 25601, 26601, 'x', 1024, 1536)`,
    B
  );
  fs.mkdirSync(path.join(root(A), 'custom'), { recursive: true });
  fs.writeFileSync(path.join(root(A), 'custom', 'a.js'), 'a');
});
test.after(async () => {
  automations.stopAll();
  await app.stop();
});

test('a dry run lists what each file step would do, and notes the other steps', async () => {
  const r = await post(admin, '/dry-run', { definition: def(), serverId: A });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [copy, other] = r.json.steps;
  assert.equal(copy.fileStep, true);
  assert.deepEqual(copy.files, [{ path: 'kubejs/a.js', change: 'create' }]);
  assert.equal(copy.totals.files, 1);
  assert.equal(copy.truncated, 0);
  assert.deepEqual({ fileStep: other.fileStep, note: other.note }, { fileStep: false, note: 'Not a file step.' });
  assert.ok(!fs.existsSync(path.join(root(A), 'kubejs')), 'nothing was written');
});

test('a step the planner refuses is reported on that step, not as a failed request', async () => {
  const r = await post(admin, '/dry-run', {
    definition: def({ steps: [{ offsetSec: 0, action: 'delete-files', params: { path: 'world', include: '**' } }] }),
    serverId: A,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.steps[0].error, "Delete Files can't touch a world folder or the panel's own files.");
  const root = await post(admin, '/dry-run', {
    definition: def({ steps: [{ offsetSec: 0, action: 'delete-files', params: { path: '', include: '*' } }] }),
    serverId: A,
  });
  assert.equal(root.status, 400, 'the server folder itself cannot be a delete path');
  assert.match(root.json.error, /needs a folder inside the server/);
});

test('a long listing is cut at 500 entries and says how many were left out', async () => {
  const dir = path.join(root(A), 'big');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), '');
  const r = await post(admin, '/dry-run', {
    definition: def({ steps: [{ offsetSec: 0, action: 'copy-files', params: { from: 'big', to: 'out' } }] }),
    serverId: A,
  });
  assert.equal(r.json.steps[0].files.length, 500);
  assert.equal(r.json.steps[0].truncated, 100);
  assert.equal(r.json.steps[0].totals.files, 600);
});

test("the server must be one of the definition's servers, and visible to you", async () => {
  const notTarget = await post(admin, '/dry-run', { definition: def(), serverId: B });
  assert.equal(notTarget.status, 400);
  assert.equal(notTarget.json.error, "That server is not one of the automation's servers.");
  const all = await post(admin, '/dry-run', { definition: def({ targets: { kind: 'all' } }), serverId: B });
  assert.equal(all.status, 200, 'an all-servers definition includes every server');

  await app.req('PUT', `/api/permissions/${operatorId}/${B}`, { cookie: admin, body: { perms: [] } });
  const hidden = await post(operator, '/dry-run', { definition: def(), serverId: B });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error, 'Server not found.');
});

test('a dry run needs the same rights as saving: files permission on the server, and not a viewer', async () => {
  await app.req('PUT', `/api/permissions/${operatorId}/${A}`, { cookie: admin, body: { perms: ['view', 'power'] } });
  const denied = await post(operator, '/dry-run', { definition: def(), serverId: A });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /files permission/);
  await app.req('PUT', `/api/permissions/${operatorId}/${A}`, {
    cookie: admin,
    body: { perms: ['view', 'files', 'settings'] },
  });
  assert.equal((await post(operator, '/dry-run', { definition: def(), serverId: A })).status, 200);
  assert.equal((await post(viewer, '/dry-run', { definition: def(), serverId: A })).status, 403);
  assert.equal((await post(viewer, '/warnings', { definition: def() })).status, 403);
  assert.equal((await post(admin, '/dry-run', { definition: { name: '' }, serverId: A })).status, 400);
});

test('warnings: a before-start copy into a pack folder on a pack server, from both routes', async () => {
  const text =
    'Pack installs overwrite kubejs when the server starts, so this copy may be undone. Use After A Pack Update, or add the files to Customizations instead.';
  const w = await post(admin, '/warnings', { definition: def() });
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.warnings, [], 'a plain server has none');
  db.run(
    "INSERT INTO server_packs (server_id, platform, project_ref, project_name, pinned_version_id, pinned_version_name) VALUES (?, 'modrinth', 'p', 'P', 'v1', '1.0')",
    A
  );
  assert.deepEqual((await post(admin, '/warnings', { definition: def() })).json.warnings, [text]);
  assert.deepEqual((await post(admin, '/dry-run', { definition: def(), serverId: A })).json.warnings, [text]);
  assert.equal(
    (await post(admin, '/warnings', { definition: def({ targets: { kind: 'all' } }) })).json.warnings.length,
    1
  );
  db.run('DELETE FROM server_packs WHERE server_id = ?', A);
});
