// Discord chat bridge card (Settings > Discord): guided setup, status, and
// removal for the two-way chat mod. All state comes from
// /api/servers/:id/integrations/chat-bridge; the card renders itself.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { withBusy } from '../lib/loading.js';
import { escapeHtml as esc } from '../lib/format.js';
import { confirmDialog } from '../lib/confirm.js';
import { runTask } from '../lib/progress.js';

const root = document.getElementById('ig-root');
const body = document.getElementById('cb-body');
if (root && body) init();

const PERMISSION_WORDS = {
  VIEW_CHANNEL: 'View Channel',
  SEND_MESSAGES: 'Send Messages',
  SEND_MESSAGES_IN_THREADS: 'Send Messages in Threads',
  EMBED_LINKS: 'Embed Links',
  ATTACH_FILES: 'Attach Files',
  PIN_MESSAGES: 'Pin Messages',
  READ_MESSAGE_HISTORY: 'Read Message History',
  MANAGE_WEBHOOKS: 'Manage Webhooks',
};

const CATEGORY_LABELS = {
  pinnedStatusMessageChannelId: 'Pinned Status Message',
  deathsChannelId: 'Deaths',
  advancementsChannelId: 'Advancements',
  serverStartStopChannelId: 'Server Start and Stop',
  playerJoinLeaveChannelId: 'Player Join and Leave',
  playerChatMessagesChannelId: 'Player Chat Messages',
  screenshotsChannelId: 'Screenshots',
  tellrawChannelId: 'Tellraw Messages',
  sayChannelId: 'Say Messages',
  meChannelId: 'Me Messages',
  commandLogChannelId: 'Command Log',
};

const INTENT_WORDS = {
  presence: 'Presence',
  serverMembers: 'Server Members',
  messageContent: 'Message Content',
};

