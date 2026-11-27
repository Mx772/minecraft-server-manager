'use strict';

// Automations API, mounted at /api/automations behind requireAuth. Routes parse
// and permission-check; the work lives in src/automations. An automation that
// names a server the user cannot see is invisible to them (404, never 403).

const express = require('express');
const { z } = require('zod');
const { Cron } = require('croner');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const permissions = require('../../services/permissions');
const settingsService = require('../../services/settings');
const httpError = require('../../utils/httpError');
const db = require('../../db');
const automations = require('../../automations');
const { requireAutomationAccess, canChange, isVisibleTo } = require('../automationAccess');

const router = express.Router();

const MISSING = 'That automation no longer exists.';

/** The stored automation, or a 404 when it is gone or names a server the user cannot see. */
function loadVisible(req) {
  const found = automations.getAutomation(String(req.params.id));
  if (!found || !isVisibleTo(permissions.visibleServerIds(req.user), found)) throw httpError(404, MISSING);
  return found;
}

/** The request body as a definition, or a friendly 400. */
function parseDefinition(body) {
  const parsed = automations.automationSchema.safeParse(body);
  if (!parsed.success) throw automations.shapeError(parsed.error);
  return parsed.data;
}

router.get('/', (req, res) => {
  const visible = permissions.visibleServerIds(req.user);
  // ?serverId= narrows to the automations that act on that server: naming it, or on every server.
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : '';
  if (serverId && !visible.has(serverId)) throw httpError(404, 'Server not found.');
  const rows = automations
    .listAutomations()
    .filter((a) => isVisibleTo(visible, a))
    .filter(
      (a) =>
        !serverId ||
        a.targets.kind === 'all' ||
        (a.targets.kind === 'servers' && a.targets.serverIds.includes(serverId))
    )
    .map((a) => ({ ...a, canEdit: canChange(req.user, a) }));
  res.json({ ok: true, automations: rows });
});

const previewQuery = z.object({
  cron: z.string().trim().max(60).default(''),
  lead: z.coerce.number().int().min(0).max(automations.MAX_OFFSET_SEC).catch(0),
});

// The next three cron times, and when the steps begin when they start early.
router.get('/preview', (req, res) => {
  const { cron, lead } = previewQuery.parse(req.query);
  const timezone = settingsService.getTimezone();
  automations.assertValidCron(cron, timezone);
  const anchors = new Cron(cron, { timezone }).nextRuns(3);
  res.json({
    ok: true,
    cron,
    runs: anchors.map((d) => d.toISOString()),
    starts: lead ? anchors.map((d) => new Date(d.getTime() - lead * 1000).toISOString()) : undefined,
  });
});

// ---- Templates ----
// Saved and built-in starting points. They do nothing until used, and using one
// goes through the normal create checks, so any signed-in user who is not a
// viewer may save, import, and delete their own.

/** Templates name no server, so the global role decides who may write them. */
function requireTemplateWriter(req) {
  if (req.user.role === 'viewer') throw httpError(403, 'Your role (Viewer) is read-only.');
}

const IMPORT_MAX_BYTES = 64 * 1024;

/** A file name safe in a header: lowercase ASCII words joined with dashes. */
function fileSlug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'automation'
  );
}

