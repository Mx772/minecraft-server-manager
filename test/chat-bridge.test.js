'use strict';

// Discord chat bridge: invite math, Discord REST validation, the owned TOML
// config, token handling (encrypted, env-injected, never on disk or in events),
// customizations ownership, removal, and blueprint exclusion. No network: fetch,
// the Modrinth client, Mojang and the mod install are all mocked.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TOML = require('smol-toml');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const config = require('../src/config');
const secrets = require('../src/services/secrets');
const servers = require('../src/services/servers');
const mods = require('../src/services/mods');
const modrinth = require('../src/services/modrinthApi');
const mojang = require('../src/services/mojang');
const customizations = require('../src/services/customizations');
const bridge = require('../src/integrations/chatBridge');
const bp = require('../src/blueprints');
const { sanitizeLogMeta } = require('../src/utils/logSanitize');

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.superSecretBotTokenValue1234567890';
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const BOT = '333333333333333333';
const CFG_PATH = 'config/discord_chat_mod-common.toml';

function seed(id, { type = 'FABRIC', mc = '1.21.1' } = {}) {
  db.run(
    `INSERT OR REPLACE INTO servers (id, display_name, type, mc_version, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb, status)
     VALUES (?, 'Bridge', ?, ?, ?, ?, 'x', 1024, 1536, 'stopped')`,
    id,
    type,
    mc,
    25700 + Math.floor(Math.random() * 200),
    26700 + Math.floor(Math.random() * 200)
  );
  fs.mkdirSync(path.join(config.dataDir, 'servers', id), { recursive: true });
  return id;
}

const root = (id) => path.join(config.dataDir, 'servers', id);

function mockModrinth(t, { versions } = {}) {
  const list = versions || [
    {
      id: 'ver1',
      version_number: '1.2.3',
      version_type: 'release',
      files: [{ primary: true, filename: 'dcc-1.2.3.jar' }],
      dependencies: [{ dependency_type: 'required', project_id: 'depproj', version_id: null }],
    },
  ];
  const calls = [];
  t.mock.method(modrinth, 'getVersions', async (slug, opts) => {
    calls.push({ slug, ...opts });
    return list;
  });
  return calls;
}

/** Stub the install: records the call and inserts the overlay row the real one would. */
function mockInstall(t, serverId) {
  const calls = [];
  t.mock.method(mods, 'installFromUrl', async (sid, url, opts) => {
    calls.push({ sid, url, opts });
    const filename = calls.length === 1 ? 'dcc-1.2.3.jar' : `dep-${calls.length}.jar`;
    db.run(
      `INSERT INTO server_content (id, server_id, kind, managed_by, name, filename, version)
       VALUES (?, ?, 'mod', 'overlay', ?, ?, '1.2.3')`,
      `sc_${calls.length}_${serverId}`,
      sid,
      filename,
      filename
    );
    return { filename, version: '1.2.3', name: filename };
  });
  return calls;
}

const form = (extra = {}) => ({
  token: TOKEN,
  guildId: GUILD,
  defaultChannelId: CHANNEL,
  enableSlashCommands: true,
  channels: { deathsChannelId: '-1' },
  botUserId: BOT,
  botName: 'MyBot',
  ...extra,
});

function allFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allFiles(p, out);
    else out.push(p);
  }
  return out;
}

test('inviteUrl computes the exact permission bits', () => {
  const url = bridge.inviteUrl(BOT);
  const bits =
    (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 29n) | (1n << 38n) | (1n << 51n);
  assert.equal(bits, 2252075228580864n);
  assert.equal(
    url,
    `https://discord.com/oauth2/authorize?client_id=${BOT}&scope=bot%20applications.commands&permissions=2252075228580864`
  );
  assert.throws(() => bridge.inviteUrl('abc'), { status: 400 });
});

function mockDiscord(t, handlers) {
  const seen = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://discord.com/')) return realFetch(url, opts); // the test client itself
    seen.push({ url: u, auth: opts && opts.headers && opts.headers.Authorization });
    const key = Object.keys(handlers).find((k) => u.endsWith(k));
    const h = key ? handlers[key] : { status: 404, json: {} };
    if (h instanceof Error) throw h;
    return { status: h.status, json: async () => h.json };
  });
  return seen;
}

