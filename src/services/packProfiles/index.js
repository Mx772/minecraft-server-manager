'use strict';

// Pack profiles: recommended per-pack config changes the panel applies for the
// user. The loader reads community profiles; this module matches one to a
// server's pinned pack, tracks which presets the user turned on, and applies
// the enabled presets through the config patch engine. Applying never throws
// for file content: every op ends in a status, and the last run is kept.

const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const httpError = require('../../utils/httpError');
const { recordEvent } = require('../../events');
const { dataPath, safeJoin } = require('../../storage/pathGuard');
const configPatch = require('../configPatch');
const loader = require('./loader');
const { satisfies } = require('./version');
const logger = require('../../logger')(path.basename(__filename));
const { serializeError } = require('../../utils/logSanitize');

const SKIPPED_MSG = 'You customized this file, so your version wins.';
const MISSING_MSG = "This file appears after the server's first start.";

/** @typedef {{ presetId: string, patch: number, op: number, file: string, status: string, message: string, current?: unknown }} OpEntry */

// ---- matching -------------------------------------------------------------

/**
 * Profile for a server_packs row, or null. project_ref is a slug for
 * CurseForge/Modrinth, a numeric id for FTB, and "gtnh" for GTNH; the profile's
 * slug or projectId may equal it. The pinned version name must satisfy the
 * profile's range (when it has one).
 */
function findProfile(pack) {
  if (!pack) return null;
  const ref = String(pack.project_ref || '').toLowerCase();
  if (!ref) return null;
  for (const p of loader.listProfiles()) {
    if (p.platform !== pack.platform) continue;
    if (p.slug.toLowerCase() !== ref && String(p.projectId || '').toLowerCase() !== ref) continue;
    if (!satisfies(pack.pinned_version_name, p.versions)) continue;
    return p;
  }
  return null;
}

function profileFor(serverId) {
  const pack = db.get('SELECT * FROM server_packs WHERE server_id = ?', serverId);
  return findProfile(pack);
}

// ---- preset state ---------------------------------------------------------

function choices(serverId, profileId) {
  const rows = db.all(
    'SELECT preset_id, enabled FROM server_profile_presets WHERE server_id = ? AND profile_id = ?',
    serverId,
    profileId
  );
  return new Map(rows.map((r) => [r.preset_id, r.enabled === 1]));
}

/** A preset follows the user's choice, or its own default until they make one. */
function enabledPresets(serverId, profile) {
  const chosen = choices(serverId, profile.id);
  return profile.presets.filter((pr) => (chosen.has(pr.id) ? chosen.get(pr.id) : pr.default));
}

function lastRunRow(serverId, profileId) {
  const row = db.get('SELECT * FROM server_profile_runs WHERE server_id = ?', serverId);
  return row && row.profile_id === profileId ? row : null;
}

