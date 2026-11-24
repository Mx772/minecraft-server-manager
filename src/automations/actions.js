'use strict';

// The action catalog: everything an automation step can do. Each entry says what
// it needs (`scope` and `capability` / `adminOnly` for the routes to enforce),
// validates its own parameters, and runs against a context.
//
//   scope        'server' acts on one target server; 'panel' acts on the panel
//   capability   per-server permission a server-scope action needs (services/permissions.js)
//   adminOnly    panel actions that outrun any per-server grant
//   retryWhenBusy  a refusal only because another action holds the server is retried
//   dropAfterLifecycleAction  a retried step is dropped if someone started or
//                stopped the server meanwhile
//   trayVerb / trayTitle  show the step in the top-bar task tray

const path = require('node:path');
const { z } = require('zod');
const logger = require('../logger')(path.basename(__filename));
const { recordEvent } = require('../events');
const { serializeError } = require('../utils/logSanitize');

/**
 * @typedef {object} ActionContext
 * @property {string | null} serverId the target server, null for panel actions
 * @property {any} params the step's validated parameters
 * @property {string} actor always 'automation'
 * @property {{ step: (label: string) => void } | null} task the tray task, if shown there
 * @property {any} automation the automation being run
 */

/**
 * @typedef {object} ActionDef
 * @property {string} label
 * @property {'server' | 'panel'} scope
 * @property {string} [capability]
 * @property {boolean} [adminOnly]
 * @property {import('zod').ZodType} params
 * @property {boolean} [retryWhenBusy]
 * @property {boolean} [dropAfterLifecycleAction]
 * @property {string} [trayVerb]
 * @property {string} [trayTitle]
 * @property {(ctx: ActionContext) => Promise<void | { skipped: string }>} run
 */

// Servers a fleet restart acts on. Mid-boot servers (starting, stalled) are left
// alone: restarting one only restarts the boot it is already in.
const FLEET_RESTART_STATUSES = new Set(['running', 'unhealthy']);

/**
 * Run `fn` for each server in turn (backups and restarts are heavy, so never in
 * parallel), isolating failures. Throws once at the end naming how many failed.
 * @param {string} verb  label for the error, e.g. "Backing up"
 * @param {Array<{id: string, display_name: string}>} list
 * @param {(server: any) => Promise<void>} fn
 * @param {{ step: (label: string) => void } | null} task
 */
async function forEachServer(verb, list, fn, task) {
  const failed = [];
  for (const server of list) {
    if (task) task.step(`${verb} ${server.display_name}…`);
    try {
      await fn(server);
    } catch (err) {
      failed.push(server.display_name);
      logger.warn('A fleet task failed for one server.', {
        serverId: server.id,
        verb,
        err: serializeError(err, { includeStack: false }),
      });
    }
  }
  if (failed.length) {
    throw new Error(`${verb} failed for ${failed.length} of ${list.length} servers: ${failed.join(', ')}.`);
  }
}

const noParams = z.object({});
const shrinkParams = z.object({ shrink: z.boolean().optional() });

