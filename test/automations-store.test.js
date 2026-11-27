'use strict';

// Definitions: validation, persistence, time zones, next-fire maths, and how an
// automation follows its servers.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Cron } = require('croner');
const app = require('./helpers/app'); // migrates the DB itself
const db = require('../src/db');
const settings = require('../src/services/settings');
const automations = require('../src/automations');

// Etc/GMT-5 is a fixed UTC+5 offset with no DST (IANA's Etc/GMT zones invert
// the sign) - deterministic, unlike a real "America/..." zone.
const FIXED_TZ = 'Etc/GMT-5';
const CRON = '0 3 * * *';

const panelDef = (over = {}) => ({
  name: 'Update check',
  targets: { kind: 'panel' },
  trigger: { type: 'schedule', cron: CRON },
  steps: [{ offsetSec: 0, action: 'update-check' }],
  ...over,
});
const serverDef = (serverIds, over = {}) => ({
  name: 'Restart',
  targets: { kind: 'servers', serverIds },
  trigger: { type: 'schedule', cron: CRON },
  steps: [{ offsetSec: 0, action: 'restart' }],
  ...over,
});

test.before(() => {
  app.seedServer('aut_srv1');
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES ('aut_srv2', 'Second', 'PAPER', 25601, 26601, 'x', 1024, 1536)`
  );
});
test.afterEach(() => {
  for (const a of automations.listAutomations()) automations.deleteAutomation(a.id);
  settings.setTimezone('auto');
});
test.after(() => automations.stopAll());

test("an automation's next anchor uses the configured panel timezone, not the system default", () => {
  settings.setTimezone(FIXED_TZ);
  const created = automations.createAutomation(panelDef());
  const expected = new Cron(CRON, { timezone: FIXED_TZ }).nextRun().getTime();
  assert.equal(created.nextMs, expected);
  assert.notEqual(created.nextMs, new Cron(CRON, { timezone: 'UTC' }).nextRun().getTime());
});

test('rearmAll() re-applies a timezone change to existing automations', () => {
  settings.setTimezone('UTC');
  const created = automations.createAutomation(panelDef());
  settings.setTimezone(FIXED_TZ);
  automations.rearmAll();
  const after = automations.listAutomations().find((a) => a.id === created.id);
  assert.equal(after.nextMs, new Cron(CRON, { timezone: FIXED_TZ }).nextRun().getTime());
});

test('nextFire anchors on the next cron time and starts the lead earlier, in the given zone', () => {
  const a = panelDef({
    steps: [
      { offsetSec: -300, action: 'update-check' },
      { offsetSec: 0, action: 'update-check' },
    ],
  });
  // 03:00 local in UTC+5 is 22:00 UTC the day before.
  const sooner = automations.nextFire(a, Date.parse('2026-03-10T21:50:00Z'), { timezone: FIXED_TZ });
  assert.equal(new Date(sooner.anchorMs).toISOString(), '2026-03-10T22:00:00.000Z');
  assert.equal(new Date(sooner.fireMs).toISOString(), '2026-03-10T21:55:00.000Z');
  // Inside the lead window the anchor is kept and the run starts now (late), not skipped.
  const now = Date.parse('2026-03-10T21:58:00Z');
  const inside = automations.nextFire(a, now, { timezone: FIXED_TZ });
  assert.equal(new Date(inside.anchorMs).toISOString(), '2026-03-10T22:00:00.000Z');
  assert.equal(inside.fireMs, now);
  // Never the same anchor twice.
  const again = automations.nextFire(a, sooner.fireMs, { timezone: FIXED_TZ, afterAnchorMs: sooner.anchorMs });
  assert.equal(new Date(again.anchorMs).toISOString(), '2026-03-11T22:00:00.000Z');
});

test('nextFire with no negative offsets fires at the anchor', () => {
  const now = Date.parse('2026-03-10T21:58:00Z');
  const next = automations.nextFire(panelDef(), now, { timezone: FIXED_TZ });
  assert.equal(new Date(next.anchorMs).toISOString(), '2026-03-10T22:00:00.000Z');
  assert.equal(next.fireMs, next.anchorMs);
});

test('cronMinGapMs finds the shortest gap between runs', () => {
  assert.equal(automations.cronMinGapMs('*/15 * * * *', { timezone: 'UTC' }), 15 * 60_000);
  assert.equal(automations.cronMinGapMs('0 4 * * *', { timezone: 'UTC' }), 24 * 3600_000);
});

test('a lead that reaches the next run is rejected', () => {
  const def = panelDef({
    trigger: { type: 'schedule', cron: '*/10 * * * *' },
    steps: [{ offsetSec: -600, action: 'update-check' }],
  });
  assert.throws(
    () => automations.createAutomation(def),
    (err) => err.status === 400 && /ahead/.test(err.message)
  );
  def.steps[0].offsetSec = -300;
  assert.ok(automations.createAutomation(def));
});

test('validation rejects bad definitions with friendly 400s', () => {
  const bad = (def, pattern) =>
    assert.throws(
      () => automations.createAutomation(def),
      (err) => err.status === 400 && pattern.test(err.message)
    );
  bad(panelDef({ trigger: { type: 'schedule', cron: 'not a cron' } }), /not a valid schedule/);
  bad(panelDef({ steps: [{ offsetSec: 0, action: 'nope' }] }), /does not know/);
  bad(panelDef({ steps: [{ offsetSec: 0, action: 'restart' }] }), /pick at least one server/);
  bad(serverDef(['aut_srv1'], { steps: [{ offsetSec: 0, action: 'update-check' }] }), /whole panel/);
  bad(
    serverDef(['aut_srv1'], {
      steps: [
        { offsetSec: 0, action: 'restart' },
        { offsetSec: -5, action: 'stop' },
      ],
    }),
    /time order/
  );
  bad(serverDef(['aut_srv1'], { steps: [{ offsetSec: 90_000, action: 'restart' }] }), /steps/);
  bad(serverDef(['aut_srv1'], { name: '' }), /name/);
  bad(serverDef([]), /Pick at least one server/);
  bad(serverDef(['aut_missing']), /no longer exists/);
  bad(serverDef(['aut_srv1'], { steps: [{ offsetSec: 0, action: 'message', params: {} }] }), /step 1/);
});

test('create persists targets and steps, normalises params, and lists with display fields', () => {
  const created = automations.createAutomation(
    serverDef(['aut_srv1', 'aut_srv2', 'aut_srv1'], {
      steps: [
        { offsetSec: -60, action: 'message', params: { text: 'Restarting soon.' } },
        { offsetSec: 0, action: 'restart' },
      ],
    }),
    { actor: 'tester' }
  );
  assert.ok(created.id.startsWith('aut_'));
  assert.deepEqual(created.targets.serverIds, ['aut_srv1', 'aut_srv2'], 'duplicates dropped');
  assert.equal(created.steps[0].params.mode, 'tellraw', 'defaults filled in');
  assert.equal(created.steps[1].onFailure, 'stop');
  assert.deepEqual(created.servers, ['Test Server', 'Second']);
  assert.equal(created.lastRun, null);
  assert.equal(created.createdBy, 'tester');
  const ev = db.get("SELECT * FROM events WHERE type = 'automation-created' ORDER BY id DESC");
  assert.equal(ev.summary, 'Automation created: Restart.');
});

test('update, toggle, and delete record history and keep the row consistent', () => {
  const created = automations.createAutomation(panelDef());
  const updated = automations.updateAutomation(created.id, panelDef({ name: 'Renamed' }));
  assert.equal(updated.name, 'Renamed');
  automations.setEnabled(created.id, false);
  assert.equal(automations.listAutomations()[0].enabled, false);
  automations.setEnabled(created.id, true);
  assert.equal(automations.listAutomations()[0].enabled, true);
  automations.deleteAutomation(created.id);
  assert.equal(automations.listAutomations().length, 0);
  for (const type of ['automation-updated', 'automation-toggled', 'automation-deleted']) {
    assert.ok(db.get('SELECT 1 AS x FROM events WHERE type = ?', type), type);
  }
  assert.throws(
    () => automations.updateAutomation('aut_nope', panelDef()),
    (err) => err.status === 404
  );
});

test('startAutomations seeds the panel housekeeping defaults exactly once', () => {
  automations.startAutomations();
  const actions = () =>
    automations
      .listAutomations()
      .filter((a) => a.targets.kind === 'panel')
      .map((a) => a.steps[0].action)
      .sort();
  const expected = ['ban-expiry-sweep', 'content-meta-backfill', 'storage-scan', 'tmp-clean', 'update-check'];
  assert.deepEqual(actions(), expected);
  automations.startAutomations(); // idempotent
  assert.deepEqual(actions(), expected);
  automations.stopAll();
});

test('removeServerFromTargets drops the server, and deletes automations left with none', () => {
  const both = automations.createAutomation(serverDef(['aut_srv1', 'aut_srv2'], { name: 'Both' }));
  const only = automations.createAutomation(serverDef(['aut_srv1'], { name: 'Only' }));
  const other = automations.createAutomation(serverDef(['aut_srv2'], { name: 'Other' }));
  const all = automations.createAutomation(serverDef(['aut_srv1'], { name: 'All', targets: { kind: 'all' } }));
  automations.removeServerFromTargets('aut_srv1');
  assert.deepEqual(automations.getAutomation(both.id).targets, { kind: 'servers', serverIds: ['aut_srv2'] });
  assert.equal(automations.getAutomation(only.id), null);
  assert.ok(automations.getAutomation(other.id));
  assert.ok(automations.getAutomation(all.id));
});
