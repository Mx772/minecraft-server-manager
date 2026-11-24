'use strict';

// The template routes and the ?serverId filter, through the real Express app.

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const authService = require('../src/services/auth');
const db = require('../src/db');
const automations = require('../src/automations');

const A = 'srv_tpl_a';
const B = 'srv_tpl_b';
let admin;
let op1;
let op2;
let viewer;

async function login(username, password, role) {
  await authService.createUser({ username, password, role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password } });
  return (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

const tpl = (over = {}) => ({
  name: 'My Restart',
  description: 'Restarts.',
  targetsKind: 'servers',
  trigger: { type: 'schedule', cron: '0 4 * * *' },
  steps: [{ offsetSec: 0, action: 'restart' }],
  ...over,
});
const mk = (cookie, path, body, method = 'POST') => app.req(method, `/api/automations${path}`, { cookie, body });

test.before(async () => {
  await app.start();
  admin = await app.adminCookie();
  op1 = await login('tpl_op1', 'operatorpass123', 'operator');
  op2 = await login('tpl_op2', 'operatorpass123', 'operator');
  viewer = await login('tpl_viewer', 'viewerpass1234', 'viewer');
  app.seedServer(A);
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Bravo', 'PAPER', 25601, 26601, 'x', 1024, 1536)`,
    B
  );
});
test.after(async () => {
  automations.stopAll();
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
  await app.stop();
});

