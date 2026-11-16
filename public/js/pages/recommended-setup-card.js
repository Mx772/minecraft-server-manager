// Recommended Setup card on the per-server Mods tab: pack profile presets the
// panel applies before each start. Hidden when no profile matches the pack.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { withBusy } from '../lib/loading.js';
import { escapeHtml } from '../lib/format.js';
import { timeAgo } from '../lib/datetime.js';

const card = document.querySelector('[data-prof-card]');
if (card) init(card);

const TRIGGERS = {
  'pre-start': 'before the last start',
  'post-upgrade': 'after the last pack update',
  'first-boot': 'after the first start',
  manual: 'when you clicked Apply Now',
};

const STATUS_LABEL = {
  applied: ['badge-ok', 'Applied'],
  unchanged: ['badge-ok', 'Already set'],
  'held-missing': ['badge-info', 'Waiting for first start'],
  'held-expect': ['badge-warn', 'Needs review'],
  'held-unsupported': ['badge-warn', 'Needs review'],
  error: ['badge-warn', 'Needs review'],
  'skipped-customized': ['badge-info', 'Skipped: you customized this file'],
};

const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

async function init(el) {
  const serverId = el.dataset.profCard;
  const canEdit = el.dataset.canEdit === 'true';
  const canPower = el.dataset.canPower === 'true';
  const serverName = el.dataset.serverName || 'server';
  const body = el.querySelector('[data-prof-body]');
  const base = `/api/servers/${encodeURIComponent(serverId)}/profile`;
  let state = null;
  let restartNeeded = false;
  const open = new Set(); // preset ids whose changes are expanded

  const allOps = (preset) => preset.patches.flatMap((pa) => pa.ops.map((o) => ({ ...o, file: pa.file })));

  function summary(preset) {
    const ops = allOps(preset);
    const count = (...s) => ops.filter((o) => s.includes(o.status)).length;
    const parts = [];
    const done = count('applied', 'unchanged');
    if (done) parts.push(`<span class="badge badge-ok">${done} applied</span>`);
    const review = count('held-expect', 'held-unsupported', 'error');
    if (review) parts.push(`<span class="badge badge-warn">${review} needs review</span>`);
    if (count('held-missing')) parts.push('<span class="badge badge-info">Waiting for first start</span>');
    if (count('skipped-customized'))
      parts.push('<span class="badge badge-info">Skipped: you customized this file</span>');
    return parts.join(' ');
  }

  function opRow(o) {
    const [cls, label] = STATUS_LABEL[o.status] || ['badge-info', 'Not applied yet'];
    let note = o.message ? escapeHtml(o.message) : '';
    if (o.status === 'held-expect' && o.expect !== null && o.expect !== undefined) {
      const now =
        o.current !== null && o.current !== undefined
          ? `the pack now sets it to <span class="font-mono">${escapeHtml(fmt(o.current))}</span>`
          : "the pack's value is different";
      note = `The profile expected <span class="font-mono">${escapeHtml(fmt(o.expect))}</span>, but ${now}. The profile's change was not applied.`;
    }
    return `<li class="py-2 text-xs">
      <div class="font-mono break-all text-ink">${escapeHtml(o.file)}</div>
      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="font-mono break-all">${escapeHtml(o.path.join('.'))}</span>
        <span class="text-ink-faint">to</span>
        <span class="font-mono break-all">${escapeHtml(fmt(o.value))}</span>
        <span class="badge ${cls}">${label}</span>
      </div>
      ${note ? `<p class="mt-1 text-ink-faint">${note}</p>` : ''}
    </li>`;
  }

  function presetRow(p) {
    const ops = allOps(p);
    return `<div class="py-3" data-prof-preset="${escapeHtml(p.id)}">
      <label class="flex cursor-pointer items-start justify-between gap-4">
        <span class="min-w-0">
          <span class="block text-sm font-medium text-ink">${escapeHtml(p.title)}</span>
          <span class="mt-1 block max-w-prose text-xs leading-relaxed text-ink-faint">${escapeHtml(p.description)}</span>
        </span>
        <span class="msm-toggle mt-0.5 shrink-0">
          <input type="checkbox" data-prof-toggle ${p.enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'} aria-label="${escapeHtml(p.title)}">
          <span></span>
        </span>
      </label>
      ${p.why ? `<details class="mt-2 text-xs"><summary class="cursor-pointer text-link">Why</summary><p class="mt-1 max-w-prose leading-relaxed text-ink-faint">${escapeHtml(p.why)}</p></details>` : ''}
      <div class="mt-2 flex flex-wrap gap-1">${summary(p)}</div>
      <details class="mt-2 text-xs" data-prof-changes ${open.has(p.id) ? 'open' : ''}>
        <summary class="cursor-pointer text-link">Show Changes</summary>
        <ul class="mt-1 divide-y divide-line">${ops.map(opRow).join('')}</ul>
      </details>
    </div>`;
  }

  function footer() {
    const run = state.lastRun;
    if (!run) return 'These settings have not been applied yet. They apply before the next start.';
    const when = timeAgo(run.ranAt.includes('T') ? run.ranAt : `${run.ranAt.replace(' ', 'T')}Z`);
    const how = TRIGGERS[run.trigger] || 'recently';
    return `Last applied ${when}, ${how}.`;
  }

  function render() {
    if (!state?.profile) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const { profile, presets } = state;
    const restart = restartNeeded
      ? `<div class="notice notice-warn mb-3 flex flex-wrap items-center justify-between gap-2">
          <span>Restart the server to load the new settings.</span>
          ${canPower ? `<button type="button" class="btn btn-sm" data-server-action="restart" data-server-id="${escapeHtml(serverId)}" data-server-name="${escapeHtml(serverName)}">Restart</button>` : ''}
        </div>`
      : '';
    body.innerHTML = `${restart}
      <p class="mb-2 max-w-prose text-xs leading-relaxed text-ink-faint">Settings the ${escapeHtml(profile.name)} profile recommends for servers. Your own customized files always win.</p>
      ${profile.notes ? `<p class="mb-2 max-w-prose text-xs leading-relaxed text-ink-faint">${escapeHtml(profile.notes)}</p>` : ''}
      <div class="divide-y divide-line">${presets.map(presetRow).join('')}</div>
      <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs text-ink-faint">${escapeHtml(footer())}</p>
        <button type="button" class="btn btn-primary btn-sm" data-prof-apply ${canEdit ? '' : 'disabled'}>Apply Now</button>
      </div>`;
  }

  async function post(path, payload) {
    const res = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function load() {
    try {
      const res = await fetch(base);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error('load failed');
      state = data;
      render();
    } catch {
      el.classList.remove('hidden');
      body.innerHTML =
        '<p class="text-sm text-ink-faint">The recommended setup could not be loaded. Reload the page to try again.</p>';
    }
  }

  body.addEventListener(
    'toggle',
    (e) => {
      const d = e.target.closest?.('[data-prof-changes]');
      if (!d) return;
      const id = d.closest('[data-prof-preset]').dataset.profPreset;
      if (d.open) open.add(id);
      else open.delete(id);
    },
    true
  );

  body.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-prof-toggle]');
    if (!input) return;
    const presetId = input.closest('[data-prof-preset]').dataset.profPreset;
    const enabled = input.checked;
    input.disabled = true;
    try {
      const { res, data } = await post('presets', { changes: [{ presetId, enabled }] });
      if (!res.ok || data.ok === false) throw res;
      state = data;
      render();
      toast(
        enabled
          ? 'Preset turned on. It applies at the next start.'
          : 'Preset turned off. Changes it already made stay until you change them or the pack updates the file.'
      );
    } catch (err) {
      input.checked = !enabled; // revert
      input.disabled = !canEdit;
      toast(friendlyError(err instanceof Response ? err : null, { action: 'change that preset' }), {
        kind: 'error',
      });
    }
  });

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-prof-apply]');
    if (!btn) return;
    await withBusy(btn, 'Applying…', async () => {
      try {
        const { res, data } = await post('apply');
        if (!res.ok || data.ok === false) throw res;
        state = data;
        restartNeeded = !!data.restartNeeded;
        render();
        toast(
          data.applied > 0
            ? `Applied ${data.applied} recommended ${data.applied === 1 ? 'setting' : 'settings'}.`
            : 'Nothing to change.'
        );
      } catch (err) {
        toast(friendlyError(err instanceof Response ? err : null, { action: 'apply the recommended setup' }), {
          kind: 'error',
        });
      }
    });
  });

  await load();
}
