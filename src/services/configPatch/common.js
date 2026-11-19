'use strict';

// Shared types and helpers for the config patch adapters.

/**
 * @typedef {{ op: 'set' | 'append' | 'removeFrom', path: Array<string | number>, value: any, expect?: any }} PatchOp
 * @typedef {'applied' | 'unchanged' | 'held-missing' | 'held-expect' | 'held-unsupported' | 'error'} PatchStatus
 * @typedef {{ status: PatchStatus, message: string, current?: any }} OpResult
 * @typedef {{ text: string, results: OpResult[] }} AdapterOutput
 */

/** Treat bigint as a number so TOML integers compare naturally. */
function norm(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Deep value equality: numbers numerically, strings exactly, arrays and objects structurally. */
function valuesEqual(a, b) {
  a = norm(a);
  b = norm(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a instanceof Date || b instanceof Date) return String(a) === String(b);
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k]));
  }
  return a === b;
}

/** @returns {OpResult[]} one error result per op, for a file we cannot read. */
function allError(ops, message) {
  return ops.map(() => ({ status: 'error', message }));
}

const UNPARSEABLE = 'The file could not be parsed, so nothing was changed.';

/** Format a value for a short message. */
function show(v) {
  try {
    const s = typeof v === 'bigint' ? String(v) : JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(v);
  }
}

module.exports = { norm, valuesEqual, allError, UNPARSEABLE, show };
