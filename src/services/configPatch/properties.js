'use strict';

// Line-based .properties adapter (server.properties style). Edits only the
// value of the targeted key; comments, blank lines, separators and line
// endings are untouched. Values are written as plain strings.

const { allError, UNPARSEABLE, show } = require('./common');

/** @typedef {import('./common').PatchOp} PatchOp */
/** @typedef {import('./common').OpResult} OpResult */

const KEY_RE = /^([ \t\f]*)((?:\\.|[^\s=:\\])+)([ \t\f]*[=:][ \t\f]*|[ \t\f]+)?(.*)$/;

function unescapeKey(k) {
  return k.replace(/\\(.)/g, '$1');
}

/**
 * @param {string} text
 * @param {PatchOp[]} ops
 * @returns {import('./common').AdapterOutput}
 */
function apply(text, ops) {
  if (text.includes('\0')) return { text, results: allError(ops, UNPARSEABLE) };
  const lines = text.split(/(?<=\n)/);
  const parsed = lines.map((raw) => {
    const body = raw.replace(/\r?\n$/, '');
    const eol = raw.slice(body.length);
    if (/^[ \t\f]*([#!]|$)/.test(body)) return { raw, body, eol, key: null };
    const m = KEY_RE.exec(body);
    if (!m) return { raw, body, eol, key: null };
    return { raw, body, eol, key: unescapeKey(m[2]), lead: m[1], keyRaw: m[2], sep: m[3], val: m[4] };
  });

  /** @type {OpResult[]} */
  const results = ops.map((o) => {
    if (o.op !== 'set') return { status: 'held-unsupported', message: 'Lists are not supported in properties files.' };
    if (o.path.length !== 1 || typeof o.path[0] !== 'string') {
      return { status: 'held-unsupported', message: 'A properties path must be a single key.' };
    }
    const key = o.path[0];
    let idx = -1;
    parsed.forEach((p, i) => {
      if (p.key === key) idx = i;
    });
    if (idx < 0) return { status: 'held-missing', message: `The key ${key} was not found.` };
    const p = parsed[idx];
    if (/(^|[^\\])(\\\\)*\\$/.test(p.val)) {
      return { status: 'held-unsupported', message: `The value of ${key} spans several lines.` };
    }
    if (o.value === null || typeof o.value === 'object' || typeof o.value === 'undefined') {
      return { status: 'held-unsupported', message: 'Only plain values can be written to a properties file.' };
    }
    const target = String(o.value);
    if (/[\r\n\\]/.test(target)) {
      return {
        status: 'held-unsupported',
        message: `The new value for ${key} needs escaping, which is not supported.`,
      };
    }
    const current = p.val;
    if (current === target) return { status: 'unchanged', message: `${key} already has the wanted value.`, current };
    if (o.expect !== undefined && String(o.expect) !== current) {
      return {
        status: 'held-expect',
        message: `${key} is ${show(current)}, not the expected ${show(String(o.expect))}.`,
        current,
      };
    }
    p.val = target;
    p.body = `${p.lead}${p.keyRaw}${p.sep ?? '='}${target}`;
    p.raw = p.body + p.eol;
    return { status: 'applied', message: `Set ${key} to ${show(target)}.`, current };
  });

  return { text: parsed.map((p) => p.raw).join(''), results };
}

module.exports = { apply };
