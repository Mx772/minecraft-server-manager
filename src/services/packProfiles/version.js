'use strict';

// Tiny comparator for dotted numeric pack versions ("8.6", "2.7.4"). Range
// terms are whitespace-separated and ANDed: ">=8.0 <9". The pinned name may carry
// extra text ("ATM10-8.6.zip"); the last dotted number is used. A name with none ("latest") never satisfies a
// range, so only profiles without a `versions` range match it.

const VERSION_RE = /^v?(\d+(?:\.\d+)*)$/;
const TERM_RE = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/;

/**
 * The version inside a pinned name: the LAST dotted-number run ("1.21.1-8.6.1"
 * gives "8.6.1", "ATM10-8.6" gives "8.6"). A lone integer ("8") counts only
 * when the whole name is that integer. Null when nothing is extractable.
 * @returns {string | null}
 */
function extractVersion(name) {
  const s = String(name == null ? '' : name).trim();
  const runs = [...s.matchAll(/\d+(?:\.\d+)+/g)];
  if (runs.length) return runs[runs.length - 1][0];
  return /^v?\d+$/.test(s) ? s.replace(/^v/, '') : null;
}

/** @returns {number[] | null} */
function parseVersion(v) {
  const m = VERSION_RE.exec(String(v == null ? '' : v).trim());
  return m ? m[1].split('.').map(Number) : null;
}

/** @param {number[]} a @param {number[]} b @returns {-1 | 0 | 1} */
function compare(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** @returns {Array<{ op: string, version: number[] }> | null} null when the range is malformed. */
function parseRange(range) {
  const terms = String(range).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const out = [];
  for (const t of terms) {
    const m = TERM_RE.exec(t);
    if (!m) return null;
    out.push({ op: m[1] || '=', version: m[2].split('.').map(Number) });
  }
  return out;
}

/** True when `range` is well formed. */
function isValidRange(range) {
  return parseRange(range) !== null;
}

/**
 * @param {string | null | undefined} version a pinned version name
 * @param {string | null | undefined} range    absent or empty means every version
 */
function satisfies(version, range) {
  if (range == null || String(range).trim() === '') return true;
  const terms = parseRange(range);
  const v = parseVersion(extractVersion(version));
  if (!terms || !v) return false;
  return terms.every(({ op, version: want }) => {
    const c = compare(v, want);
    if (op === '>=') return c >= 0;
    if (op === '>') return c > 0;
    if (op === '<=') return c <= 0;
    if (op === '<') return c < 0;
    return c === 0;
  });
}

module.exports = { extractVersion, parseVersion, parseRange, isValidRange, satisfies, compare };
