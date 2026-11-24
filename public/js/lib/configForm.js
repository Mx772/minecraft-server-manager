// Turns a mod config file into editable form fields and back. Pure (no DOM), so
// the Mod Configs page and the unit tests share it. Line-based formats keep every
// line the form does not touch byte for byte; JSON is re-serialized.

const NO_FIELDS = null;

/**
 * @typedef {object} Field
 * @property {any} value              What the control shows.
 * @property {'boolean'|'number'|'string'|'raw'} type
 * @property {string} key             Label for the control.
 * @property {string} group           Group heading.
 * @property {string} description
 * @property {string[]} [options]     Allowed values, shown as a select.
 * @property {number} [index]         Line number (line-based formats).
 * @property {string} [prefix]        Text before the value on that line.
 * @property {string} [suffix]        Text after the value on that line.
 * @property {boolean} [quoted]       SNBT string: the value is escaped on save.
 * @property {(string|number)[]} [path]  Key path (JSON).
 */

/** @param {any} value */
const typeOf = (value) => (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string');

/**
 * @param {string} content
 * @param {string} extension  Lowercase, with the dot.
 * @param {Record<string, string>} [descriptions]
 */
export function parseConfig(content, extension, descriptions = {}) {
  if (['.json', '.jsonc'].includes(extension)) return parseJson(content, descriptions);
  if (extension === '.snbt') return parseSnbt(content, descriptions);
  if (['.toml', '.ini', '.cfg', '.conf', '.properties'].includes(extension)) return parseLines(content, descriptions);
  return NO_FIELDS;
}

function parseJson(content, descriptions) {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object') return NO_FIELDS;
    /** @type {Field[]} */
    const fields = [];
    flatten(value, [], fields, descriptions);
    return { kind: 'json', value, fields };
  } catch {
    return NO_FIELDS;
  }
}

function flatten(value, path, fields, descriptions) {
  if (Array.isArray(value)) return;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flatten(child, [...path, key], fields, descriptions);
    return;
  }
  const dottedPath = path.join('.');
  fields.push({
    path,
    value,
    type: typeOf(value),
    key: String(path.at(-1)),
    group: path.length > 1 ? path.slice(0, -1).join(' › ') : 'General',
    description: descriptions[dottedPath] || descriptions[path.at(-1)] || '',
  });
}

