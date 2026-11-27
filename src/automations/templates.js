'use strict';

// Automation templates: the built-in starting points and the shareable file
// format. A template is an automation without its servers (see schema.js). A
// shared file carries the template and nothing else: no ids, server names, user
// names, or timestamps.

const { z } = require('zod');
const httpError = require('../utils/httpError');
const { ACTIONS } = require('./actions');
const { validateTemplate, shapeError, stepSchema, scheduleTriggerSchema, eventTriggerSchema } = require('./schema');

const say = (text) => ({ action: 'message', params: { text, mode: 'say' } });

/** @type {Array<{ slug: string, template: import('./schema').TemplateDef }>} */
const BUILTINS = [
  {
    slug: 'restart-with-warnings',
    template: {
      name: 'Restart With Warnings',
      description: 'Restarts the server every day at 4:00, warning players 15, 5, and 1 minute ahead.',
      targetsKind: 'servers',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      steps: [
        { offsetSec: -900, ...say('The server restarts in 15 minutes.'), onFailure: 'continue' },
        { offsetSec: -300, ...say('The server restarts in 5 minutes.'), onFailure: 'continue' },
        { offsetSec: -60, ...say('The server restarts in 1 minute.'), onFailure: 'continue' },
        { offsetSec: 0, action: 'restart', params: {}, onFailure: 'stop' },
      ],
    },
  },
  {
    slug: 'restart-when-empty',
    template: {
      name: 'Restart When Empty',
      description: 'Restarts the server every day at 4:00, but only when no players are online.',
      targetsKind: 'servers',
      trigger: { type: 'schedule', cron: '0 4 * * *' },
      steps: [{ offsetSec: 0, action: 'restart', params: {}, onFailure: 'stop', condition: { type: 'no-players' } }],
    },
  },
  {
    slug: 'nightly-backup',
    template: {
      name: 'Nightly Backup',
      description: 'Backs up the server every day at 3:00.',
      targetsKind: 'servers',
      trigger: { type: 'schedule', cron: '0 3 * * *' },
      steps: [{ offsetSec: 0, action: 'backup', params: {}, onFailure: 'stop' }],
    },
  },
  {
    slug: 'backup-then-restart',
    template: {
      name: 'Backup Then Restart',
      description: 'Backs up the server every day at 5:00, then restarts it once the backup is done.',
      targetsKind: 'servers',
      trigger: { type: 'schedule', cron: '0 5 * * *' },
      steps: [
        { offsetSec: -60, ...say('The server backs up and restarts in 1 minute.'), onFailure: 'continue' },
        { offsetSec: 0, action: 'backup', params: {}, onFailure: 'stop' },
        { offsetSec: 0, action: 'restart', params: {}, onFailure: 'stop' },
      ],
    },
  },
  {
    slug: 'notify-discord-on-crash',
    template: {
      name: 'Notify Discord On Crash',
      description: "Posts to the server's Discord channel whenever the server crashes.",
      targetsKind: 'servers',
      trigger: { type: 'event', event: 'on-crash' },
      steps: [
        {
          offsetSec: 0,
          action: 'discord',
          params: { message: 'The server crashed. The panel is looking into it.' },
          onFailure: 'stop',
        },
      ],
    },
  },
  {
    slug: 'back-up-after-stop',
    template: {
      name: 'Back Up After Stop',
      description: 'Backs up the server each time it is stopped from the panel.',
      targetsKind: 'servers',
      trigger: { type: 'event', event: 'after-stop' },
      steps: [{ offsetSec: 0, action: 'backup', params: {}, onFailure: 'stop' }],
    },
  },
  {
    slug: 'welcome-back-message',
    template: {
      name: 'Welcome Back Message',
      description: 'Tells players the server is back up, a minute after it finishes starting.',
      targetsKind: 'servers',
      trigger: { type: 'event', event: 'after-start' },
      steps: [
        {
          offsetSec: 60,
          action: 'message',
          params: { text: 'The server is back up.', mode: 'tellraw' },
          onFailure: 'stop',
        },
      ],
    },
  },
  {
    slug: 'restore-files-before-boot',
    template: {
      name: 'Restore Files Before Boot',
      description:
        'Copies a folder of your own files over the server folder each time the server starts. Change the folders to match your setup.',
      targetsKind: 'servers',
      trigger: { type: 'event', event: 'before-start' },
      steps: [
        {
          offsetSec: 0,
          action: 'copy-files',
          params: { from: 'custom/kubejs', to: 'kubejs', mode: 'overwrite', include: '**' },
          onFailure: 'stop',
        },
      ],
    },
  },
  {
    slug: 'scheduled-announcement',
    template: {
      name: 'Scheduled Announcement',
      description: 'Sends a chat message to players every 2 hours. Change the text to your own announcement.',
      targetsKind: 'servers',
      trigger: { type: 'schedule', cron: '0 */2 * * *' },
      steps: [
        {
          offsetSec: 0,
          action: 'message',
          params: { text: 'Replace this with your announcement.', mode: 'tellraw' },
          onFailure: 'stop',
        },
      ],
    },
  },
];

