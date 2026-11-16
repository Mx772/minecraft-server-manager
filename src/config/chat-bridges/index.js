'use strict';

// Chat-bridge catalog: one entry per mod that links in-game chat to Discord.
// Adding a bridge is a data change here, not new service plumbing. The entry
// says where the mod comes from, which loaders it supports, which file holds
// its config, and how the setup form maps onto that file's keys.

/** Discord permission bits (https://discord.com/developers/docs/topics/permissions). */
const PERMISSION_BITS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_WEBHOOKS: 1n << 29n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  PIN_MESSAGES: 1n << 51n,
};

/** Application flag bits for the privileged gateway intents (Discord sets the plain bit when enabled, the LIMITED bit while unverified). */
const INTENT_FLAGS = {
  presence: { label: 'Presence', bits: [1n << 12n, 1n << 13n] },
  serverMembers: { label: 'Server Members', bits: [1n << 14n, 1n << 15n] },
  messageContent: { label: 'Message Content', bits: [1n << 18n, 1n << 19n] },
};

/** Channel categories the mod can route separately. '' = use the default channel, '-1' = off. */
const CHANNEL_CATEGORIES = [
  'pinnedStatusMessageChannelId',
  'deathsChannelId',
  'advancementsChannelId',
  'serverStartStopChannelId',
  'playerJoinLeaveChannelId',
  'playerChatMessagesChannelId',
  'screenshotsChannelId',
  'tellrawChannelId',
  'sayChannelId',
  'meChannelId',
  'commandLogChannelId',
];

const TOKEN_ENV = 'CFG_DISCORD_BOT_TOKEN';
const TOKEN_PLACEHOLDER = '${' + TOKEN_ENV + '}';

/**
 * Build the managed keys of the discord-chat-connect config from form values.
 * Only these keys are ever rewritten; anything else in the file is the user's.
 * The token is ALWAYS the placeholder: the image fills it in from the container env.
 * @param {{guildId: string, defaultChannelId: string, serverLogsChannelId?: string,
 *   channels?: Record<string, string>, enablePinnedStatusMessage?: boolean,
 *   enableSlashCommands?: boolean, enableWebhookMode?: boolean}} v
 */
function buildDiscordChatConnectKeys(v) {
  const overrides = { duplicateMessages: false };
  for (const key of CHANNEL_CATEGORIES) overrides[key] = (v.channels && v.channels[key]) || '';
  return {
    top: { discordBotToken: TOKEN_PLACEHOLDER },
    guild: {
      guildId: v.guildId,
      defaultChannelId: v.defaultChannelId,
      serverLogsChannelId: v.serverLogsChannelId || '',
      enablePinnedStatusMessage: Boolean(v.enablePinnedStatusMessage),
      enableSlashCommands: Boolean(v.enableSlashCommands),
    },
    channelOverrides: overrides,
    webhookMode: { enableWebhookMode: Boolean(v.enableWebhookMode) },
  };
}

const BRIDGES = [
  {
    id: 'discord-chat-connect',
    label: 'Discord & Chat Images',
    modrinthSlug: 'discord-chat-connect',
    loaders: ['fabric', 'forge', 'neoforge', 'quilt'],
    configPath: 'config/discord_chat_mod-common.toml',
    tokenEnv: TOKEN_ENV,
    tokenPlaceholder: TOKEN_PLACEHOLDER,
    channelCategories: CHANNEL_CATEGORIES,
    permissions: [
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'SEND_MESSAGES_IN_THREADS',
      'EMBED_LINKS',
      'ATTACH_FILES',
      'PIN_MESSAGES',
      'READ_MESSAGE_HISTORY',
      'MANAGE_WEBHOOKS',
    ],
    intents: ['presence', 'serverMembers', 'messageContent'],
    buildKeys: buildDiscordChatConnectKeys,
  },
];

const DEFAULT_BRIDGE_ID = 'discord-chat-connect';

function getBridge(id = DEFAULT_BRIDGE_ID) {
  return BRIDGES.find((b) => b.id === id) || null;
}

/**
 * Server-relative paths of every bridge's LIVE config. After a start the image fills
 * the token placeholder in, so these files hold the real bot token and must never be
 * readable through the file manager, downloads, search or backups.
 */
function liveConfigPaths() {
  return BRIDGES.map((b) => b.configPath);
}

module.exports = {
  liveConfigPaths,
  BRIDGES,
  DEFAULT_BRIDGE_ID,
  getBridge,
  PERMISSION_BITS,
  INTENT_FLAGS,
  CHANNEL_CATEGORIES,
  TOKEN_ENV,
};
