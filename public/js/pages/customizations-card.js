// Customizations card on the per-server Mods tab: lists the files the panel
// copies back over the pack on every start, and lets the user remove one.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { confirmDialog } from '../lib/confirm.js';
import { withBusy } from '../lib/loading.js';
import { escapeHtml } from '../lib/format.js';
import { timeAgo } from '../lib/datetime.js';
import { fetchCustomizations } from '../lib/customizations.js';

const card = document.querySelector('[data-cust-card]');
if (card) init(card);

async function init(el) {
  const serverId = el.dataset.custCard;
  const body = el.querySelector('[data-cust-body]');
  const emptyTpl = el.querySelector('[data-cust-empty]');

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function row(c) {
    const dir = dirOf(c.path);
    const openHref = `/servers/${encodeURIComponent(serverId)}/files?path=${encodeURIComponent(dir ? `customizations/${dir}` : 'customizations')}`;
    const status =
      c.state === 'applied'
        ? '<span class="badge badge-ok">Applied</span>'
        : '<span class="badge badge-warn">Applies At Next Start</span>';
    const when = c.capturedAt ? timeAgo(c.capturedAt) : '';
    const from = c.capturedPack?.name ? `from ${escapeHtml(c.capturedPack.name)}` : '';
    const captured = [when, from].filter(Boolean).join(' ') || '<span class="text-ink-faint">Unknown</span>';
    return `<tr data-cust-row data-path="${escapeHtml(c.path)}">
      <td data-th="File" class="font-mono text-xs break-all">${escapeHtml(c.path)}</td>
      <td data-th="Status">${status}</td>
      <td data-th="Captured" class="text-ink-faint">${captured}</td>
      <td data-th="" class="text-right"><div class="flex flex-wrap gap-1 sm:inline-flex sm:flex-nowrap">
        <a class="btn btn-ghost btn-sm" href="${openHref}" data-tip="Open this file's folder in Files.">Open</a>
        <button type="button" class="btn btn-ghost btn-sm text-danger" data-cust-remove>Remove</button>
      </div></td>
    </tr>`;
  }

  async function load() {
    const list = await fetchCustomizations(serverId);
    if (!list) {
      body.innerHTML =
        '<p class="text-sm text-ink-faint">The customizations could not be loaded. Reload the page to try again.</p>';
      return;
    }
    if (!list.length) {
      body.replaceChildren(emptyTpl.content.cloneNode(true));
      return;
    }
    body.innerHTML = `<div class="overflow-x-auto">
      <table class="table-base table-stack">
        <thead><tr><th>File</th><th>Status</th><th>Captured</th><th class="text-right">Actions</th></tr></thead>
        <tbody>${list.map(row).join('')}</tbody>
      </table>
    </div>`;
  }

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cust-remove]');
    if (!btn) return;
    const path = btn.closest('[data-cust-row]').dataset.path;
    const ok = await confirmDialog({
      title: 'Remove this customization?',
      message: `The pack's version of ${path} comes back at the next pack update. Your copy is deleted.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await withBusy(btn, 'Removing…', async () => {
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/customizations/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [path] }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          toast('Customization removed.');
          await load();
        } else {
          toast(data.error || friendlyError(res, { action: 'remove that customization' }), {
            kind: 'error',
            timeout: 9000,
          });
        }
      } catch {
        toast(friendlyError(null, { action: 'remove that customization' }), { kind: 'error' });
      }
    });
  });

  await load();
}
