'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('../db');
const { dataPath, safeJoin } = require('../storage/pathGuard');
const httpError = require('../utils/httpError');
const jarMeta = require('./jarMeta');
const mods = require('./mods');

const logger = require('../logger')(path.basename(__filename));

const CONFIG_EXTENSIONS = new Set([
  '.cfg',
  '.conf',
  '.ini',
  '.json',
  '.json5',
  '.jsonc',
  '.properties',
  '.toml',
  '.xml',
  '.yaml',
  '.yml',
  '.snbt',
]);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_FILES = 1500;
const MAX_SCAN_DEPTH = 12;
const STAT_CONCURRENCY = 8;
const JAR_FOLDERS = ['mods', 'plugins'];

function mustServer(serverId) {
  const server = require('./servers').getServer(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

/** The per-world config folder (`<level>/serverconfig`), which a pack update never overwrites. */
function worldConfigRoot(server) {
  const level = String(server.env?.LEVEL || 'world');
  const safeLevel = /^[A-Za-z0-9 _.-]{1,64}$/.test(level) ? level : 'world';
  return `${safeLevel}/serverconfig`;
}

function configRoots(serverId) {
  return ['config', 'defaultconfigs', worldConfigRoot(mustServer(serverId))];
}

/**
 * How a config file relates to customizations, for the editor:
 * customized: it has a copy that is put back on every start.
 * managed: a panel feature owns it (Recommended Setup, the Discord bridge).
 * world: it lives in the world's serverconfig folder, which pack updates leave alone.
 * available: a modpack server's file that a pack update could overwrite.
 * none: not a modpack server, so nothing overwrites it.
 * @param {string} serverId @param {string[]} paths
 * @returns {Promise<Map<string, 'customized'|'managed'|'world'|'available'|'none'>>}
 */
async function customizationStates(serverId, paths) {
  // Mid-function require (cycle-breaker): customizations -> files -> servers.
  const customizations = require('./customizations');
  const server = mustServer(serverId);
  const worldRoot = `${worldConfigRoot(server)}/`;
  const customized = await customizations.customizedPaths(serverId).catch(() => new Set());
  const owned = customizations.ownedOrProtectedPaths(serverId);
  const packServer = Boolean(db.get('SELECT 1 AS x FROM server_packs WHERE server_id = ?', serverId));
  const states = new Map();
  for (const rel of paths) {
    if (owned.has(rel)) states.set(rel, 'managed');
    else if (customized.has(rel)) states.set(rel, 'customized');
    else if (rel.startsWith(worldRoot)) states.set(rel, 'world');
    else states.set(rel, packServer ? 'available' : 'none');
  }
  return states;
}

/** Normalized, space-separated lowercase words (letters and digits only). */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** @param {(string | null | undefined)[]} names */
function modTokens(names) {
  const tokens = new Set();
  for (const name of names) {
    const normalized = normalize(name);
    if (normalized.length >= 3) tokens.add(normalized);
  }
  return [...tokens];
}

/**
 * Index mods by the first word of each token so a file only tests the mods
 * whose first word it actually contains.
 * @param {{ tokens: string[] }[]} mods
 * @returns {Map<string, { index: number, token: string }[]>}
 */
function buildTokenIndex(mods) {
  const byFirstWord = new Map();
  mods.forEach((mod, index) => {
    for (const token of mod.tokens) {
      const first = token.split(' ')[0];
      if (!byFirstWord.has(first)) byFirstWord.set(first, []);
      byFirstWord.get(first).push({ index, token });
    }
  });
  return byFirstWord;
}

/**
 * Index of the single mod whose token appears as whole word(s) in the file
 * path, or -1 when none or more than one match.
 * @param {string} filePath
 * @param {Map<string, { index: number, token: string }[]>} tokenIndex
 */
function singleMatch(filePath, tokenIndex) {
  const words = normalize(filePath).split(' ');
  const padded = ` ${words.join(' ')} `;
  let match = -1;
  for (const word of new Set(words)) {
    for (const { index, token } of tokenIndex.get(word) || []) {
      if (index === match || !padded.includes(` ${token} `)) continue;
      if (match >= 0) return -1;
      match = index;
    }
  }
  return match;
}

async function detectMods(serverId) {
  const entries = await mods.listContent(serverId);
  const modEntries = entries.filter((item) => item.kind === 'mod');
  const refs = [];
  for (const entry of modEntries) {
    if (!entry.enabled || !entry.file.toLowerCase().endsWith('.jar')) continue;
    for (const folder of JAR_FOLDERS) refs.push({ folder, file: entry.file });
  }
  const infos = await jarMeta.getMany(serverId, refs);
  const detected = modEntries.map((entry) => {
    let info = null;
    if (entry.enabled) {
      for (const folder of JAR_FOLDERS) {
        const candidate = infos.get(`${folder}/${entry.file}`);
        if (candidate?.meta) {
          info = candidate;
          break;
        }
      }
    }
    const metadata = info?.meta;
    return {
      id: metadata?.modId || entry.file,
      name: metadata?.name || entry.name,
      version: entry.version,
      tokens: modTokens([
        metadata?.modId,
        metadata?.name,
        entry.name,
        path.basename(entry.file, path.extname(entry.file)),
      ]),
      descriptions: info?.descriptions || {},
    };
  });
  return { detected, jars: infos.size };
}

async function scanConfigs(serverId) {
  const roots = configRoots(serverId);
  const serverRoot = dataPath('servers', serverId);
  const candidates = [];
  async function walk(rel, depth) {
    if (depth > MAX_SCAN_DEPTH || candidates.length >= MAX_CONFIG_FILES) return;
    const abs = dataPath('servers', serverId, rel);
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      const childAbs = safeJoin(serverRoot, child);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        candidates.push({ path: child, abs: childAbs });
        if (candidates.length >= MAX_CONFIG_FILES) break;
      }
    }
  }
  for (const root of roots) await walk(root, 0);

  const found = [];
  let next = 0;
  async function statNext() {
    while (next < candidates.length) {
      const { path: filePath, abs } = candidates[next++];
      const stat = await fsp.stat(abs).catch(() => null);
      if (stat && stat.size <= MAX_CONFIG_BYTES) found.push({ path: filePath, size: stat.size });
    }
  }
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statNext));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function list(serverId) {
  const started = Date.now();
  const [{ detected, jars }, files] = await Promise.all([detectMods(serverId), scanConfigs(serverId)]);
  const groups = detected.map((mod) => ({
    id: mod.id,
    name: mod.name,
    version: mod.version,
    files: [],
    descriptions: mod.descriptions,
  }));
  const tokenIndex = buildTokenIndex(detected);
  const states = await customizationStates(
    serverId,
    files.map((file) => file.path)
  );
  const unassigned = [];
  for (const file of files) {
    file.customized = states.get(file.path) === 'customized';
    const match = singleMatch(file.path, tokenIndex);
    if (match >= 0) groups[match].files.push(file);
    else unassigned.push(file);
  }
  logger.debug('Listed mod configs.', { serverId, jars, files: files.length, ms: Date.now() - started });
  return { groups, unassigned };
}