/** @returns {OpEntry[]} */
function parseEntries(row) {
  if (!row) return [];
  try {
    const v = JSON.parse(row.results_json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The matched profile, each preset with its enabled state, and the last run's per-op results. */
function presetsFor(serverId) {
  const profile = profileFor(serverId);
  if (!profile) return { profile: null, presets: [], lastRun: null };
  const chosen = choices(serverId, profile.id);
  const row = lastRunRow(serverId, profile.id);
  const byKey = new Map(parseEntries(row).map((e) => [`${e.presetId}|${e.patch}|${e.op}`, e]));
  const presets = profile.presets.map((pr) => ({
    id: pr.id,
    title: pr.title,
    description: pr.description,
    why: pr.why || null,
    default: pr.default,
    enabled: chosen.has(pr.id) ? chosen.get(pr.id) : pr.default,
    patches: pr.patches.map((pa, pi) => ({
      file: pa.file,
      ops: pa.ops.map((o, oi) => {
        const e = byKey.get(`${pr.id}|${pi}|${oi}`);
        return {
          op: o.op,
          path: o.path,
          value: o.value,
          expect: o.expect === undefined ? null : o.expect,
          status: e ? e.status : null,
          message: e ? e.message : null,
          current: e && e.current !== undefined ? e.current : null,
        };
      }),
    })),
  }));
  return {
    profile: { id: profile.id, name: profile.name, notes: profile.notes || null },
    presets,
    lastRun: row ? { ranAt: row.ran_at, trigger: row.trigger } : null,
  };
}

/**
 * Save the user's preset choices.
 * @param {string} serverId
 * @param {Array<{ presetId: string, enabled: boolean }>} changes
 * @param {{ actor?: string }} [opts]
 */
function setPresets(serverId, changes, { actor = 'system' } = {}) {
  const profile = profileFor(serverId);
  if (!profile) throw httpError(404, 'This server has no recommended settings profile.');
  const known = new Set(profile.presets.map((p) => p.id));
  for (const c of changes) {
    if (!known.has(c.presetId)) throw httpError(400, 'One of those settings groups is not part of this profile.');
  }
  db.transaction(() => {
    for (const c of changes) {
      db.run(
        `INSERT INTO server_profile_presets (server_id, profile_id, preset_id, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT (server_id, profile_id, preset_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
        serverId,
        profile.id,
        c.presetId,
        c.enabled ? 1 : 0
      );
    }
  });
  recordEvent({
    serverId,
    actor,
    type: 'profile-presets-changed',
    summary: `Recommended settings choices changed for the ${profile.name} profile.`,
    details: { profileId: profile.id, changes },
  });
  return presetsFor(serverId);
}

// ---- apply ----------------------------------------------------------------

const isHeld = (e) => e.status.startsWith('held-') || e.status === 'error';
const plural = (n, one, many) => (n === 1 ? one : many);

/** Resolve a profile file against the server folder; `world/` is the active level. */
function resolveFile(serverId, server, file) {
  let rel = file;
  if (file.startsWith('world/')) {
    const level = require('../worlds').activeLevelName(server);
    rel = `${level}/${file.slice('world/'.length)}`;
  }
  return { rel, abs: safeJoin(dataPath('servers', serverId), rel) };
}

async function exists(abs) {
  try {
    return (await fs.promises.stat(abs)).isFile();
  } catch {
    return false;
  }
}

const chains = new Map(); // serverId -> tail of the apply queue

/** @param {string} serverId @param {() => Promise<any>} fn */
function serialized(serverId, fn) {
  const prev = chains.get(serverId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    serverId,
    next.catch(() => {})
  );
  return next;
}

async function applyNow(serverId, { trigger, actor }) {
  const profile = profileFor(serverId);
  const empty = { profile: null, applied: 0, held: 0, heldMissing: 0, changedFiles: [], results: [] };
  if (!profile) return empty;
  const server = require('../servers').getServer(serverId);
  if (!server) return empty;

  const customizations = require('../customizations');
  const skip = new Set([...(await customizations.customizedPaths(serverId)), ...customizations.ownedPaths(serverId)]);

  /** @type {OpEntry[]} */
  const entries = [];
  const changed = new Set();
  for (const preset of enabledPresets(serverId, profile)) {
    for (const [pi, patch] of preset.patches.entries()) {
      const record = (status, message, only) => {
        patch.ops.forEach((_, oi) => {
          const r = only ? only[oi] : { status, message };
          entries.push({ presetId: preset.id, patch: pi, op: oi, file: patch.file, ...r });
        });
      };
      try {
        const { rel, abs } = resolveFile(serverId, server, patch.file);
        if (skip.has(rel)) {
          record('skipped-customized', SKIPPED_MSG);
        } else if (!(await exists(abs))) {
          record('held-missing', MISSING_MSG);
        } else {
          const out = await configPatch.patchFile(abs, { format: patch.format || null, ops: patch.ops });
          record(
            null,
            null,
            // `current` (the file's value) lets the UI say what the pack now sets on a held-expect.
            out.results.map((r) => ({
              status: r.status,
              message: r.message,
              ...(r.current !== undefined ? { current: r.current } : {}),
            }))
          );
          if (out.changed) changed.add(rel);
        }
      } catch (err) {
        logger.warn('A pack profile patch failed unexpectedly.', {
          serverId,
          profileId: profile.id,
          presetId: preset.id,
          err: serializeError(err, { includeStack: false }),
        });
        record('error', 'This file could not be changed.');
      }
    }
  }

  const applied = entries.filter((e) => e.status === 'applied').length;
  const held = entries.filter(isHeld).length;
  const heldMissing = entries.filter((e) => e.status === 'held-missing').length;
  const review = entries.filter((e) => isHeld(e) && e.status !== 'held-missing').length;
  const signature = (list) =>
    list
      .filter(isHeld)
      .map((e) => `${e.presetId}|${e.patch}|${e.op}|${e.status}`)
      .sort()
      .join('\n');
  const previous = lastRunRow(serverId, profile.id);
  const heldChanged = signature(entries) !== signature(parseEntries(previous));

  db.run(
    `INSERT INTO server_profile_runs (server_id, profile_id, ran_at, trigger, results_json)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT (server_id) DO UPDATE SET profile_id = excluded.profile_id, ran_at = excluded.ran_at,
       trigger = excluded.trigger, results_json = excluded.results_json`,
    serverId,
    profile.id,
    trigger,
    JSON.stringify(entries)
  );

  if (applied > 0 || heldChanged) {
    let summary;
    if (applied > 0) {
      summary = `Applied ${applied} recommended ${plural(applied, 'setting', 'settings')} from the ${profile.name} profile.`;
      if (review > 0) summary += ` ${review} ${plural(review, 'needs', 'need')} review.`;
    } else if (review > 0) {
      summary = `${review} recommended ${plural(review, 'setting', 'settings')} from the ${profile.name} profile ${plural(review, 'needs', 'need')} review.`;
    } else {
      summary = `${heldMissing} recommended ${plural(heldMissing, 'setting', 'settings')} from the ${profile.name} profile will be applied once ${plural(heldMissing, 'its file appears', 'their files appear')}.`;
    }
    recordEvent({
      serverId,
      actor,
      type: 'profile-applied',
      summary,
      details: { profileId: profile.id, trigger, applied, held, files: [...changed] },
    });
    logger.info('Applied a pack profile.', { serverId, profileId: profile.id, trigger, applied, held });
  }
  return { profile, applied, held, heldMissing, changedFiles: [...changed], results: entries };
}

// Per-server restart bookkeeping. A start the panel did NOT trigger for a
// profile begins a new cycle (the restart guard resets); a first-boot re-apply
// is only queued when the pre-start run held a file back for not existing yet.
const restarting = new Set();
const autoRestarted = new Set();
const awaitingFirstBoot = new Set();

/**
 * Apply the enabled presets of the server's matched profile. Never throws for
 * file content problems; unexpected errors are logged and reported as an empty
 * result.
 * @param {string} serverId
 * @param {{ trigger?: string, actor?: string }} [opts]
 */
async function apply(serverId, { trigger = 'manual', actor = 'system' } = {}) {
  if (trigger === 'pre-start' && !restarting.has(serverId)) autoRestarted.delete(serverId);
  try {
    const out = await serialized(serverId, () => applyNow(serverId, { trigger, actor }));
    if (trigger === 'pre-start') {
      if (out.heldMissing > 0) awaitingFirstBoot.add(serverId);
      else awaitingFirstBoot.delete(serverId);
    }
    return out;
  } catch (err) {
    logger.warn('Applying a pack profile failed.', {
      serverId,
      trigger,
      err: serializeError(err, { includeStack: false }),
    });
    return { profile: null, applied: 0, held: 0, heldMissing: 0, changedFiles: [], results: [] };
  }
}

/**
 * Restart a server once for changed profile files. At most one automatic
 * restart per start cycle: returns false when one already happened.
 * @param {string} serverId
 * @param {{ actor?: string, restart?: (id: string, o: { actor: string }) => Promise<any> }} [opts]
 */
async function restartOnce(serverId, { actor = 'system', restart } = {}) {
  if (autoRestarted.has(serverId)) return false;
  const doRestart = restart || require('../servers').restartServer;
  autoRestarted.add(serverId);
  restarting.add(serverId);
  try {
    await doRestart(serverId, { actor });
    return true;
  } catch (err) {
    autoRestarted.delete(serverId);
    throw err;
  } finally {
    restarting.delete(serverId);
  }
}

/**
 * The server just became healthy. If the pre-start run held files back because
 * they did not exist yet, re-apply now and restart once if anything changed.
 * Never throws.
 * @param {string} serverId
 * @param {{ actor?: string, restart?: (id: string, o: { actor: string }) => Promise<any> }} [opts]
 */
async function onHealthy(serverId, opts = {}) {
  try {
    if (!awaitingFirstBoot.delete(serverId)) return;
    const out = await apply(serverId, { trigger: 'first-boot' });
    if (out.heldMissing > 0) awaitingFirstBoot.add(serverId);
    if (out.changedFiles.length > 0) await restartOnce(serverId, opts);
  } catch (err) {
    logger.warn('The first-boot profile apply failed.', {
      serverId,
      err: serializeError(err, { includeStack: false }),
    });
  }
}

module.exports = {
  findProfile,
  profileFor,
  presetsFor,
  setPresets,
  apply,
  restartOnce,
  onHealthy,
  listInvalid: loader.listInvalid,
  reloadProfiles: loader.reload,
  SKIPPED_MSG,
  MISSING_MSG,
};
