'use strict';

// The shape of an automation and its save-time checks. validateAutomation()
// returns the normalised definition (action parameters parsed and defaulted) or
// throws a 400 with a message a person can act on.

const { z } = require('zod');
const { Cron } = require('croner');
const httpError = require('../utils/httpError');
const db = require('../db');
const { getTimezone } = require('../services/settings');
const { ACTIONS } = require('./actions');

const MAX_OFFSET_SEC = 24 * 60 * 60;
const GAP_SAMPLES = 50;

const targetsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('servers'), serverIds: z.array(z.string().trim().min(1).max(40)).min(1).max(200) }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('panel') }),
]);

const triggerSchema = z.object({
  type: z.literal('schedule'),
  cron: z.string().trim().min(5).max(60),
});

const stepSchema = z.object({
  offsetSec: z.number().int().min(-MAX_OFFSET_SEC).max(MAX_OFFSET_SEC),
  action: z.string().min(1).max(40),
  params: z.record(z.string(), z.any()).default({}),
  onFailure: z.enum(['stop', 'continue']).default('stop'),
});

const automationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  targets: targetsSchema,
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(20),
});

/**
 * @typedef {z.infer<typeof automationSchema>} AutomationDef
 */

const FIELD_MESSAGES = {
  name: 'Give the automation a name of 1 to 80 characters.',
  targets: 'Pick at least one server, all servers, or the panel itself to run on.',
  trigger: 'The schedule needs a cron expression such as "0 4 * * *".',
  steps: 'An automation needs 1 to 20 steps, each with an action and a time offset within 24 hours.',
};

/** Friendly 400 for a definition that does not match the shape, never raw Zod text. */
function shapeError(error) {
  const issue = error.issues[0];
  const top = String((issue && issue.path[0]) || '');
  return httpError(400, FIELD_MESSAGES[top] || 'The automation is not valid.');
}

/** The cron expression is user input: croner's own error would surface as a generic 500. */
function assertValidCron(cron, timezone) {
  try {
    new Cron(cron, { timezone }); // throws on a bad expression
  } catch {
    throw httpError(
      400,
      `"${cron}" is not a valid schedule. Use five cron fields such as "0 4 * * *" (minute hour day month weekday).`
    );
  }
}

/**
 * The shortest gap between consecutive cron times, sampled over the next runs.
 * Infinity when the expression fires at most once.
 * @param {string} cron
 * @param {{ timezone?: string, fromMs?: number }} [opts]
 */
function cronMinGapMs(cron, { timezone = getTimezone(), fromMs = Date.now() } = {}) {
  const runs = new Cron(cron, { timezone }).nextRuns(GAP_SAMPLES, new Date(fromMs));
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) min = Math.min(min, runs[i].getTime() - runs[i - 1].getTime());
  return min;
}

/**
 * How far ahead of its anchor a run starts: the earliest negative offset.
 * @param {Array<{ offsetSec: number }>} steps
 */
function leadMs(steps) {
  return Math.max(0, -Math.min(...steps.map((s) => s.offsetSec))) * 1000;
}

function describeGap(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} minutes`;
  return `${Math.round(min / 60)} hours`;
}

/**
 * @param {unknown} def
 * @returns {AutomationDef}
 */
function validateAutomation(def) {
  const parsed = automationSchema.safeParse(def);
  if (!parsed.success) throw shapeError(parsed.error);
  const value = parsed.data;
  const timezone = getTimezone();

  assertValidCron(value.trigger.cron, timezone);

  const panel = value.targets.kind === 'panel';
  const steps = value.steps.map((step, i) => {
    const action = ACTIONS[step.action];
    if (!action) throw httpError(400, `Step ${i + 1} uses an action the panel does not know.`);
    if (panel && action.scope !== 'panel') {
      throw httpError(400, `${action.label} acts on a server, so pick at least one server to run it on.`);
    }
    if (!panel && action.scope === 'panel') {
      throw httpError(400, `${action.label} acts on the whole panel, so it cannot run for specific servers.`);
    }
    const params = action.params.safeParse(step.params);
    if (!params.success) throw httpError(400, `The settings for step ${i + 1} (${action.label}) are not valid.`);
    return { ...step, params: params.data };
  });

  for (let i = 1; i < steps.length; i++) {
    if (steps[i].offsetSec < steps[i - 1].offsetSec) {
      throw httpError(400, 'Put the steps in time order, earliest first.');
    }
  }

  let targets = value.targets;
  if (targets.kind === 'servers') {
    const ids = [...new Set(targets.serverIds)];
    const ph = ids.map(() => '?').join(',');
    const found = new Set(
      db.all(`SELECT id FROM servers WHERE deleted_at IS NULL AND id IN (${ph})`, ...ids).map((r) => r.id)
    );
    if (ids.some((id) => !found.has(id))) throw httpError(400, 'One of the chosen servers no longer exists.');
    targets = { kind: 'servers', serverIds: ids };
  }

  const lead = leadMs(steps);
  if (lead > 0) {
    const gap = cronMinGapMs(value.trigger.cron, { timezone });
    if (lead >= gap) {
      throw httpError(
        400,
        `The first step starts ${describeGap(lead)} ahead, but the schedule runs as often as every ${describeGap(gap)}. Shorten the lead time or run it less often.`
      );
    }
  }

  return { ...value, targets, steps };
}

module.exports = {
  validateAutomation,
  automationSchema,
  shapeError,
  assertValidCron,
  cronMinGapMs,
  leadMs,
  MAX_OFFSET_SEC,
};
