'use strict';

// Templates: the built-ins validate, saved ones round-trip, and the shared file
// format is strict and friendly about what it refuses.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/db/migrate').migrate();
const db = require('../src/db');
const automations = require('../src/automations');

test.afterEach(() => db.run('DELETE FROM automation_templates'));

const tpl = (over = {}) => ({
  name: 'Mine',
  description: 'A test.',
  targetsKind: 'servers',
  trigger: { type: 'schedule', cron: '0 4 * * *' },
  steps: [{ offsetSec: 0, action: 'restart' }],
  ...over,
});
const bad = (fn, pattern) => assert.throws(fn, (err) => err.status === 400 && pattern.test(err.message));

test('every built-in template validates, with Title Case names and sentence descriptions', () => {
  const builtins = automations.listTemplates().filter((t) => t.builtin);
  assert.deepEqual(
    builtins.map((t) => t.name),
    [
      'Restart With Warnings',
      'Restart When Empty',
      'Nightly Backup',
      'Backup Then Restart',
      'Notify Discord On Crash',
      'Back Up After Stop',
      'Welcome Back Message',
      'Restore Files Before Boot',
      'Scheduled Announcement',
    ]
  );
  for (const t of builtins) {
    assert.match(t.id, /^builtin:/);
    assert.match(t.description, /\.$/);
    const { id, builtin, createdBy, createdAt, ...def } = t;
    assert.deepEqual(automations.validateTemplate(def).steps.length, def.steps.length, t.name);
  }
  const bt = builtins.find((t) => t.name === 'Backup Then Restart');
  assert.deepEqual(
    bt.steps.map((s) => [s.offsetSec, s.action]),
    [
      [-60, 'message'],
      [0, 'backup'],
      [0, 'restart'],
    ]
  );
});

test('validateTemplate applies the automation rules', () => {
  bad(
    () => automations.validateTemplate(tpl({ trigger: { type: 'schedule', cron: 'not a cron' } })),
    /not a valid schedule/
  );
  bad(() => automations.validateTemplate(tpl({ targetsKind: 'panel' })), /pick at least one server/);
  bad(() => automations.validateTemplate(tpl({ steps: [{ offsetSec: 0, action: 'update-check' }] })), /whole panel/);
  bad(
    () =>
      automations.validateTemplate(
        tpl({
          steps: [
            { offsetSec: 0, action: 'restart' },
            { offsetSec: -1, action: 'stop' },
          ],
        })
      ),
    /time order/
  );
  bad(
    () =>
      automations.validateTemplate(
        tpl({ trigger: { type: 'schedule', cron: '*/10 * * * *' }, steps: [{ offsetSec: -600, action: 'restart' }] })
      ),
    /ahead/
  );
  bad(() => automations.validateTemplate(tpl({ description: 'x'.repeat(301) })), /description/);
  bad(() => automations.validateTemplate(tpl({ name: '' })), /name/);
});

test('create, list, and delete a saved template', () => {
  const made = automations.createTemplate(tpl(), { actor: 'tester', userId: 'usr_1' });
  assert.match(made.id, /^tpl_/);
  assert.equal(made.builtin, false);
  assert.equal(made.createdBy, 'usr_1');
  const list = automations.listTemplates();
  assert.ok(
    list.slice(0, 5).every((t) => t.builtin),
    'built-ins come first'
  );
  assert.equal(list.at(-1).id, made.id);
  assert.ok(db.get("SELECT 1 AS x FROM events WHERE summary = 'Automation template created: Mine.'"));
  automations.deleteTemplate(made.id, { actor: 'tester' });
  assert.equal(automations.getTemplate(made.id), null);
  assert.ok(db.get("SELECT 1 AS x FROM events WHERE type = 'automation-template-deleted'"));
  bad(() => automations.deleteTemplate('builtin:nightly-backup'), /Built-in/);
  assert.throws(
    () => automations.deleteTemplate('tpl_gone'),
    (err) => err.status === 404
  );
});

test('templateFromAutomation keeps the shape and drops servers and history', () => {
  const def = automations.templateFromAutomation({
    id: 'aut_x',
    name: 'N',
    targets: { kind: 'servers', serverIds: ['srv_a'] },
    trigger: { type: 'schedule', cron: '0 4 * * *' },
    steps: [{ offsetSec: 0, action: 'restart', params: {}, onFailure: 'stop' }],
    lastStatus: 'ok',
  });
  assert.deepEqual(Object.keys(def).sort(), ['description', 'name', 'steps', 'targetsKind', 'trigger']);
  assert.equal(def.targetsKind, 'servers');
});

test('a template round-trips through the shared file format with nothing extra', () => {
  const made = automations.createTemplate(
    tpl({ steps: [{ offsetSec: 0, action: 'restart', condition: { type: 'no-players' } }] }),
    { userId: 'usr_secret' }
  );
  const file = automations.exportTemplate(made);
  assert.deepEqual(Object.keys(file), ['msm-automation', 'name', 'description', 'targetsKind', 'trigger', 'steps']);
  assert.equal(file['msm-automation'], 1);
  assert.ok(!JSON.stringify(file).includes('usr_secret') && !JSON.stringify(file).includes(made.id));
  const back = automations.parseImport(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(automations.exportTemplate(back), file);
  assert.deepEqual(automations.parseImport(JSON.stringify(file)), back, 'a string is read too');
});

test('an import that is not right is refused with a friendly message', () => {
  const file = () => automations.exportTemplate(automations.validateTemplate(tpl()));
  const newer = /newer version of the panel, or is not an automation template/;
  bad(() => automations.parseImport(null), newer);
  bad(() => automations.parseImport([]), newer);
  bad(() => automations.parseImport({ ...file(), 'msm-automation': 2 }), newer);
  const noVersion = file();
  delete noVersion['msm-automation'];
  bad(() => automations.parseImport(noVersion), newer);
  bad(() => automations.parseImport('{nope'), /not valid JSON/);
  bad(() => automations.parseImport({ ...file(), id: 'tpl_x' }), /does not know: id\./);
  bad(
    () =>
      automations.parseImport({ ...file(), steps: [{ offsetSec: 0, action: 'rm-rf', params: {}, onFailure: 'stop' }] }),
    /uses an action this panel does not have: rm-rf\./
  );
  bad(() => automations.parseImport({ ...file(), steps: [{ offsetSec: 0, action: 'restart', extra: 1 }] }), /steps/);
  bad(
    () => automations.parseImport({ ...file(), trigger: { type: 'schedule', cron: 'not a cron' } }),
    /not a valid schedule/
  );
});
