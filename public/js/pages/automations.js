// Automation page: the list (toggle, run now, run history, delete) and the
// create/edit modal with its schedule preview and ordered, timed steps.

import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { openModal } from '../lib/modal.js';
import { confirmDialog } from '../lib/confirm.js';
import { enhanceAll } from '../lib/select.js';
import { withBusy } from '../lib/loading.js';
import { formatDateTime } from '../lib/datetime.js';
import { escapeHtml } from '../lib/format.js';

const dataEl = document.getElementById('msm-automation-data');
if (dataEl) init();

const UNITS = [
  { value: 'seconds', label: 'Seconds', secs: 1 },
  { value: 'minutes', label: 'Minutes', secs: 60 },
  { value: 'hours', label: 'Hours', secs: 3600 },
];
const MAX_OFFSET_SEC = 24 * 60 * 60;
const SELECT_CLASS = 'input w-auto';
const PREVIEW_HINT = 'Type a cron expression to preview the next runs.';

function init() {
  let editor;
  try {
    editor = JSON.parse(dataEl.dataset.editor || '{}');
  } catch {
    editor = {};
  }
  editor.servers ||= [];
  editor.actions ||= [];

  document.getElementById('automation-new')?.addEventListener('click', () => automationModal(editor));

  document.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-automation-row]');
    if (!row) return;
    const id = row.dataset.automationId;
    const name = row.dataset.automationName;

    const delBtn = e.target.closest('[data-automation-delete]');
    const runBtn = e.target.closest('[data-automation-run]');
    if (delBtn) {
      const ok = await confirmDialog({
        title: 'Delete this automation?',
        message: `${name} stops running immediately, and its run history is removed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await withBusy(delBtn, async () => {
        const res = await fetch(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          toast('Automation deleted.');
          setTimeout(() => location.reload(), 600);
        } else {
          toast(data.error || friendlyError(res, { action: 'delete that automation' }), { kind: 'error' });
        }
      });
    } else if (runBtn) {
      await withBusy(runBtn, async () => {
        const res = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) toast('Automation started. Its result shows under Last Result.');
        else toast(data.error || friendlyError(res, { action: 'start that automation' }), { kind: 'error' });
      });
    } else if (e.target.closest('[data-automation-edit]')) {
      let def = null;
      try {
        def = JSON.parse(row.dataset.def || 'null');
      } catch {
        /* fall through */
      }
      if (def) automationModal(editor, { id, def });
    } else if (e.target.closest('[data-automation-runs]')) {
      runsModal(editor, id, name);
    }
  });

  // Toggle: the checkbox is the source of truth; revert it if the API fails.
  document.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-automation-toggle]');
    if (!input) return;
    const row = input.closest('[data-automation-row]');
    const enabled = input.checked;
    input.disabled = true; // lock the switch while the request is in flight
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(row.dataset.automationId)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || friendlyError(res, { action: 'update that automation' }));
      }
      toast(`Automation ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      input.checked = !enabled;
      toast(err.message, { kind: 'error', timeout: 8000 });
    } finally {
      input.disabled = false;
    }
  });
}

// ---- Timing helpers -------------------------------------------------------

/** A step's offset in seconds as an amount, unit, and direction. */
function splitOffset(offsetSec) {
  const abs = Math.abs(offsetSec);
  const unit = abs > 0 && abs % 3600 === 0 ? 'hours' : abs > 0 && abs % 60 === 0 ? 'minutes' : 'seconds';
  const secs = UNITS.find((u) => u.value === unit).secs;
  return { amount: abs / secs, unit, dir: offsetSec < 0 ? 'before' : offsetSec > 0 ? 'after' : 'at' };
}

function offsetOf(step) {
  if (step.dir === 'at') return 0;
  const secs = UNITS.find((u) => u.value === step.unit).secs;
  return Math.round(Number(step.amount) * secs) * (step.dir === 'before' ? -1 : 1);
}

