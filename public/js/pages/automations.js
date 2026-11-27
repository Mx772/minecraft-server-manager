// Automation page wiring (also used by the server's Automation tab): the list
// (toggle, run now, run history, delete) and the buttons that open the editor,
// the template picker, and the template import. The editor itself lives in
// lib/automationEditor.js.

import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { openModal } from '../lib/modal.js';
import { confirmDialog } from '../lib/confirm.js';
import { withBusy } from '../lib/loading.js';
import { formatDateTime } from '../lib/datetime.js';
import { escapeHtml } from '../lib/format.js';
import { describeOffset, openAutomationEditor, sqlToIso } from '../lib/automationEditor.js';
import { importTemplateFile, openTemplatePicker } from '../lib/automationTemplates.js';

const dataEl = document.getElementById('msm-automation-data');
if (dataEl) init();

function init() {
  let editor;
  try {
    editor = JSON.parse(dataEl.dataset.editor || '{}');
  } catch {
    editor = {};
  }
  editor.servers ||= [];
  editor.actions ||= [];

  const presetServerId = dataEl.dataset.serverId || '';
  const reload = () => setTimeout(() => location.reload(), 600);
  // On the page, New Automation starts at the template picker; on a server's tab it goes straight to the editor.
  document.getElementById('automation-new')?.addEventListener('click', () => {
    if (presetServerId) openAutomationEditor({ editor, presetServerId, onSaved: reload });
    else openTemplatePicker({ editor, onSaved: reload });
  });
  document
    .getElementById('automation-from-template')
    ?.addEventListener('click', () => openTemplatePicker({ editor, presetServerId, onSaved: reload }));
  const importFile = document.getElementById('automation-import-file');
  document.getElementById('automation-import')?.addEventListener('click', () => importFile?.click());
  importFile?.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = '';
    if (file) await importTemplateFile(file, { editor });
  });

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
      if (def) openAutomationEditor({ editor, id, def, onSaved: reload });
    } else if (e.target.closest('[data-automation-runs]')) {
      runsModal(editor, id, name, row.dataset.automationTrigger);
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

async function runsModal(editor, id, name, trigger) {
  const content = document.createElement('div');
  content.innerHTML = '<p class="text-sm text-ink-faint">Loading the recent runs…</p>';
  openModal({ title: `Run History: ${name}`, content, size: 'lg', actions: [{ label: 'Close', kind: 'ghost' }] });
  const labels = new Map(editor.actions.map((a) => [a.key, a.label]));
  const head = trigger ? `<p class="mb-3 text-sm text-ink-faint">Runs: ${escapeHtml(trigger)}</p>` : '';
  try {
    const res = await fetch(`/api/automations/${encodeURIComponent(id)}/runs`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || friendlyError(res, { action: 'load the run history' }));
    }
    if (!data.runs.length) {
      content.innerHTML = `${head}<p class="text-sm text-ink-faint">This automation has not run yet.</p>`;
      return;
    }
    content.innerHTML = `${head}<ul class="space-y-3">${data.runs
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
