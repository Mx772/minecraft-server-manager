'use strict';

// Discord chat bridge: installs a chat mod (catalog: src/config/chat-bridges),
// writes its config as a panel-owned customization, and keeps the bot token in
// the panel's encrypted store. The token never reaches the config file: the file
// holds a ${CFG_DISCORD_BOT_TOKEN} placeholder that the image fills in from the
// container env (injected by services/servers.js assembleEnv) when it syncs the
// file at start. The token also never reaches logs, events or API responses.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');
const TOML = require('smol-toml');
const httpError = require('../utils/httpError');
const db = require('../db');
const config = require('../config');
const secrets = require('../services/secrets');
const servers = require('../services/servers');
// mods.js is untyped (@ts-nocheck), so its inferred option types omit `kind`.
const mods = /** @type {any} */ (require('../services/mods'));
const modrinth = require('../services/modrinthApi');
const customizations = require('../services/customizations');
const mojang = require('../services/mojang');
const { safeJoin } = require('../storage/pathGuard');
const { recordEvent } = require('../events');
const { serializeError } = require('../utils/logSanitize');
const logger = require('../logger')(path.basename(__filename));
const catalog = require('../config/chat-bridges');

const KIND = 'discord-chat-bridge';
const OWNER = 'discord-chat-bridge';
const DISCORD_API = 'https://discord.com/api/v10';
const SNOWFLAKE_RE = /^\d{17,20}$/;
const TOKEN_RE = /^[\w.-]{20,200}$/;

/** @typedef {{id: string, ok: boolean, message: string}} Check */