const goodDiscord = {
  '/users/@me': { status: 200, json: { id: BOT, username: 'MyBot' } },
  '/applications/@me': { status: 200, json: { flags: (1 << 14) | (1 << 12) | (1 << 18) } },
  [`/guilds/${GUILD}`]: { status: 200, json: { id: GUILD } },
  [`/channels/${CHANNEL}`]: { status: 200, json: { id: CHANNEL, guild_id: GUILD } },
};

test('validateDiscord passes when everything is in place', async (t) => {
  const seen = mockDiscord(t, goodDiscord);
  const out = await bridge.validateDiscord({ token: TOKEN, guildId: GUILD, channelId: CHANNEL });
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.checks.map((c) => c.id),
    ['token', 'intents', 'guild', 'channel']
  );
  assert.equal(out.botUserId, BOT);
  assert.ok(out.inviteUrl.includes(`client_id=${BOT}`));
  assert.ok(seen.every((s) => s.auth === `Bot ${TOKEN}`));
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('validateDiscord maps failures to friendly messages', async (t) => {
  // 401
  mockDiscord(t, { '/users/@me': { status: 401, json: { message: '401: Unauthorized' } } });
  let out = await bridge.validateDiscord({ token: TOKEN, guildId: GUILD });
  assert.equal(out.ok, false);
  assert.equal(out.checks.length, 1);
  assert.equal(
    out.checks[0].message,
    "That bot token isn't valid. Reset it in the Developer Portal and paste the new one."
  );
  t.mock.restoreAll();

  // bot not in the guild
  mockDiscord(t, { ...goodDiscord, [`/guilds/${GUILD}`]: { status: 403, json: {} } });
  out = await bridge.validateDiscord({ token: TOKEN, guildId: GUILD, channelId: CHANNEL });
  assert.equal(
    out.checks.find((c) => c.id === 'guild').message,
    "The bot isn't in that Discord server yet. Use the invite link to add it."
  );
  assert.equal(
    out.checks.find((c) => c.id === 'channel'),
    undefined
  );
  t.mock.restoreAll();

  // channel in another guild
  mockDiscord(t, {
    ...goodDiscord,
    [`/channels/${CHANNEL}`]: { status: 200, json: { guild_id: '999999999999999999' } },
  });
  out = await bridge.validateDiscord({ token: TOKEN, guildId: GUILD, channelId: CHANNEL });
  const ch = out.checks.find((c) => c.id === 'channel');
  assert.equal(ch.ok, false);
  assert.match(ch.message, /different Discord server/);
  t.mock.restoreAll();

  // Message Content intent off
  mockDiscord(t, { ...goodDiscord, '/applications/@me': { status: 200, json: { flags: (1 << 14) | (1 << 12) } } });
  out = await bridge.validateDiscord({ token: TOKEN });
  assert.equal(
    out.checks.find((c) => c.id === 'intents').message,
    'Message Content intent is off. Turn it on in the Developer Portal under Bot.'
  );
  assert.equal(out.ok, false);
  t.mock.restoreAll();

  // rate limited
  mockDiscord(t, { '/users/@me': { status: 429, json: {} } });
  out = await bridge.validateDiscord({ token: TOKEN });
  assert.match(out.checks[0].message, /rate-limiting/);
  t.mock.restoreAll();

  // unreachable
  mockDiscord(t, { '/users/@me': new Error(`boom ${TOKEN}`) });
  out = await bridge.validateDiscord({ token: TOKEN });
  assert.match(out.checks[0].message, /Couldn't reach Discord/);
  assert.ok(!JSON.stringify(out).includes(TOKEN));

  await assert.rejects(bridge.validateDiscord({}), { status: 400 });
});

test('checkCompatibility explains unsupported servers and resolves LATEST', async (t) => {
  const calls = mockModrinth(t);
  const paper = seed('srv_cb_paper', { type: 'PAPER' });
  let out = await bridge.checkCompatibility(paper);
  assert.equal(out.supported, false);
  assert.equal(out.reason, "Paper servers need a plugin bridge, which isn't supported yet.");

  const vanilla = seed('srv_cb_vanilla', { type: 'VANILLA' });
  assert.equal((await bridge.checkCompatibility(vanilla)).supported, false);

  const snap = seed('srv_cb_snap', { mc: 'SNAPSHOT' });
  out = await bridge.checkCompatibility(snap);
  assert.equal(out.supported, false);
  assert.match(out.reason, /Pin this server to a specific Minecraft version/);
  assert.equal(calls.length, 0);

  t.mock.method(mojang, 'getVersionManifest', async () => ({ latest: { release: '1.21.8' }, versions: [] }));
  const latest = seed('srv_cb_latest', { mc: 'LATEST' });
  out = await bridge.checkCompatibility(latest);
  assert.equal(out.supported, true);
  assert.equal(out.mcVersion, '1.21.8');
  assert.deepEqual(out.version, { id: 'ver1', number: '1.2.3', filename: 'dcc-1.2.3.jar' });
  assert.deepEqual(calls[0], { slug: 'discord-chat-connect', loader: 'fabric', mcVersion: '1.21.8' });
  assert.equal('raw' in out, false);

  t.mock.restoreAll();
  mockModrinth(t, { versions: [] });
  out = await bridge.checkCompatibility(seed('srv_cb_none'));
  assert.equal(out.supported, false);
  assert.match(out.reason, /No build of Discord & Chat Images is available for Fabric on Minecraft 1\.21\.1/);
});

test('configure refuses an unsupported server before installing anything', async (t) => {
  mockModrinth(t);
  const installs = mockInstall(t, 'x');
  const id = seed('srv_cb_refuse', { type: 'PAPER' });
  await assert.rejects(bridge.configure(id, form()), { status: 400, message: /plugin bridge/ });
  assert.equal(installs.length, 0);
  assert.equal(db.get('SELECT 1 AS x FROM integrations WHERE server_id = ?', id), undefined);
});

test('configure installs, writes the owned placeholder config, stores the token encrypted', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_cfg');
  const installs = mockInstall(t, id);
  const steps = [];
  const out = await bridge.configure(id, form(), { actor: 'tester', onStep: (s) => steps.push(s) });

  assert.equal(out.needsRebuild, true);
  assert.equal(db.get('SELECT pending_recreate FROM servers WHERE id = ?', id).pending_recreate, 1);
  assert.ok(steps.every((s) => s.endsWith('…')));
  // The mod by exact version, then its required dependency.
  assert.equal(installs[0].url, 'https://modrinth.com/mod/discord-chat-connect/version/ver1');
  assert.equal(installs[0].opts.kind, 'mod');
  assert.equal(installs[1].url, 'https://modrinth.com/mod/depproj');

  const copy = path.join(root(id), 'customizations', CFG_PATH);
  const doc = TOML.parse(fs.readFileSync(copy, 'utf8'));
  assert.equal(doc.discordBotToken, '${CFG_DISCORD_BOT_TOKEN}');
  assert.equal(doc.guilds.length, 1);
  assert.equal(doc.guilds[0].guildId, GUILD);
  assert.equal(doc.guilds[0].defaultChannelId, CHANNEL);
  assert.equal(doc.guilds[0].serverLogsChannelId, '');
  assert.equal(doc.guilds[0].enableSlashCommands, true);
  assert.equal(doc.guilds[0].channelOverrides.deathsChannelId, '-1');
  assert.equal(doc.guilds[0].channelOverrides.sayChannelId, '');
  assert.equal(doc.guilds[0].channelOverrides.duplicateMessages, false);
  assert.equal(doc.webhookModeConfig.enableWebhookMode, false);

  // The token: encrypted in the DB, nowhere else.
  const r = db.get("SELECT * FROM integrations WHERE server_id = ? AND kind = 'discord-chat-bridge'", id);
  assert.equal(r.enabled, 1);
  assert.ok(!r.config_cipher.includes(TOKEN));
  assert.ok(!r.config_json.includes(TOKEN));
  assert.equal(JSON.parse(secrets.decrypt(r.config_cipher)).botToken, TOKEN);
  for (const f of allFiles(root(id))) assert.ok(!fs.readFileSync(f, 'utf8').includes(TOKEN), f);
  const events = db.all('SELECT * FROM events WHERE server_id = ?', id);
  assert.ok(events.some((e) => e.type === 'chat-bridge-configured'));
  assert.ok(!JSON.stringify(events).includes(TOKEN));

  // The status view is masked.
  const status = await bridge.getStatus(id);
  assert.equal(status.tokenSet, true);
  assert.equal(status.mod.state, 'installed');
  assert.equal(status.mod.filename, 'dcc-1.2.3.jar');
  assert.ok(!JSON.stringify(status).includes(TOKEN));
});

test('reconfigure keeps user-added keys and does not reinstall or rebuild again', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_recfg');
  const installs = mockInstall(t, id);
  await bridge.configure(id, form());
  const copy = path.join(root(id), 'customizations', CFG_PATH);
  const doc = TOML.parse(fs.readFileSync(copy, 'utf8'));
  doc.modLocale = 'de_de';
  doc.guilds[0].channelOverrides.userExtra = 'keepme';
  doc.guilds.push({ guildId: '444444444444444444', defaultChannelId: CHANNEL });
  fs.writeFileSync(copy, TOML.stringify(doc));
  db.run('UPDATE servers SET pending_recreate = 0 WHERE id = ?', id);

  const out = await bridge.configure(id, form({ token: undefined, defaultChannelId: '555555555555555555' }));
  assert.equal(installs.length, 2); // mod + dependency from the first call only
  assert.equal(out.needsRebuild, false); // same token, already enabled
  const next = TOML.parse(fs.readFileSync(copy, 'utf8'));
  assert.equal(next.modLocale, 'de_de');
  assert.equal(next.guilds.length, 2);
  assert.equal(next.guilds[0].defaultChannelId, '555555555555555555');
  assert.equal(next.guilds[0].channelOverrides.userExtra, 'keepme');
  assert.equal(next.discordBotToken, '${CFG_DISCORD_BOT_TOKEN}');

  // A new token queues a rebuild.
  const out2 = await bridge.configure(id, form({ token: `${TOKEN}x` }));
  assert.equal(out2.needsRebuild, true);
  assert.equal(bridge.storedToken(id), `${TOKEN}x`);
});

