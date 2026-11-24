import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { openModal } from '../lib/modal.js';
import { escapeHtml } from '../lib/format.js';
import { parseConfig, serialize as serializeFields } from '../lib/configForm.js';

const root = document.querySelector('[data-mod-configs]');
root?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-mod-config]');
  if (button) openConfig(button.dataset.path);
});

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || friendlyError(response));
  return data;
}

async function openConfig(filePath) {
  try {
    const data = await request(
      `/api/servers/${root.dataset.serverId}/configs/file?path=${encodeURIComponent(filePath)}`
    );
    showEditor(data.path, data.content, data.descriptions || {}, data.customization);
  } catch (error) {
    toast(error.message || friendlyError(error, { action: 'load this config' }), { kind: 'error' });
  }
}

function showEditor(filePath, original, descriptions, customization) {
  const extension = `.${filePath.split('.').pop().toLowerCase()}`;
  let parsed = parseConfig(original, extension, descriptions);
  const dialog = document.createElement('div');
  dialog.innerHTML = `
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="min-w-0 truncate font-mono text-xs text-ink-faint">${escapeHtml(filePath)}</p>
      <div class="flex gap-1" role="group" aria-label="Editor mode">
        <button type="button" class="btn btn-sm" data-mode="form" ${parsed ? '' : 'disabled'}>Form</button>
        <button type="button" class="btn btn-sm btn-ghost" data-mode="raw">Raw</button>
      </div>
    </div>
    <div class="grid gap-2" data-editor-form>${parsed ? renderFields(parsed) : '<p class="help">This format could not be safely rendered as fields. Use raw view to edit the file.</p>'}</div>
    <textarea class="input hidden min-h-80 w-full resize-y font-mono text-xs" data-editor-raw spellcheck="false"></textarea>
    ${customizationNotice(customization)}
    <p class="help mt-3">Some settings only take effect after the server restarts.</p>`;
  const raw = dialog.querySelector('[data-editor-raw]');
  const form = dialog.querySelector('[data-editor-form]');
  let mode = parsed ? 'form' : 'raw';
  raw.value = original;
  syncMode();

  dialog.querySelectorAll('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      if (button.dataset.mode === mode) return;
      if (mode === 'form') raw.value = serialize(parsed, dialog);
      else if (parsed) {
        parsed = parseConfig(raw.value, extension, descriptions);
        form.innerHTML = parsed
          ? renderFields(parsed)
          : '<p class="help">This format could not be safely rendered as fields. Use raw view to edit the file.</p>';
      }
      mode = button.dataset.mode;
      syncMode();
    })
  );

  function syncMode() {
    raw.classList.toggle('hidden', mode !== 'raw');
    form.classList.toggle('hidden', mode !== 'form');
    dialog.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('btn-ghost', button.dataset.mode !== mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
  }

  openModal({
    title: filePath.split('/').pop(),
    content: dialog,
    size: 'lg',
    actions: [
      { label: 'Close', kind: 'ghost' },
      {
        label: 'Save Changes',
        kind: 'primary',
        busyLabel: 'Saving…',
        onClick: async () => {
          try {
            const content = mode === 'raw' ? raw.value : serialize(parsed, dialog);
            const customize = Boolean(dialog.querySelector('[data-customize]')?.checked);
            const saved = await request(`/api/servers/${root.dataset.serverId}/configs/file`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: filePath, content, ...(customize ? { customize } : {}) }),
            });
            afterSave(filePath, saved);
          } catch (error) {
            toast(error.message || friendlyError(error, { action: 'save this config' }), { kind: 'error' });
            return false;
          }
        },
      },
    ],
  });
}

function serialize(parsed, dialog) {
  if (!parsed) return dialog.querySelector('[data-editor-raw]').value;
  const values = parsed.fields.map((_, index) => {
    const input = dialog.querySelector(`[data-field="${index}"]`);
    return input.type === 'checkbox' ? input.checked : input.value;
  });
  return serializeFields(parsed, values);
}

const CUSTOMIZATION_NOTICES = {
  customized: [
    'ok',
    'This file is in your customizations. Saving here updates your copy too, so pack updates keep your changes.',
  ],
  world: ['info', 'This file is saved with the world, so pack updates do not overwrite it.'],
  managed: [
    'warn',
    'A panel feature manages this file (Recommended Setup or the Discord chat bridge). The next start replaces edits made here, so change it there instead.',
  ],
};

