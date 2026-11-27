// Automation templates: the picker shown before the editor, and the review
// step for an imported file. A template is an automation without its servers.

import { toast } from './toast.js';
import { friendlyError } from './errors.js';
import { openModal } from './modal.js';
import { confirmDialog } from './confirm.js';
import { escapeHtml } from './format.js';
import {
  describeCondition,
  describeFileStep,
  describeOffset,
  describeTrigger,
  editorKinds,
  openAutomationEditor,
} from './automationEditor.js';

const IMPORT_MAX_BYTES = 64 * 1024;

/** A template as the editor's starting point: no id, no servers yet. */
function defFromTemplate(t) {
  return {
    name: t.name,
    enabled: true,
    targets: { kind: t.targetsKind, serverIds: [] },
    trigger: t.trigger,
    steps: t.steps,
  };
}

function stepLabel(editor, key) {
  const a = editor.actions.find((x) => x.key === key);
  return a ? a.label : key;
}

function plural(n, one) {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function templateCard(editor, t) {
  const trigger = describeTrigger(t.trigger, editor);
  return `
    <li class="flex flex-col rounded-md border border-line bg-inset/40" data-tpl="${escapeHtml(t.id)}">
      <button type="button" class="flex-1 rounded-md p-3 text-left hover:bg-raised" data-tpl-pick>
        <span class="flex flex-wrap items-center gap-2">
          <span class="font-medium">${escapeHtml(t.name)}</span>
          ${t.builtin ? '<span class="badge badge-info">Built-In</span>' : ''}
        </span>
        ${t.description ? `<span class="mt-1 block text-sm text-ink-faint">${escapeHtml(t.description)}</span>` : ''}
        <span class="mt-2 block text-xs text-ink-faint"><span class="${trigger.mono ? 'font-mono' : ''}">${escapeHtml(trigger.text)}</span> · ${plural(t.steps.length, 'step')}</span>
      </button>
      <div class="flex justify-end gap-1 border-t border-line px-2 py-1.5">
        <a class="btn btn-ghost btn-sm" href="/api/automations/templates/${encodeURIComponent(t.id)}/export" download>Export</a>
        ${t.canDelete ? '<button type="button" class="btn btn-ghost btn-sm text-danger" data-tpl-delete>Delete</button>' : ''}
      </div>
    </li>`;
}

/**
 * The first step of New Automation: start from scratch or from a template.
 * @param {{ editor: object, presetServerId?: string, onSaved?: (data: object) => void }} opts
 */
export async function openTemplatePicker({ editor, presetServerId = '', onSaved }) {
  const content = document.createElement('div');
  content.innerHTML = '<p class="text-sm text-ink-faint">Loading the templates…</p>';
  const modal = openModal({
    title: 'New Automation',
    content,
    size: 'lg',
    actions: [{ label: 'Cancel', kind: 'ghost' }],
  });

  const kinds = new Set(editorKinds(editor).map(([k]) => k));
  let templates = [];
  try {
    const res = await fetch('/api/automations/templates');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || friendlyError(res, { action: 'load the templates' }));
    }
    templates = data.templates.filter((t) => kinds.has(t.targetsKind));
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }

  const startEditor = (def) => {
    modal.close();
    openAutomationEditor({ editor, def, presetServerId, onSaved });
  };

  const render = () => {
    const builtin = templates.filter((t) => t.builtin);
    const mine = templates.filter((t) => !t.builtin);
    const group = (title, list) =>
      list.length
        ? `<h4 class="label mt-4">${title}</h4><ul class="grid gap-2 sm:grid-cols-2">${list.map((t) => templateCard(editor, t)).join('')}</ul>`
        : '';
    content.innerHTML = `
      <button type="button" class="btn btn-primary" data-tpl-scratch>Start From Scratch</button>
      <p class="help">Or start from a template, then choose the servers and adjust anything you like.</p>
      ${group('Built-In Templates', builtin)}${group('Your Templates', mine)}`;
  };
  render();

  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-tpl-scratch]')) return startEditor(null);
    const card = e.target.closest('[data-tpl]');
    if (!card) return;
    const template = templates.find((t) => t.id === card.dataset.tpl);
    if (!template) return;
    if (e.target.closest('[data-tpl-pick]')) return startEditor(defFromTemplate(template));
    if (e.target.closest('[data-tpl-delete]')) {
      const ok = await confirmDialog({
        title: 'Delete this template?',
        message: `${template.name} is removed for everyone. Automations made from it are not affected.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const res = await fetch(`/api/automations/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        toast('Template deleted.');
        templates = templates.filter((t) => t.id !== template.id);
        render();
      } else {
        toast(data.error || friendlyError(res, { action: 'delete that template' }), { kind: 'error' });
      }
    }
  });
}