test('configure requires a token the first time and validates IDs', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_input');
  mockInstall(t, id);
  await assert.rejects(bridge.configure(id, form({ token: undefined })), {
    status: 400,
    message: /Paste the bot token/,
  });
  await assert.rejects(bridge.configure(id, form({ guildId: 'nope' })), { name: 'ZodError' });
  await assert.rejects(bridge.configure(id, form({ channels: { deathsChannelId: 'x' } })), { name: 'ZodError' });
});

test('assembleEnv injects the token and the spec preview hides it', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_env');
  mockInstall(t, id);
  assert.equal(servers.assembleEnv(servers.getServer(id)).CFG_DISCORD_BOT_TOKEN, undefined);
  await bridge.configure(id, form());
  assert.equal(servers.assembleEnv(servers.getServer(id)).CFG_DISCORD_BOT_TOKEN, TOKEN);
  assert.equal(servers.previewServerSpec(id).env.CFG_DISCORD_BOT_TOKEN, '(hidden)');
  assert.ok(!JSON.stringify(servers.previewServerSpec(id)).includes(TOKEN));
  // The log sanitizer redacts the env key.
  assert.equal(sanitizeLogMeta({ CFG_DISCORD_BOT_TOKEN: TOKEN }).CFG_DISCORD_BOT_TOKEN, '[REDACTED]');
});

