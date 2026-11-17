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
const { getField } = require('../../config/field-catalog');
const configPatch = require('../configPatch');
const { detectFormat } = configPatch;
const loader = require('./loader');
const { satisfies } = require('./version');
const { toEnvValue } = require('./settings');
const { serializeFile, previewOf } = require('./fileContent');
const logger = require('../../logger')(path.basename(__filename));
const { serializeError } = require('../../utils/logSanitize');

const SKIPPED_MSG = 'You customized this file, so your version wins.';
const MISSING_MSG = "This file appears after the server's first start.";
const FILE_HELD_MSG =
  "This file already has its own rules, so the profile's version wasn't added. Review it to replace it.";
const FILE_REPLACED_MSG = 'Replaced the empty default file.';
const FILE_APPLIED_MSG = 'Added. The server loads it at the next start.';
const FILE_UNCHANGED_MSG = 'The server already has this file.';
const FILE_PACK_SAME_MSG = "The pack's own file already matches, so nothing was added.";
const FILE_ERROR_MSG = 'This file could not be added.';
const SETTING_APPLIED_MSG = 'Saved. Rebuild the server to use it.';
const SETTING_UNCHANGED_MSG = 'The server already uses this value.';
const SETTING_ERROR_MSG = 'This setting could not be saved.';

/** @typedef {{ kind: string, presetId: string, key: string, value: unknown, status: string, message: string }} SettingEntry */
/** @typedef {{ kind: string, presetId: string, file: string, status: string, message: string }} FileEntry */
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

/**
 * A preset is on only when the user turned it on (an explicit enabled row).
 * `default: true` in a profile only pre-ticks it in the review prompt.
 */
function enabledPresets(serverId, profile) {
  const chosen = choices(serverId, profile.id);
  return profile.presets.filter((pr) => chosen.get(pr.id) === true);
}

function lastRunRow(serverId, profileId) {
  const row = db.get('SELECT * FROM server_profile_runs WHERE server_id = ?', serverId);
  return row && row.profile_id === profileId ? row : null;
}

