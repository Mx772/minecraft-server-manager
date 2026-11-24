'use strict';

// Arms and fires automations. Each schedule trigger has one setTimeout aimed at
// (next anchor - lead), where the anchor is the next cron time and the lead is
// how far ahead its earliest step starts (a step at -300 s needs a 5 minute
// lead). A firing runs one sequence per target server in parallel; within a
// sequence each step waits until anchor + offset, then runs. Every firing is a
// history event and every sequence an `automation_runs` row.

const path = require('node:path');
const { Cron } = require('croner');
const db = require('../db');
const httpError = require('../utils/httpError');
const { recordEvent, lifecycleActionSince } = require('../events');
const { getTimezone } = require('../services/settings');
const tasks = require('../services/tasks');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { ACTIONS } = require('./actions');
const { leadMs, cronMinGapMs } = require('./schema');
const store = require('./store');

// A backup or start refused only because another action holds its server (a
// restore, a backup cleanup, a port change) tries again every minute until that
// action is done, for up to 30 minutes, instead of losing this run. Restart and
// stop are not retried: a restart that collided with someone's restart has in
// effect happened and repeating it would kick players twice, and a stop or
// restart that met a backup or restore should not land unannounced minutes
// later. They run again at their next time. Before each retry the automation
// must still exist and be on. Any other failure fails at once.
const BUSY_RETRY_MS = 60_000;
const BUSY_MAX_WAIT_MS = 30 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout's ceiling (~24.8 days)
const KEEP_RUNS = 50;
const MISSED_GRACE_MS = 30_000;
// Whatever started a firing, the steps themselves act as the automation.
const STEP_ACTOR = 'automation';

/**
 * @typedef {object} EngineOptions
 * @property {number} [retryMs] wait between busy retries
 * @property {number} [maxWaitMs] how long a busy step keeps retrying
 * @property {(ms: number) => Promise<void>} [sleep] replaces the real wait (tests)
 */

/** @type {Required<Pick<EngineOptions, 'retryMs' | 'maxWaitMs'>> & { sleep: EngineOptions['sleep'] }} */
const options = { retryMs: BUSY_RETRY_MS, maxWaitMs: BUSY_MAX_WAIT_MS, sleep: undefined };

/** Override waits (tests). Call with no argument to restore the defaults. */
function configureEngine(overrides = {}) {
  options.retryMs = overrides.retryMs ?? BUSY_RETRY_MS;
  options.maxWaitMs = overrides.maxWaitMs ?? BUSY_MAX_WAIT_MS;
  options.sleep = overrides.sleep;
}

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();
/** The anchor each automation last fired for, so an early timer never fires it twice. @type {Map<string, number>} */
const lastAnchors = new Map();
/** Automations with a firing still in progress (including one waiting to retry). @type {Set<string>} */
const running = new Set();
/** @type {Set<{ timer: NodeJS.Timeout, resolve: () => void }>} */
const sleepers = new Set();
let epoch = 0; // bumped by stopAll(): sequences from an earlier epoch stop

/** @param {number} ms @returns {Promise<void>} */
function realSleep(ms) {
  return new Promise((/** @type {() => void} */ resolve) => {
    const sleeper = {
      timer: setTimeout(() => {
        sleepers.delete(sleeper);
        resolve();
      }, ms),
      resolve,
    };
    sleeper.timer.unref();
    sleepers.add(sleeper);
  });
}

function sleep(ms) {
  return (options.sleep || realSleep)(ms);
}

/**
 * When an automation next fires: the first cron time strictly after now (and
 * after `afterAnchorMs`, so an anchor never fires twice), and the moment its
 * lead begins. Inside the lead window that moment is now, so the run starts
 * late rather than being skipped.
 * @param {{ trigger: { cron: string }, steps: Array<{ offsetSec: number }> }} automation
 * @param {number} nowMs
 * @param {{ timezone?: string, afterAnchorMs?: number }} [opts]
 * @returns {{ anchorMs: number, fireMs: number } | null}
 */
function nextFire(automation, nowMs, { timezone = getTimezone(), afterAnchorMs } = {}) {
  const lead = leadMs(automation.steps);
  const after = Math.max(nowMs, afterAnchorMs ?? -Infinity);
  const anchor = new Cron(automation.trigger.cron, { timezone }).nextRun(new Date(after));
  if (!anchor) return null;
  return { anchorMs: anchor.getTime(), fireMs: Math.max(nowMs, anchor.getTime() - lead) };
}

function disarm(id) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

/** (Re)arm one automation against its current definition and the current time zone. */
function arm(id) {
  disarm(id);
  const automation = store.getAutomation(id);
  if (!automation || !automation.enabled || automation.trigger.type !== 'schedule') return;
  let next;
  try {
    next = nextFire(automation, Date.now(), { afterAnchorMs: lastAnchors.get(id) });
  } catch (err) {
    logger.error('An automation has an invalid schedule and was not armed.', {
      automationId: id,
      err: serializeError(err, { includeStack: false }),
    });
    return;
  }
  if (next) startTimer(id, next);
}