/** "5 minutes", "1 hour", "90 seconds". */
function describeSeconds(sec) {
  const n = sec % 3600 === 0 ? sec / 3600 : sec % 60 === 0 ? sec / 60 : sec;
  const unit = sec % 3600 === 0 ? 'hour' : sec % 60 === 0 ? 'minute' : 'second';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "5 minutes before", "At the schedule time", "30 seconds after" for a stored offset. */
function describeOffset(offsetSec) {
  if (offsetSec === 0) return 'At the schedule time';
  return `${describeSeconds(Math.abs(offsetSec))} ${offsetSec < 0 ? 'before' : 'after'}`;
}

function sqlToIso(value) {
  return value ? String(value).replace(' ', 'T') + 'Z' : '';
}

// ---- Run history ----------------------------------------------------------

const RUN_BADGES = {
  ok: ['badge-ok', 'OK'],
  failed: ['badge-danger', 'Failed'],
  skipped: ['badge-warn', 'Skipped'],
  aborted: ['badge-warn', 'Stopped'],
  running: ['badge-info', 'Running'],
  interrupted: ['badge-warn', 'Interrupted'],
};

function badge(status) {
  const [cls, label] = RUN_BADGES[status] || ['', status];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

async function runsModal(editor, id, name) {
  const content = document.createElement('div');
  content.innerHTML = '<p class="text-sm text-ink-faint">Loading the recent runs…</p>';
  openModal({ title: `Run History: ${name}`, content, size: 'lg', actions: [{ label: 'Close', kind: 'ghost' }] });
  const labels = new Map(editor.actions.map((a) => [a.key, a.label]));
  try {
    const res = await fetch(`/api/automations/${encodeURIComponent(id)}/runs`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || friendlyError(res, { action: 'load the run history' }));
    }
    if (!data.runs.length) {
      content.innerHTML = '<p class="text-sm text-ink-faint">This automation has not run yet.</p>';
      return;
    }
    content.innerHTML = `<ul class="space-y-3">${data.runs
      .map(
        (run) => `
      <li class="rounded-md border border-line bg-inset/40 p-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          ${badge(run.status)}
          <span class="font-medium">${escapeHtml(run.serverName || 'Panel')}</span>
          <span class="text-ink-faint">${escapeHtml(formatDateTime(sqlToIso(run.startedAt)))}</span>
        </div>
        <ol class="mt-2 space-y-1 text-sm">${run.steps
          .map(
            (s) => `
          <li class="flex flex-wrap items-baseline gap-x-2">
            ${badge(s.status)}
            <span>${escapeHtml(labels.get(s.action) || s.action)}</span>
            <span class="text-ink-faint">${escapeHtml(describeOffset(s.offsetSec))}</span>
            ${s.detail ? `<span class="w-full text-xs text-ink-faint sm:w-auto">${escapeHtml(s.detail)}</span>` : ''}
          </li>`
          )
          .join('')}</ol>
      </li>`
      )
      .join('')}</ul>`;
  } catch (err) {
    content.innerHTML = `<p class="text-sm text-danger">${escapeHtml(err.message)}</p>`;
  }
}

// ---- Editor ---------------------------------------------------------------

function automationModal(editor, edit = null) {
  const { servers, actions } = editor;
  const allowedKinds = [
    ...(servers.length ? [['servers', 'Servers']] : []),
    ...(editor.canAll ? [['all', 'All Servers']] : []),
    ...(editor.canPanel ? [['panel', 'Panel']] : []),
  ];
  const def = edit && edit.def;
  const state = {
    name: def ? def.name : '',
    kind: def ? def.targets.kind : allowedKinds[0] ? allowedKinds[0][0] : 'panel',
    serverIds: new Set(def && def.targets.kind === 'servers' ? def.targets.serverIds : []),
    cron: def ? def.trigger.cron : '',
    steps: def ? def.steps.map(stepFromDef) : [],
  };
  if (!def) state.steps = [newStep(state.kind)];

  /** Actions a step may use right now: the scope fits Runs On and the user may use it. */
  function allowedActions() {
    if (state.kind === 'panel') return actions.filter((a) => a.scope === 'panel' && (!a.adminOnly || editor.isAdmin));
    const picked = state.kind === 'servers' ? servers.filter((s) => state.serverIds.has(s.id)) : [];
    return actions.filter((a) => {
      if (a.scope !== 'server') return false;
      if (state.kind === 'all') return Boolean(editor.isAdmin);
      // Before any server is ticked, offer what at least one of them allows.
      const pool = picked.length ? picked : servers;
      return picked.length
        ? pool.every((s) => s.caps.includes(a.capability))
        : pool.some((s) => s.caps.includes(a.capability));
    });
  }

  function newStep(kind) {
    const first =
      kind === 'panel' ? actions.find((a) => a.scope === 'panel' && (!a.adminOnly || editor.isAdmin)) : null;
    return blankStep(first ? first.key : 'restart');
  }

  const content = document.createElement('div');
  content.innerHTML = `
    <label class="label" for="automation-name">Name</label>
    <input class="input" id="automation-name" maxlength="80" autocomplete="off" placeholder="Restart every 4 hours">

    <label class="label mt-4">Runs On</label>
    <div class="seg" role="group" aria-label="Runs On" data-au-kinds>
      ${allowedKinds
        .map(
          ([value, label]) =>
            `<button type="button" class="seg-btn" data-kind="${value}" aria-pressed="false">${label}</button>`
        )
        .join('')}
    </div>
    <div class="mt-3 hidden" data-au-servers>
      <div class="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line bg-inset/40 p-2" data-au-serverlist>
        ${servers
          .map(
            (s) =>
              `<label class="flex items-center gap-2 text-sm"><input type="checkbox" class="msm-check" value="${escapeHtml(s.id)}"> <span>${escapeHtml(s.name)}</span></label>`
          )
          .join('')}
      </div>
      <p class="help">Each chosen server runs the steps on its own.</p>
    </div>
    <p class="help hidden" data-au-allnote>Runs on every server, including ones created later.</p>

    <label class="label mt-4" for="automation-cron">Schedule</label>
    <input class="input font-mono" id="automation-cron" placeholder="0 */4 * * *" autocomplete="off" spellcheck="false">
    <p class="help">Five fields: minute hour day-of-month month day-of-week. Example: <b class="font-mono">0 4 * * *</b> is daily at 04:00.</p>
    <div class="mt-2 rounded-md border border-line bg-raised p-2.5 text-xs" data-au-preview aria-live="polite">
      <span class="text-ink-faint">${PREVIEW_HINT}</span>
    </div>
    <p class="help hidden" data-au-lead></p>

    <div class="mt-4 flex items-center justify-between gap-2">
      <h4 class="label mb-0">Steps</h4>
      <button type="button" class="btn btn-ghost btn-sm" data-au-addstep>Add Step</button>
    </div>
    <p class="help">Steps run in time order. Set a step before the schedule time to warn players ahead of it.</p>
    <div class="mt-2 space-y-2" data-au-steps></div>`;

  const q = (sel) => content.querySelector(sel);
  const nameInput = q('#automation-name');
  const cronInput = q('#automation-cron');
  const stepsEl = q('[data-au-steps]');
  nameInput.value = state.name;
  cronInput.value = state.cron;

  // ---- Runs On
  const syncKind = () => {
    for (const btn of content.querySelectorAll('[data-kind]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.kind === state.kind));
    }
    q('[data-au-servers]').classList.toggle('hidden', state.kind !== 'servers');
    q('[data-au-allnote]').classList.toggle('hidden', state.kind !== 'all');
  };
  for (const box of content.querySelectorAll('[data-au-serverlist] input')) {
    box.checked = state.serverIds.has(box.value);
    box.addEventListener('change', () => {
      if (box.checked) state.serverIds.add(box.value);
      else state.serverIds.delete(box.value);
      if (normalizeSteps()) renderSteps();
    });
  }
  q('[data-au-kinds]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]');
    if (!btn || btn.dataset.kind === state.kind) return;
    state.kind = btn.dataset.kind;
    syncKind();
    normalizeSteps();
    renderSteps();
  });

  /** Swap any step whose action no longer fits Runs On for the first one that does. True when something changed. */
  function normalizeSteps() {
    const ok = new Set(allowedActions().map((a) => a.key));
    const fallback = allowedActions()[0];
    let changed = false;
    for (const step of state.steps) {
      if (ok.has(step.action) || !fallback) continue;
      Object.assign(step, blankStep(fallback.key), { dir: step.dir, amount: step.amount, unit: step.unit });
      changed = true;
    }
    return changed;
  }

  // ---- Schedule preview
  const preview = q('[data-au-preview]');
  const leadHint = q('[data-au-lead]');
  let previewTimer;
  const currentLead = () => {
    const offsets = state.steps.map(offsetOf).filter(Number.isFinite);
    return Math.max(0, -Math.min(0, ...offsets));
  };
  const renderPreview = async () => {
    const lead = currentLead();
    leadHint.classList.toggle('hidden', !lead);
    leadHint.textContent = lead ? `Steps start ${describeSeconds(lead)} before each time.` : '';
    const expr = cronInput.value.trim();
    if (!expr) {
      preview.innerHTML = `<span class="text-ink-faint">${PREVIEW_HINT}</span>`;
      return;
    }
    try {
      const res = await fetch(`/api/automations/preview?cron=${encodeURIComponent(expr)}&lead=${lead}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        preview.innerHTML = `<span class="text-danger">${escapeHtml(data.error || 'That schedule is not valid.')}</span>`;
        return;
      }
      preview.innerHTML = `<span class="text-ink-faint">Next runs:</span>
        <ul class="mt-1 space-y-0.5 font-mono sm:flex sm:flex-wrap sm:gap-x-4 sm:space-y-0">${data.runs
          .map((iso) => `<li>${escapeHtml(formatDateTime(iso))}</li>`)
          .join('')}</ul>`;
    } catch {
      preview.innerHTML = '<span class="text-ink-faint">The preview is unavailable right now.</span>';
    }
  };
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 300);
  };
  cronInput.addEventListener('input', schedulePreview);

  // ---- Steps
  function paramsHtml(step) {
    const meta = actions.find((a) => a.key === step.action);
    if (!meta || !meta.form) return '';
    if (meta.form === 'message') {
      return `<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input class="input min-w-0 flex-1" data-f="text" maxlength="256" placeholder="Restarting in 5 minutes." aria-label="Message Text" autocomplete="off" value="${escapeHtml(step.text)}">
        <select class="${SELECT_CLASS}" data-f="mode" data-label="Message Style">
          <option value="tellraw"${step.mode === 'tellraw' ? ' selected' : ''}>Tellraw</option>
          <option value="say"${step.mode === 'say' ? ' selected' : ''}>Say</option>
        </select>
      </div>`;
    }
    if (meta.form === 'command') {
      return `<input class="input font-mono" data-f="command" maxlength="500" placeholder="say Back in a minute" aria-label="Command" autocomplete="off" spellcheck="false" value="${escapeHtml(step.command)}">`;
    }
    return `<label class="flex items-center gap-2 text-sm"><input type="checkbox" class="msm-check" data-f="shrink"${step.shrink ? ' checked' : ''}> Trim Unused Chunks After Backup <span class="text-xs text-ink-faint">(removes rarely-visited chunks; only runs while the server is stopped)</span></label>`;
  }

  function stepHtml(step, index) {
    const options = allowedActions();
    return `
      <div class="rounded-md border border-line bg-inset/40 p-3" data-au-step="${index}">
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div class="flex flex-wrap items-center gap-2">
            <input type="number" min="0" step="1" class="input w-20${step.dir === 'at' ? ' hidden' : ''}" data-f="amount" aria-label="Time Amount" value="${escapeHtml(String(step.amount))}">
            <select class="${SELECT_CLASS}${step.dir === 'at' ? ' hidden' : ''}" data-f="unit" data-label="Time Unit">
              ${UNITS.map((u) => `<option value="${u.value}"${u.value === step.unit ? ' selected' : ''}>${u.label}</option>`).join('')}
            </select>
            <select class="${SELECT_CLASS}" data-f="dir" data-label="Before or After">
              <option value="before"${step.dir === 'before' ? ' selected' : ''}>Before</option>
              <option value="at"${step.dir === 'at' ? ' selected' : ''}>At</option>
              <option value="after"${step.dir === 'after' ? ' selected' : ''}>After</option>
            </select>
          </div>
          <select class="${SELECT_CLASS}" data-f="action" data-label="Action">
            ${options.map((a) => `<option value="${a.key}"${a.key === step.action ? ' selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}
          </select>
          <select class="${SELECT_CLASS}" data-f="onFailure" data-label="On Failure">
            <option value="stop"${step.onFailure === 'stop' ? ' selected' : ''}>On Failure: Stop</option>
            <option value="continue"${step.onFailure === 'continue' ? ' selected' : ''}>On Failure: Continue</option>
          </select>
          <button type="button" class="btn btn-ghost btn-sm self-start text-danger sm:ml-auto sm:self-auto" data-au-remove aria-label="Remove Step ${index + 1}" data-tip="Remove this step."><svg class="icon size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
        <div class="mt-2 empty:hidden">${paramsHtml(step)}</div>
      </div>`;
  }

  function renderSteps() {
    stepsEl.innerHTML = state.steps.map(stepHtml).join('');
    enhanceAll(stepsEl);
    schedulePreview();
  }

  stepsEl.addEventListener('input', onStepEdit);
  stepsEl.addEventListener('change', onStepEdit);
  function onStepEdit(e) {
    const field = e.target.dataset && e.target.dataset.f;
    const rowEl = e.target.closest('[data-au-step]');
    if (!field || !rowEl) return;
    const step = state.steps[Number(rowEl.dataset.auStep)];
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.type === 'input' && e.target.tagName === 'SELECT') return;
    step[field] = value;
    if (field === 'action') {
      Object.assign(step, blankStep(value), {
        dir: step.dir,
        amount: step.amount,
        unit: step.unit,
        onFailure: step.onFailure,
      });
      renderSteps();
    } else if (field === 'dir') {
      // "At" has no amount; switching away from it needs a number to show.
      if (value !== 'at' && !Number(step.amount)) step.amount = 1;
      renderSteps();
    } else if (field === 'amount' || field === 'unit') {
      schedulePreview();
    }
  }
  stepsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-au-remove]');
    if (!rm) return;
    if (state.steps.length === 1) {
      toast('An automation needs at least one step.', { kind: 'error' });
      return;
    }
    state.steps.splice(Number(rm.closest('[data-au-step]').dataset.auStep), 1);
    renderSteps();
  });
  q('[data-au-addstep]').addEventListener('click', () => {
    if (state.steps.length >= 20) {
      toast('An automation can have up to 20 steps.', { kind: 'error' });
      return;
    }
    const last = state.steps[state.steps.length - 1];
    const next = blankStep(allowedActions()[0] ? allowedActions()[0].key : 'restart');
    if (last)
      Object.assign(next, {
        dir: last.dir === 'at' ? 'after' : last.dir,
        amount: last.dir === 'at' ? 1 : last.amount,
        unit: last.unit,
      });
    state.steps.push(next);
    renderSteps();
  });

  syncKind();
  normalizeSteps();
  renderSteps();
  if (def) renderPreview();

  openModal({
    title: edit ? `Edit Automation: ${state.name}` : 'New Automation',
    content,
    size: 'lg',
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: edit ? 'Save Changes' : 'Create Automation',
        kind: 'primary',
        busyLabel: edit ? 'Saving…' : 'Creating…',
        onClick: async () => {
          const problem = validate();
          if (problem) {
            toast(problem, { kind: 'error' });
            return false;
          }
          const body = {
            name: nameInput.value.trim(),
            enabled: def ? def.enabled : true,
            targets:
              state.kind === 'servers' ? { kind: 'servers', serverIds: [...state.serverIds] } : { kind: state.kind },
            trigger: { type: 'schedule', cron: cronInput.value.trim() },
            // Time order, earliest first; equal times keep the order they were listed in.
            steps: state.steps
              .map((s) => ({ offsetSec: offsetOf(s), action: s.action, params: paramsOf(s), onFailure: s.onFailure }))
              .sort((a, b) => a.offsetSec - b.offsetSec),
          };
          try {
            const res = await fetch(edit ? `/api/automations/${encodeURIComponent(edit.id)}` : '/api/automations', {
              method: edit ? 'PUT' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) {
              throw new Error(data.error || friendlyError(res, { action: 'save that automation' }));
            }
            toast(edit ? 'Automation updated.' : 'Automation created.');
            setTimeout(() => location.reload(), 600);
          } catch (err) {
            toast(err.message, { kind: 'error', timeout: 9000 });
            return false;
          }
        },
      },
    ],
  });

  /** A sentence for the first thing wrong with the form, or '' when it can be saved. */
  function validate() {
    if (!nameInput.value.trim()) return 'Give the automation a name.';
    if (state.kind === 'servers' && !state.serverIds.size) return 'Pick at least one server to run on.';
    if (!cronInput.value.trim()) return 'Enter a schedule as a cron expression.';
    for (const [i, s] of state.steps.entries()) {
      const label = `Step ${i + 1}`;
      if (s.dir !== 'at') {
        const amount = Number(s.amount);
        if (!Number.isInteger(amount) || amount < 0) return `${label} needs a whole number for its time.`;
        if (Math.abs(offsetOf(s)) > MAX_OFFSET_SEC) return `${label} is more than 24 hours from the schedule time.`;
      }
      const meta = actions.find((a) => a.key === s.action);
      if (meta && meta.form === 'message' && !s.text.trim()) return `${label} needs a message to send.`;
      if (meta && meta.form === 'command' && !s.command.trim()) return `${label} needs a command to run.`;
    }
    return '';
  }

  function paramsOf(step) {
    const meta = actions.find((a) => a.key === step.action);
    if (!meta || !meta.form) return {};
    if (meta.form === 'message') return { text: step.text.trim(), mode: step.mode };
    if (meta.form === 'command') return { command: step.command.trim() };
    return step.shrink ? { shrink: true } : {};
  }
}

function blankStep(action) {
  return {
    action,
    dir: 'at',
    amount: 5,
    unit: 'minutes',
    onFailure: 'stop',
    text: '',
    mode: 'tellraw',
    command: '',
    shrink: false,
  };
}

function stepFromDef(s) {
  const { amount, unit, dir } = splitOffset(s.offsetSec);
  const p = s.params || {};
  return {
    ...blankStep(s.action),
    dir,
    amount: dir === 'at' ? 5 : amount,
    unit: dir === 'at' ? 'minutes' : unit,
    onFailure: s.onFailure || 'stop',
    text: p.text || '',
    mode: p.mode || 'tellraw',
    command: p.command || '',
    shrink: Boolean(p.shrink),
  };
}