/** Resolve a requested config path, or throw 404 unless it is a plain config file the scan would list. */
async function existingConfig(serverId, relPath) {
  const notFound = () => httpError(404, 'Config file not found.');
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!CONFIG_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) throw notFound();
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.'))) throw notFound();
  const root = configRoots(serverId).find((candidate) => normalized.startsWith(`${candidate}/`));
  if (!root) throw notFound();
  const depth = segments.length - root.split('/').length - 1;
  if (depth > MAX_SCAN_DEPTH) throw notFound();
  const abs = safeJoin(dataPath('servers', serverId), normalized);
  const stat = await fsp.lstat(abs).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw notFound();
  return abs;
}

/** Option descriptions for the single cached jar a config file belongs to, read from the database only. */
function descriptionsFor(serverId, filePath) {
  const cached = jarMeta.cachedForServer(serverId);
  if (!cached.some((row) => row.descriptions)) return {};
  const tokenIndex = buildTokenIndex(
    cached.map((row) => ({
      tokens: modTokens([row.meta?.modId, row.meta?.name, path.basename(row.rel, path.extname(row.rel))]),
    }))
  );
  const match = singleMatch(filePath, tokenIndex);
  return (match >= 0 && cached[match].descriptions) || {};
}

async function read(serverId, relPath) {
  const abs = await existingConfig(serverId, relPath);
  const content = await fsp.readFile(abs);
  if (content.includes(0)) throw httpError(415, 'This config is not a text file.');
  const normalized = String(relPath).replace(/\\/g, '/');
  const states = await customizationStates(serverId, [normalized]);
  return {
    path: normalized,
    content: content.toString('utf8'),
    descriptions: descriptionsFor(serverId, normalized),
    customization: states.get(normalized),
  };
}

/**
 * Save a config. With `customize`, also add the saved file to the server's customizations
 * (opt-in from the editor) so a pack update does not undo the edit. The save itself has
 * already happened when that step fails, so its error comes back as `customizeError`.
 * @param {string} serverId @param {string} relPath @param {string} content
 * @param {{actor?: string, customize?: boolean}} [options]
 */
async function write(serverId, relPath, content, { actor, customize = false } = {}) {
  await existingConfig(serverId, relPath);
  const files = require('./files');
  const normalized = String(relPath).replace(/\\/g, '/');
  const saved = await files.writeText(serverId, normalized, content, { actor });
  if (!customize) return saved;
  const state = (await customizationStates(serverId, [normalized])).get(normalized);
  // Already customized: writeText's sync updated the copy. Other states cannot be added.
  if (state !== 'available') return saved;
  const out = await require('./customizations').add(serverId, [normalized], { actor });
  if (!out.succeeded) {
    logger.debug('Adding a saved config to customizations was refused.', { serverId });
    const refused = /** @type {{ error?: string } | undefined} */ (out.results[0]);
    return { ...saved, customizeError: refused?.error || 'The file could not be added to customizations.' };
  }
  return { ...saved, customized: true, needsRebuild: out.needsRebuild };
}

module.exports = { list, read, write, CONFIG_EXTENSIONS };
