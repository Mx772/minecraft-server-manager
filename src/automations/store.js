'use strict';

// Persistence for automations (the `automations` and `automation_runs` tables).
// Every mutation is a history event and re-arms the engine. The engine is
// required inside functions: it reads automations back through this module.

const path = require('node:path');
const { nanoid } = require('nanoid');
const db = require('../db');
const httpError = require('../utils/httpError');
const { recordEvent } = require('../events');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { validateAutomation } = require('./schema');
const { ACTIONS } = require('./actions');

/**
 * @typedef {import('./schema').AutomationDef & { id: string, createdBy: string | null, lastRunAt: string | null,
 *   lastStatus: string | null, lastError: string | null, createdAt: string, updatedAt: string }} Automation
 */

/** Panel housekeeping that exists from first boot; a person can retime, disable, or delete it. */
const PANEL_DEFAULTS = [
  { name: 'Update Check', action: 'update-check', cron: '0 3 * * *' },
  { name: 'Storage Re-Scan', action: 'storage-scan', cron: '0 */6 * * *' },
  { name: 'Clear Temporary Files', action: 'tmp-clean', cron: '30 4 * * *' },
  { name: 'Ban Expiry Sweep', action: 'ban-expiry-sweep', cron: '*/15 * * * *' },
  { name: 'Content Metadata Backfill', action: 'content-meta-backfill', cron: '20 3 * * *' },
];