test('customizations reports the owned file as managed and refuses user actions', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_owned');
  mockInstall(t, id);
  await bridge.configure(id, form());
  const listed = (await customizations.list(id)).find((f) => f.path === CFG_PATH);
  assert.equal(listed.state, 'managed');
  assert.equal(listed.owner, 'discord-chat-bridge');

  // A live file that differs (the mod rewrote it with the real token) is not drift.
  fs.mkdirSync(path.dirname(path.join(root(id), CFG_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root(id), CFG_PATH), `discordBotToken = "${TOKEN}"\n`);
  assert.equal((await customizations.list(id)).find((f) => f.path === CFG_PATH).state, 'managed');

  for (const action of ['remove', 'keepCurrent', 'restore', 'add']) {
    const res = await customizations[action](id, [CFG_PATH]);
    assert.equal(res.succeeded, 0, action);
    assert.equal(res.results[0].error, customizations.OWNED_MSG, action);
  }
  assert.ok(fs.existsSync(path.join(root(id), 'customizations', CFG_PATH)));
  assert.equal(fs.readFileSync(path.join(root(id), 'customizations', CFG_PATH), 'utf8').includes(TOKEN), false);
});

test('blueprint export leaves the bridge config out', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_bp');
  mockInstall(t, id);
  await bridge.configure(id, form());
  fs.mkdirSync(path.join(root(id), 'config'), { recursive: true });
  fs.writeFileSync(path.join(root(id), CFG_PATH), `discordBotToken = "${TOKEN}"\n`);
  fs.writeFileSync(path.join(root(id), 'config', 'other.toml'), 'a=1\n');
  const row = await bp.exportBlueprint(id, {}, { actor: 'tester' });
  const got = bp.getBlueprint(row.id);
  assert.ok(got.manifest.configFiles.includes('config/other.toml'));
  assert.ok(!got.manifest.configFiles.includes(CFG_PATH));
  assert.ok(!fs.readFileSync(bp.getBlueprintPath(row.id)).includes(TOKEN));
});

