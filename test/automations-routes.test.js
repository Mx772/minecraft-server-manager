'use strict';

// The /api/automations routes through the real Express app: CRUD, friendly
// refusals, the per-server permission matrix, what each user can see, run-now,
// and the schedule preview. The restart action is stubbed so nothing reaches Docker.

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const authService = require('../src/services/auth');
const permissionsService = require('../src/services/permissions');
const servers = require('../src/services/servers');
const db = require('../src/db');
const automations = require('../src/automations');
const { requireAutomationAccess } = require('../src/web/automationAccess');

const A = 'srv_aut_a';
const B = 'srv_aut_b';
let admin;
let operator;
let viewer;
let operatorId;
let viewerId;
const restarted = [];

async function login(username, password, role) {
  const user = await authService.createUser({ username, password, role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password } });
  return { id: user.id, cookie: (r.setCookie || []).map((c) => c.split(';')[0]).join('; ') };
}

const grant = (userId, serverId, perms) =>
  app.req('PUT', `/api/permissions/${userId}/${serverId}`, { cookie: admin, body: { perms } });

const def = (over = {}) => ({
  name: 'Nightly restart',
  targets: { kind: 'servers', serverIds: [A] },
  trigger: { type: 'schedule', cron: '0 4 * * *' },
  steps: [{ offsetSec: 0, action: 'restart' }],
  ...over,
});

const wipe = () => {
  for (const row of db.all('SELECT id FROM automations')) automations.deleteAutomation(row.id, { actor: 'test' });
};