function startTimer(id, next) {
  const delay = Math.max(0, next.fireMs - Date.now());
  const timer = setTimeout(
    () => {
      if (delay > MAX_TIMER_MS) return startTimer(id, next); // a long wait, resumed in chunks
      timers.delete(id);
      lastAnchors.set(id, next.anchorMs);
      arm(id); // aim at the following anchor before this one runs
      fire(id, next.anchorMs, { actor: 'automation', skipMissed: true }).catch((err) => {
        logger.error('An automation firing failed unexpectedly.', { automationId: id, err: serializeError(err) });
      });
    },
    Math.min(delay, MAX_TIMER_MS)
  );
  timer.unref();
  timers.set(id, timer);
}

/** Re-arm everything against the CURRENT time zone, e.g. after it changes in Settings. */
function rearmAll() {
  for (const a of store.allAutomations()) arm(a.id);
}

function stopAll() {
  epoch++;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  lastAnchors.clear();
  for (const s of [...sleepers]) {
    clearTimeout(s.timer);
    s.resolve();
  }
  sleepers.clear();
}

function startAutomations() {
  // A run cut off by a restart of the panel cannot finish; do not leave it "running".
  db.run("UPDATE automation_runs SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'");
  store.seedPanelDefaults();
  rearmAll();
  logger.info('Armed the automations.', { armed: timers.size });
}

function toSqlTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Server ids a firing acts on; [null] for a panel automation. @returns {Array<string | null>} */
function resolveTargets(automation) {
  const t = automation.targets;
  if (t.kind === 'panel') return [null];
  const existing = db.all('SELECT id FROM servers WHERE deleted_at IS NULL ORDER BY created_at, id').map((r) => r.id);
  if (t.kind === 'all') return existing;
  return t.serverIds.filter((id) => existing.includes(id));
}

/**
 * One firing: record it, run a sequence per target in parallel, record the result.
 * @param {string} id
 * @param {number} anchorMs
 * @param {{ actor?: string, force?: boolean, skipMissed?: boolean }} [opts] skipMissed: a timer firing that
 *   starts late skips warnings (negative offsets) whose time is long past. force: run even though the automation is off (a manual run)
 */
async function fire(id, anchorMs, { actor = 'automation', force = false, skipMissed = false } = {}) {
  const automation = store.getAutomation(id);
  if (!automation || (!automation.enabled && !force)) return;
  // A manual run of an automation that is off ignores the switch; one that was
  // on when it started still stops if someone turns it off meanwhile.
  const ignoreEnabled = force && !automation.enabled;
  if (running.has(id)) {
    logger.debug('Skipped an automation firing because its previous run is still going.', { automationId: id });
    return;
  }
  running.add(id);
  const myEpoch = epoch;
  try {
    db.run("UPDATE automations SET last_run_at = datetime('now') WHERE id = ?", id);
    const targets = resolveTargets(automation);
    recordEvent({
      serverId: targets.length === 1 ? targets[0] : null,
      actor,
      type: 'automation-fired',
      summary: `Automation fired: ${automation.name}.`,
    });
    logger.info('An automation fired.', { automationId: id, targets: targets.length });
    const results = await Promise.all(
      targets.map((serverId) =>
        runSequence(automation, serverId, anchorMs, { force: ignoreEnabled, skipMissed, epoch: myEpoch })
      )
    );
    const failed = results.filter((r) => r.status === 'failed');
    const status = !failed.length ? 'ok' : failed.length === results.length ? 'failed' : 'partial';
    db.run(
      'UPDATE automations SET last_status = ?, last_error = ? WHERE id = ?',
      status,
      failed.length ? failed[0].error : null,
      id
    );
  } finally {
    running.delete(id);
  }
}

/**
 * Run an automation now with the anchor at this moment. Negative-offset steps
 * are already due, so they run back to back. Returns without waiting for the
 * run; `done` settles when it ends.
 * @param {string} id
 * @param {{ actor?: string }} [opts]
 * @returns {{ done: Promise<void> }}
 */
function runNow(id, { actor = 'system' } = {}) {
  if (!store.getAutomation(id)) throw httpError(404, 'That automation no longer exists.');
  if (running.has(id)) throw httpError(409, 'That automation is already running.');
  const done = fire(id, Date.now(), { actor, force: true }).catch((err) => {
    logger.error('An automation run failed unexpectedly.', { automationId: id, err: serializeError(err) });
  });
  return { done };
}

/**
 * One target's steps, in order. A failed step ends the sequence when its
 * onFailure is 'stop'. A sequence never throws: its outcome is the return value.
 * @returns {Promise<{ status: string, error: string | null }>}
 */
