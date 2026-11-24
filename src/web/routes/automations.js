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
  const rows = automations
    .listAutomations()
    .filter((a) => isVisibleTo(visible, a))
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