test.before(async () => {
  test.mock.method(servers, 'restartServer', async (id) => {
    restarted.push(id);
  });
  await app.start();
  admin = await app.adminCookie();
  const o = await login('operator_a', 'operatorpass123', 'operator');
  operator = o.cookie;
  operatorId = o.id;
  const v = await login('viewer_a', 'viewerpass123', 'viewer');
  viewer = v.cookie;
  viewerId = v.id;
  app.seedServer(A);
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'Bravo Server', 'PAPER', 25601, 26601, 'x', 1024, 1536)`,
    B
  );
  db.run("UPDATE servers SET display_name = 'Alpha Server' WHERE id = ?", A);
});

test.after(async () => {
  automations.stopAll();
  wipe();
  await app.stop();
});

test('create, list, update, toggle, and delete an automation', async () => {
  const created = await app.req('POST', '/api/automations', { cookie: admin, body: def() });
  assert.equal(created.status, 201);
  const id = created.json.automation.id;
  assert.match(id, /^aut_/);

  const list = await app.req('GET', '/api/automations', { cookie: admin });
  const row = list.json.automations.find((a) => a.id === id);
  assert.equal(row.name, 'Nightly restart');
  assert.deepEqual(row.servers, ['Alpha Server']);
  assert.equal(row.canEdit, true);

  const body = def({
    name: 'Warned restart',
    steps: [
      { offsetSec: -300, action: 'message', params: { text: 'Restarting in 5 minutes.', mode: 'say' } },
      { offsetSec: 0, action: 'restart' },
    ],
  });
  const put = await app.req('PUT', `/api/automations/${id}`, { cookie: admin, body });
  assert.equal(put.status, 200);
  assert.equal(put.json.automation.name, 'Warned restart');
  assert.equal(put.json.automation.steps.length, 2);

  const off = await app.req('POST', `/api/automations/${id}/toggle`, { cookie: admin, body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(automations.getAutomation(id).enabled, false);
  // An update that leaves `enabled` out keeps the switch where it is.
  await app.req('PUT', `/api/automations/${id}`, { cookie: admin, body: def() });
  assert.equal(automations.getAutomation(id).enabled, false);

  assert.equal((await app.req('DELETE', `/api/automations/${id}`, { cookie: admin })).status, 200);
  assert.equal(automations.getAutomation(id), null);
  const gone = await app.req('DELETE', `/api/automations/${id}`, { cookie: admin });
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error, 'That automation no longer exists.');
});

test('bad definitions get friendly 400s, never raw text', async () => {
  const badCron = await app.req('POST', '/api/automations', {
    cookie: admin,
    body: def({ trigger: { type: 'schedule', cron: 'not a cron' } }),
  });
  assert.equal(badCron.status, 400);
  assert.match(badCron.json.error, /is not a valid schedule/);

  const noSteps = await app.req('POST', '/api/automations', { cookie: admin, body: def({ steps: [] }) });
  assert.equal(noSteps.status, 400);
  assert.match(noSteps.json.error, /1 to 20 steps/);

  const serverAction = await app.req('POST', '/api/automations', {
    cookie: admin,
    body: def({ targets: { kind: 'panel' } }),
  });
  assert.equal(serverAction.status, 400);
  assert.match(serverAction.json.error, /acts on a server/);

  const panelAction = await app.req('POST', '/api/automations', {
    cookie: admin,
    body: def({ steps: [{ offsetSec: 0, action: 'update-check' }] }),
  });
  assert.equal(panelAction.status, 400);
  assert.match(panelAction.json.error, /acts on the whole panel/);

  const junk = await app.req('POST', '/api/automations', { cookie: admin, body: { name: 5 } });
  assert.equal(junk.status, 400);
  assert.doesNotMatch(junk.json.error, /expected|invalid_type/i);
  assert.equal((await app.req('PUT', '/api/automations/aut_nope', { cookie: admin, body: def() })).status, 404);
});

test('the schedule preview lists the next three times and refuses a bad cron', async () => {
  const ok = await app.req('GET', `/api/automations/preview?cron=${encodeURIComponent('0 */4 * * *')}`, {
    cookie: admin,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.runs.length, 3);
  assert.ok(ok.json.runs.every((iso) => !Number.isNaN(Date.parse(iso))));
  assert.equal(ok.json.starts, undefined);

  const lead = await app.req('GET', `/api/automations/preview?cron=${encodeURIComponent('0 4 * * *')}&lead=300`, {
    cookie: admin,
  });
  assert.equal(Date.parse(lead.json.runs[0]) - Date.parse(lead.json.starts[0]), 300_000);

  const bad = await app.req('GET', `/api/automations/preview?cron=${encodeURIComponent('99 99 * * *')}`, {
    cookie: admin,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /is not a valid schedule/);
  assert.equal((await app.req('GET', '/api/automations/preview', { cookie: admin })).status, 400);
});

test('an operator needs the capability on every server the automation names', async () => {
  // Power on A, console only on B.
  assert.equal((await grant(operatorId, B, ['view', 'console'])).status, 200);
  const onA = await app.req('POST', '/api/automations', { cookie: operator, body: def() });
  assert.equal(onA.status, 201);
  const onBoth = await app.req('POST', '/api/automations', {
    cookie: operator,
    body: def({ targets: { kind: 'servers', serverIds: [A, B] } }),
  });
  assert.equal(onBoth.status, 403);
  assert.match(onBoth.json.error, /power permission/);
  // Messages are a console action: fine on both.
  const message = await app.req('POST', '/api/automations', {
    cookie: operator,
    body: def({
      targets: { kind: 'servers', serverIds: [A, B] },
      steps: [{ offsetSec: 0, action: 'message', params: { text: 'Hello.' } }],
    }),
  });
  assert.equal(message.status, 201);

  // Changing a stored automation is checked against what it names today and what it would name.
  const widen = await app.req('PUT', `/api/automations/${onA.json.automation.id}`, {
    cookie: operator,
    body: def({ targets: { kind: 'servers', serverIds: [A, B] } }),
  });
  assert.equal(widen.status, 403);
  const adminOnB = await app.req('POST', '/api/automations', {
    cookie: admin,
    body: def({ targets: { kind: 'servers', serverIds: [B] } }),
  });
  for (const attempt of [
    app.req('POST', `/api/automations/${adminOnB.json.automation.id}/toggle`, {
      cookie: operator,
      body: { enabled: false },
    }),
    app.req('POST', `/api/automations/${adminOnB.json.automation.id}/run`, { cookie: operator }),
    app.req('DELETE', `/api/automations/${adminOnB.json.automation.id}`, { cookie: operator }),
    app.req('PUT', `/api/automations/${adminOnB.json.automation.id}`, { cookie: operator, body: def() }),
  ]) {
    assert.equal((await attempt).status, 403);
  }
  // canEdit follows the same rule, not just the role.
  const list = await app.req('GET', '/api/automations', { cookie: operator });
  assert.equal(list.json.automations.find((a) => a.id === adminOnB.json.automation.id).canEdit, false);
  assert.equal(list.json.automations.find((a) => a.id === onA.json.automation.id).canEdit, true);
  await grant(operatorId, B, null);
  wipe();
});

test('a server the user cannot see is hidden: 404 on writes, and its automations vanish', async () => {
  assert.equal((await grant(operatorId, B, [])).status, 200);
  const hiddenWrite = await app.req('POST', '/api/automations', {
    cookie: operator,
    body: def({ targets: { kind: 'servers', serverIds: [A, B] } }),
  });
  assert.equal(hiddenWrite.status, 404);
  assert.equal(hiddenWrite.json.error, 'Server not found.');

  const onB = (
    await app.req('POST', '/api/automations', {
      cookie: admin,
      body: def({ name: 'Bravo only', targets: { kind: 'servers', serverIds: [B] } }),
    })
  ).json.automation;
  const mixed = (
    await app.req('POST', '/api/automations', {
      cookie: admin,
      body: def({ name: 'Both', targets: { kind: 'servers', serverIds: [A, B] } }),
    })
  ).json.automation;
  const everyone = (
    await app.req('POST', '/api/automations', {
      cookie: admin,
      body: def({ name: 'Everything', targets: { kind: 'all' } }),
    })
  ).json.automation;

  const list = await app.req('GET', '/api/automations', { cookie: operator });
  const ids = list.json.automations.map((a) => a.id);
  assert.ok(!ids.includes(onB.id) && !ids.includes(mixed.id), 'rows naming a hidden server are not listed');
  assert.ok(ids.includes(everyone.id), 'an every-server row is listed');
  assert.ok(!JSON.stringify(list.json).includes('Bravo Server'), 'the hidden name never appears');

  for (const target of [onB, mixed]) {
    const runs = await app.req('GET', `/api/automations/${target.id}/runs`, { cookie: operator });
    assert.equal(runs.status, 404);
    assert.equal(runs.json.error, 'That automation no longer exists.');
    assert.equal((await app.req('DELETE', `/api/automations/${target.id}`, { cookie: operator })).status, 404);
  }
  await grant(operatorId, B, null);
  wipe();
});

test('"all servers" is admin-only; panel work follows the role and the action', async () => {
  const all = def({ targets: { kind: 'all' } });
  const refused = await app.req('POST', '/api/automations', { cookie: operator, body: all });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'Only an admin can run an automation on every server.');
  assert.equal((await app.req('POST', '/api/automations', { cookie: admin, body: all })).status, 201);

  const panel = (action) => def({ targets: { kind: 'panel' }, steps: [{ offsetSec: 0, action }] });
  const adminOnly = await app.req('POST', '/api/automations', { cookie: operator, body: panel('restart-all') });
  assert.equal(adminOnly.status, 403);
  assert.match(adminOnly.json.error, /Only an admin/);
  assert.equal((await app.req('POST', '/api/automations', { cookie: admin, body: panel('restart-all') })).status, 201);
  assert.equal((await app.req('POST', '/api/automations', { cookie: operator, body: panel('tmp-clean') })).status, 201);
  // A viewer never reaches panel work, even holding grants on a server.
  await grant(viewerId, A, ['view', 'power']);
  const viewerPanel = await app.req('POST', '/api/automations', { cookie: viewer, body: panel('tmp-clean') });
  assert.equal(viewerPanel.status, 403);
  await grant(viewerId, A, null);
  wipe();
});

test('a viewer reaches only the servers they hold a grant on', async () => {
  const plain = await app.req('POST', '/api/automations', { cookie: viewer, body: def() });
  assert.equal(plain.status, 403);
  assert.equal(plain.json.error, 'Your role (Viewer) is read-only.');

  await grant(viewerId, A, ['view', 'power']);
  const granted = await app.req('POST', '/api/automations', { cookie: viewer, body: def() });
  assert.equal(granted.status, 201);
  const id = granted.json.automation.id;
  // Backups is not part of the grant; neither is B.
  const noCap = await app.req('POST', '/api/automations', {
    cookie: viewer,
    body: def({ steps: [{ offsetSec: 0, action: 'backup' }] }),
  });
  assert.equal(noCap.status, 403);
  assert.match(noCap.json.error, /backups permission/);
  const noSee = await app.req('POST', '/api/automations', {
    cookie: viewer,
    body: def({ targets: { kind: 'servers', serverIds: [A, B] } }),
  });
  assert.equal(noSee.status, 403, 'read-only on B');
  assert.equal(
    (await app.req('POST', `/api/automations/${id}/toggle`, { cookie: viewer, body: { enabled: false } })).status,
    200
  );
  assert.equal((await app.req('DELETE', `/api/automations/${id}`, { cookie: viewer })).status, 200);
  // An automation the viewer has no grant on stays out of reach of the gate.
  const adminAuto = (
    await app.req('POST', '/api/automations', {
      cookie: admin,
      body: def({ targets: { kind: 'servers', serverIds: [B] } }),
    })
  ).json.automation;
  assert.equal((await app.req('DELETE', `/api/automations/${adminAuto.id}`, { cookie: viewer })).status, 403);
  // Panel and all-server rows are never writable by a viewer.
  const panelAuto = automations.listAutomations().find((a) => a.targets.kind === 'panel');
  if (panelAuto)
    assert.equal((await app.req('DELETE', `/api/automations/${panelAuto.id}`, { cookie: viewer })).status, 403);
  await grant(viewerId, A, null);
  wipe();
});

test('access rules unit: every server must be viewable before any capability is checked', () => {
  const user = { id: operatorId, role: 'operator' };
  permissionsService.setGrant(operatorId, B, []);
  assert.throws(
    () =>
      requireAutomationAccess(
        { user },
        { targets: { kind: 'servers', serverIds: [A, B] }, steps: [{ action: 'restart' }] }
      ),
    (err) => err.status === 404
  );
  assert.doesNotThrow(() =>
    requireAutomationAccess({ user }, { targets: { kind: 'servers', serverIds: [A] }, steps: [{ action: 'restart' }] })
  );
  permissionsService.setGrant(operatorId, B, null);
});

test('run now answers 202 and runs the steps without waiting', async () => {
  const created = await app.req('POST', '/api/automations', { cookie: admin, body: def() });
  const id = created.json.automation.id;
  restarted.length = 0;
  const run = await app.req('POST', `/api/automations/${id}/run`, { cookie: admin });
  assert.equal(run.status, 202);
  for (
    let i = 0;
    i < 100 && !db.get("SELECT 1 AS x FROM automation_runs WHERE automation_id = ? AND status = 'ok'", id);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(restarted, [A]);

  const runs = await app.req('GET', `/api/automations/${id}/runs`, { cookie: admin });
  assert.equal(runs.status, 200);
  assert.equal(runs.json.runs.length, 1);
  assert.equal(runs.json.runs[0].status, 'ok');
  assert.equal(runs.json.runs[0].serverName, 'Alpha Server');
  assert.equal(runs.json.runs[0].serverId, undefined);
  assert.equal((await app.req('POST', '/api/automations/aut_missing/run', { cookie: admin })).status, 404);
  wipe();
});
