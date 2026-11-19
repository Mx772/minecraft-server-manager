'use strict';

// Custom domains per server (e.g. atm10.example.com): storage, the DNS/SRV
// check, state-change history, reachability pings, and the "which address do
// we show players" helper used by the overview, status page and /api/v1.

const net = require('node:net');
const db = require('../../db');
const httpError = require('../../utils/httpError');
const { recordEvent } = require('../../events');
const { makeFailureThrottle } = require('../../logger');
const logger = require('../../logger')(require('node:path').basename(__filename));
const settings = require('../settings');
const { serializeError } = require('../../utils/logSanitize');
const { gather } = require('./resolve');
const { evaluate } = require('./srvCheck');
const slp = require('./slp');
const external = require('./external');

const MAX_DOMAINS_PER_SERVER = 10;
// States where players can type the bare domain (no port) and get here.
const VERIFIED_STATES = new Set(['points-here', 'no-srv-needed']);

/** @type {import('./resolve').ResolverLike | undefined} */
let resolverOverride;
/** Test seam: use this resolver for every check (pass undefined to reset). */
function _setResolver(r) {
  resolverOverride = r;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate and normalise a hostname: lowercase, no trailing dot, no scheme,
 * port, path or IP literal, at least two labels.
 * @param {string} input
 * @returns {string}
 */
function normalizeDomain(input) {
  const raw = String(input || '')
    .trim()
    .toLowerCase();
  const bad = () => httpError(400, 'Enter a domain such as atm10.example.com, with no http://, port or path.');
  if (!raw || /[/:@\s?#]/.test(raw)) throw bad();
  const domain = raw.replace(/\.$/, '');
  if (domain.length > 253 || net.isIP(domain)) throw bad();
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) throw bad();
  if (/^\d+$/.test(labels[labels.length - 1])) throw bad(); // an all-numeric TLD is an IP in disguise
  return domain;
}

function serverRow(serverId) {
  const row = db.get(
    'SELECT id, type, port_game, port_bedrock FROM servers WHERE id = ? AND deleted_at IS NULL',
    serverId
  );
  if (!row) throw httpError(404, 'Server not found.');
  return row;
}

function parseCheck(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function present(r) {
  return {
    domain: r.domain,
    isPrimary: r.is_primary === 1,
    state: r.last_state || null,
    check: parseCheck(r.last_check_json),
    checkedAt: r.last_checked_at || null,
    dnsProviderId: r.dns_provider_id || null,
  };
}

/**
 * Bedrock clients ignore SRV records, so a Bedrock server (or one with a Geyser
 * port mapped) shows the Bedrock port next to the domain instead. Geyser has no
 * reliable marker beyond its mapped UDP port, so that port is the signal.
 */
function bedrockInfo(row) {
  if (row.type === 'BEDROCK' || row.port_bedrock) return { port: row.port_bedrock || 19132 };
  return null;
}

/** @param {string} serverId */
function list(serverId) {
  const row = serverRow(serverId);
  const domains = db
    .all('SELECT * FROM server_domains WHERE server_id = ? ORDER BY is_primary DESC, created_at, domain', serverId)
    .map(present);
  const primary = domains.find((d) => d.isPrimary);
  return {
    domains,
    primary: primary ? primary.domain : null,
    gamePort: row.port_game,
    publicHost: settings.getPublicHost() || null,
    bedrock: bedrockInfo(row),
  };
}

/** The primary domain string, or null. */
function primaryDomain(serverId) {
  const r = db.get('SELECT domain FROM server_domains WHERE server_id = ? AND is_primary = 1', serverId);
  return r ? r.domain : null;
}

/**
 * What to show players as the server address: the primary domain (no port) once
 * its DNS check verified it, else null. DB read only, so it is safe on public pages.
 */
function addressFor(serverId) {
  const r = db.get('SELECT domain, last_state FROM server_domains WHERE server_id = ? AND is_primary = 1', serverId);
  return r && VERIFIED_STATES.has(r.last_state) ? r.domain : null;
}

function add(serverId, domain, { actor = 'system' } = {}) {
  serverRow(serverId);
  const clean = normalizeDomain(domain);
  const existing = db.all('SELECT domain FROM server_domains WHERE server_id = ?', serverId);
  if (existing.some((d) => d.domain === clean)) throw httpError(409, `${clean} is already added to this server.`);
  if (existing.length >= MAX_DOMAINS_PER_SERVER) {
    throw httpError(400, `A server can have up to ${MAX_DOMAINS_PER_SERVER} domains. Remove one first.`);
  }
  db.run(
    'INSERT INTO server_domains (server_id, domain, is_primary) VALUES (?, ?, ?)',
    serverId,
    clean,
    existing.length === 0 ? 1 : 0
  );
  recordEvent({
    serverId,
    actor,
    type: 'domain-added',
    summary: `Domain added: ${clean}.`,
    details: { domain: clean },
  });
  return list(serverId);
}

function mustHave(serverId, domain) {
  const clean = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  const row = db.get('SELECT * FROM server_domains WHERE server_id = ? AND domain = ?', serverId, clean);
  if (!row) throw httpError(404, 'That domain is not set up on this server.');
  return row;
}

function remove(serverId, domain, { actor = 'system' } = {}) {
  const row = mustHave(serverId, domain);
  db.transaction(() => {
    db.run('DELETE FROM server_domains WHERE server_id = ? AND domain = ?', serverId, row.domain);
    if (row.is_primary === 1) {
      // Promote the oldest remaining domain so a server with domains always has a primary.
      const next = db.get(
        'SELECT domain FROM server_domains WHERE server_id = ? ORDER BY created_at, domain',
        serverId
      );
      if (next)
        db.run('UPDATE server_domains SET is_primary = 1 WHERE server_id = ? AND domain = ?', serverId, next.domain);
    }
  });
  recordEvent({
    serverId,
    actor,
    type: 'domain-removed',
    summary: `Domain removed: ${row.domain}.`,
    details: { domain: row.domain },
  });
  return list(serverId);
}

function setPrimary(serverId, domain, { actor = 'system' } = {}) {
  const row = mustHave(serverId, domain);
  if (row.is_primary === 1) return list(serverId);
  db.transaction(() => {
    db.run('UPDATE server_domains SET is_primary = 0 WHERE server_id = ?', serverId);
    db.run('UPDATE server_domains SET is_primary = 1 WHERE server_id = ? AND domain = ?', serverId, row.domain);
  });
  recordEvent({
    serverId,
    actor,
    type: 'domain-primary-changed',
    summary: `Primary domain changed to ${row.domain}.`,
    details: { domain: row.domain },
  });
  return list(serverId);
}

const CHANGE_SUMMARY = {
  'points-here': (d) => `${d} now points to this server.`,
  'wrong-port': (d) => `${d} now points to the wrong port.`,
  'different-ip': (d) => `${d} now points at a different IP.`,
  'no-srv-needed': (d) => `${d} now resolves without needing an SRV record.`,
  'missing-srv': (d) => `${d} is now missing its SRV record.`,
  'not-found': (d) => `${d} can no longer be found in DNS.`,
};

/**
 * Run the DNS check for one domain, store the result, and record a history
 * event only when the state changed from a previous one.
 * @param {string} serverId
 * @param {string} domain
 * @param {{ actor?: string, resolver?: import('./resolve').ResolverLike }} [opts]
 */
async function check(serverId, domain, { actor = 'system', resolver } = {}) {
  const row = mustHave(serverId, domain);
  const server = serverRow(serverId);
  const publicHost = settings.getPublicHost();
  const facts = await gather(row.domain, { publicHost, resolver: resolver || resolverOverride });
  const result = evaluate({ ...facts, gamePort: server.port_game, domain: row.domain });
  const best = facts.srv.length
    ? [...facts.srv].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
    : null;
  const stored = {
    ...result,
    srv: best ? { name: best.name, port: best.port } : null,
    gamePort: server.port_game,
  };
  // A resolver hiccup is not a verdict: keep the last real state so one bad
  // lookup does not hide a verified address or write a misleading history line.
  const keepState = result.state === 'resolver-error' && row.last_state;
  db.run(
    `UPDATE server_domains SET last_state = ?, last_check_json = ?, last_checked_at = datetime('now')
     WHERE server_id = ? AND domain = ?`,
    keepState ? row.last_state : result.state,
    JSON.stringify(stored),
    serverId,
    row.domain
  );
  if (!keepState && row.last_state && row.last_state !== result.state && CHANGE_SUMMARY[result.state]) {
    recordEvent({
      serverId,
      actor,
      type: 'domain-dns-changed',
      summary: CHANGE_SUMMARY[result.state](row.domain),
      details: { domain: row.domain, from: row.last_state, to: result.state },
    });
  }
  return { domain: row.domain, ...stored, previousState: row.last_state || null };
}

/** Check every domain of one server in turn. */
async function checkAll(serverId, opts = {}) {
  const out = [];
  for (const d of db.all('SELECT domain FROM server_domains WHERE server_id = ? ORDER BY domain', serverId)) {
    out.push(await check(serverId, d.domain, opts));
  }
  return out;
}

const failures = makeFailureThrottle();

/** The scheduled sweep: every domain of every server, one at a time. Never throws for a single failure. */
async function checkEverything({ actor = 'scheduler' } = {}) {
  const rows = db.all(
    `SELECT d.server_id, d.domain FROM server_domains d
       JOIN servers s ON s.id = d.server_id AND s.deleted_at IS NULL
      ORDER BY d.server_id, d.domain`
  );
  let failed = 0;
  for (const r of rows) {
    try {
      await check(r.server_id, r.domain, { actor });
    } catch (err) {
      failed += 1;
      failures.fail(logger.warn, 'A domain DNS check failed.', { serverId: r.server_id, err: serializeError(err) });
    }
  }
  if (!failed) failures.ok(logger.info, 'Domain DNS checks recovered.');
  return { checked: rows.length - failed, failed };
}

/**
 * Ping a domain. "panel" connects from this machine (private); "external" asks
 * a public status service and only runs when an admin has opted in.
 * @param {string} serverId
 * @param {string} domain
 * @param {{ mode?: 'panel'|'external', ping?: typeof slp.ping, fetch?: typeof fetch, resolver?: import('./resolve').ResolverLike }} [opts]
 */
async function reachability(serverId, domain, { mode = 'panel', ping = slp.ping, fetch: doFetch, resolver } = {}) {
  const row = mustHave(serverId, domain);
  if (mode === 'external') {
    const r = await external.check(row.domain, { fetch: doFetch });
    return { mode, domain: row.domain, ...r };
  }
  const r = await ping({ host: row.domain, resolver: resolver || resolverOverride });
  if (r.ok) return { mode, domain: row.domain, ...r };
  return {
    mode,
    domain: row.domain,
    ...r,
    // Behind many home routers the panel cannot reach its own public address.
    hint: 'A failure from the panel is not proof that players cannot connect. Many home routers do not let a device reach its own public address.',
  };
}

/**
 * After a game port change: re-check this server's domains and return a warning
 * for each one whose SRV record no longer matches.
 * @param {string} serverId
 * @param {number} oldPort
 * @param {number} newPort
 * @param {{ actor?: string, resolver?: import('./resolve').ResolverLike }} [opts]
 * @returns {Promise<string[]>}
 */
async function afterPortChange(serverId, oldPort, newPort, { actor = 'system', resolver } = {}) {
  const warnings = [];
  for (const d of db.all('SELECT domain, dns_provider_id FROM server_domains WHERE server_id = ?', serverId)) {
    // Provider automation hook (scaffold): a domain linked to a DNS provider would
    // have its SRV record rewritten here. Nothing can link one yet, so this is
    // dormant. Once a UI sets dns_provider_id, call:
    //   await require('../dnsProviders').syncSrvRecord(serverId, d.domain, { actor });
    // before re-checking, and skip the warning when the sync succeeds.
    let result;
    try {
      result = await check(serverId, d.domain, { actor, resolver });
    } catch (err) {
      logger.warn('Could not re-check a domain after a port change.', { serverId, err: serializeError(err) });
      continue;
    }
    if (result.state === 'wrong-port') {
      warnings.push(
        result.srv && result.srv.port === oldPort
          ? `${d.domain} still points to the old port. Update its SRV record.`
          : `${d.domain} points to port ${result.srv ? result.srv.port : 'unknown'}, but this server now listens on ${newPort}. Update its SRV record.`
      );
    } else if (result.state === 'missing-srv') {
      warnings.push(`${d.domain} has no SRV record for port ${newPort}. Create one so players can connect.`);
    }
  }
  return warnings;
}

module.exports = {
  list,
  add,
  remove,
  setPrimary,
  check,
  checkAll,
  checkEverything,
  primaryDomain,
  addressFor,
  reachability,
  afterPortChange,
  normalizeDomain,
  MAX_DOMAINS_PER_SERVER,
  _setResolver,
};