function sendExport(res, template) {
  res
    .set('Content-Type', 'application/json; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${fileSlug(template.name)}.msm-automation.json"`)
    .send(JSON.stringify(automations.exportTemplate(template), null, 2));
}

/** The template as the API shows it. */
function presentTemplate(req, t) {
  const { createdBy, createdAt, ...rest } = t;
  return { ...rest, canDelete: !t.builtin && (req.user.role === 'admin' || createdBy === req.user.id) };
}

router.get('/templates', (req, res) => {
  res.json({ ok: true, templates: automations.listTemplates().map((t) => presentTemplate(req, t)) });
});

router.post(
  '/templates',
  asyncHandler((req, res) => {
    requireTemplateWriter(req);
    const template = automations.createTemplate(req.body, { actor: req.user.username, userId: req.user.id });
    res.status(201).json({ ok: true, template: presentTemplate(req, template) });
  })
);

router.post(
  '/templates/import',
  asyncHandler((req, res) => {
    requireTemplateWriter(req);
    const size = Number(req.headers['content-length']) || 0;
    if (size > IMPORT_MAX_BYTES || JSON.stringify(req.body ?? null).length > IMPORT_MAX_BYTES) {
      throw httpError(413, 'That file is too large to be an automation template.');
    }
    const def = automations.parseImport(req.body);
    if (req.query.preview === '1') return res.json({ ok: true, template: def });
    const template = automations.createTemplate(def, { actor: req.user.username, userId: req.user.id });
    res.status(201).json({ ok: true, template: presentTemplate(req, template) });
  })
);

router.get('/templates/:id/export', (req, res) => {
  const template = automations.getTemplate(String(req.params.id));
  if (!template) throw httpError(404, 'That template no longer exists.');
  sendExport(res, template);
});

router.delete(
  '/templates/:id',
  asyncHandler((req, res) => {
    const id = String(req.params.id);
    const template = automations.getTemplate(id);
    if (id.startsWith('builtin:')) throw httpError(400, "Built-in templates can't be deleted.");
    if (!template) throw httpError(404, 'That template no longer exists.');
    if (!presentTemplate(req, template).canDelete) {
      throw httpError(403, 'Only an admin or the person who saved a template can delete it.');
    }
    automations.deleteTemplate(id, { actor: req.user.username });
    res.json({ ok: true });
  })
);

// ---- File steps: dry run and pack warnings ----
const DRY_RUN_LIST_CAP = 500;

/** The definition from a request, validated and checked against what the user may change. */
function parseAccessibleDefinition(req) {
  const def = automations.validateAutomation(req.body && req.body.definition);
  requireAutomationAccess(req, def);
  return def;
}

// What each file step of an unsaved definition would do on one of its servers. Nothing is written.
router.post(
  '/dry-run',
  asyncHandler(async (req, res) => {
    const { serverId } = z.object({ serverId: z.string().trim().min(1).max(40) }).parse(req.body);
    const def = parseAccessibleDefinition(req);
    if (!permissions.visibleServerIds(req.user).has(serverId)) throw httpError(404, 'Server not found.');
    if (!automations.targetServerIds(def).includes(serverId)) {
      throw httpError(400, "That server is not one of the automation's servers.");
    }
    const steps = [];
    const ctx = await automations.fileContext(serverId); // one read of the server folder for every step
    for (const [index, step] of def.steps.entries()) {
      const label = automations.ACTIONS[step.action].label;
      if (step.action !== 'copy-files' && step.action !== 'delete-files') {
        steps.push({ index, action: step.action, label, fileStep: false, note: 'Not a file step.' });
        continue;
      }
      try {
        const plan = await automations.planFileStep(serverId, step, ctx);
        steps.push({
          index,
          action: step.action,
          label,
          fileStep: true,
          totals: plan.totals,
          files: plan.files.slice(0, DRY_RUN_LIST_CAP),
          truncated: Math.max(0, plan.files.length - DRY_RUN_LIST_CAP),
        });
      } catch (err) {
        // A refusal (over the cap, a protected folder) is the answer for that step.
        if (!err.status || err.status >= 500) throw err;
        steps.push({ index, action: step.action, label, fileStep: true, error: err.message });
      }
    }
    res.json({ ok: true, steps, warnings: automations.fileStepWarnings(def, [serverId]) });
  })
);

// Sentences the editor shows about a definition (it does not block saving).
router.post(
  '/warnings',
  asyncHandler((req, res) => {
    const def = parseAccessibleDefinition(req);
    res.json({ ok: true, warnings: automations.fileStepWarnings(def, automations.targetServerIds(def)) });
  })
);

router.get('/:id/runs', (req, res) => {
  const found = loadVisible(req);
  const visible = permissions.visibleServerIds(req.user);
  const names = new Map(db.all('SELECT id, display_name FROM servers').map((r) => [r.id, r.display_name]));
  const runs = automations
    .listRuns(found.id)
    // A run on a server the user cannot see is not theirs to read.
    .filter((r) => !r.serverId || visible.has(r.serverId))
    .map(({ serverId, ...run }) => ({
      ...run,
      serverName: serverId ? (names.get(serverId) ?? 'A deleted server') : null,
    }));
  res.json({ ok: true, runs });
});

router.get('/:id/export', (req, res) => {
  const found = loadVisible(req);
  sendExport(res, automations.templateFromAutomation(found));
});

router.post(
  '/:id/template',
  asyncHandler((req, res) => {
    requireTemplateWriter(req);
    const found = loadVisible(req);
    const { name, description } = z
      .object({ name: z.string().optional(), description: z.string().optional() })
      .parse(req.body ?? {});
    const def = {
      ...automations.templateFromAutomation(found),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
    const template = automations.createTemplate(def, { actor: req.user.username, userId: req.user.id });
    res.status(201).json({ ok: true, template: presentTemplate(req, template) });
  })
);

router.post(
  '/',
  asyncHandler((req, res) => {
    const def = parseDefinition(req.body);
    requireAutomationAccess(req, def);
    const automation = automations.createAutomation(def, { actor: req.user.username });
    res.status(201).json({ ok: true, automation });
  })
);

router.put(
  '/:id',
  asyncHandler((req, res) => {
    const stored = loadVisible(req);
    requireAutomationAccess(req, stored);
    // Leaving `enabled` out keeps the switch where it is.
    const def = parseDefinition({ enabled: stored.enabled, ...req.body });
    requireAutomationAccess(req, def);
    const automation = automations.updateAutomation(stored.id, def, { actor: req.user.username });
    res.json({ ok: true, automation });
  })
);

router.post(
  '/:id/toggle',
  asyncHandler((req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const stored = loadVisible(req);
    requireAutomationAccess(req, stored);
    automations.setEnabled(stored.id, enabled, { actor: req.user.username });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/run',
  asyncHandler((req, res) => {
    const stored = loadVisible(req);
    requireAutomationAccess(req, stored);
    // The run continues after the answer; its outcome lands in the run history.
    automations.runNow(stored.id, { actor: req.user.username });
    res.status(202).json({ ok: true });
  })
);

router.delete(
  '/:id',
  asyncHandler((req, res) => {
    const stored = loadVisible(req);
    requireAutomationAccess(req, stored);
    automations.deleteAutomation(stored.id, { actor: req.user.username });
    res.json({ ok: true });
  })
);

router.use(makeJsonErrorHandler('automations'));

module.exports = router;
