// Global analytics page (/analytics): Overview, Servers and Players tabs over
// /api/analytics. View state lives in the query string so every view (filters,
// tab, sort, an open server or player) can be linked and survives back/forward.
// Chart.js is loaded globally from /vendor/chart.umd.js by the view.
// (The per-server Analytics tab lives in analytics.js; the two share nothing.)
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { confirmDialog } from '../lib/confirm.js';
import { withBusy } from '../lib/loading.js';
import { escapeHtml as esc } from '../lib/format.js';
import { timeAgo, formatDateTime } from '../lib/datetime.js';
import { renderPlayerHead } from '../lib/playerHead.js';

const root = document.getElementById('ag-root');
if (root) init(root);

const RANGES = ['24h', '7d', '30d', '90d', 'all'];
const TABS = ['overview', 'servers', 'players'];
const SERVER_SORTS = ['playtime', 'players', 'peak', 'lastActive', 'name'];
const PLAYER_SORTS = ['playtime', 'lastSeen', 'name', 'serverCount'];
const PAGE_SIZE = 50;

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const num = (n) => Number(n || 0).toLocaleString();

// Times always pair a relative and an exact form: the visible one is relative
// with the exact time on hover (relTime), or exact with the relative on hover (absTime).
const timeTag = (iso, text, title) => `<time datetime="${esc(iso)}" title="${esc(title)}">${esc(text)}</time>`;
const relTime = (iso) => (iso ? timeTag(iso, timeAgo(iso), formatDateTime(iso)) : 'Never');
const absTime = (iso) => (iso ? timeTag(iso, formatDateTime(iso), timeAgo(iso)) : 'Never');
const seenTime = (iso, online) => (online ? 'Online now' : relTime(iso));

// ---- Gameplay stats (keys from analytics/stats.js curate(); units mirror analytics.js) ----
const STAT_LABELS = {
  blocksMinedTotal: 'Blocks Mined',
  distanceCm: 'Distance',
  mobKills: 'Mobs Killed',
  deaths: 'Deaths',
  diamondsMined: 'Diamonds Mined',
  playerKills: 'Players Killed',
  damageDealt: 'Damage Dealt',
  damageTaken: 'Damage Taken',
  jumps: 'Jumps',
};
const STAT_ORDER = Object.keys(STAT_LABELS);
const compactFmt = () => new Intl.NumberFormat(panelLocale(), { notation: 'compact', maximumFractionDigits: 1 });
const compact = (n) => compactFmt().format(Number(n || 0));

function fmtDistance(cm) {
  return cm >= 100_000 ? `${(cm / 100_000).toFixed(1)} km` : `${Math.round(cm / 100)} m`;
}

/** A stat value with its unit, e.g. "4.1 km" or "1.2K". Damage is stored in tenths of a heart. */
function fmtStat(key, v) {
  if (key === 'distanceCm') return fmtDistance(v);
  if (key === 'damageDealt' || key === 'damageTaken') return `${compact(v / 10)} hearts`;
  return compact(v);
}

const STAT_PHRASES = {
  deaths: (v) => `${compact(v)} ${v === 1 ? 'death' : 'deaths'}`,
  mobKills: (v) => `${compact(v)} mobs killed`,
  playerKills: (v) => `${compact(v)} players killed`,
  blocksMinedTotal: (v) => `${compact(v)} blocks mined`,
  diamondsMined: (v) => `${compact(v)} diamonds mined`,
  distanceCm: (v) => fmtDistance(v),
  damageDealt: (v) => `${compact(v / 10)} hearts dealt`,
  damageTaken: (v) => `${compact(v / 10)} hearts taken`,
  jumps: (v) => `${compact(v)} jumps`,
};

/** Up to `max` non-zero stats as a middle-dot separated line, most meaningful first. */
function statLine(stats, max, order = STAT_ORDER) {
  if (!stats) return '';
  return order
    .filter((k) => Number(stats[k]) > 0)
    .slice(0, max)
    .map((k) => STAT_PHRASES[k](Number(stats[k])))
    .join(' · ');
}

const gbFmt = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const tpsClass = (v) => (v < 15 ? 'text-danger' : v < 18 ? 'text-warn' : '');

// ---- Activity heatmap (weekday x hour), shared by Overview, server and player views ----
const HEAT_LEVELS = ['bg-ok/10', 'bg-ok/25', 'bg-ok/40', 'bg-ok/60', 'bg-ok/90'];
const panelLocale = () => (window.MSM && window.MSM.locale) || undefined;
const weekdayName = (d, style = 'long') =>
  new Intl.DateTimeFormat(panelLocale(), { weekday: style, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 3 + d))
  );
const hourName = (h) =>
  new Intl.DateTimeFormat(panelLocale(), { hour: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 1, h))
  );
const trimNum = (v) => String(Number(v.toFixed(v < 1 ? 2 : 1)));

function heatTip(d, h, v, mode) {
  const when = `${weekdayName(d)} ${hourName(h)}`;
  if (mode === 'player') return `Online ${Math.round(v * 100)}% of ${weekdayName(d)}s at ${hourName(h)}.`;
  return `${when}: ${trimNum(v)} ${v === 1 ? 'player' : 'players'} online on average.`;
}