const capitalize = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function mustServer(serverId) {
  const server = servers.getServer(serverId);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

function row(serverId) {
  return db.get('SELECT * FROM integrations WHERE server_id = ? AND kind = ?', serverId, KIND);
}

const cfgOf = (r) => (r ? JSON.parse(r.config_json || '{}') : {});

/** Decrypted bot token (internal use only, never expose over HTTP). Null when unset or unreadable. */
function storedToken(serverId) {
  const r = row(serverId);
  if (!r || !r.config_cipher) return null;
  const plain = secrets.tryDecrypt(r.config_cipher);
  if (!plain) return null;
  try {
    return JSON.parse(plain).botToken || null;
  } catch {
    return null;
  }
}

/** The token to inject into the container env: only for an enabled bridge. */
function activeToken(serverId) {
  const r = row(serverId);
  return r && r.enabled ? storedToken(serverId) : null;
}

// ---------------------------------------------------------------------------
// Invite link

/** OAuth2 invite URL for the bot, with the permission bits the bridge needs. */
function inviteUrl(botUserId, bridge = catalog.getBridge()) {
  if (!SNOWFLAKE_RE.test(String(botUserId))) throw httpError(400, 'That bot ID is not valid.');
  let bits = 0n;
  for (const name of bridge.permissions) bits |= catalog.PERMISSION_BITS[name];
  return `https://discord.com/oauth2/authorize?client_id=${botUserId}&scope=bot%20applications.commands&permissions=${bits}`;
}

// ---------------------------------------------------------------------------
// Compatibility

/**
 * Resolve the Minecraft version a build must match. LATEST means "the newest
 * release", which is what the image installs on every start; SNAPSHOT or an
 * unreadable value cannot be matched, so the caller asks the user to pin one.
 */
async function resolveMcVersion(server) {
  const v = String(server.mc_version || '').trim();
  if (v && v !== 'LATEST' && v !== 'SNAPSHOT') return v;
  if (v === 'SNAPSHOT') return null;
  try {
    const manifest = await mojang.getVersionManifest();
    return (manifest.latest && manifest.latest.release) || null;
  } catch {
    return null;
  }
}

/** Newest release build that fits (loader, mc), or the newest build of any type. */
async function resolveBuild(serverId) {
  const server = mustServer(serverId);
  const bridge = catalog.getBridge();
  const base = { bridge: { id: bridge.id, label: bridge.label }, loader: null, mcVersion: null, version: null };
  const no = (reason, extra = {}) => ({ supported: false, ...base, ...extra, reason, raw: null });

  const loader = mods.loaderOf(server);
  if (loader === 'paper') return no("Paper servers need a plugin bridge, which isn't supported yet.");
  if (server.type === 'VANILLA') {
    return no("Vanilla servers can't run mods. Switch to Fabric, Forge, NeoForge, or Quilt to use the Discord bridge.");
  }
  if (!loader) {
    return no("This server's mod loader could not be detected, so the Discord mod can't be matched to it yet.");
  }
  if (!bridge.loaders.includes(loader)) {
    return no(`The Discord chat mod doesn't support ${capitalize(loader)} servers.`, { loader });
  }
  const mcVersion = await resolveMcVersion(server);
  if (!mcVersion) {
    return no(
      'Pin this server to a specific Minecraft version first, so the right build of the Discord mod can be chosen.',
      {
        loader,
      }
    );
  }
  const versions = await modrinth.getVersions(bridge.modrinthSlug, { loader, mcVersion });
  const best = (versions || []).find((v) => v.version_type === 'release') || (versions || [])[0];
  if (!best) {
    return no(`No build of ${bridge.label} is available for ${capitalize(loader)} on Minecraft ${mcVersion}.`, {
      loader,
      mcVersion,
    });
  }
  const file = modrinth.primaryFile(best);
  return {
    supported: true,
    ...base,
    loader,
    mcVersion,
    version: { id: best.id, number: best.version_number, filename: file ? file.filename : null },
    reason: null,
    raw: best,
  };
}

/**
 * Can this server run the bridge, and which build would be installed?
 * @returns {Promise<{supported: boolean, loader: string|null, mcVersion: string|null, version: {id: string, number: string, filename: string|null}|null, reason: string|null, bridge: {id: string, label: string}}>}
 */
async function checkCompatibility(serverId) {
  const { raw, ...out } = await resolveBuild(serverId);
  return out;
}

// ---------------------------------------------------------------------------
// Discord REST validation

/** One Discord GET. Never throws; `status` 0 means Discord could not be reached. */
async function discordGet(token, pathname) {
  try {
    const res = await fetch(`${DISCORD_API}${pathname}`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (minecraft-server-manager, 1)' },
      signal: AbortSignal.timeout(8000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  } catch (err) {
    logger.debug('A Discord API request failed.', { err: serializeError(err, { includeStack: false }) });
    return { status: 0, json: null };
  }
}

const RATE_LIMITED = 'Discord is rate-limiting these checks. Wait a minute and try again.';
const UNREACHABLE = "Couldn't reach Discord. Check the panel's internet connection and try again.";

function hasIntent(flags, key) {
  return catalog.INTENT_FLAGS[key].bits.some((bit) => Boolean(flags & bit));
}

/**
 * Check the bot token, the privileged intents, that the bot is in the Discord
 * server, and that the chat channel belongs to it. The token goes only to discord.com
 * and is never echoed in a message.
 * @param {{serverId?: string, token?: string, guildId?: string, channelId?: string}} input
 * @returns {Promise<{ok: boolean, checks: Check[], botUserId: string|null, botName: string|null, inviteUrl: string|null}>}
 */
async function validateDiscord({ serverId, token, guildId, channelId } = {}) {
  const useToken = token || (serverId ? storedToken(serverId) : null);
  if (!useToken) throw httpError(400, 'Paste the bot token first.');
  const bridge = catalog.getBridge();
  /** @type {Check[]} */
  const checks = [];
  const result = () => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checks,
    botUserId: botId,
    botName,
    inviteUrl: botId ? inviteUrl(botId, bridge) : null,
  });
  let botId = null;
  let botName = null;

  const me = await discordGet(useToken, '/users/@me');
  if (me.status === 200 && me.json && SNOWFLAKE_RE.test(String(me.json.id))) {
    botId = String(me.json.id);
    botName = String(me.json.username || '').slice(0, 80) || null;
    checks.push({
      id: 'token',
      ok: true,
      message: `The bot token works${botName ? ` (signed in as ${botName})` : ''}.`,
    });
  } else {
    const message =
      me.status === 401
        ? "That bot token isn't valid. Reset it in the Developer Portal and paste the new one."
        : me.status === 429
          ? RATE_LIMITED
          : me.status === 0
            ? UNREACHABLE
            : 'Discord rejected that bot token. Reset it in the Developer Portal and paste the new one.';
    checks.push({ id: 'token', ok: false, message });
    return result();
  }

  const app = await discordGet(useToken, '/applications/@me');
  if (app.status === 200 && app.json) {
    let flags = 0n;
    try {
      flags = BigInt(app.json.flags || 0);
    } catch {
      /* leave 0 */
    }
    const missing = bridge.intents.filter((k) => !hasIntent(flags, k)).map((k) => catalog.INTENT_FLAGS[k].label);
    checks.push({
      id: 'intents',
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? 'The required gateway intents are on.'
          : missing.length === 1
            ? `${missing[0]} intent is off. Turn it on in the Developer Portal under Bot.`
            : `These intents are off: ${missing.join(', ')}. Turn them on in the Developer Portal under Bot.`,
    });
  } else {
    checks.push({
      id: 'intents',
      ok: false,
      message:
        app.status === 429
          ? RATE_LIMITED
          : app.status === 0
            ? UNREACHABLE
            : "Couldn't check the bot's gateway intents.",
    });
  }

  let guildOk = false;
  if (guildId) {
    if (!SNOWFLAKE_RE.test(guildId)) {
      checks.push({ id: 'guild', ok: false, message: 'The Discord server ID should be 17 to 20 digits.' });
    } else {
      const g = await discordGet(useToken, `/guilds/${guildId}`);
      guildOk = g.status === 200;
      checks.push({
        id: 'guild',
        ok: guildOk,
        message: guildOk
          ? 'The bot is in that Discord server.'
          : g.status === 403 || g.status === 404
            ? "The bot isn't in that Discord server yet. Use the invite link to add it."
            : g.status === 429
              ? RATE_LIMITED
              : g.status === 0
                ? UNREACHABLE
                : "Couldn't check that Discord server.",
      });
    }
  }

  if (channelId && (!guildId || guildOk)) {
    if (!SNOWFLAKE_RE.test(channelId)) {
      checks.push({ id: 'channel', ok: false, message: 'The channel ID should be 17 to 20 digits.' });
    } else {
      const c = await discordGet(useToken, `/channels/${channelId}`);
      let ok = false;
      let message;
      if (c.status === 200 && c.json) {
        if (guildId && String(c.json.guild_id) !== guildId) {
          message = 'That channel is in a different Discord server. Check the IDs.';
        } else {
          ok = true;
          message = 'The bot can see that channel.';
        }
      } else if (c.status === 403 || c.status === 404) {
        message = "The bot can't see that channel. Check the channel ID and that the bot can view it.";
      } else if (c.status === 429) {
        message = RATE_LIMITED;
      } else if (c.status === 0) {
        message = UNREACHABLE;
      } else {
        message = "Couldn't check that channel.";
      }
      checks.push({ id: 'channel', ok, message });
    }
  }
  return result();
}

// ---------------------------------------------------------------------------
// Input

const snowflake = z.string().trim().regex(SNOWFLAKE_RE, 'Enter a Discord ID: 17 to 20 digits.');
const channelOverride = z.union([snowflake, z.literal(''), z.literal('-1')]);
const channelShape = Object.fromEntries(catalog.CHANNEL_CATEGORIES.map((k) => [k, channelOverride.optional()]));

const configureSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(TOKEN_RE, "That doesn't look like a bot token. Copy it again from the Developer Portal under Bot.")
    .optional(),
  guildId: snowflake,
  defaultChannelId: snowflake,
  serverLogsChannelId: z.union([snowflake, z.literal('')]).optional(),
  channels: z.object(channelShape).strict().optional(),
  enablePinnedStatusMessage: z.boolean().optional(),
  enableSlashCommands: z.boolean().optional(),
  enableWebhookMode: z.boolean().optional(),
  botUserId: snowflake.optional(),
  botName: z.string().trim().max(80).optional(),
});

