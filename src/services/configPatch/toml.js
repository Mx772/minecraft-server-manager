'use strict';

// Format-preserving TOML adapter, aimed at NeoForge/Forge/NightConfig-style
// mod configs. It scans the text to locate each key's value region and
// splices only that region, so comments, blank lines, indentation, key order,
// quoting style, line endings and trailing newline all survive byte for byte.
// smol-toml is used ONLY to validate: the original must parse, and every edit
// must parse and read back as the target, otherwise that edit is reverted.

const TOML = require('smol-toml');
const { norm, valuesEqual, allError, UNPARSEABLE, show } = require('./common');

/** @typedef {import('./common').PatchOp} PatchOp */
/** @typedef {import('./common').OpResult} OpResult */
/** @typedef {{ path: Array<string | number>, valStart: number, valEnd: number, kind: string }} Entry */

const WS = /[ \t]/;

function skipWs(t, p) {
  while (p < t.length && WS.test(t[p])) p++;
  return p;
}

function nextLine(t, p) {
  const i = t.indexOf('\n', p);
  return i < 0 ? t.length : i + 1;
}

/** End index (after the closing quote) of a single-line string at p, or -1. */
function scanString(t, p) {
  const q = t[p];
  for (let i = p + 1; i < t.length; i++) {
    const c = t[i];
    if (c === '\n') return -1;
    if (q === '"' && c === '\\') i++;
    else if (c === q) return i + 1;
  }
  return -1;
}

/** End index of a multi-line string whose opening delimiter starts at p, or -1. */
function scanMultiline(t, p) {
  const q = t[p];
  for (let i = p + 3; i < t.length; i++) {
    if (q === '"' && t[i] === '\\') i++;
    else if (t.startsWith(q.repeat(3), i)) {
      let e = i + 3;
      for (let extra = 0; extra < 2 && t[e] === q; extra++) e++;
      return e;
    }
  }
  return -1;
}