/** @returns {any[]} */
function parseEntries(row) {
  if (!row) return [];
  try {
    const v = JSON.parse(row.results_json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const parseIds = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

function reviewRow(serverId, profileId) {
  return db.get('SELECT * FROM server_profile_reviews WHERE server_id = ? AND profile_id = ?', serverId, profileId);
}

/** Where the user is in the review prompt for this profile, and which presets they have not seen. */
function reviewState(serverId, profile) {
  const row = reviewRow(serverId, profile.id);
  const all = profile.presets.map((p) => p.id);
  if (!row || !row.reviewed_at) return { state: 'new', newPresetIds: all };
  const seen = new Set(parseIds(row.seen_preset_ids));
  const newPresetIds = all.filter((id) => !seen.has(id));
  return { state: newPresetIds.length > 0 ? 'new-presets' : 'reviewed', newPresetIds };
}

/** The matched profile, each preset with its enabled state, and the last run's per-op results. */
function presetsFor(serverId) {
  const profile = profileFor(serverId);
  if (!profile) return { profile: null, presets: [], lastRun: null, review: null };
  const chosen = choices(serverId, profile.id);
  const row = lastRunRow(serverId, profile.id);
  const entries = parseEntries(row);
  const byKey = new Map(entries.filter((e) => !e.kind).map((e) => [`${e.presetId}|${e.patch}|${e.op}`, e]));
  const byFile = new Map(entries.filter((e) => e.kind === 'file').map((e) => [`${e.presetId}|${e.file}`, e]));
  const bySetting = new Map(entries.filter((e) => e.kind === 'setting').map((e) => [`${e.presetId}|${e.key}`, e]));
  const review = reviewState(serverId, profile);
  const isNew = new Set(review.newPresetIds);
  const presets = profile.presets.map((pr) => ({
    id: pr.id,
    title: pr.title,
    description: pr.description,
    why: pr.why || null,
    default: pr.default,
    enabled: chosen.get(pr.id) === true,
    isNew: isNew.has(pr.id),
    settings: Object.entries(pr.settings || {}).map(([key, value]) => {
      const e = bySetting.get(`${pr.id}|${key}`);
      return {
        key,
        label: getField('env', key)?.label || key,
        value,
        status: e ? e.status : null,
        message: e ? e.message : null,
      };
    }),
    files: pr.files.map((f) => {
      const e = chosen.get(pr.id) === true ? byFile.get(`${pr.id}|${f.path}`) : null;
      const text = serializeFile(f);
      return {
        path: f.path,
        format: f.format || detectFormat(f.path),
        size: Buffer.byteLength(text, 'utf8'),
        status: e ? e.status : null,
        message: e ? e.message : null,
        preview: previewOf(text),
        hasBackup: Boolean(getBackup(serverId, f.path)),
        currentPreview: e && e.status === 'held-exists' ? e.currentPreview || null : null,
      };
    }),
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
    review,
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

/**
 * Set the enabled presets' server settings through the same service the
 * settings form saves with (updateServer), so the rebuild flag follows. One
 * save for all changes. Never throws.
 * @returns {{ entries: SettingEntry[], rebuildNeeded: boolean, changed: number }}
 */
function applySettings(serverId, profile, server, actor) {
  /** @type {SettingEntry[]} */
  const entries = [];
  const env = { ...server.env };
  const pending = [];
  for (const preset of enabledPresets(serverId, profile)) {
    for (const [key, value] of Object.entries(preset.settings || {})) {
      const field = getField('env', key);
      const next = toEnvValue(value);
      const has = Object.prototype.hasOwnProperty.call(env, key);
      const before = has
        ? String(env[key]).trim().toLowerCase()
        : field?.type === 'boolean'
          ? String(field.default === true)
          : null;
      const entry = {
        kind: 'setting',
        presetId: preset.id,
        key,
        value,
        status: 'unchanged',
        message: SETTING_UNCHANGED_MSG,
      };
      entries.push(entry);
      if (before === next) continue;
      env[key] = next;
      // Same as the settings form: turning one of a conflicting pair on turns the other off.
      const other = field?.conflictsWith;
      if (other && next === 'true' && String(env[other]).toLowerCase() === 'true') env[other] = 'false';
      entry.status = 'applied';
      entry.message = SETTING_APPLIED_MSG;
      pending.push(entry);
    }
  }
  if (pending.length === 0) return { entries, rebuildNeeded: false, changed: 0 };
  try {
    const out = require('../servers').updateServer(serverId, { env }, { actor });
    return { entries, rebuildNeeded: Boolean(out.needsRecreate), changed: pending.length };
  } catch (err) {
    logger.warn('Saving pack profile settings failed.', {
      serverId,
      profileId: profile.id,
      err: serializeError(err, { includeStack: false }),
    });
    for (const e of pending) {
      e.status = 'error';
      e.message = SETTING_ERROR_MSG;
    }
    return { entries, rebuildNeeded: false, changed: 0 };
  }
}

const FILE_BACKUP_MAX = 64 * 1024;

const ownerOf = (profile, presetId) => `${require('../customizations').PROFILE_OWNER_PREFIX}${profile.id}/${presetId}`;

/** True when a config file holds nothing a mod would miss: empty, `[]`/`{}`, or only comments. */
function isEmptyDefault(format, text) {
  if (text.trim() === '') return true;
  if (format === 'json') {
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v.length === 0 : Boolean(v) && typeof v === 'object' && Object.keys(v).length === 0;
    } catch {
      return false;
    }
  }
  const comment = format === 'properties' ? /^\s*([#!].*)?$/ : /^\s*(#.*)?$/;
  return text.split(/\r?\n/).every((line) => comment.test(line));
}

const saveBackup = (serverId, rel, buf) =>
  db.run(
    `INSERT INTO server_profile_file_backups (server_id, path, previous_content) VALUES (?, ?, ?)
     ON CONFLICT (server_id, path) DO UPDATE SET previous_content = excluded.previous_content, saved_at = datetime('now')`,
    serverId,
    rel,
    buf
  );
const getBackup = (serverId, rel) =>
  db.get('SELECT previous_content FROM server_profile_file_backups WHERE server_id = ? AND path = ?', serverId, rel);
const dropBackup = (serverId, rel) =>
  db.run('DELETE FROM server_profile_file_backups WHERE server_id = ? AND path = ?', serverId, rel);

/** Write the owned copy (restored by the start-time sync) and the live file now. @returns {Promise<boolean>} rebuild needed */
async function placeFile(serverId, rel, abs, text, owner) {
  const w = await require('../customizations').writeOwned(serverId, rel, text, owner);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, text);
  return Boolean(w.needsRebuild);
}

/**
 * Add the enabled presets' whole files. Each file is written as an owned
 * customization (so the start-time sync restores it) and to the live folder now.
 * A file the user customized is never touched. A file the pack or a mod already
 * made is replaced only when it is an empty default (its bytes are backed up);
 * real content is held for the user to review. Never throws.
 * @returns {Promise<{ entries: FileEntry[], changed: string[], rebuildNeeded: boolean }>}
 */
async function applyFiles(serverId, profile, server) {
  const customizations = require('../customizations');
  const owned = customizations.ownedPaths(serverId);
  const userCustom = new Set([...(await customizations.customizedPaths(serverId))].filter((r) => !owned.has(r)));
  /** @type {FileEntry[]} */
  const entries = [];
  const changed = [];
  let rebuildNeeded = false;
  for (const preset of enabledPresets(serverId, profile)) {
    for (const f of preset.files) {
      /** @type {any} */
      const entry = {
        kind: 'file',
        presetId: preset.id,
        file: f.path,
        status: 'unchanged',
        message: FILE_UNCHANGED_MSG,
      };
      entries.push(entry);
      try {
        const text = serializeFile(f);
        const { rel, abs } = resolveFile(serverId, server, f.path);
        const owner = ownerOf(profile, preset.id);
        const ours = await customizations.readOwned(serverId, rel, owner);
        if (userCustom.has(rel)) {
          entry.status = 'skipped-customized';
          entry.message = SKIPPED_MSG;
          continue;
        }
        const lst = await fs.promises.lstat(abs).catch(() => null);
        if (lst && !lst.isFile()) throw new Error('The path is not a regular file.');
        const liveBuf = lst ? await fs.promises.readFile(abs) : null;
        const live = liveBuf ? liveBuf.toString('utf8') : null;
        const mine = ours !== null || owned.has(rel);
        let replaced = false;
        if (!mine && live !== null) {
          if (live === text) {
            entry.message = FILE_PACK_SAME_MSG;
            continue;
          }
          if (!isEmptyDefault(f.format || detectFormat(f.path), live) || liveBuf.length > FILE_BACKUP_MAX) {
            entry.status = 'held-exists';
            entry.message = FILE_HELD_MSG;
            entry.currentPreview = previewOf(live);
            continue;
          }
          saveBackup(serverId, rel, liveBuf);
          replaced = true;
        }
        if (ours !== text || live !== text) {
          rebuildNeeded = (await placeFile(serverId, rel, abs, text, owner)) || rebuildNeeded;
          entry.status = 'applied';
          entry.message = replaced ? FILE_REPLACED_MSG : FILE_APPLIED_MSG;
          changed.push(rel);
        }
      } catch (err) {
        logger.warn('A pack profile file could not be added.', {
          serverId,
          profileId: profile.id,
          presetId: preset.id,
          err: serializeError(err, { includeStack: false }),
        });
        entry.status = 'error';
        entry.message = FILE_ERROR_MSG;
      }
    }
  }
  return { entries, changed, rebuildNeeded };
}

/**
 * Turning a preset off removes the files it added: the owned copy always; the
 * live file only while it still holds exactly what the profile wrote, and then
 * the file it replaced (if any) is put back. Never throws.
 * @returns {Promise<string[]>} server-relative paths whose live file was changed
 */
async function removeFiles(serverId, profile, presetIds) {
  const removed = [];
  try {
    const server = require('../servers').getServer(serverId);
    if (!server) return removed;
    const customizations = require('../customizations');
    for (const preset of profile.presets.filter((p) => presetIds.includes(p.id))) {
      for (const f of preset.files) {
        try {
          const { rel, abs } = resolveFile(serverId, server, f.path);
          const owner = ownerOf(profile, preset.id);
          const ours = await customizations.readOwned(serverId, rel, owner);
          if (ours === null) continue; // we never added this file
          await customizations.removeOwned(serverId, rel, owner);
          const lst = await fs.promises.lstat(abs).catch(() => null);
          const live = lst && lst.isFile() ? await fs.promises.readFile(abs, 'utf8') : null;
          if (live === ours) {
            const backup = getBackup(serverId, rel);
            if (backup) {
              await fs.promises.writeFile(abs, Buffer.from(backup.previous_content));
              dropBackup(serverId, rel);
            } else {
              await fs.promises.rm(abs, { force: true });
            }
            removed.push(rel);
          } else if (live !== null) {
            logger.debug('Left a changed profile file in place.', { serverId, presetId: preset.id });
          }
        } catch (err) {
          logger.warn('A pack profile file could not be removed.', {
            serverId,
            presetId: preset.id,
            err: serializeError(err, { includeStack: false }),
          });
        }
      }
    }
  } catch (err) {
    logger.warn('Removing pack profile files failed.', { serverId, err: serializeError(err, { includeStack: false }) });
  }
  return removed;
}

/**
 * The user chose to replace a file the pack (or a mod) already has with the
 * profile's version. The current bytes are saved first so turning the preset off
 * can put them back.
 * @param {string} serverId
 * @param {string} presetId
 * @param {string} file the profile file path
 * @param {{ actor?: string }} [opts]
 */
async function replaceFile(serverId, presetId, file, { actor = 'system' } = {}) {
  const profile = profileFor(serverId);
  if (!profile) throw httpError(404, 'This server has no recommended settings profile.');
  const preset = enabledPresets(serverId, profile).find((p) => p.id === presetId);
  const f = preset && preset.files.find((x) => x.path === file);
  if (!preset || !f) throw httpError(400, 'That file is not part of a settings group you turned on.');
  const server = require('../servers').getServer(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  const customizations = require('../customizations');
  const { rel, abs } = resolveFile(serverId, server, f.path);
  const text = serializeFile(f);
  const owner = ownerOf(profile, preset.id);
  const rebuildNeeded = await serialized(serverId, async () => {
    const owned = customizations.ownedPaths(serverId);
    const userCustom = (await customizations.customizedPaths(serverId)).has(rel) && !owned.has(rel);
    const lst = await fs.promises.lstat(abs).catch(() => null);
    const liveBuf = lst && lst.isFile() ? await fs.promises.readFile(abs) : null;
    if (userCustom || owned.has(rel) || !liveBuf || liveBuf.toString('utf8') === text) {
      throw httpError(409, 'This file is not waiting to be replaced.');
    }
    if (liveBuf.length > FILE_BACKUP_MAX) {
      throw httpError(413, 'That file is too large to save a copy of, so it was not replaced.');
    }
    saveBackup(serverId, rel, liveBuf);
    const rebuild = await placeFile(serverId, rel, abs, text, owner);
    // Keep the card's last results in step so it shows the file as added.
    const row = lastRunRow(serverId, profile.id);
    if (row) {
      const next = parseEntries(row).map((e) =>
        e.kind === 'file' && e.presetId === presetId && e.file === file
          ? { ...e, status: 'applied', message: FILE_REPLACED_MSG, currentPreview: undefined }
          : e
      );
      db.run('UPDATE server_profile_runs SET results_json = ? WHERE server_id = ?', JSON.stringify(next), serverId);
    }
    return rebuild;
  });
  recordEvent({
    serverId,
    actor,
    type: 'profile-file-replaced',
    summary: `Replaced ${file} with the ${profile.name} profile's version. The old file was saved and comes back if you turn the preset off.`,
    details: { profileId: profile.id, presetId, path: file },
  });
  return { changedFiles: [rel], rebuildNeeded, ...presetsFor(serverId) };
}

async function applyNow(serverId, { trigger, actor, withSettings }) {
  const profile = profileFor(serverId);
  const empty = {
    profile: null,
    applied: 0,
    held: 0,
    heldMissing: 0,
    changedFiles: [],
    results: [],
    fileResults: [],
    settingResults: [],
    settingsChanged: 0,
    rebuildNeeded: false,
  };
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

  // Settings live in the panel's DB (a pack update cannot overwrite them), so only a
  // user action applies them. Every other trigger keeps the last settings results.
  const previous = lastRunRow(serverId, profile.id);
  /** @type {SettingEntry[]} */
  let settingResults;
  let rebuildNeeded = false;
  let settingsChanged = 0;
  if (withSettings) {
    const out = applySettings(serverId, profile, server, actor);
    settingResults = out.entries;
    rebuildNeeded = out.rebuildNeeded;
    settingsChanged = out.changed;
  } else {
    settingResults = parseEntries(previous).filter((e) => e.kind === 'setting');
  }

  // Added files, like settings, are only written for a user action; hooks keep the last results
  // (the start-time customizations sync restores the files by itself).
  /** @type {FileEntry[]} */
  let fileResults;
  if (withSettings) {
    const out = await applyFiles(serverId, profile, server);
    fileResults = out.entries;
    rebuildNeeded = rebuildNeeded || out.rebuildNeeded;
    for (const rel of out.changed) changed.add(rel);
  } else {
    const on = new Set(enabledPresets(serverId, profile).map((p) => p.id));
    fileResults = parseEntries(previous).filter((e) => e.kind === 'file' && on.has(e.presetId));
  }

  const everything = [...entries, ...fileResults];
  const applied = everything.filter((e) => e.status === 'applied').length;
  const held = everything.filter(isHeld).length;
  const heldMissing = everything.filter((e) => e.status === 'held-missing').length;
  const review = everything.filter((e) => isHeld(e) && e.status !== 'held-missing').length;
  const signature = (list) =>
    list
      .filter(isHeld)
      .map((e) => `${e.presetId}|${e.kind === 'file' ? `file:${e.file}` : `${e.patch}|${e.op}`}|${e.status}`)
      .sort()
      .join('\n');
  const heldChanged = signature(everything) !== signature(parseEntries(previous).filter((e) => e.kind !== 'setting'));

  db.run(
    `INSERT INTO server_profile_runs (server_id, profile_id, ran_at, trigger, results_json)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT (server_id) DO UPDATE SET profile_id = excluded.profile_id, ran_at = excluded.ran_at,
       trigger = excluded.trigger, results_json = excluded.results_json`,
    serverId,
    profile.id,
    trigger,
    JSON.stringify([...entries, ...fileResults, ...settingResults])
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
  return {
    profile,
    applied,
    held,
    heldMissing,
    changedFiles: [...changed],
    results: entries,
    fileResults,
    settingResults,
    settingsChanged,
    rebuildNeeded,
  };
}

/**
 * Save preset choices, then apply what the user has on (config patches, settings,
 * and added files), so turning a preset on takes effect now. Turning one off never
 * reverts a patch or setting; it only removes the whole files the preset added.
 */
async function savePresets(serverId, changes, { actor = 'system' } = {}) {
  setPresets(serverId, changes, { actor });
  const profile = profileFor(serverId);
  const off = changes.filter((c) => !c.enabled).map((c) => c.presetId);
  const removed =
    profile && off.length > 0 ? await serialized(serverId, () => removeFiles(serverId, profile, off)) : [];
  const turnedOn = changes.some((c) => c.enabled);
  let out = turnedOn ? await apply(serverId, { trigger: 'manual', actor, withSettings: true }) : null;
  if (removed.length > 0) {
    out = out
      ? { ...out, changedFiles: [...out.changedFiles, ...removed] }
      : {
          profile,
          applied: 0,
          held: 0,
          heldMissing: 0,
          changedFiles: removed,
          results: [],
          fileResults: [],
          settingResults: [],
          settingsChanged: 0,
          rebuildNeeded: false,
        };
  }
  return { out, ...presetsFor(serverId) };
}

/**
 * Answer the review prompt: turn on exactly the presets in `enable` (others are
 * left as they are, off unless the user turned them on before), mark every
 * preset of the profile as seen, and apply the enabled presets now. An empty
 * `enable` is "Not Now": seen, nothing applied.
 */
async function review(serverId, enable, { actor = 'system' } = {}) {
  const profile = profileFor(serverId);
  if (!profile) throw httpError(404, 'This server has no recommended settings profile.');
  const known = new Set(profile.presets.map((p) => p.id));
  for (const id of enable) {
    if (!known.has(id)) throw httpError(400, 'One of those settings groups is not part of this profile.');
  }
  const all = profile.presets.map((p) => p.id);
  const row = reviewRow(serverId, profile.id);
  const notified = [...new Set([...(row ? parseIds(row.notified_preset_ids) : []), ...all])];
  db.transaction(() => {
    for (const id of new Set(enable)) {
      db.run(
        `INSERT INTO server_profile_presets (server_id, profile_id, preset_id, enabled) VALUES (?, ?, ?, 1)
         ON CONFLICT (server_id, profile_id, preset_id) DO UPDATE SET enabled = 1, updated_at = datetime('now')`,
        serverId,
        profile.id,
        id
      );
    }
    db.run(
      `INSERT INTO server_profile_reviews (server_id, profile_id, seen_preset_ids, reviewed_at, notified_preset_ids)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT (server_id, profile_id) DO UPDATE SET seen_preset_ids = excluded.seen_preset_ids,
         reviewed_at = excluded.reviewed_at, notified_preset_ids = excluded.notified_preset_ids`,
      serverId,
      profile.id,
      JSON.stringify(all),
      JSON.stringify(notified)
    );
  });
  recordEvent({
    serverId,
    actor,
    type: 'profile-presets-changed',
    summary:
      enable.length > 0
        ? `Suggested settings reviewed for the ${profile.name} profile. ${enable.length} turned on.`
        : `Suggested settings reviewed for the ${profile.name} profile. None turned on.`,
    details: { profileId: profile.id, enabled: [...new Set(enable)] },
  });
  const out = enable.length > 0 ? await apply(serverId, { trigger: 'review', actor, withSettings: true }) : null;
  return { out, ...presetsFor(serverId) };
}

/**
 * Record one history event when the matched profile has presets the user has
 * not been told about or shown. Never applies anything and never throws.
 * @returns {number} how many presets were announced
 */
function checkForSuggestions(serverId) {
  try {
    const profile = profileFor(serverId);
    if (!profile) return 0;
    const row = reviewRow(serverId, profile.id);
    const notified = row ? parseIds(row.notified_preset_ids) : [];
    const seen = row ? parseIds(row.seen_preset_ids) : [];
    const known = new Set([...notified, ...seen]);
    const fresh = profile.presets.map((p) => p.id).filter((id) => !known.has(id));
    if (fresh.length === 0) return 0;
    const first = known.size === 0;
    db.run(
      `INSERT INTO server_profile_reviews (server_id, profile_id, notified_preset_ids) VALUES (?, ?, ?)
       ON CONFLICT (server_id, profile_id) DO UPDATE SET notified_preset_ids = excluded.notified_preset_ids`,
      serverId,
      profile.id,
      JSON.stringify([...notified, ...fresh])
    );
    recordEvent({
      serverId,
      actor: 'system',
      type: 'profile-suggestions-available',
      summary: first
        ? `Suggested settings are available for ${profile.name}.`
        : `${fresh.length} new suggested ${plural(fresh.length, 'setting is', 'settings are')} available for ${profile.name}.`,
      details: { profileId: profile.id, presetIds: fresh },
    });
    return fresh.length;
  } catch (err) {
    logger.warn('Checking for suggested pack settings failed.', {
      serverId,
      err: serializeError(err, { includeStack: false }),
    });
    return 0;
  }
}

/** Run checkForSuggestions for every server once (panel boot). */
function checkAllForSuggestions() {
  try {
    for (const s of require('../servers').listServers()) checkForSuggestions(s.id);
  } catch (err) {
    logger.warn('Checking servers for suggested pack settings failed.', {
      err: serializeError(err, { includeStack: false }),
    });
  }
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
 * result. Server settings are only applied when `withSettings` is set (a user
 * action); hooks apply config patches only.
 * @param {string} serverId
 * @param {{ trigger?: string, actor?: string, withSettings?: boolean }} [opts]
 */
async function apply(serverId, { trigger = 'manual', actor = 'system', withSettings = false } = {}) {
  if (trigger === 'pre-start' && !restarting.has(serverId)) autoRestarted.delete(serverId);
  try {
    const out = await serialized(serverId, () => applyNow(serverId, { trigger, actor, withSettings }));
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
    return {
      profile: null,
      applied: 0,
      held: 0,
      heldMissing: 0,
      changedFiles: [],
      results: [],
      settingResults: [],
      fileResults: [],
      settingsChanged: 0,
      rebuildNeeded: false,
    };
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
  savePresets,
  replaceFile,
  review,
  checkForSuggestions,
  checkAllForSuggestions,
  apply,
  restartOnce,
  onHealthy,
  listInvalid: loader.listInvalid,
  reloadProfiles: loader.reload,
  SKIPPED_MSG,
  MISSING_MSG,
  FILE_HELD_MSG,
};
