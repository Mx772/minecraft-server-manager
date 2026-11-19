// Domains card on the server Overview tab: list, add, remove, make primary, DNS
// check, reachability check, and the DNS record to create when one is wrong.
// Rendered from the server-provided JSON, then re-rendered from API responses.
// Every string goes in through textContent, never innerHTML.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { withBusy } from '../lib/loading.js';
import { confirmDialog } from '../lib/confirm.js';
import { timeAgo } from '../lib/datetime.js';

const card = document.querySelector('[data-domains-card]');
if (card) init(card);

const RECORD_STATES = new Set(['wrong-port', 'missing-srv', 'not-found', 'different-ip', 'resolver-error']);

/** Build an element: h('div', 'class', child, ...). Strings become text nodes. */
function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

function humanTtl(secs) {
  const n = Number(secs);
  const unit = (v, name) => `${v} ${name}${v === 1 ? '' : 's'}`;
  if (n >= 86400) return unit(Math.round(n / 86400), 'day');
  if (n >= 3600) return unit(Math.round(n / 3600), 'hour');
  if (n >= 60) return unit(Math.round(n / 60), 'minute');
  return unit(Math.max(1, Math.round(n)), 'second');
}

function init(root) {
  const serverId = root.dataset.domainsCard;
  const canEdit = root.dataset.canEdit === 'true';
  const external = root.dataset.external === 'true';
  const listEl = root.querySelector('[data-domains-list]');
  const form = root.querySelector('[data-domains-add]');
  const base = `/api/servers/${encodeURIComponent(serverId)}/domains`;
  let data = { domains: [], bedrock: null };
  const reach = new Map(); // domain -> last reachability result

  try {
    data = JSON.parse(root.querySelector('[data-domains-initial]').textContent);
  } catch {
    /* fall back to an empty list; the first action refreshes it */
  }

  async function call(method, path, body, action) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      toast(friendlyError(err, { action }), { kind: 'error' });
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      toast(json.error || friendlyError(res, { action }), { kind: 'error', timeout: 8000 });
      return null;
    }
    return json;
  }

  function adopt(json) {
    data = { ...data, ...json };
    render();
  }

  function copyBtn(value, label) {
    const b = h('button', 'btn btn-ghost btn-sm shrink-0', 'Copy');
    b.type = 'button';
    b.dataset.copy = value;
    b.setAttribute('aria-label', `Copy ${label}`);
    return b;
  }

  function field(label, value) {
    const row = h('div', 'flex items-center justify-between gap-2');
    row.append(
      h(
        'div',
        'min-w-0',
        h('div', 'text-xs text-ink-faint', label),
        h('div', 'break-all font-mono text-sm', String(value))
      ),
      copyBtn(String(value), label)
    );
    return row;
  }

  function recordBlock(check, open) {
    const rec = check.record;
    const det = h('details', 'mt-3 rounded-sm border border-line bg-inset p-3 text-sm');
    det.open = open;
    det.append(h('summary', 'cursor-pointer font-medium', 'Record to Create'));
    const body = h('div', 'mt-3 space-y-4');
    if (rec.address) {
      const a = rec.address;
      body.append(
        h(
          'div',
          'space-y-2',
          h('div', 'text-xs font-semibold', `${a.type} record`),
          field('Name', a.name),
          field('Type', a.type),
          field('Value', a.value)
        )
      );
    }
    body.append(
      h(
        'div',
        'space-y-2',
        h('div', 'text-xs font-semibold', 'SRV record'),
        field('Name', rec.name),
        field('Type', 'SRV'),
        field('Priority', rec.priority),
        field('Weight', rec.weight),
        field('Port', rec.port),
        field('Target', rec.target)
      )
    );
    if (rec.bind) {
      const pre = h('pre', 'overflow-x-auto rounded-sm bg-surface p-2 font-mono text-xs', rec.bind);
      body.append(
        h(
          'div',
          'space-y-2',
          h(
            'div',
            'flex items-center justify-between gap-2',
            h('div', 'text-xs font-semibold', 'BIND format'),
            copyBtn(rec.bind, 'the BIND record')
          ),
          pre
        )
      );
    }
    det.append(body);
    return det;
  }

  function reachBlock(r) {
    if (!r) return null;
    if (r.ok === false && r.reason) {
      const n = h('div', 'notice notice-warn mt-3', h('div', 'font-medium', r.reason));
      if (r.hint) n.append(h('div', 'mt-1', r.hint));
      return n;
    }
    if (r.online === false) {
      return h('div', 'notice notice-warn mt-3', 'The outside check could not reach this server.');
    }
    const parts = [];
    if (typeof r.latencyMs === 'number') parts.push(`${r.latencyMs} ms`);
    if (r.version) parts.push(String(r.version));
    if (r.players) parts.push(`${r.players.online ?? 0}/${r.players.max ?? 0} players`);
    const n = h('div', 'notice notice-ok mt-3', h('div', 'font-medium', 'Reachable.'));
    if (parts.length) n.append(h('div', 'mt-1', parts.join(', ')));
    if (r.motd) n.append(h('div', 'mt-1 break-words', String(r.motd)));
    return n;
  }

  function actions(d) {
    const wrap = h('div', 'mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap');
    const btn = (label, cls, fn) => {
      const b = h('button', `btn btn-sm ${cls}`.trim(), label);
      b.type = 'button';
      b.addEventListener('click', () => fn(b));
      wrap.append(b);
    };
    btn('Check DNS', '', (b) => checkDns(d.domain, b));
    btn('Check Reachability', '', (b) => checkReach(d.domain, 'panel', b));
    if (external) btn('Check From Outside', '', (b) => checkReach(d.domain, 'external', b));
    if (!d.isPrimary) btn('Make Primary', '', (b) => makePrimary(d.domain, b));
    btn('Remove', 'btn-ghost text-danger', (b) => remove(d.domain, b));
    return wrap;
  }

  function row(d) {
    const c = d.check;
    const li = h('div', 'rounded-sm border border-line bg-raised p-3');
    const head = h('div', 'flex flex-wrap items-center gap-2');
    head.append(h('span', 'min-w-0 break-all font-mono text-sm font-semibold', d.domain));
    if (d.isPrimary) head.append(h('span', 'chip', 'Primary'));
    head.append(h('span', `badge ${c ? c.badge : 'badge-info'}`, c ? c.label : 'Not Checked'));
    li.append(head);
    if (c && c.message) li.append(h('p', 'mt-2 text-sm text-ink-soft', c.message));
    const meta = [];
    if (d.checkedAt)
      meta.push(`Checked ${timeAgo(d.checkedAt.includes('T') ? d.checkedAt : `${d.checkedAt.replace(' ', 'T')}Z`)}.`);
    if (c && c.ttl) meta.push(`Changes can take up to ${humanTtl(c.ttl)} to show up.`);
    if (meta.length) li.append(h('p', 'mt-1 text-xs text-ink-faint', meta.join(' ')));
    if (c && c.record && (RECORD_STATES.has(c.state) || d.state === 'points-here')) {
      li.append(recordBlock(c, RECORD_STATES.has(c.state)));
    }
    if (data.bedrock) {
      li.append(
        h(
          'p',
          'mt-2 text-xs text-ink-faint',
          `Bedrock players: ${d.domain}, port ${data.bedrock.port}. SRV records do not apply to Bedrock.`
        )
      );
    }
    li.append(reachBlock(reach.get(d.domain)));
    if (external)
      li.append(h('p', 'mt-2 text-xs text-ink-faint', 'Check From Outside sends the domain name to mcsrvstat.us.'));
    if (canEdit) li.append(actions(d));
    return li;
  }

  function render() {
    listEl.replaceChildren();
    if (!data.domains.length) {
      listEl.append(h('p', 'text-sm text-ink-faint', 'No domains yet.'));
      return;
    }
    for (const d of data.domains) listEl.append(row(d));
  }

  async function checkDns(domain, b) {
    await withBusy(b, 'Checking…', async () => {
      const json = await call('POST', `/${encodeURIComponent(domain)}/check`, null, 'check DNS');
      if (json) adopt(json);
    });
  }

  async function checkReach(domain, mode, b) {
    await withBusy(b, 'Checking…', async () => {
      const json = await call('POST', `/${encodeURIComponent(domain)}/reachability`, { mode }, 'check reachability');
      if (json) {
        reach.set(domain, json.reachability);
        render();
      }
    });
  }

  async function makePrimary(domain, b) {
    await withBusy(b, 'Saving…', async () => {
      const json = await call('PUT', `/${encodeURIComponent(domain)}/primary`, null, 'change the primary domain');
      if (json) {
        adopt(json);
        toast(`${domain} is now the primary domain.`);
      }
    });
  }

  async function remove(domain, b) {
    const ok = await confirmDialog({
      title: 'Remove this domain?',
      message: `${domain} will stop being offered to players. Your DNS records are not touched.`,
      confirmLabel: 'Remove Domain',
      danger: true,
    });
    if (!ok) return;
    await withBusy(b, 'Removing…', async () => {
      const json = await call('DELETE', `/${encodeURIComponent(domain)}`, null, 'remove the domain');
      if (json) {
        reach.delete(domain);
        adopt(json);
        toast('Domain removed.');
      }
    });
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.elements.domain;
    const domain = input.value.trim();
    if (!domain) {
      toast('Enter a domain.', { kind: 'error' });
      return;
    }
    await withBusy(form.querySelector('button[type="submit"]'), 'Adding…', async () => {
      const json = await call('POST', '', { domain }, 'add the domain');
      if (!json) return;
      input.value = '';
      adopt(json);
      toast('Domain added. Checking its DNS records…', { kind: 'info' });
      const added =
        json.domains.find((x) => x.domain.toLowerCase() === domain.toLowerCase().replace(/\.$/, '')) ||
        json.domains.at(-1);
      if (added) {
        const checked = await call('POST', `/${encodeURIComponent(added.domain)}/check`, null, 'check DNS');
        if (checked) adopt(checked);
      }
    });
  });

  render();
}