/** Parse and validate the setup form (throws a ZodError the route turns into a 400). */
function parseInput(body) {
  return configureSchema.parse(body);
}

// ---------------------------------------------------------------------------
// Config file

/**
 * Update only the keys the form owns. `previous` is the stored config, used to
 * find the guild table to update when the Discord server ID changed.
 */
function buildToml(existingText, keys, previousGuildId) {
  /** @type {any} */
  let doc = {};
  if (existingText != null) {
    try {
      doc = TOML.parse(existingText);
    } catch {
      throw httpError(
        409,
        "The bridge's settings file couldn't be read. Fix or remove the file in the customizations folder, then try again."
      );
    }
  }
  Object.assign(doc, keys.top);
  const guilds = Array.isArray(doc.guilds) ? doc.guilds : [];
  let idx = guilds.findIndex((g) => g && g.guildId === keys.guild.guildId);
  if (idx < 0 && previousGuildId) idx = guilds.findIndex((g) => g && g.guildId === previousGuildId);
  const current = idx >= 0 ? guilds[idx] : {};
  const next = {
    ...current,
    ...keys.guild,
    channelOverrides: { ...(current.channelOverrides || {}), ...keys.channelOverrides },
  };
  if (idx >= 0) guilds[idx] = next;
  else guilds.push(next);
  doc.guilds = guilds;
  doc.webhookModeConfig = { ...(doc.webhookModeConfig || {}), ...keys.webhookMode };
  return TOML.stringify(doc);
}