/** One step in plain words, with its full message or command text. */
function stepReview(editor, step) {
  const p = step.params || {};
  const detail = [];
  if (p.text) detail.push(`${p.mode === 'say' ? 'Say' : 'Tellraw'}: ${p.text}`);
  if (p.command) detail.push(p.command);
  const fileStep = describeFileStep(step);
  if (fileStep) detail.push(`${fileStep}.`);
  if (p.message) detail.push(`Discord: ${p.message}`);
  if (p.shrink) detail.push('Trims unused chunks after the backup.');
  const condition = describeCondition(step.condition);
  return `
    <li class="rounded-md border border-line bg-inset/40 p-3 text-sm">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-medium">${escapeHtml(stepLabel(editor, step.action))}</span>
        <span class="text-ink-faint">${escapeHtml(describeOffset(step.offsetSec))}</span>
      </div>
      ${detail.map((d) => `<pre class="mt-1 whitespace-pre-wrap break-words font-mono text-xs">${escapeHtml(d)}</pre>`).join('')}
      ${condition ? `<p class="mt-1 text-xs text-ink-faint">${escapeHtml(condition)}</p>` : ''}
      <p class="mt-1 text-xs text-ink-faint">On failure: ${step.onFailure === 'continue' ? 'continue with the next step' : 'stop the remaining steps'}.</p>
    </li>`;
}

/**
 * Read a template file, show what it would do, and save it once confirmed.
 * @param {File} file
 * @param {{ editor: object, onSaved?: () => void }} opts
 */
export async function importTemplateFile(file, { editor, onSaved }) {
  if (file.size > IMPORT_MAX_BYTES) {
    toast('That file is too large to be an automation template.', { kind: 'error' });
    return;
  }
  let body;
  try {
    body = JSON.parse(await file.text());
  } catch {
    toast('This file is not valid JSON.', { kind: 'error' });
    return;
  }
  const post = (preview) =>
    fetch(`/api/automations/templates/import?preview=${preview}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let template;
  try {
    const res = await post(1);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || friendlyError(res, { action: 'read that template' }));
    }
    template = data.template;
  } catch (err) {
    toast(err.message, { kind: 'error', timeout: 9000 });
    return;
  }

  const content = document.createElement('div');
  content.innerHTML = `
    <div class="notice notice-warn">Imported commands and messages run on your servers exactly as written, so read every step before saving.</div>
    <h4 class="label mt-4">${escapeHtml(template.name)}</h4>
    ${template.description ? `<p class="text-sm text-ink-faint">${escapeHtml(template.description)}</p>` : ''}
    <p class="mt-2 text-sm text-ink-faint">Runs on ${template.targetsKind === 'servers' ? 'the servers you choose' : template.targetsKind === 'all' ? 'all servers' : 'the panel'}, ${template.trigger.type === 'event' ? '' : 'on the schedule'} <span class="${describeTrigger(template.trigger, editor).mono ? 'font-mono' : ''}">${escapeHtml(describeTrigger(template.trigger, editor).text.toLowerCase())}</span>.</p>
    <ol class="mt-3 space-y-2">${template.steps.map((s) => stepReview(editor, s)).join('')}</ol>`;
  openModal({
    title: 'Review Template',
    content,
    size: 'lg',
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Save Template',
        kind: 'primary',
        busyLabel: 'Saving…',
        onClick: async () => {
          try {
            const res = await post(0);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) {
              throw new Error(data.error || friendlyError(res, { action: 'save that template' }));
            }
            toast('Template saved. Find it under New Automation.');
            if (onSaved) onSaved();
          } catch (err) {
            toast(err.message, { kind: 'error', timeout: 9000 });
            return false;
          }
        },
      },
    ],
  });
}