/** @returns {Automation} */
function rowToAutomation(r) {
  return {
    id: r.id,
    name: r.name,
    enabled: Boolean(r.enabled),
    targets: JSON.parse(r.targets_json),
    trigger: JSON.parse(r.trigger_json),
    steps: JSON.parse(r.steps_json),
    createdBy: r.created_by || null,
    lastRunAt: r.last_run_at || null,
    lastStatus: r.last_status || null,
    lastError: r.last_error || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** @returns {Automation | null} */
function getAutomation(id) {
  const row = db.get('SELECT * FROM automations WHERE id = ?', id);
  return row ? rowToAutomation(row) : null;
}

/** @returns {Automation[]} */
function allAutomations() {
  return db.all('SELECT * FROM automations ORDER BY created_at, id').map(rowToAutomation);
}

/** The one server an automation is about, for its history events; null for several, all, or the panel. */
function eventServerId(targets) {
  return targets.kind === 'servers' && targets.serverIds.length === 1 ? targets.serverIds[0] : null;
}

function engine() {
  return require('./engine');
}

/**
 * @param {unknown} def
 * @param {{ actor?: string }} [opts]
 */
function createAutomation(def, { actor = 'system' } = {}) {
  const value = validateAutomation(def);
  const id = `aut_${nanoid(8)}`;
  db.run(
    `INSERT INTO automations (id, name, enabled, targets_json, trigger_json, steps_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    value.name,
    value.enabled ? 1 : 0,
    JSON.stringify(value.targets),
    JSON.stringify(value.trigger),
    JSON.stringify(value.steps),
    actor
  );
  engine().arm(id);
  recordEvent({
    serverId: eventServerId(value.targets),
    actor,
    type: 'automation-created',
    summary: `Automation created: ${value.name}.`,
  });
  return listAutomations().find((a) => a.id === id);
}

/**
 * @param {string} id
 * @param {unknown} def
 * @param {{ actor?: string }} [opts]
 */
function updateAutomation(id, def, { actor = 'system' } = {}) {
  if (!getAutomation(id)) throw httpError(404, 'That automation no longer exists.');
  const value = validateAutomation(def);
  db.run(
    `UPDATE automations SET name = ?, enabled = ?, targets_json = ?, trigger_json = ?, steps_json = ?,
       updated_at = datetime('now') WHERE id = ?`,
    value.name,
    value.enabled ? 1 : 0,
    JSON.stringify(value.targets),
    JSON.stringify(value.trigger),
    JSON.stringify(value.steps),
    id
  );
  engine().arm(id);
  recordEvent({
    serverId: eventServerId(value.targets),
    actor,
    type: 'automation-updated',
    summary: `Automation updated: ${value.name}.`,
  });
  return listAutomations().find((a) => a.id === id);
}

/**
 * @param {string} id
 * @param {boolean} enabled
 * @param {{ actor?: string }} [opts]
 */
function setEnabled(id, enabled, { actor = 'system' } = {}) {
  const existing = getAutomation(id);
  if (!existing) return;
  db.run("UPDATE automations SET enabled = ?, updated_at = datetime('now') WHERE id = ?", enabled ? 1 : 0, id);
  engine().arm(id);
  recordEvent({
    serverId: eventServerId(existing.targets),
    actor,
    type: 'automation-toggled',
    summary: `Automation ${enabled ? 'enabled' : 'disabled'}: ${existing.name}.`,
  });
}

/**
 * @param {string} id
 * @param {{ actor?: string }} [opts]
 */
function deleteAutomation(id, { actor = 'system' } = {}) {
  const existing = getAutomation(id);
  engine().disarm(id);
  db.run('DELETE FROM automations WHERE id = ?', id);
  if (existing) {
    recordEvent({
      serverId: eventServerId(existing.targets),
      actor,
      type: 'automation-deleted',
      summary: `Automation deleted: ${existing.name}.`,
    });
  }
}

/** Display names for a set of server ids. */
function serverNames(ids) {
  const names = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const r of db.all(`SELECT id, display_name FROM servers WHERE id IN (${ph})`, ...ids)) {
      names.set(r.id, r.display_name);
    }
  }
  return names;
}

/** last_run_at is SQLite datetime('now'): UTC without a zone marker. */
function sqlTimeMs(value) {
  const ms = value ? Date.parse(String(value).replace(' ', 'T') + 'Z') : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Automations with display fields: server names, next anchor, last run. */
function listAutomations() {
  const { nextFire } = engine();
  const all = allAutomations();
  const ids = [...new Set(all.flatMap((a) => (a.targets.kind === 'servers' ? a.targets.serverIds : [])))];
  const names = serverNames(ids);
  const now = Date.now();
  return all.map((a) => {
    let next = null;
    let nextMs = null;
    try {
      const upcoming = nextFire(a, now);
      if (upcoming) {
        next = new Date(upcoming.anchorMs).toISOString().replace('T', ' ').slice(0, 16);
        nextMs = upcoming.anchorMs;
      }
    } catch {
      /* invalid cron stays null */
    }
    // A server whose row is gone shows its id, not nothing.
    const servers = a.targets.kind === 'servers' ? a.targets.serverIds.map((id) => names.get(id) ?? id) : [];
    const target =
      a.targets.kind === 'panel' ? '- panel -' : a.targets.kind === 'all' ? 'All servers' : servers.join(', ');
    return {
      ...a,
      cron: a.trigger.cron,
      target,
      servers,
      actionLabels: a.steps.map((s) => ACTIONS[s.action]?.label || s.action),
      lastRun: a.lastRunAt,
      lastRunMs: sqlTimeMs(a.lastRunAt),
      next,
      nextMs,
    };
  });
}

/** The newest runs of an automation, one row per server sequence. */
function listRuns(id, limit = 50) {
  return db
    .all('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?', id, limit)
    .map((r) => ({
      id: r.id,
      automationId: r.automation_id,
      serverId: r.server_id,
      anchorAt: r.anchor_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      steps: JSON.parse(r.steps_json || '[]'),
    }));
}

/**
 * A deleted server leaves every automation that named it. One left with no
 * servers is deleted too, since there is nothing for it to act on.
 * @param {string} serverId
 * @param {{ actor?: string }} [opts]
 */
function removeServerFromTargets(serverId, { actor = 'system' } = {}) {
  for (const a of allAutomations()) {
    if (a.targets.kind !== 'servers' || !a.targets.serverIds.includes(serverId)) continue;
    const remaining = a.targets.serverIds.filter((id) => id !== serverId);
    try {
      if (!remaining.length) {
        deleteAutomation(a.id, { actor });
        continue;
      }
      const targets = { kind: 'servers', serverIds: remaining };
      db.run(
        "UPDATE automations SET targets_json = ?, updated_at = datetime('now') WHERE id = ?",
        JSON.stringify(targets),
        a.id
      );
      engine().arm(a.id);
      recordEvent({
        serverId: eventServerId(targets),
        actor,
        type: 'automation-updated',
        summary: `Automation updated: ${a.name} no longer includes a deleted server.`,
      });
    } catch (err) {
      logger.error('Could not update an automation while deleting its server.', {
        serverId,
        automationId: a.id,
        err: serializeError(err),
      });
    }
  }
}

/** Seed the panel housekeeping automations that do not exist yet. Silent: no history events. */
function seedPanelDefaults() {
  const have = new Set(
    allAutomations()
      .filter((a) => a.targets.kind === 'panel')
      .flatMap((a) => a.steps.map((s) => s.action))
  );
  for (const d of PANEL_DEFAULTS) {
    if (have.has(d.action)) continue;
    db.run(
      `INSERT INTO automations (id, name, enabled, targets_json, trigger_json, steps_json, created_by)
       VALUES (?, ?, 1, ?, ?, ?, 'system')`,
      `aut_${nanoid(8)}`,
      d.name,
      JSON.stringify({ kind: 'panel' }),
      JSON.stringify({ type: 'schedule', cron: d.cron }),
      JSON.stringify([{ offsetSec: 0, action: d.action, params: {}, onFailure: 'stop' }])
    );
  }
}

module.exports = {
  createAutomation,
  updateAutomation,
  setEnabled,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listRuns,
  removeServerFromTargets,
  seedPanelDefaults,
  allAutomations,
};