function modRowByFilename(serverId, filename) {
  if (!filename) return null;
  return db.get(
    "SELECT * FROM server_content WHERE server_id = ? AND filename = ? AND managed_by = 'overlay'",
    serverId,
    filename
  );
}

function installedProject(serverId, projectId) {
  return db.get(
    `SELECT sc.id FROM server_content sc JOIN library_files lf ON lf.id = sc.library_id
     WHERE sc.server_id = ? AND lf.platform = 'modrinth' AND lf.project_id = ?`,
    serverId,
    projectId
  );
}

// ---------------------------------------------------------------------------
// Status

/** Masked, UI-safe view. Never includes the token. */
async function getStatus(serverId) {
  const server = mustServer(serverId);
  const bridge = catalog.getBridge();
  const r = row(serverId);
  const cfg = cfgOf(r);
  let compatibility;
  try {
    compatibility = await checkCompatibility(serverId);
  } catch (err) {
    logger.debug('Checking chat bridge compatibility failed.', {
      serverId,
      err: serializeError(err, { includeStack: false }),
    });
    compatibility = {
      supported: false,
      loader: null,
      mcVersion: null,
      version: null,
      reason: "Couldn't check compatibility right now. Try again in a minute.",
      bridge: { id: bridge.id, label: bridge.label },
    };
  }
  const modRow = cfg.installedFilename ? modRowByFilename(serverId, cfg.installedFilename) : null;
  return {
    configured: Boolean(r),
    enabled: Boolean(r && r.enabled),
    tokenSet: Boolean(r && r.config_cipher),
    bridge: { id: bridge.id, label: bridge.label, configPath: bridge.configPath },
    settings: r
      ? {
          guildId: cfg.guildId || '',
          defaultChannelId: cfg.defaultChannelId || '',
          serverLogsChannelId: cfg.serverLogsChannelId || '',
          channels: cfg.channels || {},
          enablePinnedStatusMessage: Boolean(cfg.enablePinnedStatusMessage),
          enableSlashCommands: Boolean(cfg.enableSlashCommands),
          enableWebhookMode: Boolean(cfg.enableWebhookMode),
        }
      : null,
    bot: cfg.botUserId ? { id: cfg.botUserId, name: cfg.botName || null } : null,
    inviteUrl: cfg.botUserId ? inviteUrl(cfg.botUserId, bridge) : null,
    mod:
      !r || !cfg.installedFilename
        ? { state: 'none', filename: null, version: null }
        : {
            state: modRow ? 'installed' : 'missing',
            filename: cfg.installedFilename,
            version: cfg.installedVersion || null,
          },
    requirements: {
      permissions: bridge.permissions,
      intents: bridge.intents.map((k) => catalog.INTENT_FLAGS[k].label),
    },
    needsRebuild: Boolean(server.pending_recreate),
    compatibility,
  };
}

// ---------------------------------------------------------------------------
// Configure / remove

/**
 * Install the mod (if needed), write its config as a panel-owned customization,
 * and store the token encrypted. The token reaches the container as env at the
 * next rebuild, so a changed token or a newly enabled bridge queues one.
 * @param {string} serverId
 * @param {object} input raw form body (validated here)
 * @param {{actor?: string, onStep?: (label: string) => void}} [opts]
 */