test('remove deletes the mod, both config copies and the integration', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_rm');
  mockInstall(t, id);
  await bridge.configure(id, form());
  fs.mkdirSync(path.join(root(id), 'config'), { recursive: true });
  fs.writeFileSync(path.join(root(id), CFG_PATH), `discordBotToken = "${TOKEN}"\n`);
  db.run('UPDATE servers SET pending_recreate = 0 WHERE id = ?', id);

  const out = await bridge.remove(id, { actor: 'tester' });
  assert.equal(out.needsRebuild, true);
  assert.equal(db.get('SELECT pending_recreate FROM servers WHERE id = ?', id).pending_recreate, 1);
  assert.equal(
    db.get('SELECT 1 AS x FROM server_content WHERE server_id = ? AND filename = ?', id, 'dcc-1.2.3.jar'),
    undefined
  );
  // The dependency is left alone: it may be shared.
  assert.ok(db.get('SELECT 1 AS x FROM server_content WHERE server_id = ? AND filename = ?', id, 'dep-2.jar'));
  assert.equal(fs.existsSync(path.join(root(id), CFG_PATH)), false);
  assert.equal(fs.existsSync(path.join(root(id), 'customizations', CFG_PATH)), false);
  assert.equal(db.get('SELECT 1 AS x FROM server_customizations WHERE server_id = ?', id), undefined);
  assert.equal(db.get('SELECT 1 AS x FROM integrations WHERE server_id = ?', id), undefined);
  assert.equal(servers.assembleEnv(servers.getServer(id)).CFG_DISCORD_BOT_TOKEN, undefined);
  assert.ok(db.all('SELECT type FROM events WHERE server_id = ?', id).some((e) => e.type === 'chat-bridge-removed'));
});