/** Scan a bracketed value ([...] or {...}) starting at p. Returns the end or -1. */
function scanBracket(t, p) {
  let depth = 0;
  for (let i = p; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'") {
      const e = t.startsWith(c.repeat(3), i) ? scanMultiline(t, i) : scanString(t, i);
      if (e < 0) return -1;
      i = e - 1;
    } else if (c === '#') {
      const nl = t.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** @returns {{ kind: string, end: number } | null} */
function scanValue(t, p) {
  const c = t[p];
  if (c === '"' || c === "'") {
    if (t.startsWith(c.repeat(3), p)) {
      const end = scanMultiline(t, p);
      return end < 0 ? null : { kind: 'mlstring', end };
    }
    const end = scanString(t, p);
    return end < 0 ? null : { kind: c === '"' ? 'string-basic' : 'string-literal', end };
  }
  if (c === '[' || c === '{') {
    const end = scanBracket(t, p);
    return end < 0 ? null : { kind: c === '[' ? 'array' : 'inline', end };
  }
  let end = p;
  while (end < t.length && !/[\s,#\]}]/.test(t[end])) end++;
  if (end === p) return null;
  const raw = t.slice(p, end);
  let kind = 'other';
  if (raw === 'true' || raw === 'false') kind = 'bool';
  else if (/^[+-]?(inf|nan)$/.test(raw)) kind = 'float';
  else if (/^[+-]?\d[\d_]*$/.test(raw) || /^0[xob][0-9a-fA-F_]+$/.test(raw)) kind = 'int';
  else if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(raw)) kind = 'float';
  return { kind, end };
}

/** Parse a possibly dotted key at p. @returns {{ parts: string[], end: number } | null} */
function parseKey(t, p) {
  const parts = [];
  let end;
  for (;;) {
    p = skipWs(t, p);
    const c = t[p];
    if (c === '"' || c === "'") {
      const e = scanString(t, p);
      if (e < 0) return null;
      const inner = t.slice(p + 1, e - 1);
      let s = inner;
      if (c === '"') {
        try {
          s = JSON.parse(t.slice(p, e));
        } catch {
          s = inner;
        }
      }
      parts.push(s);
      p = e;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(t.slice(p, p + 200));
      if (!m) return null;
      parts.push(m[0]);
      p += m[0].length;
    }
    end = p;
    p = skipWs(t, p);
    if (t[p] === '.') p++;
    else break;
  }
  return { parts, end };
}

/** Scan the document into key/value entries. @returns {Entry[] | null} */
function scan(t) {
  /** @type {Entry[]} */
  const entries = [];
  const counts = new Map();
  /** @type {Array<string | number>} */
  let table = [];
  let pos = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < t.length) {
    const p = skipWs(t, pos);
    const c = t[p];
    if (c === undefined) break;
    if (c === '\n' || c === '\r' || c === '#') {
      pos = nextLine(t, p);
      continue;
    }
    if (c === '[') {
      const isArr = t[p + 1] === '[';
      const k = parseKey(t, p + (isArr ? 2 : 1));
      if (!k) return null;
      const q = skipWs(t, k.end);
      if (t[q] !== ']' || (isArr && t[q + 1] !== ']')) return null;
      /** @type {Array<string | number>} */
      const res = [];
      k.parts.forEach((seg, i) => {
        res.push(seg);
        const key = JSON.stringify(res);
        if (i === k.parts.length - 1 && isArr) {
          const n = (counts.get(key) ?? -1) + 1;
          counts.set(key, n);
          res.push(n);
        } else if (counts.has(key)) res.push(counts.get(key));
      });
      table = res;
      pos = nextLine(t, q);
      continue;
    }
    const k = parseKey(t, p);
    if (!k) return null;
    let q = skipWs(t, k.end);
    if (t[q] !== '=') return null;
    q = skipWs(t, q + 1);
    const v = scanValue(t, q);
    if (!v) return null;
    entries.push({ path: [...table, ...k.parts], valStart: q, valEnd: v.end, kind: v.kind });
    pos = nextLine(t, v.end);
  }
  return entries;
}

const pathEq = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Look up a path in a parsed document. */
function getPath(doc, path) {
  let cur = doc;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Split a scanned array region into raw element texts, or null when unsafe to rewrite. */
function splitArray(t, start, end) {
  const elems = [];
  let p = start + 1;
  let trailingComma = false;
  for (;;) {
    while (p < end && /\s/.test(t[p])) p++;
    if (t[p] === '#') return null;
    if (p >= end - 1 && t[p] === ']') break;
    const v = scanValue(t, p);
    if (!v || v.kind === 'array' || v.kind === 'inline' || v.kind === 'mlstring' || v.kind === 'other') return null;
    elems.push({ raw: t.slice(p, v.end), start: p, end: v.end });
    p = v.end;
    while (p < end && /\s/.test(t[p])) p++;
    trailingComma = false;
    if (t[p] === ',') {
      trailingComma = true;
      p++;
    }
  }
  return { elems, trailingComma };
}

function fmtString(s, preferLiteral) {
  if (preferLiteral && !/['\x00-\x08\x0a-\x1f\x7f]/.test(s)) return `'${s}'`;
  return JSON.stringify(s).replace(/[\u007f]/g, '\\u007f');
}

/** Format a scalar for TOML, or null if it cannot be written safely. */
function fmtScalar(v, existingKind) {
  if (typeof v === 'string') return fmtString(v, existingKind === 'string-literal');
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    return existingKind === 'float' && /^-?\d+$/.test(s) ? `${s}.0` : s;
  }
  return null;
}

/** Position of the comma following an element, or -1. */
function commaAfter(t, e) {
  let p = e.end;
  while (/\s/.test(t[p])) p++;
  return t[p] === ',' ? p : -1;
}

/**
 * Edit an array with the smallest possible text change: append inserts after
 * the last element, removeFrom deletes one element and one separator. Returns
 * the full new text, or null to fall back to the full rewrite.
 */
function minimalArrayEdit(t, entry, split, o) {
  const { elems } = split;
  if (elems.length === 0) return null;
  const last = elems[elems.length - 1];
  if (o.op === 'append') {
    const raw = fmtScalar(o.value, elems[0].raw.startsWith("'") ? 'string-literal' : 'string-basic');
    if (raw === null) return null;
    const comma = commaAfter(t, last);
    const multi =
      t.slice(elems[0].start, last.start).includes('\n') || t.slice(entry.valStart, entry.valEnd).includes('\n');
    if (multi) {
      const eol = t.includes('\r\n') ? '\r\n' : '\n';
      const ls = t.lastIndexOf('\n', last.start - 1) + 1;
      const indent = /^[ \t]*/.exec(t.slice(ls))[0];
      if (comma < 0) return `${t.slice(0, last.end)},${eol}${indent}${raw}${t.slice(last.end)}`;
      return `${t.slice(0, comma + 1)}${eol}${indent}${raw},${t.slice(comma + 1)}`;
    }
    let sep = ', ';
    if (elems.length >= 2) sep = t.slice(elems[0].end, elems[1].start);
    if (comma < 0) return `${t.slice(0, last.end)}${sep}${raw}${t.slice(last.end)}`;
    return `${t.slice(0, comma + 1)}${sep.replace(/^\s*,/, '')}${raw},${t.slice(comma + 1)}`;
  }
  const vals = elems.map((e) => TOML.parse(`v = ${e.raw}`).v);
  const hits = vals.map((v, i) => (valuesEqual(v, o.value) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1 || elems.length < 2) return null;
  const i = hits[0];
  if (i < elems.length - 1) return t.slice(0, elems[i].start) + t.slice(elems[i + 1].start);
  const prevComma = commaAfter(t, elems[i - 1]);
  return prevComma < 0 ? null : t.slice(0, prevComma) + t.slice(last.end);
}

/** Build the text for a rewritten array, reusing the raw text of unchanged elements. */
function fmtArray(t, entry, values, split) {
  const old = split.elems.map((e) => ({ raw: e.raw, val: TOML.parse(`v = ${e.raw}`).v, used: false }));
  const literal = split.elems.length > 0 && split.elems[0].raw.startsWith("'");
  const items = [];
  for (const v of values) {
    const hit = old.find((o) => !o.used && valuesEqual(o.val, v));
    if (hit) {
      hit.used = true;
      items.push(hit.raw);
      continue;
    }
    const s = fmtScalar(v, literal ? 'string-literal' : 'string-basic');
    if (s === null) return null;
    items.push(s);
  }
  if (items.length === 0) return '[]';
  const region = t.slice(entry.valStart, entry.valEnd);
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  if (!region.includes('\n')) {
    const pad = /^\[([ \t]*)/.exec(region)[1];
    let sep = ', ';
    if (split.elems.length >= 2) sep = t.slice(split.elems[0].end, split.elems[1].start).replace(/\s*\n\s*/g, ' ');
    return `[${pad}${items.join(sep)}${pad}]`;
  }
  const lineStart = t.lastIndexOf('\n', entry.valStart) + 1;
  const lineIndent = /^[ \t]*/.exec(t.slice(lineStart))[0];
  let itemIndent = `${lineIndent}  `;
  if (split.elems.length) {
    const ls = t.lastIndexOf('\n', split.elems[0].start) + 1;
    const ind = t.slice(ls, split.elems[0].start);
    if (/^[ \t]*$/.test(ind)) itemIndent = ind;
  }
  const closeLs = t.lastIndexOf('\n', entry.valEnd - 1) + 1;
  const closeInd = t.slice(closeLs, entry.valEnd - 1);
  const closeIndent = /^[ \t]*$/.test(closeInd) ? closeInd : lineIndent;
  const comma = split.trailingComma ? ',' : '';
  return `[${eol}${items.map((i) => itemIndent + i).join(`,${eol}`)}${comma}${eol}${closeIndent}]`;
}

/**
 * @param {string} text
 * @param {PatchOp[]} ops
 * @returns {import('./common').AdapterOutput}
 */
function apply(text, ops) {
  const strip = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
  /** @type {any} */
  let doc;
  try {
    doc = TOML.parse(strip(text));
  } catch {
    return { text, results: allError(ops, UNPARSEABLE) };
  }
  let entries = scan(text);
  if (!entries) return { text, results: allError(ops, 'The file could not be read safely, so nothing was changed.') };

  /** @type {OpResult[]} */
  const results = [];
  for (const o of ops) {
    const label = o.path.join('.');
    const entry = entries.find((e) => pathEq(e.path, o.path));
    if (!entry) {
      const blocker = entries.find(
        (e) =>
          (e.kind === 'inline' || e.kind === 'array') &&
          e.path.length < o.path.length &&
          pathEq(e.path, o.path.slice(0, e.path.length))
      );
      results.push(
        blocker
          ? {
              status: 'held-unsupported',
              message: `${label} is inside an inline table or list, which is not supported.`,
            }
          : { status: 'held-missing', message: `The key ${label} was not found.` }
      );
      continue;
    }
    if (entry.kind === 'inline' || entry.kind === 'mlstring' || entry.kind === 'other') {
      results.push({
        status: 'held-unsupported',
        message: `${label} holds an inline table, multi-line string or date, which is not supported.`,
      });
      continue;
    }
    const current = getPath(doc, o.path);
    /** @type {any} */
    let target;
    let replacement;
    /** @type {string | null} */
    let minimal = null;
    if (o.op === 'set') {
      if (valuesEqual(current, o.value)) {
        results.push({
          status: 'unchanged',
          message: `${label} already has the wanted value.`,
          current: norm(current),
        });
        continue;
      }
      if (o.expect !== undefined && !valuesEqual(current, o.expect)) {
        results.push({
          status: 'held-expect',
          message: `${label} is ${show(current)}, not the expected ${show(o.expect)}.`,
          current: norm(current),
        });
        continue;
      }
      target = o.value;
      if (Array.isArray(target)) {
        const split = entry.kind === 'array' ? splitArray(text, entry.valStart, entry.valEnd) : null;
        replacement = split ? fmtArray(text, entry, target, split) : target.length === 0 ? '[]' : arrayFresh(target);
      } else replacement = fmtScalar(target, entry.kind);
    } else {
      if (entry.kind !== 'array' || !Array.isArray(current)) {
        results.push({ status: 'held-unsupported', message: `${label} is not a list.`, current: norm(current) });
        continue;
      }
      const has = current.some((x) => valuesEqual(x, o.value));
      if ((o.op === 'append') === has) {
        results.push({
          status: 'unchanged',
          message: has ? `${label} already contains the value.` : `${label} does not contain the value.`,
          current,
        });
        continue;
      }
      target = o.op === 'append' ? [...current, o.value] : current.filter((x) => !valuesEqual(x, o.value));
      const split = splitArray(text, entry.valStart, entry.valEnd);
      replacement = split ? fmtArray(text, entry, target, split) : null;
      if (split) minimal = minimalArrayEdit(text, entry, split, o);
    }
    if (replacement === null || replacement === undefined) {
      results.push({
        status: 'held-unsupported',
        message: `The value for ${label} cannot be written safely.`,
        current: norm(current),
      });
      continue;
    }
    const candidates = [];
    if (minimal !== null) candidates.push(minimal);
    candidates.push(text.slice(0, entry.valStart) + replacement + text.slice(entry.valEnd));
    let next = text;
    /** @type {any} */
    let nextDoc;
    /** @type {Entry[] | null} */
    let nextEntries = null;
    for (const cand of candidates) {
      try {
        nextDoc = TOML.parse(strip(cand));
        if (valuesEqual(getPath(nextDoc, o.path), target)) nextEntries = scan(cand);
      } catch {
        nextEntries = null;
      }
      if (nextEntries) {
        next = cand;
        break;
      }
    }
    if (!nextEntries) {
      results.push({
        status: 'error',
        message: `The edit to ${label} would have broken the file, so it was skipped.`,
        current: norm(current),
      });
      continue;
    }
    text = next;
    doc = nextDoc;
    entries = nextEntries;
    results.push({ status: 'applied', message: `Set ${label} to ${show(target)}.`, current: norm(current) });
  }
  return { text, results };
}

/** A single-line array for a key whose old value was not an array. */
function arrayFresh(values) {
  const parts = values.map((v) => fmtScalar(v, 'string-basic'));
  return parts.includes(null) ? null : `[${parts.join(', ')}]`;
}

module.exports = { apply };