/** Fill `container` with a 7x24 grid from a /hours payload. mode: 'server' | 'player'. */
function renderHeatmap(container, data, { mode = 'server' } = {}) {
  if (!container) return;
  if (!data || !data.peakCell) {
    container.innerHTML = '<p class="py-4 text-center text-sm text-ink-faint">No activity in this range.</p>';
    return;
  }
  const max = data.max || 1;
  let html =
    '<div class="overflow-x-auto"><div class="grid min-w-[26rem] grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-0.5" role="img" aria-label="Activity by weekday and hour">';
  html += '<span></span>';
  for (let h = 0; h < 24; h++) {
    html += `<span class="truncate text-center text-[10px] text-ink-faint">${h % 6 === 0 ? esc(hourName(h)) : ''}</span>`;
  }
  for (let d = 0; d < 7; d++) {
    html += `<span class="pr-1 text-right text-[10px] leading-5 text-ink-faint">${esc(weekdayName(d, 'short'))}</span>`;
    for (let h = 0; h < 24; h++) {
      const v = data.cells[d][h];
      const cls =
        v > 0
          ? HEAT_LEVELS[Math.min(HEAT_LEVELS.length - 1, Math.ceil((v / max) * HEAT_LEVELS.length) - 1)]
          : 'bg-inset';
      html += `<div class="h-5 rounded-sm ${cls}" data-tip="${esc(heatTip(d, h, v, mode))}"></div>`;
    }
  }
  html += '</div></div>';
  const p = data.peakCell;
  html += `<p class="mt-2 text-sm text-ink-soft">Busiest: ${esc(weekdayName(p.day))}s around ${esc(hourName(p.hour))}.</p>`;
  container.innerHTML = html;
}

const heatCard = (id, title) => `<div class="card">
  <div class="border-b border-line p-3"><h3 class="font-semibold">${esc(title)}</h3></div>
  <div class="p-3" id="${id}"><p class="py-4 text-center text-sm text-ink-faint">Loading…</p></div>
  <p class="help border-t border-line p-3">Averaged over the selected range, in the panel's time zone.</p>
</div>`;