/** @type {Record<string, ActionDef>} */
const ACTIONS = {
  restart: {
    label: 'Restart server',
    scope: 'server',
    capability: 'power',
    params: noParams,
    trayVerb: 'Restarting',
    async run({ serverId, actor }) {
      await require('../services/servers').restartServer(serverId, { actor });
    },
  },
  stop: {
    label: 'Stop server',
    scope: 'server',
    capability: 'power',
    params: noParams,
    trayVerb: 'Stopping',
    async run({ serverId, actor }) {
      await require('../services/servers').stopServer(serverId, { actor });
    },
  },
  start: {
    label: 'Start server',
    scope: 'server',
    capability: 'power',
    params: noParams,
    // A start is safe to repeat. One that waited must not undo what a person
    // did meanwhile (a Stop pressed while the backup that blocked it ran).
    retryWhenBusy: true,
    dropAfterLifecycleAction: true,
    trayVerb: 'Starting',
    async run({ serverId, actor }) {
      await require('../services/servers').startServer(serverId, { actor });
    },
  },
  backup: {
    label: 'Backup',
    scope: 'server',
    capability: 'backups',
    params: shrinkParams,
    retryWhenBusy: true,
    trayVerb: 'Backing up',
    async run({ serverId, params, actor, task }) {
      const backups = require('../services/backups');
      if (await backups.isScheduledBackupRedundant(serverId)) {
        logger.info('Skipped a scheduled backup because the server is stopped and already backed up.', { serverId });
        return { skipped: 'The server is stopped and already backed up.' };
      }
      const backup = await backups.createBackup(serverId, {
        reason: 'scheduled',
        actor,
        task,
        // Opt-in: trim rarely-visited chunks after the archive is written. Only
        // runs when the server is stopped (see createBackupImpl).
        shrinkAfter: Boolean(params.shrink),
      });
      // Read the fresh archive back end to end. A damaged one throws, so the
      // run is marked failed and the operator hears about it now, not at restore time.
      await backups.verifyBackup(backup.id, { actor, task });
    },
  },
  command: {
    label: 'Run command',
    scope: 'server',
    capability: 'console',
    params: z.object({ command: z.string().max(500).optional() }),
    async run({ serverId, params, actor }) {
      const { execCapture } = require('../docker/containers');
      // '--' stops rcon-cli parsing command words that start with '-' as flags.
      // Trim and drop a leading slash like the console does: " say hi" used to
      // send an empty first word, and "/say hi" an unknown "/say" command.
      const words = (
        String(params.command || '')
          .trim()
          .replace(/^\//, '') || 'list'
      ).split(/\s+/);
      const out = await execCapture(serverId, ['rcon-cli', '--', ...words]);
      recordEvent({
        serverId,
        actor,
        type: 'rcon',
        summary: `Scheduled RCON: ${words.join(' ')}.`,
        details: { output: out.slice(0, 1000) },
      });
    },
  },
  message: {
    label: 'Send message',
    scope: 'server',
    capability: 'console',
    params: z.object({
      text: z.string().trim().min(1).max(256),
      mode: z.enum(['say', 'tellraw']).default('tellraw'),
    }),
    async run({ serverId, params, actor }) {
      try {
        await require('../services/chat').sendChat(serverId, { text: params.text, mode: params.mode, actor });
      } catch (err) {
        // sendChat refuses with a 409 when the server is not running. A warning
        // to nobody is not a failure, so the step is skipped.
        if (err && err.status === 409) return { skipped: 'The server is not running.' };
        throw err;
      }
    },
  },

  // Fleet actions: act on every server, so they are admin-only (a per-server
  // grant cannot cover "all"). Each server is handled on its own, one failure
  // does not stop the rest, and any failure fails the run at the end.
  'backup-all': {
    label: 'Back up all servers',
    scope: 'panel',
    adminOnly: true,
    params: shrinkParams,
    trayTitle: 'Backing up all servers (automation)…',
    async run({ params, actor, task }) {
      const servers = require('../services/servers');
      const backups = require('../services/backups');
      await forEachServer(
        'Backing up',
        servers.listServers(),
        async (server) => {
          if (await backups.isScheduledBackupRedundant(server.id)) return; // stopped and already backed up
          const backup = await backups.createBackup(server.id, {
            reason: 'scheduled',
            actor,
            task,
            shrinkAfter: Boolean(params.shrink),
          });
          await backups.verifyBackup(backup.id, { actor, task });
        },
        task
      );
    },
  },
  'restart-all': {
    label: 'Restart all running servers',
    scope: 'panel',
    adminOnly: true,
    params: noParams,
    trayTitle: 'Restarting all running servers (automation)…',
    async run({ actor, task }) {
      const servers = require('../services/servers');
      await forEachServer(
        'Restarting',
        servers.listServers().filter((s) => FLEET_RESTART_STATUSES.has(s.status)),
        (server) => servers.restartServer(server.id, { actor }),
        task
      );
    },
  },
  'update-check': {
    label: 'Update check',
    scope: 'panel',
    params: noParams,
    trayTitle: 'Checking for updates…',
    async run({ actor, task }) {
      if (task) task.step('Checking for updates…');
      await require('../updates/checker').checkAll({ actor });
      if (task) task.step('Applying automatic updates…');
      // Only the scheduled daily check triggers auto-updates. The manual
      // "check now" buttons never apply anything (the settings-page policy
      // label promises exactly this).
      await require('../updates/upgrade').runAutoUpgrades({ actor });
    },
  },
  'storage-scan': {
    label: 'Storage re-scan',
    scope: 'panel',
    params: noParams,
    trayTitle: 'Scanning storage…',
    async run({ task }) {
      if (task) task.step('Scanning storage…');
      await require('../storage/indexer').scan();
      await require('../storage/indexer').enforceStrictQuotas();
    },
  },
  'tmp-clean': {
    label: 'Clear temporary files',
    scope: 'panel',
    params: noParams,
    async run() {
      // Only clears entries older than 24h so in-flight downloads and uploads
      // survive the 04:30 sweep (boot still wipes fully).
      require('../storage/dataRoot').cleanTmp({ olderThanMs: 24 * 60 * 60 * 1000 });
      require('../services/auth').pruneExpiredSessions();
    },
  },
  'ban-expiry-sweep': {
    label: 'Ban expiry sweep',
    scope: 'panel',
    params: noParams,
    async run() {
      await require('../services/players').sweepExpiredBans();
    },
  },
  'content-meta-backfill': {
    label: 'Content metadata backfill',
    scope: 'panel',
    params: noParams,
    async run() {
      await require('../services/contentIcons').backfillContentMeta();
    },
  },
};

module.exports = { ACTIONS, FLEET_RESTART_STATUSES };