async function runSequence(automation, serverId, anchorMs, { force, skipMissed, epoch: myEpoch }) {
  const startedAt = Date.now();
  const runId = Number(
    db.run(
      "INSERT INTO automation_runs (automation_id, server_id, anchor_at, started_at, status) VALUES (?, ?, ?, ?, 'running')",
      automation.id,
      serverId,
      toSqlTime(anchorMs),
      toSqlTime(startedAt)
    ).lastInsertRowid
  );
  const server = serverId ? db.get('SELECT display_name FROM servers WHERE id = ?', serverId) : null;
  /** @type {Array<{ index: number, action: string, offsetSec: number, status: string, detail?: string }>} */
  const record = [];
  let error = null;
  let failedLabel = '';

  for (let index = 0; index < automation.steps.length; index++) {
    const step = automation.steps[index];
    const wait = anchorMs + step.offsetSec * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (myEpoch !== epoch) {
      record.push({ index, action: step.action, offsetSec: step.offsetSec, status: 'aborted' });
      break;
    }
    // Turned off or deleted while waiting: stop before the next step.
    const current = store.getAutomation(automation.id);
    if (!current || (!current.enabled && !force)) {
      record.push({ index, action: step.action, offsetSec: step.offsetSec, status: 'aborted' });
      break;
    }
    const action = ACTIONS[step.action];
    const entry = { index, action: step.action, offsetSec: step.offsetSec, status: 'ok' };
    record.push(entry);
    // A "5 minutes left" warning must not be sent at 1 minute left.
    if (skipMissed && step.offsetSec < 0 && wait < -MISSED_GRACE_MS) {
      entry.status = 'skipped';
      entry.detail = 'Its time had passed when the automation started.';
      continue;
    }
    try {
      if (!action) throw new Error(`Unknown action ${step.action}`);
      const outcome = await runStep(automation, step, action, serverId, server && server.display_name, {
        force,
      });
      if (outcome && outcome.skipped) {
        entry.status = 'skipped';
        entry.detail = outcome.skipped;
      }
    } catch (err) {
      entry.status = 'failed';
      entry.detail = String(err.message || 'unknown error');
      error = error || entry.detail;
      failedLabel = failedLabel || (action ? action.label : step.action);
      recordEvent({
        serverId,
        actor: STEP_ACTOR,
        type: 'automation-failed',
        summary: `Automation ${automation.name} failed at ${failedLabel}: ${entry.detail.replace(/[.!?]+$/, '')}.`,
      });
      logger.error('An automation step failed.', {
        automationId: automation.id,
        action: step.action,
        serverId: serverId || undefined,
        err: serializeError(err),
      });
      if (step.onFailure !== 'continue') break;
    }
  }

  const status = record.some((r) => r.status === 'failed') ? 'failed' : 'ok';
  db.run(
    "UPDATE automation_runs SET status = ?, finished_at = datetime('now'), steps_json = ? WHERE id = ?",
    status,
    JSON.stringify(record),
    runId
  );
  db.run(
    'DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?)',
    automation.id,
    automation.id,
    KEEP_RUNS
  );
  return { status, error };
}

/** One step: shown in the tray when it is the kind a person would wonder about, with busy retries. */
function runStep(automation, step, action, serverId, serverName, { force }) {
  const params = action.params.parse(step.params ?? {});
  const title =
    action.trayVerb && serverName ? `${action.trayVerb} ${serverName} (automation)…` : action.trayTitle || null;
  const run = (task) => runWithRetry(automation, step, action, params, serverId, task, { force });
  if (!title) return run(null);
  // One tray entry covers every busy retry, so waiting does not flash a failure.
  return tasks.track(title, { serverId, actor: STEP_ACTOR }, run);
}

async function runWithRetry(automation, step, action, params, serverId, task, { force }) {
  const { retryMs, maxWaitMs } = options;
  const firedAt = Date.now();
  const giveUpAt = firedAt + maxWaitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await action.run({ serverId, params, actor: STEP_ACTOR, task, automation });
    } catch (err) {
      const busy = err && err.code === 'BUSY';
      if (!busy || !action.retryWhenBusy || Date.now() + retryMs > giveUpAt) throw err;
      if (attempt === 0) {
        logger.info('An automation step found its server busy and will retry.', {
          automationId: automation.id,
          action: step.action,
          serverId: serverId || undefined,
        });
      }
      if (task) task.step('Waiting for the server to finish another action…');
      await sleep(retryMs);
      const still = store.getAutomation(automation.id);
      if (!still || (!still.enabled && !force)) return { skipped: 'The automation was turned off or deleted.' };
      if (action.dropAfterLifecycleAction && serverId && lifecycleActionSince(serverId, firedAt)) {
        logger.debug('Dropped a scheduled start because the server was stopped or started meanwhile.', {
          automationId: automation.id,
          serverId,
        });
        return { skipped: 'The server was stopped or started in the meantime.' };
      }
    }
  }
}

module.exports = {
  startAutomations,
  rearmAll,
  arm,
  disarm,
  runNow,
  stopAll,
  configureEngine,
  nextFire,
  cronMinGapMs,
};