function customizationNotice(state) {
  if (state === 'available') {
    return `
    <label class="mt-4 flex items-start gap-3 rounded-sm border border-line bg-inset p-3">
      <input class="msm-check mt-0.5 shrink-0" type="checkbox" data-customize>
      <span class="min-w-0">
        <span class="block text-sm font-medium text-ink">Keep My Changes When the Pack Updates</span>
        <span class="mt-0.5 block text-xs leading-relaxed text-ink-faint">A pack update can overwrite this file. This saves a copy to your customizations on Pack Setup, which is put back over the pack's version every time the server starts.</span>
      </span>
    </label>`;
  }
  const notice = CUSTOMIZATION_NOTICES[state];
  if (!notice) return '';
  const [kind, text] = notice;
  return `<div class="notice notice-${kind} mt-4"><p>${escapeHtml(text)}</p></div>`;
}

function afterSave(filePath, saved) {
  if (saved.customized) {
    toast('Config saved and added to your customizations.');
    markCustomized(filePath);
    if (saved.needsRebuild) {
      toast('Rebuild the server to start applying your customizations.', { kind: 'warn', timeout: 9000 });
    }
  } else if (saved.customizeError) {
    toast(`Config saved, but it could not be added to your customizations. ${saved.customizeError}`, {
      kind: 'warn',
      timeout: 9000,
    });
  } else if (saved.customizationUpdated) {
    toast('Config saved. Your customization was updated too.');
  } else {
    toast('Config saved.');
  }
}

/** Show the Customized badge on a file the editor just added, without a reload. */
function markCustomized(filePath) {
  root.querySelectorAll('[data-open-mod-config]').forEach((button) => {
    if (button.dataset.path !== filePath || button.parentElement.querySelector('[data-customized-badge]')) return;
    const badge = document.createElement('span');
    badge.className = 'badge badge-info shrink-0';
    badge.dataset.customizedBadge = '';
    badge.dataset.tip = CUSTOMIZED_TIP;
    badge.textContent = 'Customized';
    button.after(badge);
  });
}

const CUSTOMIZED_TIP = "The panel copies your version over the pack's file every time the server starts.";

function renderFields(parsed) {
  const groups = new Map();
  parsed.fields.forEach((field, index) => {
    const group = field.group;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ field, index });
  });
  return (
    [...groups.entries()]
      .map(
        ([group, fields]) => `
    <details class="card overflow-hidden">
      <summary class="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm font-semibold hover:bg-hover">
        <span class="min-w-0 truncate" title="${escapeHtml(group)}">${escapeHtml(group)}</span>
        <span class="badge shrink-0">${fields.length} ${fields.length === 1 ? 'setting' : 'settings'}</span>
      </summary>
      <div class="border-t border-line px-3 pb-2">
        ${fields
          .map(({ field, index }) => {
            const key = field.key;
            const description = field.description
              ? `<p id="config-description-${index}" class="mt-0.5 max-w-prose whitespace-pre-line text-xs leading-relaxed text-ink-faint">${escapeHtml(field.description)}</p>`
              : '';
            const control = fieldControl(field, index);
            const describedBy = field.description ? `aria-describedby="config-description-${index}"` : '';
            return `<div class="flex min-w-0 items-center gap-4 border-b border-line py-2"><div class="min-w-0 flex-1"><label class="block truncate text-sm font-medium text-ink" for="config-field-${index}" title="${escapeHtml(key)}">${escapeHtml(key)}</label>${description}</div>${control.replace('data-field=', `${describedBy} data-field=`)}</div>`;
          })
          .join('')}
      </div>
    </details>`
      )
      .join('') || '<p class="help">No editable settings were found in this file.</p>'
  );
}

function fieldControl(field, index) {
  const value = field.value;
  if (field.type === 'boolean') {
    return `<input id="config-field-${index}" class="msm-check shrink-0" type="checkbox" data-field="${index}" ${value ? 'checked' : ''}>`;
  }
  if (field.options) {
    const options = field.options.includes(value) ? field.options : [value, ...field.options];
    return `<select id="config-field-${index}" class="input h-8 w-36 min-w-0 px-2 py-1 text-xs sm:w-40" data-field="${index}">${options
      .map(
        (option) =>
          `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`
      )
      .join('')}</select>`;
  }
  const numeric = field.type === 'number' ? 'type="number" step="any"' : '';
  const mono = field.type === 'raw' ? ' font-mono' : '';
  return `<input id="config-field-${index}" class="input h-8 w-36 min-w-0 px-2 py-1 text-xs sm:w-40${mono}" data-field="${index}" ${numeric} value="${escapeHtml(value)}">`;
}
