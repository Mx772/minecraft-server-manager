'use strict';

// Include patterns for file steps: `*` (within one folder), `**` (across
// folders), `?` (one character) and `{a,b}` (a choice, not nested). Matching is
// done without regular expressions, so a hostile pattern cannot make the panel
// spin: every match is bounded by the pattern's length times the path's.
//
// Limits (checked when a pattern is saved): 200 characters, 8 wildcards, and 8
// alternatives from braces.

const MAX_PATTERN_LENGTH = 200;
const MAX_WILDCARDS = 8;
const MAX_ALTERNATIVES = 8;

class GlobError extends Error {}

/** `{a,b}` groups expanded into plain patterns. Throws GlobError for nesting, an open brace, or too many choices. */
function expandBraces(pattern) {
  let results = [''];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '{') {
      const close = pattern.indexOf('}', i + 1);
      const inner = close === -1 ? '' : pattern.slice(i + 1, close);
      if (close === -1 || inner.includes('{'))
        throw new GlobError('Use { } for a choice such as {js,ts}, without nesting.');
      const options = inner.split(',');
      if (results.length * options.length > MAX_ALTERNATIVES) {
        throw new GlobError(`An include pattern can have up to ${MAX_ALTERNATIVES} choices in total.`);
      }
      results = results.flatMap((r) => options.map((o) => r + o));
      i = close + 1;
    } else if (c === '}') {
      throw new GlobError('Use { } for a choice such as {js,ts}, without nesting.');
    } else {
      results = results.map((r) => r + c);
      i++;
    }
  }
  return results;
}

/** One folder or file name against a pattern of literals, `*` and `?`: two pointers, no recursion. */
function matchSegment(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** `**` as a whole segment matches any number of folders: the same two-pointer idea, one level up. */
function matchSegments(pSegs, tSegs) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < tSegs.length) {
    if (p < pSegs.length && pSegs[p] !== '**' && matchSegment(pSegs[p], tSegs[t])) {
      p++;
      t++;
    } else if (p < pSegs.length && pSegs[p] === '**') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pSegs.length && pSegs[p] === '**') p++;
  return p === pSegs.length;
}

/**
 * Check a pattern and prepare it for matching.
 * @param {string} pattern
 * @returns {{ test: (relPath: string) => boolean }}
 */
function compileGlob(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new GlobError('Add an include pattern such as "**/*.json".');
  if (pattern.length > MAX_PATTERN_LENGTH)
    throw new GlobError(`An include pattern can be up to ${MAX_PATTERN_LENGTH} characters.`);
  if (pattern.includes('\0')) throw new GlobError('An include pattern cannot contain a null character.');
  // Runs of * are one wildcard; every * and ? counts.
  const wildcards = (pattern.replace(/\*+/g, '*').match(/[*?]/g) || []).length;
  if (wildcards > MAX_WILDCARDS)
    throw new GlobError(`An include pattern can have up to ${MAX_WILDCARDS} wildcards (* and ?).`);

  const alternatives = expandBraces(pattern).map((alt) => {
    const segs = alt.split('/').map((seg) => (seg === '**' ? '**' : seg.replace(/\*+/g, '*')));
    // `a/**` means everything below a, never a itself.
    if (segs[segs.length - 1] === '**') segs.push('*');
    return segs;
  });
  return {
    test(relPath) {
      const tSegs = String(relPath).split('/');
      return alternatives.some((segs) => matchSegments(segs, tSegs));
    },
  };
}

module.exports = { compileGlob, GlobError, MAX_PATTERN_LENGTH, MAX_WILDCARDS, MAX_ALTERNATIVES };
