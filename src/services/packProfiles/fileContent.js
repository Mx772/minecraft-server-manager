'use strict';

// Whole-file content a pack profile preset may add. Profiles are community
// data, so the content is checked hard: it must parse as its format, stay small,
// and (for JSON) never contain a key some config systems read as a command.

const TOML = require('smol-toml');
const { detectFormat } = require('../configPatch');

const MAX_BYTES = 64 * 1024;
const PREVIEW_CHARS = 4096;
const MAX_DEPTH = 32;
/** JSON keys a profile file may not use at any depth: some config systems run these. */
const DENIED_JSON_KEYS = ['command', 'commands', 'cmd', 'script'];

/** First denied key found in a JSON value (or too-deep nesting), or null. */
function deniedKeyIn(value, depth = 0) {
  if (depth > MAX_DEPTH) return '(nesting too deep)';
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = deniedKeyIn(v, depth + 1);
      if (hit) return hit;
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (DENIED_JSON_KEYS.includes(k.toLowerCase())) return k;
      const hit = deniedKeyIn(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The text written to disk for a profile file: JSON is 2-space indented with a trailing newline. */
function serializeFile(file) {
  const format = file.format || detectFormat(file.path);
  return format === 'json' ? `${JSON.stringify(file.content, null, 2)}\n` : String(file.content);
}

/** Why a profile file's content is not allowed, or null when it is fine. */
function contentProblem(file) {
  const format = file.format || detectFormat(file.path);
  const c = file.content;
  if (format === 'json') {
    if (c === null || typeof c !== 'object') return 'must be a JSON array or object';
    const hit = deniedKeyIn(c);
    if (hit) return `must not use the key "${hit}"`;
  } else if (typeof c !== 'string') {
    return 'must be text';
  } else if (c.includes('\0')) {
    return 'must be plain text';
  } else if (format === 'toml') {
    try {
      TOML.parse(c);
    } catch {
      return 'is not valid TOML';
    }
  } else if (format === 'properties') {
    const bad = c.split(/\r?\n/).some((line) => !/^\s*([#!].*)?$/.test(line) && !/^\s*[^\s=:#!][^=:]*[=:]/.test(line));
    if (bad) return 'is not valid properties text (each line needs a key and "=")';
  }
  if (Buffer.byteLength(serializeFile(file), 'utf8') > MAX_BYTES) return `must be at most ${MAX_BYTES / 1024} KB`;
  return null;
}

/** The first PREVIEW_CHARS of the serialized text, for display. */
function previewOf(text) {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…` : text;
}

module.exports = { MAX_BYTES, DENIED_JSON_KEYS, serializeFile, contentProblem, previewOf };
