'use strict';

// Cloudflare DNS provider (API v4) for managing a domain's _minecraft._tcp SRV
// record. fetch is injectable. The API token is never put in an error message or log.

const httpError = require('../../utils/httpError');

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;

/**
 * @typedef {{ token: string }} CloudflareConfig
 * @typedef {{ fetch?: typeof fetch }} Deps
 */

/**
 * One API call. Throws a friendly httpError that never includes the token.
 * @param {CloudflareConfig} config
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @param {Deps} [deps]
 */
async function call(config, method, path, body, { fetch: doFetch = globalThis.fetch } = {}) {
  let res;
  try {
    res = await doFetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'minecraft-server-manager',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'Could not reach Cloudflare. Check the network connection and try again.');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }
  if (res.status === 401 || res.status === 403) {
    throw httpError(400, 'Cloudflare rejected the API token. Check that it is correct and can edit DNS records.');
  }
  if (!res.ok || !json || json.success === false) {
    const detail = json && Array.isArray(json.errors) && json.errors[0] && json.errors[0].message;
    throw httpError(
      502,
      `Cloudflare could not complete the request${detail ? ` (${String(detail).slice(0, 120)})` : ''}.`
    );
  }
  return json;
}

/** Check that the token is valid and active. */
async function verify(config, deps) {
  const json = await call(config, 'GET', '/user/tokens/verify', undefined, deps);
  const active = Boolean(json.result && json.result.status === 'active');
  if (!active) throw httpError(400, 'That Cloudflare API token is not active.');
  return { ok: true };
}

/**
 * Find the zone that holds `domain`, trying each parent name from most to least specific.
 * @returns {Promise<{ zoneId: string, zoneName: string } | null>}
 */
async function findZone(config, domain, deps) {
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    const json = await call(config, 'GET', `/zones?name=${encodeURIComponent(name)}`, undefined, deps);
    const zone = json.result && json.result[0];
    if (zone) return { zoneId: zone.id, zoneName: zone.name };
  }
  return null;
}

async function findSrv(config, zoneId, fqdn, deps) {
  const q = `?type=SRV&name=${encodeURIComponent(fqdn)}`;
  const json = await call(config, 'GET', `/zones/${encodeURIComponent(zoneId)}/dns_records${q}`, undefined, deps);
  return (json.result && json.result[0]) || null;
}

/**
 * Create or update the SRV record `name` (a full name, e.g. _minecraft._tcp.atm10.example.com).
 * @param {CloudflareConfig} config
 * @param {{ zoneId: string, name: string, port: number, target: string, priority?: number, weight?: number, ttl?: number }} rec
 * @param {Deps} [deps]
 */
async function upsertSrv(config, { zoneId, name, port, target, priority = 0, weight = 5, ttl = 3600 }, deps) {
  const payload = {
    type: 'SRV',
    name,
    ttl,
    data: { priority, weight, port, target },
  };
  const existing = await findSrv(config, zoneId, name, deps);
  const base = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  if (existing) {
    await call(config, 'PUT', `${base}/${encodeURIComponent(existing.id)}`, payload, deps);
    return { action: 'updated' };
  }
  await call(config, 'POST', base, payload, deps);
  return { action: 'created' };
}

/**
 * A/AAAA records at a name, as { type, content, proxied }.
 * @param {CloudflareConfig} config
 * @param {{ zoneId: string, name: string }} rec
 * @param {Deps} [deps]
 */
async function getAddressRecords(config, { zoneId, name }, deps) {
  const base = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const out = [];
  for (const type of ['A', 'AAAA']) {
    const json = await call(config, 'GET', `${base}?type=${type}&name=${encodeURIComponent(name)}`, undefined, deps);
    for (const r of json.result || []) out.push({ id: r.id, type, content: r.content, proxied: r.proxied === true });
  }
  return out;
}

/**
 * Create the A/AAAA record `name` (a full name) pointing at `value`, never proxied.
 * An existing record with different content is never overwritten (it could be
 * the zone apex); one with the same content that is proxied is switched to DNS only.
 * @param {CloudflareConfig} config
 * @param {{ zoneId: string, type: 'A'|'AAAA', name: string, value: string, ttl?: number }} rec
 * @param {Deps} [deps]
 */
async function upsertAddress(config, { zoneId, type, name, value, ttl = 3600 }, deps) {
  const base = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const found = await call(config, 'GET', `${base}?type=${type}&name=${encodeURIComponent(name)}`, undefined, deps);
  const existing = (found.result && found.result[0]) || null;
  const payload = { type, name, content: value, ttl, proxied: false };
  if (!existing) {
    await call(config, 'POST', base, payload, deps);
    return { action: 'created' };
  }
  if (existing.content !== value) {
    throw httpError(
      409,
      `${name} already has an address record pointing at ${existing.content}. Change it in Cloudflare or remove it first.`
    );
  }
  if (existing.proxied === true) {
    await call(config, 'PUT', `${base}/${encodeURIComponent(existing.id)}`, payload, deps);
    return { action: 'unproxied' };
  }
  return { action: 'unchanged' };
}

/** Delete the SRV record `name` if it exists. */
async function deleteSrv(config, { zoneId, name }, deps) {
  const existing = await findSrv(config, zoneId, name, deps);
  if (!existing) return { action: 'none' };
  await call(
    config,
    'DELETE',
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
    undefined,
    deps
  );
  return { action: 'deleted' };
}

module.exports = {
  kind: 'cloudflare',
  label: 'Cloudflare',
  verify,
  findZone,
  upsertSrv,
  upsertAddress,
  getAddressRecords,
  deleteSrv,
};
