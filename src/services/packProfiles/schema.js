'use strict';

// Zod schema for pack profile files. Profiles arrive from community PRs, so the
// schema is the trust boundary: strict objects, config-only file paths, no
// scripts or code, scalar-only values. Keep pack-profiles/schema.json in sync
// with `node scripts/pack-profiles-schema.js` (a test asserts they agree).

const { z } = require('zod');
const { detectFormat } = require('../configPatch');
const { isValidRange } = require('./version');
const { ALLOWED_SETTING_KEYS, settingProblem } = require('./settings');
const { contentProblem } = require('./fileContent');

const PLATFORMS = ['curseforge', 'modrinth', 'ftb', 'gtnh'];
const ROOTS = ['config', 'defaultconfigs', 'world/serverconfig'];
const BANNED_SEGMENTS = new Set(['kubejs', 'scripts']);
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Why a profile file path is not allowed, or null when it is fine. */
function filePathProblem(file) {
  if (file.includes('\0') || file.includes('\\') || file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
    return 'must be a relative path with forward slashes';
  }
  const segments = file.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'must not contain empty, "." or ".." segments';
  if (segments.some((s) => BANNED_SEGMENTS.has(s.toLowerCase()))) return 'must not point at scripts or code';
  if (!ROOTS.some((r) => file.startsWith(`${r}/`))) {
    return 'must be under config/, defaultconfigs/, or world/serverconfig/';
  }
  if (!detectFormat(file)) return 'must be a .toml, .json, or .properties file';
  return null;
}

// Added whole files live in the customizations folder, which cannot hold world files,
// so unlike patches they may not target world/serverconfig/.
const FILE_ROOTS = ['config', 'defaultconfigs'];

const addedFile = z
  .strictObject({
    path: z.string().min(1).max(300),
    format: z.enum(['toml', 'json', 'properties']).optional(),
    content: z.unknown(),
  })
  .superRefine((f, ctx) => {
    const problem = filePathProblem(f.path);
    if (problem) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: `File path ${problem}.` });
      return;
    }
    if (!FILE_ROOTS.some((r) => f.path.startsWith(`${r}/`))) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'Added files must be under config/ or defaultconfigs/.',
      });
      return;
    }
    if (f.format && f.format !== detectFormat(f.path)) {
      ctx.addIssue({ code: 'custom', path: ['format'], message: 'Format does not match the file extension.' });
      return;
    }
    const why = contentProblem(f);
    if (why) ctx.addIssue({ code: 'custom', path: ['content'], message: `Content ${why}.` });
  });

const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
const value = z.union([scalar, z.array(scalar).max(500)]);
const keyPath = z
  .array(z.union([z.string().min(1).max(200), z.number().int().min(0)]))
  .min(1)
  .max(20);

const op = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set'),
    path: keyPath,
    value,
    expect: value.optional(),
  }),
  z.strictObject({ op: z.literal('append'), path: keyPath, value }),
  z.strictObject({ op: z.literal('removeFrom'), path: keyPath, value }),
]);

const patch = z
  .strictObject({
    file: z.string().min(1).max(300),
    format: z.enum(['toml', 'json', 'properties']).optional(),
    ops: z.array(op).min(1).max(100),
  })
  .superRefine((p, ctx) => {
    const problem = filePathProblem(p.file);
    if (problem) {
      ctx.addIssue({ code: 'custom', path: ['file'], message: `File path ${problem}.` });
      return;
    }
    if (p.format && p.format !== detectFormat(p.file)) {
      ctx.addIssue({ code: 'custom', path: ['format'], message: 'Format does not match the file extension.' });
    }
  });

const settings = z
  .partialRecord(z.enum(ALLOWED_SETTING_KEYS), z.union([z.number().finite(), z.boolean()]))
  .superRefine((s, ctx) => {
    for (const [key, val] of Object.entries(s)) {
      const problem = settingProblem(key, val);
      if (problem) ctx.addIssue({ code: 'custom', path: [key], message: `${key} ${problem}.` });
    }
  });

const preset = z
  .strictObject({
    id: z.string().regex(ID_RE),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    why: z.string().max(500).optional(),
    default: z.boolean(),
    patches: z.array(patch).max(50).default([]),
    settings: settings.optional(),
    files: z.array(addedFile).max(10).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.patches.length === 0 && p.files.length === 0 && (!p.settings || Object.keys(p.settings).length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['patches'], message: 'A preset needs patches, settings, or files.' });
    }
    const seenPaths = new Set();
    p.files.forEach((f, i) => {
      if (seenPaths.has(f.path))
        ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'Duplicate file.' });
      seenPaths.add(f.path);
    });
  });

const profile = z
  .strictObject({
    id: z.string().max(120),
    platform: z.enum(PLATFORMS),
    slug: z.string().regex(SLUG_RE).max(100),
    projectId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(40)
      .optional(),
    name: z.string().min(1).max(120),
    versions: z
      .string()
      .max(100)
      .refine(isValidRange, { message: 'Version range must look like ">=8.0 <9".' })
      .optional(),
    notes: z.string().max(1000).optional(),
    presets: z.array(preset).min(1).max(30),
  })
  .superRefine((p, ctx) => {
    if (p.id !== `${p.platform}/${p.slug}`) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'The id must be "<platform>/<slug>".' });
    }
    const seen = new Set();
    const filePaths = new Set();
    p.presets.forEach((pr, i) => {
      pr.files.forEach((f, fi) => {
        if (filePaths.has(f.path)) {
          ctx.addIssue({ code: 'custom', path: ['presets', i, 'files', fi, 'path'], message: 'Duplicate file.' });
        }
        filePaths.add(f.path);
      });
      if (seen.has(pr.id))
        ctx.addIssue({ code: 'custom', path: ['presets', i, 'id'], message: 'Duplicate preset id.' });
      seen.add(pr.id);
    });
  });

module.exports = { profile, filePathProblem, PLATFORMS };
