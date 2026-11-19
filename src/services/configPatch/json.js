'use strict';

// JSON adapter. JSON has no comments to preserve, so this parses, edits and
// re-serialises, keeping the file's indentation, line endings and trailing
// newline. Key order is kept by JS objects.

const { valuesEqual, allError, UNPARSEABLE, show } = require('./common');

/** @typedef {import('./common').PatchOp} PatchOp */
/** @typedef {import('./common').OpResult} OpResult */

const BOM = String.fromCharCode(0xfeff);
const BOM_RE = new RegExp(`^${BOM}`);

/** Resolve the container that holds the last path segment. */
function parentOf(root, path) {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur !== null && typeof cur === 'object' ? cur : undefined;
}

/**
 * @param {string} text
 * @param {PatchOp[]} ops
 * @returns {import('./common').AdapterOutput}
 */
function apply(text, ops) {
  let root;
  try {
    root = JSON.parse(text.replace(BOM_RE, ''));
  } catch {
    return { text, results: allError(ops, UNPARSEABLE) };
  }
  if (root === null || typeof root !== 'object') {
    return { text, results: allError(ops, 'The file is not a JSON object or array, so nothing was changed.') };
  }
  const bom = BOM_RE.test(text) ? BOM : '';
  const crlf = text.includes('\r\n');
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m ? (m[1].startsWith('\t') ? '\t' : m[1]) : undefined;
  const trailing = /\n$/.test(text);

  let changed = false;
  /** @type {OpResult[]} */
  const results = ops.map((o) => {
    const last = o.path[o.path.length - 1];
    const parent = parentOf(root, o.path);
    if (last === '__proto__' || !parent || !Object.hasOwn(parent, last)) {
      return { status: 'held-missing', message: `The path ${o.path.join('.')} was not found.` };
    }
    const current = parent[last];
    const label = o.path.join('.');
    if (o.op === 'set') {
      if (valuesEqual(current, o.value))
        return { status: 'unchanged', message: `${label} already has the wanted value.`, current };
      if (o.expect !== undefined && !valuesEqual(current, o.expect)) {
        return {
          status: 'held-expect',
          message: `${label} is ${show(current)}, not the expected ${show(o.expect)}.`,
          current,
        };
      }
      parent[last] = o.value;
      changed = true;
      return { status: 'applied', message: `Set ${label} to ${show(o.value)}.`, current };
    }
    if (!Array.isArray(current)) return { status: 'held-unsupported', message: `${label} is not a list.`, current };
    const has = current.some((x) => valuesEqual(x, o.value));
    if (o.op === 'append') {
      if (has) return { status: 'unchanged', message: `${label} already contains the value.`, current };
      current.push(o.value);
      changed = true;
      return { status: 'applied', message: `Added ${show(o.value)} to ${label}.`, current };
    }
    if (!has) return { status: 'unchanged', message: `${label} does not contain the value.`, current };
    parent[last] = current.filter((x) => !valuesEqual(x, o.value));
    changed = true;
    return { status: 'applied', message: `Removed ${show(o.value)} from ${label}.`, current };
  });

  if (!changed) return { text, results };
  let out = JSON.stringify(root, null, indent);
  if (crlf) out = out.replace(/\n/g, '\r\n');
  if (trailing) out += crlf ? '\r\n' : '\n';
  return { text: bom + out, results };
}

module.exports = { apply };
