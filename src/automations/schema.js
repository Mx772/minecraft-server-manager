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
const { EVENTS, EVENT_NAMES, MAX_EVENT_OFFSET_SEC } = require('./events');

const MAX_OFFSET_SEC = 24 * 60 * 60;
const GAP_SAMPLES = 50;

const targetsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('servers'), serverIds: z.array(z.string().trim().min(1).max(40)).min(1).max(200) }),
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('panel') }),
]);

const scheduleTriggerSchema = z.object({
  type: z.literal('schedule'),
  cron: z.string().trim().min(5).max(60),
});

const eventTriggerSchema = z.object({
  type: z.literal('event'),
  event: z.enum(EVENT_NAMES),
});

const triggerSchema = z.discriminatedUnion('type', [scheduleTriggerSchema, eventTriggerSchema]);

// Checked right before a step runs; a step whose condition is not met is skipped.
const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('server-running') }),
  z.object({ type: z.literal('players-online'), min: z.number().int().min(1).max(500).default(1) }),
  z.object({ type: z.literal('no-players') }),
]);

const stepSchema = z.object({
  offsetSec: z.number().int().min(-MAX_OFFSET_SEC).max(MAX_OFFSET_SEC),
  action: z.string().min(1).max(40),
  params: z.record(z.string(), z.any()).default({}),
  onFailure: z.enum(['stop', 'continue']).default('stop'),
  condition: conditionSchema.optional(),
});

const automationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  targets: targetsSchema,
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(20),
});

// A template is an automation without its servers: the kind of target stands in
// for the target itself.
const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  targetsKind: z.enum(['servers', 'all', 'panel']),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(20),
});

/**
 * @typedef {z.infer<typeof automationSchema>} AutomationDef
 * @typedef {z.infer<typeof templateSchema>} TemplateDef
 */

const FIELD_MESSAGES = {
  name: 'Give it a name of 1 to 80 characters.',
  targets: 'Pick at least one server, all servers, or the panel itself to run on.',
  targetsKind: 'Pick servers, all servers, or the panel itself for the template to run on.',
  description: 'Keep the description to 300 characters or fewer.',
  trigger: 'The trigger needs a cron schedule such as "0 4 * * *", or one of the known events.',
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
 * The checks an automation and a template share: the trigger, each step's
 * action, parameters and condition, step order, and (for schedules) the lead time.
 * @param {{ kind: 'servers' | 'all' | 'panel', trigger: AutomationDef['trigger'], steps: AutomationDef['steps'] }} def
 * @returns {AutomationDef['steps']} the steps with parameters parsed and defaulted
 */
function validateSteps({ kind, trigger, steps: rawSteps }) {
  const timezone = getTimezone();
  const eventName = trigger.type === 'event' ? trigger.event : null;
  const event = eventName ? EVENTS[eventName] : null;
  if (trigger.type === 'schedule') assertValidCron(trigger.cron, timezone);
  else if (kind === 'panel') {
    throw httpError(400, 'An event runs for a server, so pick at least one server or all servers.');
  }

  const panel = kind === 'panel';
  const steps = rawSteps.map((step, i) => {
    const action = ACTIONS[step.action];
    if (!action) throw httpError(400, `Step ${i + 1} uses an action the panel does not know.`);
    if (panel && action.scope !== 'panel') {
      throw httpError(400, `${action.label} acts on a server, so pick at least one server to run it on.`);
    }
    if (!panel && action.scope === 'panel') {
      throw httpError(400, `${action.label} acts on the whole panel, so it cannot run for specific servers.`);
    }
    if (event && !(action.events || []).includes(/** @type {string} */ (eventName))) {
      // Catalog labels are sentence case; the refusal names the action the way the editor's menu does.
      const name = action.label.replace(/\b[a-z]/g, (c) => c.toUpperCase());
      const lifecycle = !action.events || !action.events.length;
      throw httpError(
        400,
        lifecycle
          ? `${name} can't run ${event.when}, because it could trigger the same event again.`
          : `${name} can't run ${event.when}, because ${event.reason}.`
      );
    }
    if (step.condition && (panel || action.scope !== 'server')) {
      throw httpError(
        400,
        `Step ${i + 1} (${action.label}) cannot have a condition, since it does not act on a server.`
      );
    }
    const params = action.params.safeParse(step.params);
    if (!params.success) {
      // A parameter rule with its own sentence (a path that leaves the folder) says what is wrong.
      const custom = params.error.issues.find((issue) => issue.code === 'custom');
      throw httpError(
        400,
        `The settings for step ${i + 1} (${action.label}) are not valid.${custom ? ` ${custom.message}` : ''}`
      );
    }
    return { ...step, params: params.data };
  });

  if (event) {
    if (steps.some((s) => s.offsetSec < 0 || s.offsetSec > MAX_EVENT_OFFSET_SEC)) {
      throw httpError(400, 'A step on an event can wait up to 1 hour after it, and cannot run before it.');
    }
    if (event.zeroOffsetOnly && steps.some((s) => s.offsetSec !== 0)) {
      throw httpError(400, `Steps ${event.when} must run right away, with no delay.`);
    }
  }

  for (let i = 1; i < steps.length; i++) {
    if (steps[i].offsetSec < steps[i - 1].offsetSec) {
      throw httpError(400, 'Put the steps in time order, earliest first.');
    }
  }

  const lead = leadMs(steps);
  if (trigger.type === 'schedule' && lead > 0) {
    const gap = cronMinGapMs(trigger.cron, { timezone });
    if (lead >= gap) {
      throw httpError(
        400,
        `The first step starts ${describeGap(lead)} ahead, but the schedule runs as often as every ${describeGap(gap)}. Shorten the lead time or run it less often.`
      );
    }
  }
  return steps;
}

/**
 * @param {unknown} def
 * @returns {AutomationDef}
 */
function validateAutomation(def) {
  const parsed = automationSchema.safeParse(def);
  if (!parsed.success) throw shapeError(parsed.error);
  const value = parsed.data;

  const steps = validateSteps({ kind: value.targets.kind, trigger: value.trigger, steps: value.steps });

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

  return { ...value, targets, steps };
}

/**
 * @param {unknown} def
 * @returns {TemplateDef}
 */
function validateTemplate(def) {
  const parsed = templateSchema.safeParse(def);
  if (!parsed.success) throw shapeError(parsed.error);
  const value = parsed.data;
  const steps = validateSteps({ kind: value.targetsKind, trigger: value.trigger, steps: value.steps });
  return { ...value, steps };
}

module.exports = {
  validateAutomation,
  validateTemplate,
  automationSchema,
  templateSchema,
  stepSchema,
  triggerSchema,
  scheduleTriggerSchema,
  eventTriggerSchema,
  shapeError,
  assertValidCron,
  cronMinGapMs,
  leadMs,
  MAX_OFFSET_SEC,
};
