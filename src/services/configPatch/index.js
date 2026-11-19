'use strict';

// Format-preserving config patch engine. Pure text in, text out: applyPatch()
// never touches the disk and never throws for a bad input file (every op is
// reported as `error` instead). It only throws for programmer errors (unknown
// format or op). patchFile() is the one I/O convenience.

const fs = require('node:fs');
const path = require('node:path');
const toml = require('./toml');
const properties = require('./properties');
const json = require('./json');
const { allError } = require('./common');

/** @typedef {import('./common').PatchOp} PatchOp */
/** @typedef {import('./common').PatchStatus} PatchStatus */
/** @typedef {'toml' | 'properties' | 'json'} PatchFormat */
/** @typedef {{ index: number, status: PatchStatus, message: string, current?: any }} IndexedResult */
/** @typedef {{ text: string, changed: boolean, results: IndexedResult[] }} PatchOutcome */

const ADAPTERS = { toml, properties, json };
const OPS = new Set(['set', 'append', 'removeFrom']);

/** @returns {PatchFormat | null} */
function detectFormat(filename) {
  const ext = path.extname(String(filename)).toLowerCase();
  if (ext === '.toml') return 'toml';
  if (ext === '.properties') return 'properties';
  if (ext === '.json') return 'json';
  return null;
}

/**
 * Apply patch ops to file text.
 * @param {string} text
 * @param {PatchFormat} format
 * @param {PatchOp[]} ops
 * @returns {PatchOutcome}
 */
function applyPatch(text, format, ops) {
  const adapter = ADAPTERS[format];
  if (!adapter || !Object.hasOwn(ADAPTERS, format)) throw new TypeError(`Unknown config format: ${format}`);
  if (!Array.isArray(ops)) throw new TypeError('ops must be an array');
  for (const o of ops) {
    if (!o || !OPS.has(o.op)) throw new TypeError(`Unknown patch op: ${o && o.op}`);
    if (
      !Array.isArray(o.path) ||
      o.path.length === 0 ||
      !o.path.every((s) => typeof s === 'string' || Number.isInteger(s))
    ) {
      throw new TypeError('Patch op path must be a non-empty array of strings and integers.');
    }
  }
  const out = adapter.apply(String(text), ops);
  return {
    text: out.text,
    changed: out.text !== text,
    results: out.results.map((r, index) => ({ index, ...r })),
  };
}

/**
 * Read a file, apply the patch, and write it back atomically only if changed.
 * The caller is responsible for resolving `abs` through the path guard.
 * @param {string} abs
 * @param {{ format?: PatchFormat | null, ops: PatchOp[] }} patch
 * @returns {Promise<PatchOutcome>}
 */
async function patchFile(abs, patch) {
  const format = patch.format || detectFormat(abs);
  if (!format) throw new TypeError(`Cannot detect the config format of ${path.basename(abs)}`);
  let text;
  try {
    text = await fs.promises.readFile(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const results = allError(patch.ops, 'The file does not exist.').map((r, index) => ({
        ...r,
        index,
        status: /** @type {PatchStatus} */ ('held-missing'),
      }));
      return { text: '', changed: false, results };
    }
    throw err;
  }
  const out = applyPatch(text, format, patch.ops);
  if (out.changed) {
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    const { mode } = await fs.promises.stat(abs);
    try {
      await fs.promises.writeFile(tmp, out.text, { mode });
      await fs.promises.rename(tmp, abs);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
  }
  return out;
}

module.exports = { applyPatch, detectFormat, patchFile };