function parseLines(content, descriptions) {
  const lines = content.split(/\r?\n/);
  /** @type {Field[]} */
  const fields = [];
  let section = '';
  let comments = [];
  lines.forEach((line, index) => {
    const sectionMatch = /^\s*\[([^\]]+)\]/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      comments = [];
      return;
    }
    const comment = /^\s*[#;]\s?(.*)$/.exec(line);
    if (comment) {
      comments.push(comment[1].trim());
      return;
    }
    if (!line.trim()) {
      comments = [];
      return;
    }
    const match = /^(\s*(?:[^#;\s][^=:#]*?)\s*[=:]\s*)(.*?)(\s*(?:#|;).*)?$/.exec(line);
    if (match) {
      const rawValue = match[2];
      const value = /^(true|false)$/i.test(rawValue)
        ? rawValue.toLowerCase() === 'true'
        : /^[-+]?\d+(?:\.\d+)?$/.test(rawValue)
          ? Number(rawValue)
          : rawValue;
      const rawKey = match[1].trim().replace(/[=:]\s*$/, '');
      const parts = rawKey.split('.');
      const inlineDescription = (match[3] || '').replace(/^\s*[#;]\s?/, '').trim();
      fields.push({
        index,
        prefix: match[1],
        value,
        type: typeOf(value),
        suffix: match[3] || '',
        group: section || (parts.length > 1 ? parts.slice(0, -1).join('.') : 'General'),
        key: parts.at(-1),
        description:
          descriptions[rawKey] || descriptions[rawKey.toLowerCase()] || comments.join(' ') || inlineDescription,
      });
    }
    comments = [];
  });
  return fields.length ? { kind: 'lines', lines, fields } : NO_FIELDS;
}

// ---- SNBT (FTB-style configs: `key: value` lines, `name: { … }` compounds, # comments) ----

const SNBT_KEY = String.raw`(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.+-]+)`;
const SNBT_OPEN = new RegExp(String.raw`^(?:(${SNBT_KEY})\s*:\s*)?\{\s*$`);
const SNBT_ENTRY = new RegExp(String.raw`^(\s*(${SNBT_KEY})\s*:\s*)(.*?)(\s*,?\s*)$`);
const SNBT_NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([bBsSlLfFdD]?)$/;
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

const unquoteKey = (key) => (key.startsWith('"') ? key.slice(1, -1).replace(/\\(.)/g, '$1') : key);

/** Net `{`/`[` depth change across a line, ignoring brackets inside quoted strings. */
function depthDelta(text) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') break;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth;
}

/** The quoted choices of a "Valid values: "a", "b"" comment line, or null. */
function validValues(comments) {
  const line = comments.find((c) => /^valid values\s*:/i.test(c));
  if (!line) return null;
  const options = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return options.length ? options : null;
}

function parseSnbt(content, descriptions) {
  const lines = content.split(/\r?\n/);
  /** @type {Field[]} */
  const fields = [];
  /** @type {(string|null)[]} */
  const stack = [];
  let comments = [];
  let skipDepth = 0; // inside a multi-line list or nested value the form leaves alone
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (skipDepth > 0) {
      skipDepth += depthDelta(trimmed);
      comments = [];
      return;
    }
    if (!trimmed) {
      comments = [];
      return;
    }
    const comment = /^#\s?(.*)$/.exec(trimmed);
    if (comment) {
      comments.push(comment[1].trim());
      return;
    }
    const open = SNBT_OPEN.exec(trimmed);
    if (open) {
      stack.push(open[1] ? unquoteKey(open[1]) : null);
      comments = [];
      return;
    }
    if (/^\}\s*,?$/.test(trimmed)) {
      stack.pop();
      comments = [];
      return;
    }
    const match = SNBT_ENTRY.exec(line);
    if (!match) {
      comments = [];
      return;
    }
    const [, prefix, rawKey, rawValue, tail] = match;
    const delta = depthDelta(rawValue);
    if (delta !== 0) {
      // A value that opens a list or compound and closes it on a later line.
      skipDepth = delta > 0 ? delta : 0;
      comments = [];
      return;
    }
    const key = unquoteKey(rawKey);
    const parents = stack.filter((s) => s !== null);
    const dotted = [...parents, key].join('.');
    const options = validValues(comments);
    const description =
      descriptions[dotted] ||
      descriptions[key] ||
      comments.filter((c) => !(options && /^valid values\s*:/i.test(c))).join('\n');
    /** @type {Field} */
    const field = {
      index,
      key,
      group: parents.join(' › ') || 'General',
      description,
      prefix,
      suffix: tail,
      value: '',
      type: 'raw',
    };
    const str = /^"((?:[^"\\]|\\.)*)"$/.exec(rawValue);
    const num = SNBT_NUMBER.exec(rawValue);
    if (str) {
      Object.assign(field, {
        value: str[1].replace(/\\(.)/g, '$1'),
        type: 'string',
        quoted: true,
        prefix: `${prefix}"`,
        suffix: `"${tail}`,
      });
    } else if (/^(true|false)$/.test(rawValue)) {
      Object.assign(field, { value: rawValue === 'true', type: 'boolean' });
    } else if (num) {
      // Keep the number's own text ("0.0" stays "0.0") and its type letter.
      Object.assign(field, { value: num[1], type: 'number', suffix: `${num[2]}${tail}` });
    } else {
      field.value = rawValue;
    }
    if (options && field.type === 'string') field.options = options;
    fields.push(field);
    comments = [];
  });
  return fields.length ? { kind: 'lines', lines, fields } : NO_FIELDS;
}

/**
 * Write the form's values back into the file text.
 * @param {{ kind: string, lines?: string[], value?: any, fields: Field[] }} parsed
 * @param {(string|boolean)[]} values  One per field, in field order: a boolean for a checkbox, else the input text.
 */
export function serialize(parsed, values) {
  if (parsed.kind === 'json') {
    const result = structuredClone(parsed.value);
    parsed.fields.forEach((field, i) => {
      let value = values[i];
      if (field.type === 'number') value = Number(value);
      else if (field.type === 'boolean') value = value === true || value === 'true';
      let target = result;
      for (const key of field.path.slice(0, -1)) target = target[key];
      target[field.path.at(-1)] = value;
    });
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const lines = [...parsed.lines];
  parsed.fields.forEach((field, i) => {
    let text = String(values[i]);
    // A cleared or garbled number keeps the file's value rather than writing a broken line.
    if (field.type === 'number') text = PLAIN_NUMBER.test(text.trim()) ? text.trim() : String(field.value);
    if (field.quoted) text = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines[field.index] = `${field.prefix}${text}${field.suffix}`;
  });
  return lines.join('\n');
}