test('everyone signed in lists built-ins first; only the creator or an admin can delete a saved one', async () => {
  const saved = await mk(op1, '/templates', tpl());
  assert.equal(saved.status, 201);
  const id = saved.json.template.id;
  assert.equal(saved.json.template.canDelete, true);

  const list = await mk(viewer, '/templates', undefined, 'GET');
  assert.equal(list.status, 200);
  const rows = list.json.templates;
  assert.ok(rows.slice(0, 5).every((t) => t.builtin && !t.canDelete));
  assert.equal(rows.find((t) => t.id === id).canDelete, false, 'not the viewer');
  assert.equal(
    (await mk(op2, '/templates', undefined, 'GET')).json.templates.find((t) => t.id === id).canDelete,
    false
  );
  assert.equal(
    (await mk(admin, '/templates', undefined, 'GET')).json.templates.find((t) => t.id === id).canDelete,
    true
  );
  assert.ok(!JSON.stringify(rows).includes('created_by'));

  assert.equal((await mk(op2, `/templates/${id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await mk(viewer, `/templates/${id}`, undefined, 'DELETE')).status, 403);
  assert.equal((await mk(op1, `/templates/${id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await mk(op1, `/templates/${id}`, undefined, 'DELETE')).status, 404);

  const other = (await mk(op1, '/templates', tpl({ name: 'Again' }))).json.template.id;
  assert.equal((await mk(admin, `/templates/${other}`, undefined, 'DELETE')).status, 200);

  const builtin = await mk(admin, '/templates/builtin:nightly-backup', undefined, 'DELETE');
  assert.equal(builtin.status, 400);
  assert.equal(builtin.json.error, "Built-in templates can't be deleted.");
});

test('viewers cannot save, import, or save from an automation', async () => {
  assert.equal((await mk(viewer, '/templates', tpl())).status, 403);
  assert.equal((await mk(viewer, '/templates/import?preview=0', automations.exportTemplate(tpl()))).status, 403);
  const a = automations.createAutomation({
    name: 'Viewer target',
    targets: { kind: 'all' },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [{ offsetSec: 0, action: 'restart' }],
  });
  assert.equal((await mk(viewer, `/${a.id}/template`, {})).status, 403);
  assert.equal((await mk(viewer, '/templates', tpl())).json.ok, false);
});

test('save an automation as a template, then export it with no ids in the file', async () => {
  const a = automations.createAutomation({
    name: 'Alpha Nightly',
    targets: { kind: 'servers', serverIds: [A] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [
      { offsetSec: -60, action: 'message', params: { text: 'Soon.' } },
      { offsetSec: 0, action: 'restart' },
    ],
  });
  const made = await mk(op1, `/${a.id}/template`, { description: 'From one.' });
  assert.equal(made.status, 201);
  assert.equal(made.json.template.name, 'Alpha Nightly');
  assert.equal(made.json.template.description, 'From one.');
  assert.equal(made.json.template.targetsKind, 'servers');

  const exp = await app.req('GET', `/api/automations/${a.id}/export`, { cookie: op1 });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /^attachment; filename="alpha-nightly\.msm-automation\.json"$/);
  assert.equal(exp.json['msm-automation'], 1);
  assert.ok(!exp.text.includes(A) && !exp.text.includes(a.id) && !exp.text.includes('Test Server'));

  const tplExp = await app.req('GET', `/api/automations/templates/${made.json.template.id}/export`, { cookie: viewer });
  assert.equal(tplExp.status, 200);
  assert.deepEqual(
    tplExp.json.steps.map((s) => s.action),
    ['message', 'restart']
  );
  const builtinExp = await app.req('GET', '/api/automations/templates/builtin:nightly-backup/export', {
    cookie: viewer,
  });
  assert.match(builtinExp.headers.get('content-disposition'), /nightly-backup\.msm-automation\.json/);
  assert.equal((await app.req('GET', '/api/automations/templates/tpl_gone/export', { cookie: viewer })).status, 404);
});

test('import preview shows the template without saving; import saves it', async () => {
  const file = automations.exportTemplate(automations.validateTemplate(tpl({ name: 'Imported' })));
  const before = automations.listTemplates().length;
  const preview = await mk(op1, '/templates/import?preview=1', file);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.template.name, 'Imported');
  assert.equal(automations.listTemplates().length, before);

  const saved = await mk(op1, '/templates/import?preview=0', file);
  assert.equal(saved.status, 201);
  assert.equal(automations.listTemplates().length, before + 1);
  assert.equal(saved.json.template.canDelete, true);

  const bad = await mk(op1, '/templates/import?preview=1', { ...file, 'msm-automation': 9 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /newer version/);
  const unknown = await mk(op1, '/templates/import?preview=1', { ...file, who: 'me' });
  assert.equal(unknown.status, 400);
  const huge = await mk(op1, '/templates/import?preview=1', { ...file, description: 'x'.repeat(70_000) });
  assert.equal(huge.status, 413);
});

test('?serverId narrows the list to that server and every-server automations; a hidden server is a 404', async () => {
  const mkAut = (name, targets) =>
    automations.createAutomation({
      name,
      targets,
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      steps: [{ offsetSec: 0, action: 'restart' }],
    });
  const onA = mkAut('On A', { kind: 'servers', serverIds: [A] });
  const onB = mkAut('On B', { kind: 'servers', serverIds: [B] });
  const everyone = mkAut('On all', { kind: 'all' });
  const panel = automations.createAutomation({
    name: 'Panel one',
    targets: { kind: 'panel' },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [{ offsetSec: 0, action: 'update-check' }],
  });
  const ids = async (cookie, q) =>
    (await app.req('GET', `/api/automations${q}`, { cookie })).json?.automations?.map((a) => a.id);
  const forA = await ids(admin, `?serverId=${A}`);
  assert.ok(forA.includes(onA.id) && forA.includes(everyone.id) && !forA.includes(onB.id));
  assert.ok(!forA.some((id) => id === panel.id));

  assert.equal(
    (
      await app.req(
        'PUT',
        `/api/permissions/${(await authService.listUsers()).find((u) => u.username === 'tpl_op2').id}/${B}`,
        { cookie: admin, body: { perms: [] } }
      )
    ).status,
    200
  );
  const hidden = await app.req('GET', `/api/automations?serverId=${B}`, { cookie: op2 });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error, 'Server not found.');
  assert.equal((await app.req('GET', `/api/automations?serverId=nope`, { cookie: admin })).status, 404);
});
