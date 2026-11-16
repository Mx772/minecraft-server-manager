# Integrations

[← Back to docs index](README.md)

Each server carries its integrations under the **Settings** group: **Discord**, a public **Status Page**, one-click **Invites**, and the optional **Chatbot** tab (admins only). This page covers Discord (the others have their own docs and setup helpers in the panel).

## Discord notifications

The panel forwards server events to a Discord channel through a webhook. No bot, no OAuth.

### Setup

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**. Pick the channel and copy the webhook URL.
2. In the panel, open the server's **Settings → Discord** tab, paste the URL into **Webhook URL**, turn the card **on**, and **Save**. The URL is stored encrypted (in the same at-rest store as your API keys).
3. Use **Send Test** to confirm it works.

![Discord integration](images/integrations-discord.png)

To replace a stored URL, paste a new one and save; leave the field blank to keep the current one. The stored URL is shown masked (the token is hidden).

### What gets sent

Notifications are grouped into toggleable categories. All are on by default.

| Category         | Events                                                    |
| ---------------- | --------------------------------------------------------- |
| **Start / stop** | Server started, server stopped                            |
| **Crashes**      | Crash, crash loop detected, new crash report              |
| **Backups**      | Backup created, backup restored                           |
| **Updates**      | Update applied, update rolled back, update failed         |
| **Kicks / bans** | Player kicked, player banned                              |
| **Alerts**       | The things that quietly leave a server broken (see below) |

### The Alerts category

`Alerts` is the "something needs a human" channel, for conditions that used to be visible only in the panel:

| Event                   | Meaning                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `oom`                   | The container was stopped for running out of memory.                                                           |
| `unhealthy`             | The process is up but the `mc-health` probe is failing: a live but dead server.                                |
| `startup-stalled`       | Still starting after ~10 min with no "Done" in the logs (with a diagnosis of what to fix, where one is known). |
| `stop-failed`           | A graceful stop didn't take effect and the container is still running.                                         |
| `schedule-failed`       | A scheduled restart / backup / command failed.                                                                 |
| `quota-exceeded`        | Strict-mode disk quota tripped and the server was stopped.                                                     |
| `offline-after-restart` | The server was up before the panel restarted, isn't now, and won't be auto-started.                            |
| `port-change-failed`    | A port change failed and the server could not be put back on its old port, so it is down.                      |
| `auto-restart-gave-up`  | A crashed server was not restarted because another action kept it busy for too long.                           |

### How delivery works

A background bridge polls the [event log](activity.md) every 15 seconds and forwards mapped rows. If a webhook POST fails transiently, that row is retried on later polls rather than dropped; after a few failed attempts the row is skipped, and delivery failures are logged at most once per hour per server. After a panel restart the bridge sends the events it had not delivered yet, but never more than two hours back; on its very first run it starts from the newest event.

## Two-way chat with Discord

The **Discord Chat Bridge** card on the **Settings → Discord** tab links in-game chat to a Discord channel in both directions. It uses the Discord & Chat Images mod, which the panel installs and keeps across pack updates. This is separate from the webhook notifications above, which only send events one way.

### Setup

1. The card first checks that the mod fits the server's loader and Minecraft version. If it does not, you can still upload a mod jar yourself from the Mods tab.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Open **Bot**, turn on the privileged intents (Presence, Server Members, and Message Content), then choose **Reset Token** and copy the token.
3. Paste the token into the card. It is stored encrypted and only given to this server.
4. Use **Invite The Bot** to add the bot to your Discord server. It needs these permissions in the chat channel: View Channel, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Pin Messages, Read Message History, and Manage Webhooks.
5. In Discord, turn on **User Settings → Advanced → Developer Mode**. Right-click your server and choose **Copy Server ID**, then right-click the channel and choose **Copy Channel ID**. Enter both in the card. A console log channel is optional.
6. Use **Check Setup** to confirm the token, intents, server, and channel. You can run it again at any time.
7. Choose your options, then select **Set Up Bridge**. Rebuild the server afterwards so the bot connects.

### Options

- **Pinned Status Message** keeps one pinned message in Discord that shows who is online.
- **Slash Commands** lets people use bot commands in Discord. Commands such as `/cmd` let people in that Discord server run console commands, so restrict who can use them in the config file.
- **Webhook Mode** shows messages under each player's name and head. It needs the Manage Webhooks permission.
- **Per-Category Channels** sends a category (deaths, advancements, joins and leaves, and so on) to its own channel. Leave a field empty to use the chat channel, or enter `-1` to turn that category off.

### The config file is managed

The panel writes the bridge's config file (`config/discord_chat_mod-common.toml`) from this card. You can add extra settings to it from **Open Config** (the `customizations/config` folder in Files), and they are kept. The settings the card controls are rewritten when you save. **Remove Bridge** removes the mod, its settings, and the saved token.

### The token and backups

The saved token is encrypted in the panel. Once the server has started, the live config file and backups contain the token, so share backups carefully.
