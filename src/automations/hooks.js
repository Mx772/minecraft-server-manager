'use strict';

// The hook registry: the panel's own code calls emit() at the moments an event
// automation can run on. Most events are fire-and-forget and never delay or fail
// the caller. `before-start` is awaited, and a failure blocks the start.

const path = require('node:path');
const httpError = require('../utils/httpError');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { EVENTS } = require('./events');
const store = require('./store');
const engine = require('./engine');

const BEFORE_START_TIMEOUT_MS = 2 * 60_000;
const SETTLE_AFTER_ABORT_MS = 30_000; // how long to wait for aborted steps to stop
const options = { beforeStartTimeoutMs: BEFORE_START_TIMEOUT_MS };

/** Override the before-start time limit (tests). Call with no argument to restore it. */
function configureHooks(overrides = {}) {
  options.beforeStartTimeoutMs = overrides.beforeStartTimeoutMs ?? BEFORE_START_TIMEOUT_MS;
}

/** The enabled event automations that act on this event for this server. */
function matching(event, serverId) {
  return store
    .allAutomations()
    .filter(
      (a) =>
        a.enabled &&
        a.trigger.type === 'event' &&
        a.trigger.event === event &&
        (a.targets.kind === 'all' || (a.targets.kind === 'servers' && a.targets.serverIds.includes(serverId)))
    );
}

/**
 * Run the event automations for a server's event. For `before-start` this
 * resolves once every sequence has finished (within two minutes) and rejects with
 * a 409 when one failed on a 'stop' step or ran out of time, so the caller does
 * not start the server. For every other event it returns at once and never rejects.
 * @param {string} event one of the events in events.js
 * @param {string} serverId
 * @param {{ actor?: string }} [ctx]
 * @returns {Promise<void>}
 */
async function emit(event, serverId, ctx = {}) {
  const info = EVENTS[event];
  if (!info) return;
  let found;
  try {
    found = matching(event, serverId);
  } catch (err) {
    logger.error('Looking up the automations for an event failed.', { event, serverId, err: serializeError(err) });
    return;
  }
  if (!found.length) return;
  logger.debug('Running the automations for an event.', { event, serverId, count: found.length, actor: ctx.actor });
  if (event !== 'before-start') {
    // Fire and forget. The caller is usually still inside its own operation (a
    // stop holds the server's lock), so start the runs once it has returned and
    // released it: a backup step would otherwise meet "busy" and wait a minute.
    setImmediate(() => {
      for (const automation of found) void engine.fireForServer(automation, serverId, { firedPhrase: info.fired });
    });
    return;
  }
  // before-start runs inside the start, which holds the server's lock already. If it
  // runs out of time the runs are told to stop, and the start only fails once they
  // have: a step must not keep changing files after the start has let go of the lock.
  const abort = new AbortController();
  const runs = found.map((automation) => ({
    automation,
    done: engine.fireForServer(automation, serverId, {
      firedPhrase: info.fired,
      insideStartLock: true,
      signal: abort.signal,
    }),
  }));

  /** @type {Set<string>} */
  const pending = new Set(runs.map((r) => r.automation.name));
  const all = Promise.all(
    runs.map(async (r) => {
      const result = await r.done;
      pending.delete(r.automation.name);
      return { name: r.automation.name, result };
    })
  );
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), options.beforeStartTimeoutMs);
    timer.unref();
  });
  const settled = await Promise.race([all, timeout]);
  clearTimeout(timer);
  if (!settled) {
    const name = [...pending][0];
    abort.abort('the start took too long');
    // Residual: a step that does not stop within this wait (one stuck in a single slow
    // disk call) is given up on, and the start fails while it may still be finishing.
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_ABORT_MS).unref())]);
    logger.warn('A before-start automation ran out of time, so the start was blocked.', { serverId });
    throw httpError(
      409,
      `The automation "${name}" failed before the start, so the server was not started: it did not finish in time.`
    );
  }
  const blocker = settled.find((s) => s.result.stopped);
  if (blocker) {
    const reason = String(blocker.result.error || 'a step failed').replace(/[.!?]+$/, '');
    throw httpError(
      409,
      `The automation "${blocker.name}" failed before the start, so the server was not started: ${reason}.`
    );
  }
}

module.exports = { emit, configureHooks };