test('routes: status, input validation and the task-based configure', async (t) => {
  const app = require('./helpers/app');
  await app.start();
  t.after(() => app.stop());
  const cookie = await app.adminCookie();
  const id = seed('srv_cb_route');
  mockModrinth(t);
  mockInstall(t, id);
  const base = `/api/servers/${id}/integrations/chat-bridge`;

  const status = await app.req('GET', base, { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.json.chatBridge.tokenSet, false);
  assert.equal(status.json.chatBridge.compatibility.supported, true);

  const bad = await app.req('POST', base, { cookie, body: { guildId: 'nope' } });
  assert.equal(bad.status, 400);

  const ok = await app.req('POST', base, { cookie, body: form() });
  assert.equal(ok.status, 202);
  assert.match(ok.json.taskId, /^task_/);

  const check = await app.req('POST', `${base}/check`, { cookie });
  assert.equal(check.json.compatibility.supported, true);

  // A malformed token is a friendly 400 from the route, before Discord is contacted.
  const badTok = await app.req('POST', `${base}/validate`, {
    cookie,
    body: { token: 'abcdefghijklmnopqrstuvwxyz\r\nX-Evil: 1' },
  });
  assert.equal(badTok.status, 400);

  mockDiscord(t, goodDiscord);
  const val = await app.req('POST', `${base}/validate`, { cookie, body: { token: TOKEN, guildId: GUILD } });
  assert.equal(val.json.validation.ok, true);
  assert.ok(!val.text.includes(TOKEN));
});

// ---- Live-config protection in the file manager ----

const filesSvc = require('../src/services/files');

function liveFixture(id) {
  const live = path.join(root(id), CFG_PATH);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, `discordBotToken = "${TOKEN}"\n`);
  fs.writeFileSync(path.join(root(id), 'config', 'other.toml'), `note = "x"\n`);
  return live;
}

test('the file manager never exposes the live bridge config', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_files');
  mockInstall(t, id);
  await bridge.configure(id, form());
  liveFixture(id);
  const reject = { status: 403, message: /holds the Discord bot token/ };

  await assert.rejects(filesSvc.readText(id, CFG_PATH), reject);
  await assert.rejects(filesSvc.statFile(id, CFG_PATH), reject);
  await assert.rejects(filesSvc.writeText(id, CFG_PATH, 'x'), reject);
  await assert.rejects(filesSvc.remove(id, CFG_PATH), reject);
  await assert.rejects(filesSvc.rename(id, CFG_PATH, 'x.toml'), reject);
  await assert.rejects(filesSvc.move(id, 'config', ''), reject); // moving the folder would expose it
  await assert.rejects(filesSvc.zipEntries(id, [CFG_PATH]), reject);

  // Inside a selected folder it is skipped, the rest still zips.
  const zip = await filesSvc.zipEntries(id, ['config']);
  assert.ok(zip.files.some((f) => f.name === 'config/other.toml'));
  assert.ok(!zip.files.some((f) => f.name.endsWith('discord_chat_mod-common.toml')));

  // Search skips it (token text is only in the live file).
  const found = await filesSvc.searchFiles(id, 'superSecretBotToken');
  assert.deepEqual(found.matches, []);

  // Copying the folder leaves the live file behind.
  fs.mkdirSync(path.join(root(id), 'dest'));
  await filesSvc.copy(id, 'config', 'dest');
  assert.equal(fs.existsSync(path.join(root(id), 'dest', 'config', 'other.toml')), true);
  assert.equal(fs.existsSync(path.join(root(id), 'dest', 'config', 'discord_chat_mod-common.toml')), false);

  // The owned copy (placeholder only) stays readable.
  const copy = await filesSvc.readText(id, `customizations/${CFG_PATH}`);
  assert.ok(copy.content.includes('${CFG_DISCORD_BOT_TOKEN}'));
  assert.ok(!copy.content.includes(TOKEN));
});