async function configure(serverId, input, { actor = 'system', onStep = () => {} } = {}) {
  const server = mustServer(serverId);
  const form = parseInput(input);
  const bridge = catalog.getBridge();
  const existing = row(serverId);
  const cfg = cfgOf(existing);
  const oldToken = storedToken(serverId);
  if (!form.token && !oldToken) throw httpError(400, 'Paste the bot token first.');

  onStep('Checking compatibility…');
  const build = await resolveBuild(serverId);
  if (!build.supported) throw httpError(400, build.reason);

  let installedFilename = cfg.installedFilename || null;
  let installedVersion = cfg.installedVersion || null;
  if (!installedFilename || !modRowByFilename(serverId, installedFilename)) {
    onStep(`Installing ${bridge.label}…`);
    const installed = await mods.installFromUrl(
      serverId,
      `https://modrinth.com/mod/${bridge.modrinthSlug}/version/${build.version.id}`,
      { actor, kind: 'mod' }
    );
    installedFilename = installed.filename;
    installedVersion = installed.version || build.version.number;

    const required = (build.raw.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id);
    if (required.length) onStep('Installing required mods…');
    for (const dep of required) {
      if (installedProject(serverId, dep.project_id)) continue;
      const ref = dep.version_id
        ? `https://modrinth.com/mod/${dep.project_id}/version/${dep.version_id}`
        : `https://modrinth.com/mod/${dep.project_id}`;
      await mods.installFromUrl(serverId, ref, { actor, kind: 'mod' });
    }
  }

  onStep('Writing the bridge settings…');
  const keys = bridge.buildKeys({
    guildId: form.guildId,
    defaultChannelId: form.defaultChannelId,
    serverLogsChannelId: form.serverLogsChannelId,
    channels: form.channels,
    enablePinnedStatusMessage: form.enablePinnedStatusMessage,
    enableSlashCommands: form.enableSlashCommands,
    enableWebhookMode: form.enableWebhookMode,
  });
  const existingToml = await customizations.readOwned(serverId, bridge.configPath, OWNER);
  const toml = buildToml(existingToml, keys, cfg.guildId);
  const written = await customizations.writeOwned(serverId, bridge.configPath, toml, OWNER);

  onStep('Saving the bot settings…');
  const tokenChanged = Boolean(form.token) && form.token !== oldToken;
  const justEnabled = !existing || !existing.enabled;
  const cipher = form.token ? secrets.encrypt(JSON.stringify({ botToken: form.token })) : existing.config_cipher;
  const nextCfg = {
    bridgeId: bridge.id,
    guildId: form.guildId,
    defaultChannelId: form.defaultChannelId,
    serverLogsChannelId: form.serverLogsChannelId || '',
    channels: Object.fromEntries(Object.entries(form.channels || {}).filter(([, v]) => v)),
    enablePinnedStatusMessage: Boolean(form.enablePinnedStatusMessage),
    enableSlashCommands: Boolean(form.enableSlashCommands),
    enableWebhookMode: Boolean(form.enableWebhookMode),
    botUserId: form.botUserId || cfg.botUserId || null,
    botName: form.botName || cfg.botName || null,
    installedFilename,
    installedVersion,
  };
  db.run(
    `INSERT INTO integrations (server_id, kind, enabled, config_cipher, config_json, updated_at)
     VALUES (?, ?, 1, ?, ?, datetime('now'))
     ON CONFLICT(server_id, kind) DO UPDATE SET
       enabled = 1, config_cipher = excluded.config_cipher,
       config_json = excluded.config_json, updated_at = excluded.updated_at`,
    serverId,
    KIND,
    cipher,
    JSON.stringify(nextCfg)
  );
  const needsRebuild = tokenChanged || justEnabled || written.needsRebuild;
  if (needsRebuild) db.run('UPDATE servers SET pending_recreate = 1 WHERE id = ?', server.id);

  recordEvent({
    serverId,
    actor,
    type: 'chat-bridge-configured',
    summary: needsRebuild
      ? 'Discord chat bridge configured. Rebuild the server to connect the bot.'
      : 'Discord chat bridge settings updated.',
    details: { mod: installedFilename, version: installedVersion, needsRebuild },
  });
  logger.info('Configured the Discord chat bridge.', { serverId, actor, needsRebuild });
  return { needsRebuild, status: await getStatus(serverId) };
}

/**
 * Remove the mod, both copies of its config (the live one holds the token) and the
 * integration. The mod's dependencies are left installed: they may be shared with
 * other mods, and removing one of those would break them.
 */
async function remove(serverId, { actor = 'system' } = {}) {
  mustServer(serverId);
  const bridge = catalog.getBridge();
  const r = row(serverId);
  const cfg = cfgOf(r);
  if (cfg.installedFilename && modRowByFilename(serverId, cfg.installedFilename)) {
    await mods.removeContent(serverId, cfg.installedFilename, { actor });
  }
  await customizations.removeOwned(serverId, bridge.configPath, OWNER);
  const live = safeJoin(config.dataDir, 'servers', serverId, bridge.configPath);
  await fsp.rm(live, { force: true });
  db.run('DELETE FROM integrations WHERE server_id = ? AND kind = ?', serverId, KIND);
  db.run('UPDATE servers SET pending_recreate = 1 WHERE id = ?', serverId);
  recordEvent({
    serverId,
    actor,
    type: 'chat-bridge-removed',
    summary: 'Discord chat bridge removed. Rebuild the server to finish.',
  });
  logger.info('Removed the Discord chat bridge.', { serverId, actor });
  return { needsRebuild: true };
}

module.exports = {
  KIND,
  OWNER,
  parseInput,
  getStatus,
  checkCompatibility,
  validateDiscord,
  inviteUrl,
  configure,
  remove,
  storedToken,
  activeToken,
  TOKEN_ENV: catalog.TOKEN_ENV,
};
