// File manager tab: navigation is server-rendered (?path=), actions go through
// /api/servers/:id/files (or /api/files when unscoped). Text edit in a modal
// textarea (line numbers + wrap toggle; a full editor lands later) plus a
// bounded "find in files" grep.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { openModal } from '../lib/modal.js';
import { confirmDialog } from '../lib/confirm.js';
import { setBusy, withBusy } from '../lib/loading.js';
import { fmtBytes, escapeHtml } from '../lib/format.js';
import { createSelection } from '../lib/selection.js';

const root = document.querySelector('[data-files-server], [data-files-global]');
if (root) init(root);

function init(rootEl) {
  const serverId = rootEl.dataset.filesServer || null;
  const base = serverId ? `/api/servers/${serverId}/files` : '/api/files';
  const currentPath = rootEl.dataset.filesPath || '';
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);
  const reload = () => setTimeout(() => location.reload(), 600);

  // ---- Upload ----
  const uploadBtn = document.getElementById('files-upload');
  uploadBtn?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      const form = new FormData();
      for (const f of input.files) form.append('files', f);
      toast(`Uploading ${input.files.length} file${input.files.length > 1 ? 's' : ''}…`, { kind: 'info' });
      await withBusy(uploadBtn, 'Uploading…', async () => {
        try {
          const res = await fetch(`${base}/upload?path=${encodeURIComponent(currentPath)}`, {
            method: 'POST',
            body: form,
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok !== false) {
            const n = (data.uploaded || []).length;
            toast(`Uploaded ${n} file${n === 1 ? '' : 's'}.`);
            reload();
          } else {
            toast(data.error || friendlyError(res, { action: 'upload those files' }), {
              kind: 'error',
              timeout: 9000,
            });
          }
        } catch {
          toast(friendlyError(null, { action: 'upload those files' }), { kind: 'error' });
        }
      });
    });
    input.click();
  });

  // ---- New folder ----
  document.getElementById('files-mkdir')?.addEventListener('click', () => {
    const content = document.createElement('div');
    content.innerHTML = `
      <label class="label">Folder name</label>
      <input class="input" data-mk-name placeholder="new-folder" autocomplete="off">`;
    openModal({
      title: 'New Folder',
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Create',
          kind: 'primary',
          busyLabel: 'Creating…',
          onClick: async () => {
            const name = content.querySelector('[data-mk-name]').value.trim();
            if (!name) return false;
            const res = await post(`${base}/mkdir`, { path: join(currentPath, name) });
            if (!res) return false;
            toast(`Folder "${name}" created.`);
            reload();
          },
        },
      ],
    });
  });

  // ---- Find in files ----
  document.getElementById('files-search')?.addEventListener('click', () => {
    const content = document.createElement('div');
    content.innerHTML = `
      <label class="label" for="fs-q">Search text</label>
      <input class="input" id="fs-q" placeholder="Enter a word or phrase (at least 2 characters)" autocomplete="off">
      <label class="mt-2 flex items-center gap-2 text-xs text-ink-faint">
        <input type="checkbox" class="msm-check" id="fs-case"> Match Case
      </label>
      <p class="help mt-1">Searches text files${currentPath ? ` under <span class="font-mono">${escapeHtml(currentPath)}</span>` : ' from here down'}. Large and binary files are skipped.</p>
      <div class="mt-3 max-h-80 overflow-y-auto rounded-md border border-line text-sm" id="fs-results" hidden></div>`;
    const q = content.querySelector('#fs-q');
    const results = content.querySelector('#fs-results');

    const run = async () => {
      const term = q.value.trim();
      if (term.length < 2) return false;
      results.hidden = false;
      results.innerHTML = '<div class="p-3 text-ink-faint">Searching…</div>';
      const params = new URLSearchParams({ q: term });
      if (currentPath) params.set('path', currentPath);
      if (content.querySelector('#fs-case').checked) params.set('case', '1');
      let data;
      try {
        const res = await fetch(`${base}/search?${params}`);
        data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          results.innerHTML = `<div class="p-3 text-danger">${escapeHtml(data.error || 'Search failed.')}</div>`;
          return false;
        }
      } catch {
        results.innerHTML = '<div class="p-3 text-danger">Search failed.</div>';
        return false;
      }
      if (!data.matches.length) {
        results.innerHTML = '<div class="p-3 text-ink-faint">No matches.</div>';
        return false;
      }
      results.innerHTML =
        data.matches
          .map(
            (m) => `
        <button class="flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left last:border-0 hover:bg-inset" data-fs-open="${escapeHtml(m.path)}" data-fs-line="${m.line}">
          <span class="min-w-0 shrink-0 truncate font-mono text-xs text-link">${escapeHtml(m.path)}:${m.line}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink-faint">${escapeHtml(m.text)}</span>
        </button>`
          )
          .join('') +
        (data.truncated
          ? '<div class="px-3 py-1.5 text-xs text-ink-faint">Showing the first results only. Narrow the search to see the rest.</div>'
          : '');
      return false; // keep the modal open
    };

    openModal({
      title: 'Find in Files',
      content,
      size: 'lg',
      actions: [
        { label: 'Close', kind: 'ghost' },
        { label: 'Search', kind: 'primary', busyLabel: 'Searching…', onClick: run },
      ],
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    results.addEventListener('click', (e) => {
      const hit = e.target.closest('[data-fs-open]');
      if (!hit) return;
      openEditor(hit.dataset.fsOpen, hit.dataset.fsOpen.split('/').pop(), Number(hit.dataset.fsLine) || 0);
    });
    q.focus();
  });

  // ---- Row actions ----
  document.getElementById('files-table')?.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-file-row]');
    if (!row) return;
    const { path, name, size } = row.dataset;
    const isDir = row.dataset.dir === 'true';

    if (e.target.closest('[data-file-edit]')) {
      // The read fetch happens before the editor modal opens - spinner the
      // row button for that gap.
      await withBusy(e.target.closest('[data-file-edit]'), () => openEditor(path, name));
    } else if (e.target.closest('[data-file-download]')) {
      location.href = `${base}/download?path=${encodeURIComponent(path)}`;
    } else if (e.target.closest('[data-file-delete]')) {
      const btn = e.target.closest('[data-file-delete]');
      const ok = await confirmDialog({
        title: `Delete ${isDir ? 'folder' : 'file'} "${name}"?`,
        message: isDir ? 'Deletes the folder and everything inside it.' : 'Deletes this file permanently.',
        detail: `${fmtBytes(size)} will be freed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const restore = setBusy(btn);
      try {
        const res = await fetch(`${base}?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          toast(`"${name}" deleted (${fmtBytes(data.freedBytes)} freed).`);
          removeRow(row);
        } else {
          toast(data.error || friendlyError(res, { action: 'delete that item' }), { kind: 'error' });
        }
      } finally {
        restore();
      }
    }
  });

  // ---- Customizations (per-server page only) ----
  // Inside customizations/ itself the Add action makes no sense (those files
  // are already copies), so swap it for an explanatory notice.
  const inCustomizations = currentPath === 'customizations' || currentPath.startsWith('customizations/');
  if (serverId && inCustomizations) {
    document.getElementById('cust-folder-notice')?.classList.remove('hidden');
    document.querySelector('[data-bulk="customize"]')?.remove();
    for (const tpl of document.querySelectorAll('template[id^="file-menu-"]')) {
      tpl.content.querySelector('[data-file-customize]')?.remove();
    }
  }

  async function addToCustomizations(paths) {
    // post() passes partial failures (ok:false with per-item results) through.
    const res = await post(`/api/servers/${serverId}/customizations/add`, { paths });
    if (!res) return null;
    const files = res.results.reduce((n, x) => n + (x.ok ? Number(x.count) || 1 : 0), 0);
    if (files) toast(`Added ${plural(files, 'file', 'files')} to customizations.`);
    if (res.failed) {
      showFailures(
        'added',
        res.results.filter((x) => !x.ok)
      );
    }
    if (res.needsRebuild) {
      toast('Rebuild the server to start applying your customizations.', { kind: 'warn', timeout: 9000 });
    }
    return res;
  }

  // ---- Multi-select and bulk actions ----
  const table = document.getElementById('files-table');
  const bar = document.getElementById('files-bulk-bar');
  const countEl = document.getElementById('files-bulk-count');
  const selection = table
    ? createSelection({
        table,
        rowSelector: '[data-file-row]',
        checkboxSelector: '[data-file-select]',
        selectAll: document.getElementById('files-select-all'),
        onChange: (n) => {
          if (!bar) return;
          bar.hidden = n === 0;
          const spacer = document.getElementById('files-bulk-spacer');
          if (spacer) spacer.hidden = n === 0;
          if (countEl) countEl.textContent = `${n} selected`;
        },
      })
    : null;

  // Drop a row from the DOM; a header-only table after the last delete looks
  // broken, so restore the empty state the server renders on first load.
  function removeRow(row) {
    const tbody = row.closest('tbody');
    if (selection) selection.remove(row);
    else row.remove();
    if (tbody && !tbody.querySelector('[data-file-row]') && !tbody.querySelector('[data-files-empty]')) {
      const tr = document.createElement('tr');
      tr.dataset.filesEmpty = '';
      tr.innerHTML =
        '<td data-th="" colspan="5" class="py-10 text-center text-sm text-ink-faint">This folder is empty. Upload files or create a folder above.</td>';
      tbody.appendChild(tr);
    }
  }

  const baseName = (p) => p.split('/').pop();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Disable every bar button while one action runs; the clicked one spins.
  async function runBulk(btn, fn) {
    const buttons = [...bar.querySelectorAll('button')];
    const was = buttons.map((b) => b.disabled);
    buttons.forEach((b) => (b.disabled = true));
    const restore = setBusy(btn);
    try {
      return await fn();
    } finally {
      restore();
      buttons.forEach((b, i) => (b.disabled = was[i]));
    }
  }

  // Lists which items failed and why; the caller keeps those rows selected.
  function showFailures(verb, failed, { stillSelected = false } = {}) {
    const content = document.createElement('div');
    content.className = 'space-y-2 text-sm';
    content.innerHTML = `
      <p>${escapeHtml(plural(failed.length, 'item', 'items'))} could not be ${escapeHtml(verb)}.${stillSelected ? ' They are still selected.' : ''}</p>
      <ul class="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
        ${failed
          .map(
            (f) => `<li class="p-2"><span class="font-mono text-xs">${escapeHtml(baseName(f.path))}</span>
              <span class="block text-xs text-danger">${escapeHtml(f.error || 'Something went wrong.')}</span></li>`
          )
          .join('')}
      </ul>`;
    openModal({ title: 'Some Items Failed', content, actions: [{ label: 'Close', kind: 'ghost' }] });
  }

  // Keep only the failed rows selected after a partial failure.
  function selectOnly(rowsToKeep) {
    selection.clear();
    for (const r of rowsToKeep) {
      const cb = r.querySelector('[data-file-select]');
      if (cb) cb.checked = true;
    }
    selection.refresh();
  }

  async function bulkDelete(btn, rows) {
    const dirs = rows.filter((r) => r.dataset.dir === 'true').length;
    const files = rows.filter((r) => r.dataset.dir !== 'true');
    const total = files.reduce((n, r) => n + (Number(r.dataset.size) || 0), 0);
    const parts = [];
    if (files.length) parts.push(`${fmtBytes(total)} across ${plural(files.length, 'file', 'files')}`);
    if (dirs) parts.push(`${files.length ? 'plus ' : ''}${plural(dirs, 'folder', 'folders')} and everything inside`);
    const ok = await confirmDialog({
      title: `Delete ${plural(rows.length, 'item', 'items')}?`,
      message: 'This cannot be undone.',
      detail: `${parts.join(', ')}.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await runBulk(btn, () => post(`${base}/bulk/delete`, { paths: rows.map((r) => r.dataset.path) }));
    if (!res) return;
    const failedPaths = new Set(res.results.filter((x) => !x.ok).map((x) => x.path));
    for (const r of rows) if (!failedPaths.has(r.dataset.path)) removeRow(r);
    if (res.succeeded) toast(`Deleted ${plural(res.succeeded, 'item', 'items')}.`);
    if (res.failed) {
      showFailures(
        'deleted',
        res.results.filter((x) => !x.ok),
        { stillSelected: true }
      );
      selectOnly(rows.filter((r) => failedPaths.has(r.dataset.path)));
    }
  }

  function bulkDestination(verb, rows) {
    const paths = rows.map((r) => r.dataset.path);
    const url = `${base}/bulk/${verb === 'Copy' ? 'copy' : 'move'}`;
    destinationModal(verb, null, plural(rows.length, 'item', 'items'), url, {
      paths,
      onResult: (res) => {
        if (res.succeeded) {
          toast(`${verb === 'Copy' ? 'Copied' : 'Moved'} ${plural(res.succeeded, 'item', 'items')}.`);
        }
        if (res.failed) {
          showFailures(
            verb === 'Copy' ? 'copied' : 'moved',
            res.results.filter((x) => !x.ok)
          );
        }
        if (res.succeeded) reload();
        else return false; // nothing worked: leave the picker open to retry
      },
    });
  }

  // A zip is streamed as an attachment. Posting a form into a hidden iframe
  // keeps the page in place: a download never fires the iframe's load event,
  // but a JSON error response does, so we can read it and toast it.
  function bulkDownload(btn, rows) {
    if (rows.length === 1 && rows[0].dataset.dir !== 'true') {
      location.href = `${base}/download?path=${encodeURIComponent(rows[0].dataset.path)}`;
      return;
    }
    const frameName = `files-dl-${Date.now()}`;
    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.hidden = true;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.addEventListener('load', () => {
      let message = '';
      try {
        const text = iframe.contentDocument?.body?.textContent || '';
        if (text) message = JSON.parse(text).error || '';
      } catch {
        // Not JSON (or not readable): fall through to the generic message.
      }
      // An empty about:blank load can fire on insert; ignore it.
      if (iframe.contentWindow?.location?.href === 'about:blank') return;
      toast(message || friendlyError(null, { action: 'prepare that download' }), { kind: 'error', timeout: 9000 });
      iframe.remove();
    });
    document.body.appendChild(iframe);
    // A successful download never fires `load`, so tidy the frame up later.
    setTimeout(() => iframe.remove(), 10 * 60 * 1000);

    const form = document.createElement('form');
    form.method = 'post';
    form.action = `${base}/download-zip`;
    form.target = frameName;
    form.hidden = true;
    for (const r of rows) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'paths';
      input.value = r.dataset.path;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    toast('Preparing your download…', { kind: 'info' });
    form.submit();
    form.remove();
  }

  bar?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn || btn.disabled || !selection) return;
    const rows = selection.selected();
    const action = btn.dataset.bulk;
    if (action === 'clear') return selection.clear();
    if (action === 'all') return selection.selectAll();
    if (!rows.length) return;
    if (action === 'delete') await bulkDelete(btn, rows);
    else if (action === 'move') bulkDestination('Move', rows);
    else if (action === 'copy') bulkDestination('Copy', rows);
    else if (action === 'download') bulkDownload(btn, rows);
    else if (action === 'customize') {
      const res = await runBulk(btn, () => addToCustomizations(rows.map((r) => r.dataset.path)));
      if (res && res.succeeded) reload();
    }
  });

  // Esc clears the selection when focus is inside the bar or the table.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !selection) return;
    const active = document.activeElement;
    if (!active || !(bar?.contains(active) || table?.contains(active))) return;
    if (document.querySelector('[role="dialog"]')) return;
    selection.clear();
  });

  // Rename/move/copy live in the row overflow menu, which dropdown.js portals
  // to <body> - so these are document-delegated and carry their own data-path.
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-file-rename], [data-file-move], [data-file-copy], [data-file-customize]');
    if (!act || !act.dataset.path) return;
    const { path, name } = act.dataset;
    if (act.hasAttribute('data-file-customize')) {
      addToCustomizations([path]).then((res) => {
        if (res && res.succeeded) reload();
      });
    } else if (act.hasAttribute('data-file-rename')) renameModal(path, name);
    else if (act.hasAttribute('data-file-move')) destinationModal('Move', path, name, `${base}/move`);
    else destinationModal('Copy', path, name, `${base}/copy`);
  });

  // ---- Text editor (modal textarea) ----
  const LANG_BY_EXT = {
    properties: 'Properties',
    json: 'JSON',
    json5: 'JSON5',
    yml: 'YAML',
    yaml: 'YAML',
    toml: 'TOML',
    txt: 'Text',
    md: 'Markdown',
    mcfunction: 'mcfunction',
    cfg: 'Config',
    conf: 'Config',
    ini: 'INI',
    js: 'JavaScript',
    ts: 'TypeScript',
    sh: 'Shell',
    xml: 'XML',
    html: 'HTML',
    css: 'CSS',
    log: 'Log',
  };

  async function openEditor(path, name, gotoLine = 0) {
    const res = await fetch(`${base}/read?path=${encodeURIComponent(path)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return toast(data.error || friendlyError(res, { action: 'open this file' }), { kind: 'error', timeout: 8000 });
    }
    const ext = (name.split('.').pop() || '').toLowerCase();
    const lang = LANG_BY_EXT[ext] || (ext ? ext.toUpperCase() : 'Text');
    const lineCount = data.content.split('\n').length;
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="mb-1 flex items-center gap-2 text-xs text-ink-faint">
        <span class="badge">${escapeHtml(lang)}</span>
        <span>${lineCount} line${lineCount === 1 ? '' : 's'} · ${fmtBytes(data.size)}</span>
        <label class="ml-auto flex cursor-pointer items-center gap-1.5"><input type="checkbox" class="msm-check" data-ed-wrap> Wrap</label>
      </div>
      <textarea class="input h-96 w-full resize-y whitespace-pre font-mono text-xs leading-relaxed" spellcheck="false" wrap="off"></textarea>
      <p class="help mt-2">${escapeHtml(path)}. Tab inserts a tab; saves are written safely in one step.</p>`;
    const textarea = content.querySelector('textarea');
    textarea.value = data.content;
    content.querySelector('[data-ed-wrap]').addEventListener('change', (e) => {
      const on = e.target.checked;
      textarea.setAttribute('wrap', on ? 'soft' : 'off');
      textarea.classList.toggle('whitespace-pre', !on);
      textarea.classList.toggle('whitespace-pre-wrap', on);
    });
    // Tab should indent, not move focus out of the editor.
    textarea.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.shiftKey) return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = textarea;
      textarea.setRangeText('\t', s, en, 'end');
    });
    openModal({
      title: `Edit ${name}`,
      content,
      size: 'lg',
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Save',
          kind: 'primary',
          busyLabel: 'Saving…',
          onClick: async () => {
            const saved = await post(`${base}/write`, { path, content: textarea.value });
            if (!saved) return false;
            toast(`${name} saved (${fmtBytes(saved.size)}).`);
            reload();
          },
        },
      ],
    });
    textarea.focus();
    if (gotoLine > 0) {
      // Put the caret at the start of the target line and scroll it into view.
      const offset =
        textarea.value
          .split('\n')
          .slice(0, gotoLine - 1)
          .join('\n').length + (gotoLine > 1 ? 1 : 0);
      textarea.setSelectionRange(offset, offset);
      const approxLineHeight = 16;
      textarea.scrollTop = Math.max(0, (gotoLine - 3) * approxLineHeight);
    }
  }

  function renameModal(path, name) {
    const content = document.createElement('div');
    content.innerHTML = `
      <label class="label">New name</label>
      <input class="input" data-rn-name autocomplete="off">`;
    const input = content.querySelector('[data-rn-name]');
    input.value = name;
    openModal({
      title: `Rename ${name}`,
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Rename',
          kind: 'primary',
          busyLabel: 'Renaming…',
          onClick: async () => {
            const newName = input.value.trim();
            if (!newName || newName === name) return false;
            const res = await post(`${base}/rename`, { path, newName });
            if (!res) return false;
            toast(`Renamed to "${newName}".`);
            reload();
          },
        },
      ],
    });
    input.select();
  }

  // `bulk` ({ paths, onResult }) switches to the multi-item form: `name` is then
  // a count label such as "3 items" and onResult handles the response.
  function destinationModal(verb, path, name, url, bulk = null) {
    const content = document.createElement('div');
    content.innerHTML = `
      <label class="label">Destination folder (relative to the root)</label>
      <input class="input font-mono" data-dst placeholder="e.g. world/datapacks (leave empty for the root)" autocomplete="off">
      <p class="help">${verb === 'Copy' ? 'Copies' : 'Moves'} ${bulk ? escapeHtml(name) : `"${escapeHtml(name)}"`} into the folder. It must already exist.</p>`;
    const input = content.querySelector('[data-dst]');
    input.value = currentPath;
    openModal({
      title: `${verb} ${name}`,
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: verb,
          kind: 'primary',
          busyLabel: verb === 'Copy' ? 'Copying…' : 'Moving…',
          onClick: async () => {
            if (bulk) {
              const out = await post(url, { paths: bulk.paths, dest: input.value.trim() });
              return out ? bulk.onResult(out) : false;
            }
            const res = await post(url, { path, dest: input.value.trim() });
            if (!res) return false;
            toast(`${verb === 'Copy' ? 'Copied' : 'Moved'} to ${res.path}.`);
            reload();
          },
        },
      ],
    });
    input.focus();
  }

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      // Bulk actions answer 200 with ok:false on a PARTIAL failure, plus
      // per-item results: hand those back so the caller can show what failed
      // and update the rows that did succeed.
      if (res.ok && Array.isArray(data.results)) return data;
      if (!res.ok || data.ok === false) {
        toast(data.error || friendlyError(res, { action: 'complete that file action' }), {
          kind: 'error',
          timeout: 9000,
        });
        return null;
      }
      return data;
    } catch {
      toast(friendlyError(null, { action: 'complete that file action' }), { kind: 'error' });
      return null;
    }
  }
}
