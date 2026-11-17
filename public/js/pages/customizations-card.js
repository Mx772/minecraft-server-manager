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
    const status = {
      applied: '<span class="badge badge-ok">Applied</span>',
      pending: '<span class="badge badge-info">Applies At Next Start</span>',
      managed: `<span class="badge badge-info">${
        c.owner && c.owner.startsWith('pack-profile:') ? 'Managed by Recommended Setup' : 'Managed by Discord Bridge'
      }</span>`,
      changed:
        '<span class="badge badge-warn" data-tip="This file on the server is newer than your saved copy. At the next start your saved copy replaces it.">Changed Since Captured</span>',
    }[c.state];
    const changedActions =
      c.state === 'changed'
        ? `<button type="button" class="btn btn-ghost btn-sm" data-cust-keep data-tip="Save the server's current version as your customization.">Keep Current</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cust-restore>Restore My Copy</button>`
        : '';
    const when = c.capturedAt ? timeAgo(c.capturedAt) : '';
    const from = c.capturedPack?.name ? `from ${escapeHtml(c.capturedPack.name)}` : '';
    const captured = [when, from].filter(Boolean).join(' ') || '<span class="text-ink-faint">Unknown</span>';
    return `<tr data-cust-row data-path="${escapeHtml(c.path)}">
      <td data-th="File" class="font-mono text-xs break-all">${escapeHtml(c.path)}</td>
      <td data-th="Status">${status}</td>
      <td data-th="Captured" class="text-ink-faint">${captured}</td>
      <td data-th="" class="text-right"><div class="flex flex-wrap gap-1 sm:inline-flex sm:flex-nowrap">
        ${changedActions}
        <a class="btn btn-ghost btn-sm" href="${openHref}" data-tip="Open this file's folder in Files.">Open</a>
        ${c.state === 'managed' ? '' : '<button type="button" class="btn btn-ghost btn-sm text-danger" data-cust-remove>Remove</button>'}
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
    const changed = list.filter((c) => c.state === 'changed').length;
    const notice = changed
      ? `<div class="notice notice-warn mb-3">${changed === 1 ? '1 customized file changed' : `${changed} customized files changed`} on the server after you saved ${changed === 1 ? 'it' : 'them'}. Choose which version to keep, or your saved ${changed === 1 ? 'copy wins' : 'copies win'} at the next start.</div>`
      : '';
    body.innerHTML = `${notice}<div class="overflow-x-auto">
      <table class="table-base table-stack">
        <thead><tr><th>File</th><th>Status</th><th>Captured</th><th class="text-right">Actions</th></tr></thead>
        <tbody>${list.map(row).join('')}</tbody>
      </table>
    </div>`;
  }

  // Posts one customizations action for a single path; reloads the list on success.
  async function act(btn, action, busyLabel, successToast, failAction) {
    const path = btn.closest('[data-cust-row]').dataset.path;
    await withBusy(btn, busyLabel, async () => {
      try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/customizations/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [path] }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          toast(successToast);
          await load();
        } else {
          const itemError = Array.isArray(data.results) ? data.results.find((r) => !r.ok)?.error : '';
          toast(data.error || itemError || friendlyError(res, { action: failAction }), {
            kind: 'error',
            timeout: 9000,
          });
        }
      } catch {
        toast(friendlyError(null, { action: failAction }), { kind: 'error' });
      }
    });
  }

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cust-remove], [data-cust-keep], [data-cust-restore]');
    if (!btn) return;
    const path = btn.closest('[data-cust-row]').dataset.path;
    if (btn.hasAttribute('data-cust-keep')) {
      await act(btn, 'keep-current', 'Saving…', 'Customization updated.', 'update that customization');
    } else if (btn.hasAttribute('data-cust-restore')) {
      const ok = await confirmDialog({
        title: 'Restore your saved copy?',
        message: `Your saved version of ${path} replaces the server's current one now. The current version is not kept.`,
        confirmLabel: 'Restore',
        danger: true,
      });
      if (ok) await act(btn, 'restore', 'Restoring…', 'Your saved copy was restored.', 'restore that customization');
    } else {
      const ok = await confirmDialog({
        title: 'Remove this customization?',
        message: `The pack's version of ${path} comes back at the next pack update. Your copy is deleted.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (ok) await act(btn, 'remove', 'Removing…', 'Customization removed.', 'remove that customization');
    }
  });

  await load();
}
