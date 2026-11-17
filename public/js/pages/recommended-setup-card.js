// Recommended Setup card on the per-server Mods tab: pack profile presets the
// panel applies before each start. Hidden when no profile matches the pack.
// Suggestions are opt-in: a new profile shows a prompt, and nothing is applied
// until the user reviews it and turns settings on.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { withBusy } from '../lib/loading.js';
import { confirmDialog } from '../lib/confirm.js';
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
  'held-exists': ['badge-warn', 'Not added: the pack has its own'],
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
  let rebuildNeeded = false;
  let reviewing = false; // the checklist is open
  const open = new Set(); // preset ids whose changes are expanded

  const allOps = (preset) => preset.patches.flatMap((pa) => pa.ops.map((o) => ({ ...o, file: pa.file })));

  function summary(preset) {
    const ops = [...allOps(preset), ...preset.settings, ...preset.files];
    const count = (...s) => ops.filter((o) => s.includes(o.status)).length;
    const parts = [];
    const done = count('applied', 'unchanged');
    if (done) parts.push(`<span class="badge badge-ok">${done} applied</span>`);
    const review = count('held-expect', 'held-unsupported', 'held-exists', 'error');
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

  function fileBlock(f) {
    return `<details class="mt-1 text-xs"><summary class="cursor-pointer text-link">Show File</summary><pre class="mt-1 max-h-64 overflow-auto rounded-sm bg-inset p-2 font-mono text-xs whitespace-pre-wrap break-all text-ink-soft">${escapeHtml(f.preview)}</pre></details>`;
  }

  function fileRow(p, f) {
    const [cls, label] = STATUS_LABEL[f.status] || ['badge-info', 'Not added yet'];
    const held = f.status === 'held-exists';
    const current = held
      ? `<details class="mt-1 text-xs"><summary class="cursor-pointer text-link">Current File</summary><pre class="mt-1 max-h-64 overflow-auto rounded-sm bg-inset p-2 font-mono text-xs whitespace-pre-wrap break-all text-ink-soft">${escapeHtml(f.currentPreview || '')}</pre></details>`
      : '';
    const file = held
      ? `<details class="mt-1 text-xs"><summary class="cursor-pointer text-link">Profile's Version</summary><pre class="mt-1 max-h-64 overflow-auto rounded-sm bg-inset p-2 font-mono text-xs whitespace-pre-wrap break-all text-ink-soft">${escapeHtml(f.preview)}</pre></details>`
      : fileBlock(f);
    const replace = held
      ? `<button type="button" class="btn btn-sm mt-2" data-prof-replace data-preset="${escapeHtml(p.id)}" data-path="${escapeHtml(f.path)}" ${canEdit ? '' : 'disabled'}>Replace It</button>`
      : '';
    const backupNote =
      f.hasBackup && (f.status === 'applied' || f.status === 'unchanged')
        ? '<p class="mt-1 text-ink-faint">Turning this off puts back the previous file.</p>'
        : '';
    return `<li class="py-2 text-xs">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-ink">Adds</span>
        <span class="font-mono break-all">${escapeHtml(f.path)}</span>
        <span class="badge ${cls}">${label}</span>
      </div>
      ${f.message ? `<p class="mt-1 text-ink-faint">${escapeHtml(f.message)}</p>` : ''}
      ${backupNote}${current}${file}${replace}
    </li>`;
  }

  function settingRow(st) {
    const [cls, label] = STATUS_LABEL[st.status] || ['badge-info', 'Not applied yet'];
    return `<li class="py-2 text-xs">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-ink">${escapeHtml(st.label)}:</span>
        <span class="font-mono break-all">${escapeHtml(fmt(st.value))}</span>
        <span class="badge ${cls}">${label}</span>
      </div>
      ${st.message ? `<p class="mt-1 text-ink-faint">${escapeHtml(st.message)}</p>` : ''}
    </li>`;
  }

  // What a preset changes, as plain lines, for the review checklist.
  function changeLines(p) {
    const lines = [
      ...allOps(p).map((o) => `${o.file}: ${o.path.join('.')} to ${fmt(o.value)}`),
      ...p.settings.map((st) => `${st.label}: ${fmt(st.value)}`),
    ];
    const items = lines.map((l) => `<li>${escapeHtml(l)}</li>`);
    for (const f of p.files) {
      items.push(
        `<li><span class="font-sans">Adds</span> ${escapeHtml(f.path)}<div class="font-sans">${fileBlock(f)}</div></li>`
      );
    }
    return `<ul class="mt-1 space-y-0.5 font-mono text-xs break-all text-ink-faint">${items.join('')}</ul>`;
  }

  function reviewRow(p) {
    return `<div class="py-3" data-prof-review-row="${escapeHtml(p.id)}">
      <label class="flex cursor-pointer items-start gap-3">
        <input type="checkbox" class="msm-check mt-0.5" data-prof-pick="${escapeHtml(p.id)}" ${p.default ? 'checked' : ''}>
        <span class="min-w-0">
          <span class="block text-sm font-medium text-ink">${escapeHtml(p.title)}</span>
          <span class="mt-1 block max-w-prose text-xs leading-relaxed text-ink-faint">${escapeHtml(p.description)}</span>
        </span>
      </label>
      <div class="ml-7">
        ${p.why ? `<details class="mt-2 text-xs"><summary class="cursor-pointer text-link">Why</summary><p class="mt-1 max-w-prose leading-relaxed text-ink-faint">${escapeHtml(p.why)}</p></details>` : ''}
        <details class="mt-2 text-xs"><summary class="cursor-pointer text-link">What It Changes</summary>${changeLines(p)}</details>
      </div>
    </div>`;
  }

  function reviewTargets() {
    const all = state.presets;
    return state.review?.state === 'new-presets' ? all.filter((p) => p.isNew) : all;
  }

  function promptHtml() {
    const { profile, review } = state;
    const name = escapeHtml(profile.name);
    const n = review.newPresetIds.length;
    const headline =
      review.state === 'new'
        ? `Detected ${name}. Suggested settings are available.`
        : `${n} new suggested ${n === 1 ? 'setting' : 'settings'} for ${name}.`;
    if (!reviewing) {
      return `<div class="notice notice-info mb-4" data-prof-prompt>
        <p class="font-semibold">${headline}</p>
        <p class="mt-1 text-xs">Nothing changes until you turn them on.</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary btn-sm" data-prof-review ${canEdit ? '' : 'disabled'}>Review Suggestions</button>
          <button type="button" class="btn btn-ghost btn-sm" data-prof-notnow ${canEdit ? '' : 'disabled'}>Not Now</button>
        </div>
      </div>`;
    }
    return `<div class="notice notice-info mb-4" data-prof-prompt>
      <p class="font-semibold">${headline}</p>
      <p class="mt-1 text-xs">Nothing changes until you turn them on.</p>
      <div class="mt-2 divide-y divide-line" data-prof-checklist>${reviewTargets().map(reviewRow).join('')}</div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary btn-sm" data-prof-enable disabled>Enable Selected</button>
        <button type="button" class="btn btn-ghost btn-sm" data-prof-notnow>Not Now</button>
      </div>
    </div>`;
  }

  function presetRow(p) {
    const ops = allOps(p);
    return `<div class="py-3" data-prof-preset="${escapeHtml(p.id)}">
      <label class="flex cursor-pointer items-start justify-between gap-4">
        <span class="min-w-0">
          <span class="block text-sm font-medium text-ink">${escapeHtml(p.title)}${p.isNew ? ' <span class="badge badge-info">New</span>' : ''}</span>
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
        <ul class="mt-1 divide-y divide-line">${ops.map(opRow).join('')}${p.settings.map(settingRow).join('')}${p.files.map((f) => fileRow(p, f)).join('')}</ul>
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
    const rebuild = rebuildNeeded
      ? `<div class="notice notice-warn mb-3 flex flex-wrap items-center justify-between gap-2">
          <span>Rebuild the server to use the new server settings.</span>
          ${canPower ? `<button type="button" class="btn btn-sm" data-server-action="recreate" data-server-id="${escapeHtml(serverId)}" data-server-name="${escapeHtml(serverName)}">Rebuild Now</button>` : ''}
        </div>`
      : '';
    const restart =
      restartNeeded && !rebuildNeeded
        ? `<div class="notice notice-warn mb-3 flex flex-wrap items-center justify-between gap-2">
          <span>Restart the server to load the new settings.</span>
          ${canPower ? `<button type="button" class="btn btn-sm" data-server-action="restart" data-server-id="${escapeHtml(serverId)}" data-server-name="${escapeHtml(serverName)}">Restart</button>` : ''}
        </div>`
        : '';
    const reviewState = state.review?.state;
    const prompting = reviewState === 'new' || reviewState === 'new-presets';
    const list =
      reviewState === 'new'
        ? ''
        : `<p class="mb-2 max-w-prose text-xs leading-relaxed text-ink-faint">Settings the ${escapeHtml(profile.name)} profile suggests for servers. Your own customized files always win.</p>
      ${profile.notes ? `<p class="mb-2 max-w-prose text-xs leading-relaxed text-ink-faint">${escapeHtml(profile.notes)}</p>` : ''}
      <div class="divide-y divide-line">${presets.map(presetRow).join('')}</div>
      <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs text-ink-faint">${escapeHtml(footer())}</p>
        <button type="button" class="btn btn-primary btn-sm" data-prof-apply ${canEdit ? '' : 'disabled'}>Apply Now</button>
      </div>`;
    body.innerHTML = `${rebuild}${restart}${prompting ? promptHtml() : ''}${list}`;
    if (reviewing) syncEnable();
  }

  function syncEnable() {
    const enable = body.querySelector('[data-prof-enable]');
    if (!enable) return;
    const any = [...body.querySelectorAll('[data-prof-pick]')].some((c) => c.checked);
    enable.disabled = !any || !canEdit;
    // With nothing ticked there is nothing to enable, so only Not Now remains.
    enable.classList.toggle('hidden', !any);
  }

  function takeResult(data) {
    state = data;
    rebuildNeeded = !!data.rebuildNeeded;
    restartNeeded = !!data.restartNeeded;
    reviewing = false;
    render();
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
      // The Overview hint links to #recommended-setup, but the card is hidden until
      // this fetch reveals it, so the browser's own anchor jump has nothing to land on.
      if (location.hash === '#recommended-setup' && !el.classList.contains('hidden')) {
        el.scrollIntoView({ block: 'start' });
      }
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
      takeResult(data);
      toast(
        enabled
          ? 'Preset turned on. It applies at the next start.'
          : 'Preset turned off. Files it added were removed. Other changes it made stay until you change them or the pack updates the file.'
      );
    } catch (err) {
      input.checked = !enabled; // revert
      input.disabled = !canEdit;
      toast(friendlyError(err instanceof Response ? err : null, { action: 'change that preset' }), {
        kind: 'error',
      });
    }
  });

  body.addEventListener('change', (e) => {
    if (e.target.closest('[data-prof-pick]')) syncEnable();
  });

  async function submitReview(btn, ids) {
    await withBusy(btn, ids.length ? 'Enabling…' : 'Saving…', async () => {
      try {
        const { res, data } = await post('review', { enable: ids });
        if (!res.ok || data.ok === false) throw res;
        takeResult(data);
        toast(
          ids.length
            ? `Turned on ${ids.length} suggested ${ids.length === 1 ? 'setting' : 'settings'}.`
            : 'Okay. You can turn suggestions on any time from this card.'
        );
      } catch (err) {
        toast(friendlyError(err instanceof Response ? err : null, { action: 'save your choice' }), {
          kind: 'error',
        });
      }
    });
  }

  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-prof-review]')) {
      reviewing = true;
      render();
      return;
    }
    const replace = e.target.closest('[data-prof-replace]');
    if (replace) {
      const { preset, path } = replace.dataset;
      const ok = await confirmDialog({
        title: 'Replace this file?',
        message: `The profile's version replaces ${path}. The current file is saved and comes back if you turn this preset off.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
      await withBusy(replace, 'Replacing…', async () => {
        try {
          const { res, data } = await post('replace-file', { presetId: preset, path });
          if (!res.ok || data.ok === false) throw res;
          takeResult(data);
          toast('File replaced. Restart the server to load it.');
        } catch (err) {
          toast(friendlyError(err instanceof Response ? err : null, { action: 'replace that file' }), {
            kind: 'error',
          });
        }
      });
      return;
    }
    const notNow = e.target.closest('[data-prof-notnow]');
    if (notNow) return submitReview(notNow, []);
    const enable = e.target.closest('[data-prof-enable]');
    if (enable) {
      const ids = [...body.querySelectorAll('[data-prof-pick]:checked')].map((c) => c.dataset.profPick);
      return ids.length ? submitReview(enable, ids) : undefined;
    }
    const btn = e.target.closest('[data-prof-apply]');
    if (!btn) return;
    await withBusy(btn, 'Applying…', async () => {
      try {
        const { res, data } = await post('apply');
        if (!res.ok || data.ok === false) throw res;
        takeResult(data);
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