test('a lost row cannot expose the live config through Add, and folders skip owned files', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_prune');
  mockInstall(t, id);
  await bridge.configure(id, form());
  liveFixture(id);

  // Folder add: the owned file is skipped, the rest succeeds.
  let res = await customizations.add(id, ['config']);
  assert.equal(res.succeeded, 1);
  assert.equal(res.results[0].count, 1);
  assert.equal(fs.existsSync(path.join(root(id), 'customizations', 'config', 'other.toml')), true);
  assert.ok(!fs.readFileSync(path.join(root(id), 'customizations', CFG_PATH), 'utf8').includes(TOKEN));

  // Folder keep/restore skip the owned file too.
  res = await customizations.keepCurrent(id, ['config']);
  assert.equal(res.succeeded, 1);
  assert.ok(!fs.readFileSync(path.join(root(id), 'customizations', CFG_PATH), 'utf8').includes(TOKEN));

  // Lose the copy: list keeps the owned row (missing), it is not pruned.
  fs.rmSync(path.join(root(id), 'customizations', CFG_PATH));
  const entry = (await customizations.list(id)).find((f) => f.path === CFG_PATH);
  assert.equal(entry.state, 'managed');
  assert.equal(entry.missing, true);
  assert.equal(entry.owner, 'discord-chat-bridge');

  // Even with the row gone entirely, Add refuses the path.
  db.run('DELETE FROM server_customizations WHERE server_id = ? AND path = ?', id, CFG_PATH);
  res = await customizations.add(id, [CFG_PATH]);
  assert.equal(res.succeeded, 0);
  assert.equal(res.results[0].error, customizations.OWNED_MSG);
  assert.equal(fs.existsSync(path.join(root(id), 'customizations', CFG_PATH)), false);

  // Folder remove leaves owned files and removes the rest.
  await bridge.configure(id, form());
  res = await customizations.remove(id, ['config']);
  assert.equal(res.succeeded, 1);
  assert.equal(fs.existsSync(path.join(root(id), 'customizations', 'config', 'other.toml')), false);
  assert.equal(fs.existsSync(path.join(root(id), 'customizations', CFG_PATH)), true);
});

test('syncAfterWrite skips an owned file even when its copy has no placeholder', async (t) => {
  mockModrinth(t);
  const id = seed('srv_cb_sync');
  mockInstall(t, id);
  await bridge.configure(id, form());
  const copy = path.join(root(id), 'customizations', CFG_PATH);
  fs.writeFileSync(copy, 'plain = 1\n'); // no ${CFG_ text: only the owner guard can stop the copy
  const live = liveFixture(id);
  assert.equal(await customizations.syncAfterWrite(id, CFG_PATH), false);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'plain = 1\n');
  assert.ok(fs.readFileSync(live, 'utf8').includes(TOKEN));
});

test('a malformed token is rejected before any request to Discord', async (t) => {
  const discordCalls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    discordCalls.push(url);
    throw new Error('should not be called');
  });
  const bad = 'abcdefghijklmnopqrstuvwxyz\r\nX-Evil: 1';
  await assert.rejects(bridge.validateDiscord({ token: bad }), {
    status: 400,
    message: /doesn't look like a bot token/,
  });
  assert.equal(discordCalls.length, 0);
});

test('the Discord request sets redirect error and logs no error message', async (t) => {
  let opts;
  t.mock.method(globalThis, 'fetch', async (url, o) => {
    opts = o;
    throw Object.assign(new Error(`Invalid header value ${TOKEN}`), { code: 'ERR_X' });
  });
  const out = await bridge.validateDiscord({ token: TOKEN });
  assert.equal(opts.redirect, 'error');
  assert.equal(out.ok, false);
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('a server without the panel bridge keeps full access to its own config', async () => {
  const id = seed('srv_cb_manual');
  const live = path.join(root(id), CFG_PATH);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, 'hand = "configured"\n');

  assert.equal((await filesSvc.readText(id, CFG_PATH)).content, 'hand = "configured"\n');
  await filesSvc.writeText(id, CFG_PATH, 'hand = "edited"\n');
  assert.equal((await filesSvc.statFile(id, CFG_PATH)).size > 0, true);
  const zip = await filesSvc.zipEntries(id, ['config']);
  assert.ok(zip.files.some((f) => f.name.endsWith('discord_chat_mod-common.toml')));
  assert.equal((await filesSvc.searchFiles(id, 'edited')).matches.length, 1);
  assert.deepEqual(bridge.protectedLivePaths(id), []);

  const res = await customizations.add(id, [CFG_PATH]);
  assert.equal(res.succeeded, 1);
  assert.equal((await customizations.list(id)).find((f) => f.path === CFG_PATH).state !== 'managed', true);
});
