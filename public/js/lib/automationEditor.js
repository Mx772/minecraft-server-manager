// The automation editor, shared by the Automation page and the server's
// Automation tab: the create/edit modal with its schedule preview and ordered,
// timed steps (each with an optional "Only If" condition).

import { toast } from './toast.js';
import { friendlyError } from './errors.js';
import { openModal } from './modal.js';
import { enhanceAll } from './select.js';
import { formatDateTime } from './datetime.js';
import { escapeHtml, fmtBytes } from './format.js';

const UNITS = [
  { value: 'seconds', label: 'Seconds', secs: 1 },
  { value: 'minutes', label: 'Minutes', secs: 60 },
  { value: 'hours', label: 'Hours', secs: 3600 },
];
const MAX_OFFSET_SEC = 24 * 60 * 60;
const SELECT_CLASS = 'input w-auto';
const PREVIEW_HINT = 'Type a cron expression to preview the next runs.';

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
export function describeSeconds(sec) {
  const n = sec % 3600 === 0 ? sec / 3600 : sec % 60 === 0 ? sec / 60 : sec;
  const unit = sec % 3600 === 0 ? 'hour' : sec % 60 === 0 ? 'minute' : 'second';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "5 minutes before", "At the schedule time", "30 seconds after" for a stored offset. */
export function describeOffset(offsetSec) {
  if (offsetSec === 0) return 'At the schedule time';
  return `${describeSeconds(Math.abs(offsetSec))} ${offsetSec < 0 ? 'before' : 'after'}`;
}

export function sqlToIso(value) {
  return value ? String(value).replace(' ', 'T') + 'Z' : '';
}

/** The Runs On choices this user is offered, as [value, label] pairs. */
export function editorKinds(editor) {
  return [
    ...(editor.servers.length ? [['servers', 'Servers']] : []),
    ...(editor.canAll ? [['all', 'All Servers']] : []),
    ...(editor.canPanel ? [['panel', 'Panel']] : []),
  ];
}

/**
 * The trigger in words: the cron expression, or "After the server crashes".
 * @returns {{ text: string, mono: boolean }}
 */
export function describeTrigger(trigger, editor) {
  if (!trigger || trigger.type !== 'event') return { text: (trigger && trigger.cron) || '', mono: true };
  const info = (editor.events || []).find((e) => e.key === trigger.event);
  const when = info ? info.when : 'when something happens';
  return { text: when.charAt(0).toUpperCase() + when.slice(1), mono: false };
}

const COPY_MODES = [
  ['overwrite', 'Overwrite'],
  ['skip-existing', 'Skip Existing Files'],
  ['only-if-newer', 'Only If Newer'],
];
const COPY_MODE_WORDS = {
  overwrite: 'overwrite',
  'skip-existing': 'skip existing files',
  'only-if-newer': 'only if newer',
};

/** A file step in plain words ("Copy custom/kubejs to kubejs (overwrite)"), or '' for any other step. */
export function describeFileStep(step) {
  const p = step.params || {};
  if (step.action === 'copy-files') {
    const extra = p.include && p.include !== '**' ? `, matching ${p.include}` : '';
    return `Copy ${p.from || ''} to ${p.to || ''} (${COPY_MODE_WORDS[p.mode || 'overwrite']}${extra})`;
  }
  if (step.action === 'delete-files') return `Delete ${p.include || ''} in ${p.path || ''}`;
  return '';
}

/** "Only if the server is running", "Only if at least 3 players are online", or '' for none. */
export function describeCondition(condition) {
  if (!condition) return '';
  if (condition.type === 'server-running') return 'Only if the server is running.';
  if (condition.type === 'no-players') return 'Only if no players are online.';
  const min = condition.min || 1;
  return `Only if at least ${min} ${min === 1 ? 'player is' : 'players are'} online.`;
}

// ---- Editor ---------------------------------------------------------------

/**
 * Open the create/edit modal.
 * @param {{ editor: object, id?: string | null, def?: object | null, presetServerId?: string,
 *   onSaved?: (data: object) => void }} opts
 *   id: edit this automation; def alone (a template) pre-fills a new one;
 *   presetServerId: tick this server for a new one on Servers.
 */
export function openAutomationEditor({ editor, id = null, def = null, presetServerId = '', onSaved }) {
  const edit = id ? { id, def } : null;
  const { servers, actions } = editor;
  const allowedKinds = editorKinds(editor);
  const eventNames = (editor.events || []).map((e) => e.key);
  const wantedKind = def ? def.targets.kind : '';
  const state = {
    name: def ? def.name : '',
    kind: allowedKinds.some(([k]) => k === wantedKind) ? wantedKind : allowedKinds[0] ? allowedKinds[0][0] : 'panel',
    serverIds: new Set(
      def && def.targets.kind === 'servers' && def.targets.serverIds.length
        ? def.targets.serverIds
        : servers.some((s) => s.id === presetServerId)
          ? [presetServerId]
          : []
    ),
    when: def && def.trigger.type === 'event' ? 'event' : 'schedule',
    event: def && def.trigger.type === 'event' ? def.trigger.event : eventNames[0] || 'after-start',
    cron: def && def.trigger.type === 'schedule' ? def.trigger.cron : '',
    steps: def ? def.steps.map(stepFromDef) : [],
  };
  // An event runs for a server, never for the panel.
  if (state.when === 'event' && state.kind === 'panel')
    state.kind = allowedKinds.find(([k]) => k !== 'panel')?.[0] || 'servers';
  if (!def) state.steps = [newStep(state.kind)];

  /** Actions a step may use right now: the scope fits Runs On and the user may use it. */
  function allowedActions() {
    if (state.kind === 'panel') return actions.filter((a) => a.scope === 'panel' && (!a.adminOnly || editor.isAdmin));
    const picked = state.kind === 'servers' ? servers.filter((s) => state.serverIds.has(s.id)) : [];
    return actions.filter((a) => {
      if (a.scope !== 'server') return false;
      if (state.when === 'event' && !(a.events || []).includes(state.event)) return false;
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

    <label class="label mt-4">When</label>
    <div class="seg" role="group" aria-label="When" data-au-when>
      <button type="button" class="seg-btn" data-when="schedule" aria-pressed="false">On A Schedule</button>
      <button type="button" class="seg-btn" data-when="event" aria-pressed="false">When Something Happens</button>
    </div>

    <div data-au-schedule>
      <label class="label mt-3" for="automation-cron">Schedule</label>
      <input class="input font-mono" id="automation-cron" placeholder="0 */4 * * *" autocomplete="off" spellcheck="false">
      <p class="help">Five fields: minute hour day-of-month month day-of-week. Example: <b class="font-mono">0 4 * * *</b> is daily at 04:00.</p>
      <div class="mt-2 rounded-md border border-line bg-raised p-2.5 text-xs" data-au-preview aria-live="polite">
        <span class="text-ink-faint">${PREVIEW_HINT}</span>
      </div>
      <p class="help hidden" data-au-lead></p>
    </div>

    <div class="hidden" data-au-event>
      <label class="label mt-3">Event</label>
      <select class="input w-auto" data-au-eventselect data-label="Event">
        ${(editor.events || []).map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.label)}</option>`).join('')}
      </select>
      <p class="help" data-au-eventhint></p>
    </div>

    <div class="mt-4 space-y-2 empty:hidden" data-au-warnings aria-live="polite"></div>

    <div class="mt-4 flex items-center justify-between gap-2">
      <h4 class="label mb-0">Steps</h4>
      <button type="button" class="btn btn-ghost btn-sm" data-au-addstep>Add Step</button>
    </div>
    <p class="help" data-au-stepshelp></p>
    <div class="mt-2 space-y-2" data-au-steps></div>`;

  const q = (sel) => content.querySelector(sel);
  const nameInput = q('#automation-name');
  const cronInput = q('#automation-cron');
  const stepsEl = q('[data-au-steps]');
  nameInput.value = state.name;
  cronInput.value = state.cron;
  const eventSelect = q('[data-au-eventselect]');
  eventSelect.value = state.event;

  // ---- When
  const syncWhen = () => {
    const isEvent = state.when === 'event';
    for (const btn of content.querySelectorAll('[data-when]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.when === state.when));
    }
    q('[data-au-schedule]').classList.toggle('hidden', isEvent);
    q('[data-au-event]').classList.toggle('hidden', !isEvent);
    const info = (editor.events || []).find((e) => e.key === state.event);
    q('[data-au-eventhint]').textContent = info ? info.hint : '';
    q('[data-au-stepshelp]').textContent = isEvent
      ? 'Steps run in time order, up to an hour after the event.'
      : 'Steps run in time order. Set a step before the schedule time to warn players ahead of it.';
    // The panel has no server to have an event.
    const panelBtn = content.querySelector('[data-kind="panel"]');
    if (panelBtn) panelBtn.classList.toggle('hidden', isEvent);
  };
  q('[data-au-when]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-when]');
    if (!btn || btn.dataset.when === state.when) return;
    state.when = btn.dataset.when;
    if (state.when === 'event' && state.kind === 'panel') {
      state.kind = allowedKinds.find(([k]) => k !== 'panel')?.[0] || 'servers';
      syncKind();
    }
    syncWhen();
    normalizeSteps();
    renderSteps();
  });
  eventSelect.addEventListener('change', () => {
    state.event = eventSelect.value;
    syncWhen();
    normalizeSteps();
    renderSteps();
  });

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
      scheduleWarnings();
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

  /** The timing choices a step has: any for a schedule, At and After for an event, only At before a start. */
  function dirsFor() {
    if (state.when !== 'event') return ['before', 'at', 'after'];
    return state.event === 'before-start' ? ['at'] : ['at', 'after'];
  }

  /** Swap any step whose action no longer fits Runs On for the first one that does. True when something changed. */
  function normalizeSteps() {
    const ok = new Set(allowedActions().map((a) => a.key));
    const fallback = allowedActions()[0];
    let changed = false;
    for (const step of state.steps) {
      // An event has no "before", and a start that has not happened yet allows no delay at all.
      const allowedDirs = dirsFor();
      if (!allowedDirs.includes(step.dir)) {
        step.dir = allowedDirs[0];
        changed = true;
      }
      if (ok.has(step.action) || !fallback) continue;
      Object.assign(step, blankStep(fallback.key), {
        dir: step.dir,
        amount: step.amount,
        unit: step.unit,
        cond: step.cond,
        min: step.min,
      });
      changed = true;
    }
    return changed;
  }

  // ---- Schedule preview
  const preview = q('[data-au-preview]');
  const leadHint = q('[data-au-lead]');
  let previewTimer;
  const currentLead = () => {
    if (state.when === 'event') return 0;
    const offsets = state.steps.map(offsetOf).filter(Number.isFinite);
    return Math.max(0, -Math.min(0, ...offsets));
  };
  const renderPreview = async () => {
    if (state.when === 'event') return;
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
  cronInput.addEventListener('input', () => {
    schedulePreview();
    scheduleWarnings();
  });

  // ---- Pack warnings: sentences about the file steps, never a reason to refuse saving.
  const warningsEl = q('[data-au-warnings]');
  let warningsTimer;
  let warningsSeq = 0;
  function scheduleWarnings() {
    clearTimeout(warningsTimer);
    warningsTimer = setTimeout(async () => {
      const seq = ++warningsSeq;
      let sentences = [];
      if (hasFileStep() && (state.kind !== 'servers' || state.serverIds.size)) {
        try {
          const res = await fetch('/api/automations/warnings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ definition: definitionBody() }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok !== false) sentences = data.warnings || [];
        } catch {
          /* a warning that cannot load is just not shown */
        }
      }
      if (seq !== warningsSeq) return;
      warningsEl.innerHTML = sentences.map((w) => `<div class="notice notice-warn">${escapeHtml(w)}</div>`).join('');
    }, 600);
  }

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
    if (meta.form === 'copy') {
      return `<div class="grid gap-2 sm:grid-cols-2">
        <div><label class="label">From</label><input class="input font-mono" data-f="from" maxlength="300" placeholder="custom/kubejs" autocomplete="off" spellcheck="false" value="${escapeHtml(step.from)}"></div>
        <div><label class="label">To</label><input class="input font-mono" data-f="to" maxlength="300" placeholder="kubejs" autocomplete="off" spellcheck="false" value="${escapeHtml(step.to)}"></div>
        <div><label class="label">Mode</label><select class="input w-auto" data-f="fmode" data-label="Mode">${COPY_MODES.map(([v, l]) => `<option value="${v}"${step.fmode === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label class="label">Include</label><input class="input font-mono" data-f="include" maxlength="200" placeholder="**" autocomplete="off" spellcheck="false" value="${escapeHtml(step.include)}"></div>
      </div>
      <p class="help">Both paths are inside the server's folder. <code>*.json</code> matches the top level only; <code>**/*.json</code> matches every level.</p>`;
    }
    if (meta.form === 'delete') {
      return `<div class="grid gap-2 sm:grid-cols-2">
        <div><label class="label">Path</label><input class="input font-mono" data-f="path" maxlength="300" placeholder="logs" autocomplete="off" spellcheck="false" value="${escapeHtml(step.path)}"></div>
        <div><label class="label">Include</label><input class="input font-mono" data-f="include" maxlength="200" placeholder="**/*.log" autocomplete="off" spellcheck="false" value="${escapeHtml(step.include)}"></div>
      </div>
      <p class="help"><code>*.json</code> matches the top level only; <code>**/*.json</code> matches every level.</p>
      <div class="notice notice-warn">Deleted files can't be recovered unless a backup has them.</div>`;
    }
    if (meta.form === 'discord') {
      return `<textarea class="input" data-f="message" rows="2" maxlength="500" placeholder="The server just crashed." aria-label="Discord Message">${escapeHtml(step.message)}</textarea>
        <p class="help">Posts to the server's Discord webhook, which you set up on its Discord settings page.</p>`;
    }
    if (meta.form === 'command') {
      return `<input class="input font-mono" data-f="command" maxlength="500" placeholder="say Back in a minute" aria-label="Command" autocomplete="off" spellcheck="false" value="${escapeHtml(step.command)}">`;
    }
    return `<label class="flex items-center gap-2 text-sm"><input type="checkbox" class="msm-check" data-f="shrink"${step.shrink ? ' checked' : ''}> Trim Unused Chunks After Backup <span class="text-xs text-ink-faint">(removes rarely-visited chunks; only runs while the server is stopped)</span></label>`;
  }

  /** "Only If" for server steps: skip the step unless the server (or its players) is in the right state. */
  function conditionHtml(step) {
    const meta = actions.find((a) => a.key === step.action);
    if (!meta || meta.scope !== 'server') return '';
    const option = (value, label) =>
      `<option value="${value}"${step.cond === value ? ' selected' : ''}>${label}</option>`;
    return `<div class="flex flex-wrap items-center gap-2">
      <span class="text-sm text-ink-faint">Only If</span>
      <select class="${SELECT_CLASS}" data-f="cond" data-label="Only If">
        ${option('always', 'Always')}${option('server-running', 'Server Is Running')}${option('players-online', 'Players Online')}${option('no-players', 'No Players Online')}
      </select>
      ${
        step.cond === 'players-online'
          ? `<span class="text-sm text-ink-faint">At least</span>
      <input type="number" min="1" max="500" step="1" class="input w-20" data-f="min" aria-label="Minimum Players" value="${escapeHtml(String(step.min))}">
      <span class="text-sm text-ink-faint">players</span>`
          : ''
      }
    </div>`;
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
              ${dirsFor()
                .map(
                  (d) =>
                    `<option value="${d}"${step.dir === d ? ' selected' : ''}>${d === 'at' ? (state.when === 'event' ? 'When It Happens' : 'At') : d === 'before' ? 'Before' : 'After'}</option>`
                )
                .join('')}
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
        <div class="mt-2 space-y-2 empty:hidden">${paramsHtml(step)}${conditionHtml(step)}</div>
      </div>`;
  }

  function renderSteps() {
    stepsEl.innerHTML = state.steps.map(stepHtml).join('');
    enhanceAll(stepsEl);
    schedulePreview();
    scheduleWarnings();
    syncDryRun();
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
    scheduleWarnings();
    if (field === 'action') {
      Object.assign(step, blankStep(value), {
        dir: step.dir,
        amount: step.amount,
        unit: step.unit,
        onFailure: step.onFailure,
        cond: step.cond,
        min: step.min,
      });
      renderSteps();
    } else if (field === 'cond') {
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

  const definitionBody = () => ({
    name: nameInput.value.trim() || 'Untitled',
    enabled: edit && def ? def.enabled : true,
    targets: state.kind === 'servers' ? { kind: 'servers', serverIds: [...state.serverIds] } : { kind: state.kind },
    trigger: triggerBody(),
    steps: stepsBody(),
  });
  const isFileStep = (s) => s.action === 'copy-files' || s.action === 'delete-files';
  const hasFileStep = () => state.steps.some(isFileStep);
  const hasDeleteStep = () => state.steps.some((s) => s.action === 'delete-files');
  // A dry run covers the servers and file steps as they are now; changing either makes it stale.
  const dryRunSignature = () =>
    JSON.stringify([state.kind, [...state.serverIds].sort(), stepsBody().filter(isFileStep)]);
  let dryRunDone = '';
  let dryRunBtn = null;

  /** Dry Run only shows while the form has a file step. */
  function syncDryRun() {
    if (dryRunBtn) dryRunBtn.classList.toggle('hidden', !hasFileStep());
  }

  /** Pick the server to try the file steps on, then show what they would do. */
  async function startDryRun() {
    const problem = validate();
    if (problem) {
      toast(problem, { kind: 'error' });
      return;
    }
    const pool = state.kind === 'servers' ? servers.filter((s) => state.serverIds.has(s.id)) : servers;
    if (!pool.length) {
      toast('There is no server to try this on.', { kind: 'error' });
      return;
    }
    if (pool.length === 1) return runDryRun(pool[0]);
    const pick = document.createElement('div');
    pick.innerHTML = `<label class="label">Server</label>
      <select class="input" data-au-dryserver data-label="Server">${pool.map((sv) => `<option value="${escapeHtml(sv.id)}">${escapeHtml(sv.name)}</option>`).join('')}</select>
      <p class="help">Shows what the file steps would do on this server. Nothing is changed.</p>`;
    openModal({
      title: 'Dry Run On Which Server',
      content: pick,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Run Dry Run',
          kind: 'primary',
          busyLabel: 'Checking…',
          onClick: async () => {
            const chosen = pool.find((sv) => sv.id === pick.querySelector('[data-au-dryserver]').value);
            await runDryRun(chosen);
          },
        },
      ],
    });
  }

  async function runDryRun(server) {
    const signature = dryRunSignature();
    let data;
    try {
      const res = await fetch('/api/automations/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: definitionBody(), serverId: server.id }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false)
        throw new Error(data.error || friendlyError(res, { action: 'run the dry run' }));
    } catch (err) {
      toast(err.message, { kind: 'error', timeout: 9000 });
      return;
    }
    const fileSteps = data.steps.filter((st) => st.fileStep);
    // A step the panel refuses would fail for real too, so it does not count as a look at the result.
    if (fileSteps.every((st) => !st.error)) dryRunDone = signature;
    showDryRun(server, data);
  }

  function showDryRun(server, data) {
    const content = document.createElement('div');
    const fileSteps = data.steps.filter((st) => st.fileStep);
    content.innerHTML = `
      ${(data.warnings || []).map((w) => `<div class="notice notice-warn mb-3">${escapeHtml(w)}</div>`).join('')}
      ${fileSteps.map(dryRunStepHtml).join('') || '<p class="text-sm text-ink-faint">There are no file steps to check.</p>'}`;
    openModal({
      title: `Dry Run: ${server.name}`,
      content,
      size: 'lg',
      actions: [{ label: 'Close', kind: 'ghost' }],
    });
  }

  function dryRunStepHtml(st) {
    const step = state.steps[st.index];
    const phrase = step ? describeFileStep({ action: st.action, params: paramsOf(step) }) : '';
    const head = `<h4 class="label">Step ${st.index + 1}: ${escapeHtml((actions.find((x) => x.key === st.action) || { label: st.label }).label)}</h4><p class="mb-2 text-sm text-ink-faint">${escapeHtml(phrase)}</p>`;
    if (st.error)
      return `<section class="mb-4">${head}<div class="notice notice-danger">${escapeHtml(st.error)}</div></section>`;
    const t = st.totals;
    const parts = [];
    if (t.create) parts.push(`${t.create} new`);
    if (t.overwrite) parts.push(`${t.overwrite} overwritten`);
    if (t.skip) parts.push(`${t.skip} skipped`);
    if (t.delete) parts.push(`${t.delete} deleted`);
    const totals = t.files
      ? `${t.files} ${t.files === 1 ? 'file' : 'files'} (${fmtBytes(t.bytes)}): ${parts.join(', ')}.`
      : 'No files match, so nothing would change.';
    const badge = {
      create: ['badge-ok', 'Create'],
      overwrite: ['badge-warn', 'Overwrite'],
      delete: ['badge-danger', 'Delete'],
      skip: ['', 'Skip'],
    };
    return `<section class="mb-4">${head}<p class="mb-2 text-sm">${escapeHtml(totals)}</p>
      ${
        st.files.length
          ? `<ul class="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line bg-inset/40">${st.files
              .map((f) => {
                const [cls, label] = badge[f.change] || ['', f.change];
                return `<li class="flex items-center gap-2 px-3 py-1.5 text-xs"><span class="badge ${cls}">${label}</span><span class="min-w-0 break-all font-mono">${escapeHtml(f.path)}</span></li>`;
              })
              .join('')}</ul>`
          : ''
      }
      ${st.truncated ? `<p class="mt-1 text-xs text-ink-faint">and ${st.truncated} more.</p>` : ''}</section>`;
  }

  const triggerBody = () =>
    state.when === 'event' ? { type: 'event', event: state.event } : { type: 'schedule', cron: cronInput.value.trim() };

  /** The steps as the API takes them: time order, earliest first (equal times keep the order listed). */
  const stepsBody = () =>
    state.steps
      .map((s) => {
        const meta = actions.find((a) => a.key === s.action);
        const condition =
          meta && meta.scope === 'server' && s.cond !== 'always'
            ? s.cond === 'players-online'
              ? { type: s.cond, min: Number(s.min) }
              : { type: s.cond }
            : undefined;
        return {
          offsetSec: offsetOf(s),
          action: s.action,
          params: paramsOf(s),
          onFailure: s.onFailure,
          ...(condition ? { condition } : {}),
        };
      })
      .sort((a, b) => a.offsetSec - b.offsetSec);

  syncKind();
  syncWhen();
  normalizeSteps();
  renderSteps();
  if (def) renderPreview();

  const modal = openModal({
    title: edit ? `Edit Automation: ${state.name}` : 'New Automation',
    content,
    size: 'lg',
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Dry Run',
        kind: 'ghost',
        busyLabel: 'Checking…',
        onClick: async () => {
          await startDryRun();
          return false; // stay in the editor
        },
      },
      {
        label: 'Save As Template',
        kind: 'ghost',
        busyLabel: 'Saving…',
        onClick: async () => {
          const problem = validate({ needServers: false });
          if (problem) {
            toast(problem, { kind: 'error' });
            return false;
          }
          try {
            const res = await fetch('/api/automations/templates', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: nameInput.value.trim(),
                description: '',
                targetsKind: state.kind,
                trigger: triggerBody(),
                steps: stepsBody(),
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) {
              throw new Error(data.error || friendlyError(res, { action: 'save that template' }));
            }
            toast('Template saved.');
          } catch (err) {
            toast(err.message, { kind: 'error', timeout: 9000 });
          }
          return false; // stay in the editor
        },
      },
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
          const body = definitionBody();
          if (hasDeleteStep() && dryRunDone !== dryRunSignature()) {
            toast('Run Dry Run first to see what Delete Files would remove, then save.', { kind: 'error' });
            return false;
          }
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
            if (onSaved) onSaved(data);
            else setTimeout(() => location.reload(), 600);
          } catch (err) {
            toast(err.message, { kind: 'error', timeout: 9000 });
            return false;
          }
        },
      },
    ],
  });

  dryRunBtn = [...modal.el.querySelectorAll('button')].find((b) => b.textContent === 'Dry Run') || null;
  syncDryRun();

  /** A sentence for the first thing wrong with the form, or '' when it can be saved. */
  function validate({ needServers = true } = {}) {
    if (!nameInput.value.trim()) return 'Give the automation a name.';
    if (needServers && state.kind === 'servers' && !state.serverIds.size) return 'Pick at least one server to run on.';
    if (state.when === 'schedule' && !cronInput.value.trim()) return 'Enter a schedule as a cron expression.';
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
      if (meta && meta.form === 'copy' && (!s.from.trim() || !s.to.trim()))
        return `${label} needs a From and a To path.`;
      if (meta && meta.form === 'delete' && (!s.path.trim() || !s.include.trim())) {
        return `${label} needs a Path and an Include pattern.`;
      }
      if (meta && meta.form === 'discord' && !s.message.trim()) return `${label} needs a message to post.`;
      if (state.when === 'event' && s.dir === 'after' && Math.abs(offsetOf(s)) > 3600) {
        return `${label} can wait up to 1 hour after the event.`;
      }
      if (meta && meta.scope === 'server' && s.cond === 'players-online') {
        const min = Number(s.min);
        if (!Number.isInteger(min) || min < 1 || min > 500) return `${label} needs a player count from 1 to 500.`;
      }
    }
    return '';
  }

  function paramsOf(step) {
    const meta = actions.find((a) => a.key === step.action);
    if (!meta || !meta.form) return {};
    if (meta.form === 'message') return { text: step.text.trim(), mode: step.mode };
    if (meta.form === 'command') return { command: step.command.trim() };
    if (meta.form === 'discord') return { message: step.message.trim() };
    if (meta.form === 'copy') {
      const include = step.include.trim();
      return { from: step.from.trim(), to: step.to.trim(), mode: step.fmode, ...(include ? { include } : {}) };
    }
    if (meta.form === 'delete') return { path: step.path.trim(), include: step.include.trim() };
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
    message: '',
    from: '',
    to: '',
    fmode: 'overwrite',
    include: '',
    path: '',
    shrink: false,
    cond: 'always',
    min: 1,
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
    message: p.message || '',
    from: p.from || '',
    to: p.to || '',
    fmode: p.mode || 'overwrite',
    include: p.include || '',
    path: p.path || '',
    shrink: Boolean(p.shrink),
    cond: s.condition ? s.condition.type : 'always',
    min: s.condition && s.condition.min ? s.condition.min : 1,
  };
}
