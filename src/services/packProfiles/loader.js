'use strict';

// Loads pack profiles from pack-profiles/<platform>/<slug>.json. A profile that
// fails validation is skipped with one warn log (ids only) and remembered for
// listInvalid(). Loaded lazily and cached; reload() re-reads the folder.

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../logger')(path.basename(__filename));
const { profile: profileSchema, PLATFORMS } = require('./schema');

const DEFAULT_DIR = path.join(__dirname, '..', '..', '..', 'pack-profiles');
const MAX_BYTES = 512 * 1024;

let dir = DEFAULT_DIR;
/** @type {{ profiles: any[], invalid: Array<{ file: string, reason: string }> } | null} */
let cache = null;

/**
 * @param {string} root
 * @returns {{ profiles: any[], invalid: Array<{ file: string, reason: string }> }}
 */
function loadDir(root) {
  const profiles = [];
  const invalid = [];
  const seen = new Set();
  const skip = (file, reason) => {
    invalid.push({ file, reason });
    logger.warn('Skipped an invalid pack profile.', { file, reason });
  };
  for (const platform of PLATFORMS) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, platform)).filter((n) => n.endsWith('.json'));
    } catch {
      continue; // no folder for this platform
    }
    for (const name of names.sort()) {
      const rel = `${platform}/${name}`;
      let raw;
      try {
        const abs = path.join(root, platform, name);
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_BYTES) {
          skip(rel, 'not a regular file or too large');
          continue;
        }
        raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch {
        skip(rel, 'not readable JSON');
        continue;
      }
      const parsed = profileSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        skip(rel, `${issue.path.join('.') || 'profile'}: ${issue.message}`);
        continue;
      }
      const p = parsed.data;
      if (p.platform !== platform || `${p.slug}.json` !== name) {
        skip(rel, 'the file location does not match its platform and slug');
        continue;
      }
      if (seen.has(p.id)) {
        skip(rel, 'duplicate profile id');
        continue;
      }
      seen.add(p.id);
      profiles.push(p);
    }
  }
  return { profiles, invalid };
}

function registry() {
  if (!cache) cache = loadDir(dir);
  return cache;
}

/** Valid profiles, in load order. */
function listProfiles() {
  return registry().profiles;
}

/** Files skipped at load, with a one-line reason each. */
function listInvalid() {
  return registry().invalid;
}

/** Re-read the folder, optionally from a different one (tests). */
function reload(newDir) {
  if (newDir) dir = newDir;
  cache = null;
  return registry();
}

module.exports = { loadDir, listProfiles, listInvalid, reload, DEFAULT_DIR };