/** The built-in templates, as listed: id `builtin:<slug>`, never stored. */
function builtinTemplates() {
  return BUILTINS.map(({ slug, template }) => ({ id: `builtin:${slug}`, ...template, builtin: true }));
}

const FORMAT_VERSION = 1;
const FORMAT_KEY = 'msm-automation';

/**
 * The shareable form of a template: only what defines it.
 * @param {import('./schema').TemplateDef} def
 */
function exportTemplate(def) {
  return {
    [FORMAT_KEY]: FORMAT_VERSION,
    name: def.name,
    description: def.description || '',
    targetsKind: def.targetsKind,
    trigger:
      def.trigger.type === 'event'
        ? { type: 'event', event: def.trigger.event }
        : { type: 'schedule', cron: def.trigger.cron },
    steps: def.steps.map((s) => ({
      offsetSec: s.offsetSec,
      action: s.action,
      params: s.params,
      onFailure: s.onFailure,
      ...(s.condition ? { condition: s.condition } : {}),
    })),
  };
}

const importSchema = z
  .object({
    [FORMAT_KEY]: z.literal(FORMAT_VERSION),
    name: z.string(),
    description: z.string().optional(),
    targetsKind: z.enum(['servers', 'all', 'panel']),
    trigger: z.union([scheduleTriggerSchema.strict(), eventTriggerSchema.strict()]),
    steps: z.array(stepSchema.strict()),
  })
  .strict();

const NOT_A_TEMPLATE = 'This file is from a newer version of the panel, or is not an automation template.';

/**
 * Read a shared file's contents (text or already-parsed JSON) into a validated
 * template, or throw a friendly 400.
 * @param {unknown} input
 * @returns {import('./schema').TemplateDef}
 */
function parseImport(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw httpError(400, 'This file is not valid JSON.');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, NOT_A_TEMPLATE);
  const obj = /** @type {Record<string, any>} */ (data);
  if (obj[FORMAT_KEY] !== FORMAT_VERSION) throw httpError(400, NOT_A_TEMPLATE);

  const known = new Set(Object.keys(importSchema.shape));
  const extra = Object.keys(obj).find((k) => !known.has(k));
  if (extra) throw httpError(400, `This file has a setting the panel does not know: ${extra.slice(0, 40)}.`);

  if (Array.isArray(obj.steps)) {
    for (const step of obj.steps) {
      const action = step && typeof step === 'object' ? step.action : undefined;
      if (typeof action === 'string' && !ACTIONS[action]) {
        throw httpError(400, `This template uses an action this panel does not have: ${action.slice(0, 40)}.`);
      }
    }
  }

  const parsed = importSchema.safeParse(obj);
  if (!parsed.success) throw shapeError(parsed.error);
  const { [FORMAT_KEY]: _version, ...def } = parsed.data;
  return validateTemplate(def);
}

module.exports = { builtinTemplates, exportTemplate, parseImport, FORMAT_KEY };