function init(el) {
  const $ = (id) => document.getElementById(id);
  const isAdmin = el.dataset.admin === '1';
  const opts = [...el.querySelectorAll('[data-server-opt]')];
  const state = {
    servers: null, // null = every visible server
    deleted: false,
    range: '30d',
    tab: 'overview',
    ssort: 'playtime',
    psort: 'playtime',
    q: '',
    server: '',
    player: '',
  };

  // ---- Theme-aware chart colors (canvas can't follow CSS variables) ----
  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fb) => css.getPropertyValue(name).trim() || fb;
    const line = css.getPropertyValue('--color-line').trim();
    return {
      palette: [
        v('--color-grass-400', '#59c53e'),
        v('--color-diamond-400', '#3cc5c7'),
        v('--color-gold-400', '#f0b42f'),
        v('--color-redstone-400', '#f87171'),
        v('--color-stone-400', '#87919b'),
      ],
      grid: line ? `${line}66` : 'rgba(128,128,128,.12)',
      tick: v('--color-ink-faint', '#87919b'),
    };
  }
  let colors = themeColors();
  const charts = {}; // canvas id -> Chart

  function drawChart(id, config) {
    charts[id]?.destroy();
    delete charts[id];
    const canvas = $(id);
    if (!canvas || !window.Chart) return;
    const stacked = !!config.stacked;
    charts[id] = new window.Chart(canvas, {
      type: config.type,
      data: config.data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked, grid: { display: false }, ticks: { color: colors.tick, maxTicksLimit: 8 } },
          y: {
            stacked,
            beginAtZero: true,
            grid: { color: colors.grid },
            ticks: { color: colors.tick, precision: 0, callback: config.yTick },
            ...(config.y || {}),
          },
          ...(config.y1
            ? {
                y1: {
                  position: 'right',
                  beginAtZero: true,
                  grid: { drawOnChartArea: false },
                  ticks: { color: colors.tick, precision: 0 },
                },
              }
            : {}),
        },
        plugins: {
          legend: { display: config.legend, labels: { color: colors.tick, boxWidth: 12 } },
          tooltip: { callbacks: config.tooltip || {} },
        },
      },
    });
  }

  new MutationObserver(() => {
    colors = themeColors();
    for (const ch of Object.values(charts)) {
      ch.options.scales.x.ticks.color = colors.tick;
      ch.options.scales.y.ticks.color = colors.tick;
      ch.options.scales.y.grid.color = colors.grid;
      if (ch.options.scales.y1) ch.options.scales.y1.ticks.color = colors.tick;
      if (ch.options.plugins.legend.labels) ch.options.plugins.legend.labels.color = colors.tick;
      ch.update('none');
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- State <-> query string ----
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.deleted = p.get('deleted') === '1';
    state.range = RANGES.includes(p.get('range')) ? p.get('range') : '30d';
    state.tab = TABS.includes(p.get('tab')) ? p.get('tab') : 'overview';
    state.ssort = SERVER_SORTS.includes(p.get('ssort')) ? p.get('ssort') : 'playtime';
    state.psort = PLAYER_SORTS.includes(p.get('psort')) ? p.get('psort') : 'playtime';
    state.q = (p.get('q') || '').slice(0, 64);
    state.server = p.get('server') || '';
    state.player = p.get('player') || '';
    // A detail link implies its tab.
    if (state.server) state.tab = 'servers';
    else if (state.player) state.tab = 'players';
    const wanted = p.get('servers');
    const set = wanted ? new Set(wanted.split(',').filter(Boolean)) : null;
    for (const o of opts) {
      const box = o.querySelector('input');
      box.checked = set ? set.has(box.value) : true;
    }
    if (set && !opts.some((o) => o.querySelector('input').checked)) {
      for (const o of opts) o.querySelector('input').checked = true; // unknown ids: fall back to all
    }
  }

  function writeUrl(push) {
    const p = new URLSearchParams();
    if (state.servers) p.set('servers', state.servers.join(','));
    if (state.deleted) p.set('deleted', '1');
    if (state.range !== '30d') p.set('range', state.range);
    if (state.tab !== 'overview') p.set('tab', state.tab);
    if (state.ssort !== 'playtime') p.set('ssort', state.ssort);
    if (state.psort !== 'playtime') p.set('psort', state.psort);
    if (state.q) p.set('q', state.q);
    if (state.server) p.set('server', state.server);
    if (state.player) p.set('player', state.player);
    const qs = p.toString();
    const url = location.pathname + (qs ? `?${qs}` : '');
    if (url === location.pathname + location.search) return;
    history[push ? 'pushState' : 'replaceState'](null, '', url);
  }

  // ---- Server picker ----
  function visibleBoxes() {
    return opts.filter((o) => !o.hidden).map((o) => o.querySelector('input'));
  }

  function syncSelection() {
    const boxes = visibleBoxes();
    const on = boxes.filter((b) => b.checked);
    state.servers = on.length === boxes.length ? null : on.map((b) => b.value);
    $('ag-servers-text').textContent =
      on.length === boxes.length
        ? 'All Servers'
        : on.length === 1
          ? opts.find((o) => o.querySelector('input') === on[0]).querySelector('span').textContent
          : `${on.length} of ${boxes.length} Servers`;
  }

  function applyDeletedVisibility() {
    for (const o of opts) {
      if (o.dataset.deleted === '1') o.hidden = !state.deleted;
    }
    $('ag-deleted').checked = state.deleted;
  }

  function syncControls() {
    applyDeletedVisibility();
    syncSelection();
    for (const c of el.querySelectorAll('#ag-ranges [data-range]')) {
      c.setAttribute('aria-pressed', String(c.dataset.range === state.range));
    }
    for (const t of el.querySelectorAll('[data-tab]')) {
      const on = t.dataset.tab === state.tab;
      t.setAttribute('aria-selected', String(on));
      t.classList.toggle('border-grass-500', on);
      t.classList.toggle('text-ink', on);
      t.classList.toggle('border-transparent', !on);
      t.classList.toggle('text-ink-faint', !on);
    }
    for (const p of el.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== state.tab;
    $('ag-q').value = state.q;
    for (const [table, sort] of [
      ['ag-servers-body', state.ssort],
      ['ag-players-body', state.psort],
    ]) {
      for (const b of $(table).closest('table').querySelectorAll('[data-sort]')) {
        const on = b.dataset.sort === sort;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('text-ok', on);
      }
    }
  }

  // ---- API ----
  function baseParams() {
    const p = new URLSearchParams();
    if (state.servers) p.set('servers', state.servers.join(','));
    if (state.deleted) p.set('deleted', '1');
    p.set('range', state.range);
    return p;
  }

  async function api(path, extra = {}) {
    const p = baseParams();
    for (const [k, v] of Object.entries(extra)) if (v !== '' && v != null) p.set(k, v);
    try {
      const res = await fetch(`/api/analytics${path}?${p}`, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast(friendlyError(res, { action: 'load analytics' }), { kind: 'error' });
        return null;
      }
      return data;
    } catch (err) {
      toast(friendlyError(err, { action: 'load analytics' }), { kind: 'error' });
      return null;
    }
  }

  const tokens = {}; // per-section request token: a stale response never paints over a newer one
  const fresh = (name) => (tokens[name] = (tokens[name] || 0) + 1);
  const stale = (name, t) => tokens[name] !== t;

  const emptyRow = (cols, text) =>
    `<tr><td colspan="${cols}" class="p-6 text-center text-ink-faint">${esc(text)}</td></tr>`;
  const noneSelected = () => visibleBoxes().every((b) => !b.checked);

  // ---- Overview ----
  async function loadOverview() {
    const t = fresh('overview');
    if (noneSelected()) {
      for (const id of ['play', 'players', 'peak', 'sessions', 'busiest']) $(`ag-t-${id}`).textContent = '0';
      $('ag-heat').innerHTML = '';
      return;
    }
    const [sum, online, srv, top, hours] = await Promise.all([
      api('/summary'),
      api('/online', { split: $('ag-split').checked ? '1' : '' }),
      api('/servers', { sort: 'playtime' }),
      api('/players', { sort: 'playtime', limit: 10 }),
      api('/hours'),
    ]);
    if (stale('overview', t)) return;
    if (sum) renderTiles(sum.summary);
    if (online) renderOnline(online);
    if (srv) renderBars(srv.servers);
    if (top) renderTop(top.rows);
    if (hours) renderHeatmap($('ag-heat'), hours, { mode: 'server' });
  }

  function renderTiles(s) {
    $('ag-t-play').textContent = fmtDuration(s.playSeconds);
    $('ag-t-players').textContent = num(s.uniquePlayers);
    $('ag-t-peak').textContent = num(s.peakOnline);
    $('ag-t-peak-at').innerHTML = s.peakOnline && s.peakAt ? absTime(s.peakAt) : '';
    $('ag-t-sessions').textContent = num(s.sessions);
    const b = s.busiestServer;
    $('ag-t-busiest').textContent = b ? b.name : 'None yet';
    $('ag-t-busiest-play').textContent = b ? fmtDuration(b.playSeconds) : '';
  }

  function renderOnline(data) {
    const empty = !data.series.some((s) => s.values.some((v) => v > 0));
    $('ag-online-empty').classList.toggle('hidden', !empty);
    $('ag-online-chart').parentElement.classList.toggle('hidden', empty);
    if (empty) {
      charts['ag-online-chart']?.destroy();
      delete charts['ag-online-chart'];
      return;
    }
    const daily = data.bucketMs >= 86_400_000;
    const labels = data.buckets.map((b) =>
      daily ? formatDateTime(b, { timeStyle: undefined }) : formatDateTime(b, { dateStyle: 'short' })
    );
    const split = data.series.length > 1 || data.series[0]?.serverId;
    drawChart('ag-online-chart', {
      type: 'line',
      stacked: !!split,
      legend: !!split,
      data: {
        labels,
        datasets: data.series.map((s, i) => {
          const c = colors.palette[i % colors.palette.length];
          return {
            label: s.name,
            data: s.values,
            borderColor: c,
            backgroundColor: `${c}${split ? '55' : '33'}`,
            fill: true,
            tension: 0.25,
            pointRadius: 0,
            borderWidth: 2,
          };
        }),
      },
    });
  }

  function renderBars(list) {
    const box = $('ag-bars');
    const rows = list.filter((s) => s.playSeconds > 0);
    if (!rows.length) {
      box.innerHTML = '<p class="py-4 text-center text-sm text-ink-faint">No play time recorded in this range.</p>';
      return;
    }
    const max = Math.max(...rows.map((s) => s.playSeconds));
    box.innerHTML = rows
      .map(
        (s) => `<div class="mb-3 last:mb-0">
          <div class="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span class="min-w-0 truncate">${esc(s.name)}${s.deleted ? ' <span class="badge">Deleted</span>' : ''}</span>
            <span class="shrink-0 tabular-nums text-ink-faint">${esc(fmtDuration(s.playSeconds))}</span>
          </div>
          <div class="h-2 rounded-sm bg-inset"><div class="h-full rounded-sm bg-ok" style="width:${Math.max(2, Math.round((s.playSeconds / max) * 100))}%"></div></div>
        </div>`
      )
      .join('');
  }

  function playerCell(p, serverId, sub = '') {
    const uuid = p.uuid || '';
    return `<span class="flex min-w-0 items-center gap-2">
      <img class="size-6 shrink-0 rounded-sm bg-inset" alt="" ${uuid ? `data-head-uuid="${esc(uuid)}" data-head-server="${esc(serverId || '')}"` : ''} src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
      <span class="min-w-0"><span class="block truncate">${esc(p.name)}</span>${sub ? `<span class="block truncate text-xs font-normal text-ink-faint">${esc(sub)}</span>` : ''}</span></span>`;
  }

  function paintHeads(scope) {
    for (const img of scope.querySelectorAll('img[data-head-uuid]')) {
      if (img.dataset.headServer) renderPlayerHead(img, img.dataset.headUuid, { serverId: img.dataset.headServer });
    }
  }

  function renderTop(rows) {
    const ol = $('ag-top');
    if (!rows.length) {
      ol.innerHTML = '<li class="p-6 text-center text-sm text-ink-faint">No play time recorded in this range.</li>';
      return;
    }
    ol.innerHTML = rows
      .map((p, i) => {
        const live = (p.servers || []).find((s) => !s.deleted);
        return `<li><a class="flex items-center gap-3 p-3 text-sm hover:bg-inset" href="#" data-open-player="${esc(p.key)}">
          <span class="w-5 shrink-0 text-right tabular-nums text-ink-faint">${i + 1}</span>
          ${playerCell(p, live && live.id)}
          <span class="ml-auto shrink-0 tabular-nums text-ink-faint">${esc(fmtDuration(p.playSeconds))}</span></a></li>`;
      })
      .join('');
    paintHeads(ol);
  }

  // ---- Servers tab ----
  async function loadServers() {
    if (state.server) return loadServerDetail();
    showDetail('server', false);
    const t = fresh('servers');
    const body = $('ag-servers-body');
    if (noneSelected()) {
      body.innerHTML = emptyRow(6, 'Select at least one server.');
      return;
    }
    body.innerHTML = emptyRow(6, 'Loading…');
    const data = await api('/servers', { sort: state.ssort });
    if (stale('servers', t)) return;
    if (!data) {
      body.innerHTML = emptyRow(6, 'Could not load servers.');
      return;
    }
    if (!data.servers.length) {
      body.innerHTML = emptyRow(6, 'No servers match these filters.');
      return;
    }
    body.innerHTML = data.servers
      .map(
        (s) => `<tr>
        <td data-th="Server"><button type="button" class="flex items-center gap-2 text-left font-medium hover:underline" data-open-server="${esc(s.id)}">
          <span class="truncate">${esc(s.name)}</span>${s.deleted ? '<span class="badge">Deleted</span>' : ''}</button></td>
        <td class="text-right tabular-nums" data-th="Players">${num(s.players)}</td>
        <td class="text-right tabular-nums" data-th="Play Time">${esc(fmtDuration(s.playSeconds))}</td>
        <td class="text-right tabular-nums" data-th="Peak Online">${num(s.peakOnline)}</td>
        <td class="text-right tabular-nums ${s.tpsAvg == null ? '' : tpsClass(s.tpsAvg)}" data-th="Avg TPS">${s.tpsAvg == null ? '' : esc(String(s.tpsAvg))}</td>
        <td class="text-right" data-th="Last Active">${seenTime(s.lastActive, s.online)}</td></tr>`
      )
      .join('');
  }

  function showDetail(which, on) {
    const [list, detail] =
      which === 'server' ? ['ag-servers-list', 'ag-server-detail'] : ['ag-players-list', 'ag-player-detail'];
    $(list).hidden = on;
    $(detail).hidden = !on;
    if (!on) {
      const canvases = which === 'server' ? ['ag-s-daily', 'ag-perf-tps', 'ag-perf-mem'] : ['ag-p-daily'];
      for (const id of canvases) {
        charts[id]?.destroy();
        delete charts[id];
      }
    }
  }

  const backLink = (kind, label) =>
    `<button type="button" class="btn btn-ghost btn-sm" data-back="${kind}">${label}</button>`;

  async function loadServerDetail() {
    showDetail('server', true);
    const box = $('ag-server-detail');
    const t = fresh('server-detail');
    box.innerHTML = `${backLink('server', 'Back to Servers')}<p class="p-6 text-center text-sm text-ink-faint">Loading…</p>`;
    const data = await api(`/servers/${encodeURIComponent(state.server)}`);
    if (stale('server-detail', t)) return;
    if (!data) {
      box.innerHTML = `${backLink('server', 'Back to Servers')}<div class="notice notice-warn">That server's stats could not be loaded.</div>`;
      return;
    }
    const s = data.server;
    const live = s.deleted ? '' : s.id;
    box.innerHTML = `
      <div>${backLink('server', 'Back to Servers')}</div>
      <div class="card flex flex-wrap items-center gap-3 p-3">
        <h3 class="min-w-0 truncate text-lg font-semibold">${esc(s.name)}</h3>
        ${s.deleted ? '<span class="badge">Deleted</span>' : ''}
        ${s.deleted && s.deletedAt ? `<span class="text-xs text-ink-faint">Deleted ${relTime(s.deletedAt)}.</span>` : ''}
        ${s.deleted && isAdmin ? '<button type="button" class="btn btn-danger btn-sm ml-auto" id="ag-remove-stats">Remove Stats</button>' : ''}
      </div>
      <div class="grid items-start gap-4 lg:grid-cols-2">
        <div class="card">
          <div class="border-b border-line p-3"><h3 class="font-semibold">Players</h3></div>
          <ol class="divide-y divide-line" id="ag-s-players"></ol>
        </div>
        <div class="card">
          <div class="border-b border-line p-3"><h3 class="font-semibold">Play Time per Day</h3></div>
          <div class="relative h-64 p-3"><canvas id="ag-s-daily" role="img" aria-label="Play time per day"></canvas></div>
          <p class="hidden p-6 text-center text-sm text-ink-faint" id="ag-s-daily-empty">No play time recorded in this range.</p>
        </div>
      </div>
      ${heatCard('ag-s-heat', 'When Players Are Online')}
      ${s.deleted ? '' : perfCard()}`;
    if (!s.deleted) {
      api(`/servers/${encodeURIComponent(s.id)}/performance`).then((perf) => {
        if (!stale('server-detail', t)) renderPerformance(perf);
      });
    }
    api('/hours', { servers: s.id, deleted: '1' }).then((h) => {
      if (!stale('server-detail', t) && h) renderHeatmap($('ag-s-heat'), h, { mode: 'server' });
    });
    const ol = $('ag-s-players');
    ol.innerHTML = data.players.length
      ? data.players
          .map(
            (
              p
            ) => `<li><a class="flex items-center gap-3 p-3 text-sm hover:bg-inset" href="#" data-open-player="${esc(p.key)}">
              ${playerCell(p, live, statLine(p.gameplay, 3))}
              <span class="ml-auto shrink-0 text-right tabular-nums text-ink-faint">${esc(fmtDuration(p.playSeconds))}<span class="block text-xs">${seenTime(p.lastSeen, p.online)}</span></span></a></li>`
          )
          .join('')
      : '<li class="p-6 text-center text-sm text-ink-faint">No play time recorded in this range.</li>';
    paintHeads(ol);

    const hasDaily = data.daily.some((d) => d.playSeconds > 0);
    $('ag-s-daily-empty').classList.toggle('hidden', hasDaily);
    $('ag-s-daily').parentElement.classList.toggle('hidden', !hasDaily);
    if (hasDaily) {
      drawChart('ag-s-daily', {
        type: 'bar',
        legend: false,
        yTick: (v) => fmtDuration(v),
        tooltip: { label: (c) => fmtDuration(c.parsed.y) },
        data: {
          labels: data.daily.map((d) => d.day),
          datasets: [
            { label: 'Play Time', data: data.daily.map((d) => d.playSeconds), backgroundColor: colors.palette[0] },
          ],
        },
      });
    }
    $('ag-remove-stats')?.addEventListener('click', (e) => removeStats(s, e.currentTarget));
  }

  const perfCard = () => `<div class="card" id="ag-perf">
      <div class="border-b border-line p-3"><h3 class="font-semibold">Performance</h3></div>
      <div class="p-3">
        <div class="mb-3 flex flex-wrap gap-1" id="ag-perf-chips"></div>
        <p class="py-4 text-center text-sm text-ink-faint" id="ag-perf-state">Loading…</p>
        <div id="ag-perf-charts" hidden class="space-y-4">
          <div class="relative h-64"><canvas id="ag-perf-tps" role="img" aria-label="Server TPS and players online over time"></canvas></div>
          <div class="relative h-40"><canvas id="ag-perf-mem" role="img" aria-label="Memory used over time"></canvas></div>
        </div>
      </div>
    </div>`;

  function renderPerformance(perf) {
    const state = $('ag-perf-state');
    if (!state) return;
    const hasData = perf && perf.points.some((x) => x.tpsAvg != null || x.playersAvg != null || x.memAvg != null);
    $('ag-perf-charts').hidden = !hasData;
    $('ag-perf-chips').innerHTML = '';
    for (const id of ['ag-perf-tps', 'ag-perf-mem']) {
      charts[id]?.destroy();
      delete charts[id];
    }
    if (!hasData) {
      state.hidden = false;
      state.textContent = perf
        ? 'No performance samples in this range. Samples are recorded every minute while the server runs.'
        : 'Could not load performance data.';
      return;
    }
    state.hidden = true;
    const sm = perf.summary;
    const chips = [];
    if (sm.tpsAvg != null) chips.push(`Avg TPS ${sm.tpsAvg}`);
    if (sm.tpsMin != null) chips.push(`Lowest TPS ${sm.tpsMin}`);
    if (sm.playersMax != null) chips.push(`Peak Players ${sm.playersMax}`);
    if (sm.memMax != null) chips.push(`Peak Memory ${gbFmt(sm.memMax)}`);
    $('ag-perf-chips').innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');

    const daily = perf.bucketMs >= 86_400_000;
    const labels = perf.points.map((x) =>
      daily ? formatDateTime(x.t, { timeStyle: undefined }) : formatDateTime(x.t, { dateStyle: 'short' })
    );
    const pts = perf.points;
    const line = (label, data, color, extra = {}) => ({
      label,
      data,
      borderColor: color,
      backgroundColor: color,
      spanGaps: false,
      pointRadius: 0,
      borderWidth: 2,
      tension: 0.2,
      ...extra,
    });
    drawChart('ag-perf-tps', {
      type: 'line',
      legend: true,
      y: { min: 0, max: 20, ticks: { color: colors.tick, precision: 0 } },
      y1: true,
      data: {
        labels,
        datasets: [
          line(
            'TPS',
            pts.map((x) => x.tpsAvg),
            colors.palette[0],
            { yAxisID: 'y' }
          ),
          line(
            'Target TPS',
            pts.map(() => 20),
            colors.tick,
            { yAxisID: 'y', borderDash: [4, 4], borderWidth: 1 }
          ),
          line(
            'Players',
            pts.map((x) => x.playersAvg),
            colors.palette[1],
            { yAxisID: 'y1' }
          ),
          line(
            'Peak Players',
            pts.map((x) => x.playersMax),
            `${colors.palette[1]}66`,
            { yAxisID: 'y1', borderWidth: 1 }
          ),
        ],
      },
    });
    const gb = (v) => (v == null ? null : Math.round((v / 1024 ** 3) * 100) / 100);
    drawChart('ag-perf-mem', {
      type: 'line',
      legend: true,
      yTick: (v) => `${v} GB`,
      tooltip: { label: (c) => `${c.dataset.label}: ${c.parsed.y} GB` },
      data: {
        labels,
        datasets: [
          line(
            'Memory Used',
            pts.map((x) => gb(x.memAvg)),
            colors.palette[2],
            { fill: true, backgroundColor: `${colors.palette[2]}33` }
          ),
          line(
            'Memory Limit',
            pts.map((x) => gb(x.memLimit)),
            colors.tick,
            { borderDash: [4, 4], borderWidth: 1 }
          ),
        ],
      },
    });
  }

  async function removeStats(s, btn) {
    const ok = await confirmDialog({
      title: 'Remove these stats?',
      message: `This permanently removes the recorded play time for ${s.name}.`,
      detail: 'The server is already deleted, so this cannot be undone.',
      confirmLabel: 'Remove Stats',
      danger: true,
    });
    if (!ok) return;
    await withBusy(btn, 'Removing…', async () => {
      try {
        const res = await fetch(`/api/analytics/deleted-servers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        if (!res.ok) {
          toast(friendlyError(res, { action: 'remove these stats' }), { kind: 'error' });
          return;
        }
        toast('Stats removed.');
        const box = opts.find((o) => o.querySelector('input').value === s.id);
        if (box) {
          box.remove();
          opts.splice(opts.indexOf(box), 1);
        }
        state.server = '';
        syncSelection();
        writeUrl(false);
        refresh();
      } catch (err) {
        toast(friendlyError(err, { action: 'remove these stats' }), { kind: 'error' });
      }
    });
  }

  // ---- Players tab ----
  let playerRows = [];
  let nextCursor = null;

  async function loadPlayers({ more = false } = {}) {
    if (state.player) return loadPlayerDetail();
    showDetail('player', false);
    const t = fresh('players');
    const body = $('ag-players-body');
    if (noneSelected()) {
      body.innerHTML = emptyRow(4, 'Select at least one server.');
      $('ag-more').hidden = true;
      return;
    }
    if (!more) {
      playerRows = [];
      body.innerHTML = emptyRow(4, 'Loading…');
    }
    const data = await api('/players', {
      sort: state.psort,
      q: state.q,
      limit: PAGE_SIZE,
      cursor: more ? nextCursor : '',
    });
    if (stale('players', t)) return;
    if (!data) {
      if (!more) body.innerHTML = emptyRow(4, 'Could not load players.');
      return;
    }
    playerRows = playerRows.concat(data.rows);
    nextCursor = data.nextCursor;
    $('ag-more').hidden = nextCursor == null;
    if (!playerRows.length) {
      body.innerHTML = emptyRow(4, state.q ? 'No players match that search.' : 'No players recorded in this range.');
      return;
    }
    body.innerHTML = playerRows
      .map((p) => {
        const live = (p.servers || []).find((s) => !s.deleted);
        const chips = (p.servers || [])
          .map(
            (s) =>
              `<span class="chip max-w-40"><span class="truncate">${esc(s.name)}</span>${s.deleted ? '<span class="badge">Deleted</span>' : ''}</span>`
          )
          .join('');
        return `<tr>
          <td data-th="Player"><button type="button" class="text-left font-medium hover:underline" data-open-player="${esc(p.key)}">${playerCell(p, live && live.id)}</button></td>
          <td class="text-right tabular-nums" data-th="Play Time">${esc(fmtDuration(p.playSeconds))}</td>
          <td data-th="Servers"><span class="flex flex-wrap gap-1">${chips}</span></td>
          <td class="text-right" data-th="Last Seen">${seenTime(p.lastSeen, p.online)}</td></tr>`;
      })
      .join('');
    paintHeads(body);
  }

  function gameplayTiles(g) {
    const keys = STAT_ORDER.filter((k) => Number((g || {})[k]) > 0).slice(0, 6);
    if (!keys.length) return '';
    return `<div><h3 class="mb-2 font-semibold">Gameplay</h3>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">${keys
        .map(
          (k) =>
            `<div class="card p-3"><div class="eyebrow">${esc(STAT_LABELS[k])}</div><div class="mt-1 text-xl font-semibold tabular-nums">${esc(fmtStat(k, Number(g[k])))}</div></div>`
        )
        .join('')}</div></div>`;
  }

  /** Per-session summary line, or '' when nothing should show. */
  function sessionStats(s) {
    if (s.statsState === 'unavailable') return '';
    if (s.stats) return statLine(s.stats, 4, ['deaths', 'blocksMinedTotal', 'mobKills', 'distanceCm', 'diamondsMined']);
    const ended = s.endedAt ? Date.parse(s.endedAt) : NaN;
    return Date.now() - ended < 2 * 3_600_000 ? 'Stats pending.' : '';
  }

  async function loadPlayerDetail() {
    showDetail('player', true);
    const box = $('ag-player-detail');
    const t = fresh('player-detail');
    box.innerHTML = `${backLink('player', 'Back to Players')}<p class="p-6 text-center text-sm text-ink-faint">Loading…</p>`;
    const data = await api(`/players/${encodeURIComponent(state.player)}`);
    if (stale('player-detail', t)) return;
    if (!data) {
      box.innerHTML = `${backLink('player', 'Back to Players')}<div class="notice notice-warn">That player's stats could not be loaded.</div>`;
      return;
    }
    const p = data.player;
    const live = data.servers.find((s) => !s.deleted);
    box.innerHTML = `
      <div>${backLink('player', 'Back to Players')}</div>
      <div class="card flex items-center gap-3 p-3 text-lg font-semibold">${playerCell(p, live && live.id)}</div>
      ${gameplayTiles(data.gameplay)}
      <div class="card overflow-x-auto">
        <table class="table-base table-stack">
          <thead><tr><th data-th="Server">Server</th><th class="text-right" data-th="Play Time">Play Time</th><th class="text-right" data-th="Sessions">Sessions</th><th class="text-right" data-th="Deaths">Deaths</th><th class="text-right" data-th="Blocks Mined">Blocks Mined</th><th class="text-right" data-th="First Seen">First Seen</th><th class="text-right" data-th="Last Seen">Last Seen</th></tr></thead>
          <tbody>${
            data.servers.length
              ? data.servers
                  .map(
                    (s) => `<tr>
              <td data-th="Server"><span class="flex items-center gap-2"><span class="truncate">${esc(s.name)}</span>${s.deleted ? '<span class="badge">Deleted</span>' : ''}</span></td>
              <td class="text-right tabular-nums" data-th="Play Time">${esc(fmtDuration(s.playSeconds))}</td>
              <td class="text-right tabular-nums" data-th="Sessions">${num(s.sessions)}</td>
              <td class="text-right tabular-nums" data-th="Deaths">${compact((s.gameplay || {}).deaths)}</td>
              <td class="text-right tabular-nums" data-th="Blocks Mined">${compact((s.gameplay || {}).blocksMinedTotal)}</td>
              <td class="text-right" data-th="First Seen">${absTime(s.firstSeen)}</td>
              <td class="text-right" data-th="Last Seen">${seenTime(s.lastSeen, s.online)}</td></tr>`
                  )
                  .join('')
              : emptyRow(7, 'No play time recorded in this range.')
          }</tbody>
        </table>
      </div>
      <div class="card">
        <div class="border-b border-line p-3"><h3 class="font-semibold">Play Time per Day</h3></div>
        <div class="relative h-64 p-3"><canvas id="ag-p-daily" role="img" aria-label="Play time per day by server"></canvas></div>
        <p class="hidden p-6 text-center text-sm text-ink-faint" id="ag-p-daily-empty">No play time recorded in this range.</p>
      </div>
      ${heatCard('ag-p-heat', 'Usual Play Times')}
      <div class="card">
        <div class="border-b border-line p-3"><h3 class="font-semibold">Recent Sessions</h3></div>
        <ol class="divide-y divide-line" id="ag-p-sessions"></ol>
      </div>`;

    api('/hours', { player: p.key }).then((h) => {
      if (!stale('player-detail', t) && h) renderHeatmap($('ag-p-heat'), h, { mode: 'player' });
    });

    const hasDaily = data.daily.some((d) => Object.values(d.byServer || {}).some((v) => v > 0));
    $('ag-p-daily-empty').classList.toggle('hidden', hasDaily);
    $('ag-p-daily').parentElement.classList.toggle('hidden', !hasDaily);
    if (hasDaily) {
      drawChart('ag-p-daily', {
        type: 'bar',
        stacked: true,
        legend: data.servers.length > 1,
        yTick: (v) => fmtDuration(v),
        tooltip: { label: (c) => `${c.dataset.label}: ${fmtDuration(c.parsed.y)}` },
        data: {
          labels: data.daily.map((d) => d.day),
          datasets: data.servers.map((s, i) => ({
            label: s.name,
            data: data.daily.map((d) => (d.byServer || {})[s.id] || 0),
            backgroundColor: colors.palette[i % colors.palette.length],
          })),
        },
      });
    }

    $('ag-p-sessions').innerHTML = data.recentSessions.length
      ? data.recentSessions
          .map((s) => {
            const secs = s.endedAt ? (new Date(s.endedAt) - new Date(s.startedAt)) / 1000 : null;
            const line = sessionStats(s);
            return `<li class="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span class="min-w-0 flex-1"><span class="block truncate">${esc(s.serverName)}</span>${line ? `<span class="block truncate text-xs text-ink-faint">${esc(line)}</span>` : ''}</span>
              <span class="text-ink-faint">${absTime(s.startedAt)}</span>
              <span class="w-20 shrink-0 text-right tabular-nums">${s.endedAt ? esc(fmtDuration(secs)) : '<span class="badge badge-ok">Online</span>'}</span></li>`;
          })
          .join('')
      : '<li class="p-6 text-center text-sm text-ink-faint">No sessions recorded in this range.</li>';
  }

  // ---- Orchestration ----
  function refresh() {
    if (state.tab === 'overview') return loadOverview();
    if (state.tab === 'servers') return loadServers();
    return loadPlayers();
  }

  function change({ push = false } = {}) {
    syncControls();
    writeUrl(push);
    refresh();
  }

  el.addEventListener('click', (e) => {
    const range = e.target.closest('[data-range]');
    if (range) {
      state.range = range.dataset.range;
      return change();
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      state.server = '';
      state.player = '';
      return change({ push: true });
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      state[state.tab === 'servers' ? 'ssort' : 'psort'] = sort.dataset.sort;
      return change();
    }
    const os = e.target.closest('[data-open-server]');
    if (os) {
      e.preventDefault();
      state.server = os.dataset.openServer;
      return change({ push: true });
    }
    const op = e.target.closest('[data-open-player]');
    if (op) {
      e.preventDefault();
      state.tab = 'players';
      state.player = op.dataset.openPlayer;
      return change({ push: true });
    }
    const back = e.target.closest('[data-back]');
    if (back) {
      state[back.dataset.back] = '';
      return change({ push: true });
    }
    if (e.target.closest('#ag-more')) loadPlayers({ more: true });
  });

  $('ag-deleted').addEventListener('change', (e) => {
    state.deleted = e.target.checked;
    applyDeletedVisibility();
    change();
  });
  $('ag-split').addEventListener('change', () => {
    if (state.tab === 'overview') loadOverview();
  });
  $('ag-servers').addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"]')) change();
  });
  $('ag-servers-all').addEventListener('click', () => {
    for (const b of visibleBoxes()) b.checked = true;
    change();
  });
  $('ag-servers-none').addEventListener('click', () => {
    for (const b of visibleBoxes()) b.checked = false;
    change();
  });
  document.addEventListener('click', (e) => {
    const d = $('ag-servers');
    if (d.open && !d.contains(e.target)) d.open = false;
  });

  let qTimer;
  $('ag-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      writeUrl(false);
      loadPlayers();
    }, 300);
  });

  window.addEventListener('popstate', () => {
    readUrl();
    syncControls();
    refresh();
  });

  readUrl();
  syncControls();
  writeUrl(false);
  refresh();
}