function init() {
  const serverId = root.dataset.serverId;
  const serverName = root.dataset.serverName || 'server';
  const base = `/api/servers/${encodeURIComponent(serverId)}/integrations/chat-bridge`;

  let status = null;
  let compat = null;
  let editing = false;
  // Validation outcome survives re-renders of the summary but resets with the form.
  let validated = null;

  async function call(path, method = 'GET', payload) {
    const res = await fetch(base + path, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function load() {
    try {
      const { res, data } = await call('');
      if (!res.ok || !data.chatBridge) throw new Error('load');
      status = data.chatBridge;
    } catch {
      body.innerHTML =
        '<p class="text-sm text-ink-faint">The Discord bridge could not be loaded. Reload the page to try again.</p>';
      return;
    }
    compat = status.compatibility || null;
    if (!status.configured || editing) {
      if (!compat) {
        try {
          const { res, data } = await call('/check', 'POST');
          if (res.ok) compat = data.compatibility;
        } catch {
          /* leave null: setup stays disabled with a message */
        }
      }
      renderForm();
    } else {
      renderSummary();
    }
  }

  function noticeHtml(kind, text) {
    return `<div class="notice notice-${kind}">${text}</div>`;
  }

  function rebuildNotice() {
    return `<div class="notice notice-warn mt-3 flex flex-wrap items-center justify-between gap-2">
      <span>Rebuild the server to connect the bot.</span>
      <button type="button" class="btn btn-sm" data-server-action="recreate" data-server-id="${esc(serverId)}" data-server-name="${esc(serverName)}">Rebuild Now</button>
    </div>`;
  }

  function permissionsList() {
    const names = (status.requirements?.permissions || []).map((p) => PERMISSION_WORDS[p] || p);
    return names.map((n) => `<li>${esc(n)}</li>`).join('');
  }

  function inviteHtml() {
    if (!status.inviteUrl) return '';
    return `<a class="btn btn-primary" href="${esc(status.inviteUrl)}" target="_blank" rel="noopener">Invite The Bot</a>`;
  }

  function renderResults(v) {
    const rows = v.checks
      .map(
        (c) =>
          `<li class="flex items-start gap-2"><span class="badge ${c.ok ? 'badge-ok' : 'badge-danger'} shrink-0">${c.ok ? 'OK' : 'Failed'}</span><span class="min-w-0 text-sm">${esc(c.message)}</span></li>`
      )
      .join('');
    return `<ul class="space-y-1.5">${rows}</ul>${v.ok ? `<div class="notice notice-ok mt-2">Everything checks out.</div>` : ''}`;
  }

  // ---- Configured: summary + actions ----
  function renderSummary() {
    const s = status.settings || {};
    const mod = status.mod || { state: 'none' };
    const modLine =
      mod.state === 'installed'
        ? `Installed${mod.version ? `, version ${esc(mod.version)}` : ''}`
        : mod.state === 'missing'
          ? 'Missing'
          : 'Not installed';
    const modWarn =
      mod.state === 'missing'
        ? `<div class="notice notice-warn mt-3 flex flex-wrap items-center justify-between gap-2">
            <span>The bridge mod is missing from this server. Set it up again to reinstall it.</span>
            <button type="button" class="btn btn-sm" data-cb-reinstall>Reinstall</button>
          </div>`
        : '';
    body.innerHTML = `
      <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt class="text-xs text-ink-faint">Bot</dt><dd>${esc(status.bot?.name || 'Not checked yet')}</dd></div>
        <div><dt class="text-xs text-ink-faint">Mod</dt><dd>${esc(status.bridge?.label || 'Discord & Chat Images')}: ${modLine}</dd></div>
        <div><dt class="text-xs text-ink-faint">Discord Server ID</dt><dd class="font-mono text-xs break-all">${esc(s.guildId || '')}</dd></div>
        <div><dt class="text-xs text-ink-faint">Chat Channel ID</dt><dd class="font-mono text-xs break-all">${esc(s.defaultChannelId || '')}</dd></div>
      </dl>
      ${modWarn}
      ${status.needsRebuild ? rebuildNotice() : ''}
      <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" class="btn" data-cb-edit>Edit Settings</button>
        <button type="button" class="btn" data-cb-validate-stored>Check Setup</button>
        ${inviteHtml().replace('btn btn-primary', 'btn')}
        <a class="btn" href="/servers/${encodeURIComponent(serverId)}/files?path=customizations/config">Open Config</a>
        <button type="button" class="btn btn-danger" data-cb-remove>Remove Bridge</button>
      </div>
      <div class="mt-3" data-cb-results></div>
      <p class="help mt-3">The bridge's config file is managed by the panel. You can add extra settings to it in the Files tab and they are kept. Once the server has started, the live config file and backups contain the bot token, so share backups carefully.</p>`;
    if (validated) body.querySelector('[data-cb-results]').innerHTML = renderResults(validated);
  }

  // ---- Form (setup + edit) ----
  function toggleRow(id, label, help, checked) {
    return `<label class="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span class="min-w-0">
        <span class="block text-sm font-medium text-ink">${label}</span>
        <span class="mt-1 block max-w-prose text-xs leading-relaxed text-ink-faint">${help}</span>
      </span>
      <span class="msm-toggle mt-0.5 shrink-0"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span>
    </label>`;
  }

  function step(n, title, inner) {
    return `<li class="space-y-2"><p class="text-sm font-medium">${n}. ${title}</p>${inner}</li>`;
  }

  function renderForm() {
    const s = status.settings || {};
    const ch = s.channels || {};
    const tokenSet = Boolean(status.tokenSet);
    const intents = (status.requirements?.intents || []).map((i) => INTENT_WORDS[i] || i).join(', ');
    let compatHtml;
    if (!compat) {
      compatHtml = noticeHtml(
        'warn',
        'The panel could not check whether the bridge fits this server. Reload the page to try again.'
      );
    } else if (compat.supported) {
      compatHtml = noticeHtml(
        'ok',
        `${esc(compat.bridge?.label || 'Discord & Chat Images')} ${esc(compat.version?.number || '')} fits this ${esc(cap(compat.loader))} ${esc(compat.mcVersion)} server.`
      );
    } else {
      compatHtml =
        noticeHtml('warn', esc(compat.reason || 'The bridge does not support this server.')) +
        '<p class="help">You can still upload a mod jar yourself from the Mods tab.</p>';
    }
    const supported = Boolean(compat?.supported);
    const catRows = (status.bridge ? Object.keys(CATEGORY_LABELS) : [])
      .map(
        (k) => `<div>
          <label class="label" for="cb-ch-${k}">${CATEGORY_LABELS[k]}</label>
          <input class="input font-mono text-xs" id="cb-ch-${k}" data-cb-cat="${k}" inputmode="text" autocomplete="off" value="${esc(ch[k] || '')}">
        </div>`
      )
      .join('');

    const setup = `
      <ol class="space-y-5">
        ${step(1, 'Check compatibility', compatHtml)}
        <li class="space-y-5 list-none p-0 m-0"><fieldset class="space-y-5 ${supported ? '' : 'pointer-events-none opacity-50'}" ${supported ? '' : 'disabled'}><ol class="space-y-5">
        ${step(
          2,
          'Create a Discord application and bot',
          `<p class="help">Open the <a class="text-link underline" href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a> and create an application. Open Bot, turn on the privileged intents (${esc(intents)}), then choose Reset Token and copy it.</p>`
        )}
        ${step(
          3,
          'Paste the bot token',
          `<div class="flex gap-2">
            <input class="input min-w-0 flex-1 font-mono text-xs" type="password" id="cb-token" autocomplete="off" spellcheck="false" placeholder="${tokenSet ? 'Leave empty to keep the saved token' : 'Bot token'}">
            <button type="button" class="btn" data-cb-reveal aria-pressed="false">Show</button>
          </div>
          <p class="help">The token is stored encrypted and only given to this server. It is never shown again.</p>`
        )}
        ${step(
          4,
          'Invite the bot',
          `<div data-cb-invite>${status.inviteUrl ? inviteHtml() : '<p class="help">Check your setup in step 6 and an invite link appears here.</p>'}</div>
          <p class="help">The bot needs these permissions in the chat channel:</p>
          <ul class="list-disc pl-5 text-xs text-ink-faint">${permissionsList()}</ul>`
        )}
        ${step(
          5,
          'Pick the channel',
          `<p class="help">In Discord, turn on User Settings → Advanced → Developer Mode. Then right-click your server and choose Copy Server ID, and right-click the channel and choose Copy Channel ID.</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <div><label class="label" for="cb-guild">Discord Server ID</label><input class="input font-mono text-xs" id="cb-guild" inputmode="numeric" autocomplete="off" value="${esc(s.guildId || '')}"></div>
            <div><label class="label" for="cb-chan">Chat Channel ID</label><input class="input font-mono text-xs" id="cb-chan" inputmode="numeric" autocomplete="off" value="${esc(s.defaultChannelId || '')}"></div>
            <div><label class="label" for="cb-logs">Console Log Channel ID (optional)</label><input class="input font-mono text-xs" id="cb-logs" inputmode="numeric" autocomplete="off" value="${esc(s.serverLogsChannelId || '')}"></div>
          </div>`
        )}
        ${step(
          6,
          'Check the setup',
          `<div><button type="button" class="btn" data-cb-validate>Check Setup</button></div>
          <div data-cb-results></div>`
        )}
        ${step(
          7,
          'Choose options',
          `<div class="space-y-1">
            ${toggleRow('cb-pinned', 'Pinned Status Message', 'Keeps one pinned message in Discord that shows who is online.', s.enablePinnedStatusMessage)}
            ${toggleRow('cb-slash', 'Slash Commands', 'Lets people use bot commands in Discord.', s.enableSlashCommands)}
            <div class="notice notice-warn hidden" data-cb-slash-warn>Slash commands such as /cmd let people in that Discord server run console commands. Restrict who can use them in the config file.</div>
            ${toggleRow('cb-webhook', 'Webhook Mode', "Messages appear under each player's name and head. Needs the Manage Webhooks permission.", s.enableWebhookMode)}
          </div>
          <details class="rounded-sm border border-line p-2">
            <summary class="cursor-pointer text-sm font-medium">Per-Category Channels</summary>
            <p class="help mt-2">Leave a field empty to use the chat channel, or enter -1 to turn that category off.</p>
            <div class="mt-2 grid gap-3 sm:grid-cols-2">${catRows}</div>
          </details>`
        )}
        ${step(
          8,
          'Set up the bridge',
          `<div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button type="button" class="btn btn-primary" data-cb-save disabled>Set Up Bridge</button>
            ${status.configured ? '<button type="button" class="btn btn-ghost" data-cb-cancel>Cancel</button>' : ''}
          </div>
          <p class="help hidden" data-cb-skip-hint>You have not checked the setup yet. You can continue, but checking first catches wrong IDs.</p>
          <div data-cb-after></div>`
        )}
      </ol></fieldset></li>
      </ol>
      <p class="help mt-4">Once the server has started, the live config file and backups contain the bot token, so share backups carefully.</p>`;
    body.innerHTML = setup;
    wireForm();
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function val(id) {
    return (document.getElementById(id)?.value || '').trim();
  }

  function formPayload() {
    const channels = {};
    for (const el of body.querySelectorAll('[data-cb-cat]')) {
      const v = el.value.trim();
      if (v) channels[el.dataset.cbCat] = v;
    }
    const out = {
      guildId: val('cb-guild'),
      defaultChannelId: val('cb-chan'),
      serverLogsChannelId: val('cb-logs'),
      channels,
      enablePinnedStatusMessage: document.getElementById('cb-pinned').checked,
      enableSlashCommands: document.getElementById('cb-slash').checked,
      enableWebhookMode: document.getElementById('cb-webhook').checked,
    };
    const token = val('cb-token');
    if (token) out.token = token;
    if (validated?.botUserId) {
      out.botUserId = validated.botUserId;
      out.botName = validated.botName;
    }
    return out;
  }

  function wireForm() {
    refreshForm();
  }

  // Enables Set Up Bridge once the required fields are filled; listeners are bound once on body.
  function refreshForm() {
    const saveBtn = body.querySelector('[data-cb-save]');
    if (!saveBtn) return;
    const ready = compat?.supported && (val('cb-token') || status.tokenSet) && val('cb-guild') && val('cb-chan');
    saveBtn.disabled = !ready;
    body.querySelector('[data-cb-slash-warn]').classList.toggle('hidden', !document.getElementById('cb-slash').checked);
    body.querySelector('[data-cb-skip-hint]').classList.toggle('hidden', Boolean(validated) || saveBtn.disabled);
  }
  body.addEventListener('input', refreshForm);
  body.addEventListener('change', refreshForm);

  async function validate(btn, payload) {
    await withBusy(btn, 'Checking…', async () => {
      try {
        const { res, data } = await call('/validate', 'POST', payload);
        if (!res.ok || !data.validation) {
          toast(data.error || friendlyError(res, { action: 'check the setup' }), { kind: 'error' });
          return;
        }
        validated = data.validation;
        if (validated.inviteUrl) status.inviteUrl = validated.inviteUrl;
        const out = body.querySelector('[data-cb-results]');
        if (out) out.innerHTML = renderResults(validated);
        const inv = body.querySelector('[data-cb-invite]');
        if (inv && validated.inviteUrl) inv.innerHTML = inviteHtml();
        refreshForm();
      } catch {
        toast(friendlyError(null, { action: 'check the setup' }), { kind: 'error' });
      }
    });
  }

  async function configure(payload) {
    try {
      await runTask({
        title: 'Setting up the Discord bridge…',
        start: async () => {
          const { res, data } = await call('', 'POST', payload);
          if (!res.ok || !data.taskId)
            throw new Error(data.error || friendlyError(res, { action: 'set up the bridge' }));
          return data.taskId;
        },
      });
      toast('The Discord bridge is set up.');
      editing = false;
      validated = null;
      await load();
    } catch (err) {
      if (err.dismissed) return;
      toast(err.message || friendlyError(null, { action: 'set up the bridge' }), { kind: 'error', timeout: 9000 });
    }
  }

  body.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-cb-reveal')) {
      const input = document.getElementById('cb-token');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      t.textContent = show ? 'Hide' : 'Show';
      t.setAttribute('aria-pressed', String(show));
    } else if (t.hasAttribute('data-cb-validate')) {
      const payload = { guildId: val('cb-guild') || undefined, channelId: val('cb-chan') || undefined };
      if (val('cb-token')) payload.token = val('cb-token');
      await validate(t, payload);
    } else if (t.hasAttribute('data-cb-validate-stored')) {
      await validate(t, {});
    } else if (t.hasAttribute('data-cb-save')) {
      await configure(formPayload());
    } else if (t.hasAttribute('data-cb-edit')) {
      editing = true;
      validated = null;
      await load();
    } else if (t.hasAttribute('data-cb-cancel')) {
      editing = false;
      validated = null;
      await load();
    } else if (t.hasAttribute('data-cb-reinstall')) {
      const s = status.settings || {};
      await configure({
        guildId: s.guildId,
        defaultChannelId: s.defaultChannelId,
        serverLogsChannelId: s.serverLogsChannelId || '',
        channels: s.channels || {},
        enablePinnedStatusMessage: s.enablePinnedStatusMessage,
        enableSlashCommands: s.enableSlashCommands,
        enableWebhookMode: s.enableWebhookMode,
      });
    } else if (t.hasAttribute('data-cb-remove')) {
      const ok = await confirmDialog({
        title: 'Remove the Discord bridge?',
        message:
          'The bridge mod, its settings, and the saved bot token are removed from this server. Rebuild the server afterwards.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
      await withBusy(t, 'Removing…', async () => {
        try {
          const { res, data } = await call('', 'DELETE');
          if (!res.ok) {
            toast(data.error || friendlyError(res, { action: 'remove the bridge' }), { kind: 'error' });
            return;
          }
          toast('The Discord bridge was removed.');
          validated = null;
          await load();
        } catch {
          toast(friendlyError(null, { action: 'remove the bridge' }), { kind: 'error' });
        }
      });
    }
  });

  load();
}
