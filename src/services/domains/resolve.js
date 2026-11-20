'use strict';

// DNS gathering for the domain check. The resolver is injectable (any object
// shaped like dns.promises.Resolver) so tests never touch the network.

const net = require('node:net');
const dns = require('node:dns');

const TIMEOUT_MS = 5000;
// "No such record" answers. Anything else is a resolver problem worth retrying.
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

/**
 * @typedef {object} ResolverLike
 * @property {(name: string) => Promise<Array<{name: string, port: number, priority: number, weight: number}>>} resolveSrv
 * @property {(name: string, opts?: any) => Promise<any[]>} resolve4
 * @property {(name: string, opts?: any) => Promise<any[]>} resolve6
 */

/** @returns {ResolverLike} */
function defaultResolver() {
  return new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
}

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out.'), { code: 'ETIMEOUT' })), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one lookup. Resolves { value } on success, { value: [] } when there is no
 * such record, and { error } for anything else.
 * @returns {Promise<{ value: any[], error?: Error }>}
 */
async function attempt(fn) {
  try {
    return { value: (await withTimeout(fn())) || [] };
  } catch (err) {
    if (err && NO_RECORD.has(err.code)) return { value: [] };
    return { value: [], error: err };
  }
}

/** A and AAAA addresses of a name, with the smallest TTL seen (null when unknown). */
async function addresses(resolver, name) {
  const [a, aaaa] = await Promise.all([
    attempt(() => resolver.resolve4(name, { ttl: true })),
    attempt(() => (resolver.resolve6 ? resolver.resolve6(name, { ttl: true }) : Promise.resolve([]))),
  ]);
  const ips = [];
  let ttl = null;
  for (const r of [...a.value, ...aaaa.value]) {
    const address = typeof r === 'string' ? r : r && r.address;
    if (!address) continue;
    ips.push(address);
    if (r && typeof r.ttl === 'number') ttl = ttl === null ? r.ttl : Math.min(ttl, r.ttl);
  }
  // Both lookups failing for a real reason (not "no record") is a resolver error.
  const error = ips.length === 0 ? a.error || aaaa.error : undefined;
  return { ips, ttl, error };
}

/**
 * Everything evaluate() needs about one domain.
 * @param {string} domain
 * @param {{ publicHost?: string, resolver?: ResolverLike }} [opts]
 */
async function gather(domain, { publicHost = '', resolver = defaultResolver() } = {}) {
  const srvRes = await attempt(() => resolver.resolveSrv(`_minecraft._tcp.${domain}`));
  const srv = srvRes.value.map((r) => ({
    name: String(r.name || '').replace(/\.$/, ''),
    port: Number(r.port),
    priority: Number(r.priority) || 0,
    weight: Number(r.weight) || 0,
  }));
  const best = srv.length ? [...srv].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0] : null;

  const [target, own, pub] = await Promise.all([
    best ? addresses(resolver, best.name) : { ips: [], ttl: null },
    addresses(resolver, domain),
    publicHost ? resolveHost(publicHost, resolver) : { ips: [] },
  ]);

  // A failed SRV lookup only matters when nothing else answered either.
  const srvError = Boolean(srvRes.error) && !best && !own.ips.length;
  const ttl = best ? target.ttl : own.ttl;
  return {
    srv,
    srvError: srvError || Boolean(!best && !own.ips.length && own.error),
    targetIps: target.ips,
    domainIps: own.ips,
    publicIps: pub.ips,
    publicHost,
    ttl,
  };
}

/** IPs for a host: an IP literal is used as-is, a name is resolved. */
async function resolveHost(host, resolver) {
  if (net.isIP(host)) return { ips: [host] };
  const r = await addresses(resolver, host);
  return { ips: r.ips };
}

module.exports = { gather, defaultResolver, resolveHost, withTimeout, TIMEOUT_MS };
