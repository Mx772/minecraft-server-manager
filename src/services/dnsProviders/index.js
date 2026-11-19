'use strict';

// DNS provider scaffold: stored API tokens (encrypted) and a registry of
// provider implementations that can create/update a server's SRV record.
// Nothing calls syncSrvRecord automatically yet and there are no routes: a
// later change wires the UI and the port-change hook (see domains.afterPortChange).

const { nanoid } = require('nanoid');
const db = require('../../db');
const httpError = require('../../utils/httpError');
const { recordEvent } = require('../../events');
const secrets = require('../secrets');
const settings = require('../settings');
const { buildRecord } = require('../domains/srvCheck');

/**
 * What a provider module implements. `config` is the decrypted provider config
 * ({ token }); `deps.fetch` is injectable for tests.
 * @typedef {object} DnsProvider
 * @property {string} kind
 * @property {string} label
 * @property {(config: any, deps?: { fetch?: typeof fetch }) => Promise<{ ok: boolean }>} verify
 * @property {(config: any, domain: string, deps?: { fetch?: typeof fetch }) => Promise<{ zoneId: string, zoneName: string } | null>} findZone
 * @property {(config: any, rec: { zoneId: string, name: string, port: number, target: string, priority?: number, weight?: number, ttl?: number }, deps?: { fetch?: typeof fetch }) => Promise<{ action: string }>} upsertSrv
 * @property {(config: any, rec: { zoneId: string, type: 'A'|'AAAA', name: string, value: string, ttl?: number }, deps?: { fetch?: typeof fetch }) => Promise<{ action: string }>} upsertAddress
 * @property {(config: any, rec: { zoneId: string, name: string }, deps?: { fetch?: typeof fetch }) => Promise<{ action: string }>} deleteSrv
 */

/** @type {Record<string, DnsProvider>} */
const PROVIDERS = { cloudflare: require('./cloudflare') };

const tokenHint = (token) => `…${String(token).slice(-4)}`;

/** Providers for display. Never includes the token itself, only a short hint. */
function list() {
  return db.all('SELECT * FROM dns_providers ORDER BY created_at, id').map((r) => {
    const config = JSON.parse(secrets.tryDecrypt(r.config_cipher) || '{}');
    return { id: r.id, kind: r.kind, label: r.label, tokenHint: config.token ? tokenHint(config.token) : null };
  });
}

/** Decrypted config for a provider. Internal use only: never return this from a route. */
function getConfig(id) {
  const r = db.get('SELECT * FROM dns_providers WHERE id = ?', id);
  if (!r) return null;
  const plain = secrets.tryDecrypt(r.config_cipher);
  return plain ? { kind: r.kind, config: JSON.parse(plain) } : null;
}

/** @param {{ kind: string, label: string, token: string }} input */
function create({ kind, label, token }, { actor = 'system' } = {}) {
  if (!PROVIDERS[kind]) throw httpError(400, 'That DNS provider is not supported.');
  const cleanLabel = String(label || '').trim();
  const cleanToken = String(token || '').trim();
  if (!cleanLabel) throw httpError(400, 'Give the provider a name.');
  if (!cleanToken) throw httpError(400, 'An API token is required.');
  const id = `dns_${nanoid(8)}`;
  db.run(
    'INSERT INTO dns_providers (id, kind, label, config_cipher) VALUES (?, ?, ?, ?)',
    id,
    kind,
    cleanLabel,
    secrets.encrypt(JSON.stringify({ token: cleanToken }))
  );
  recordEvent({ actor, type: 'dns-provider-added', summary: `DNS provider added: ${cleanLabel}.` });
  return { id, kind, label: cleanLabel, tokenHint: tokenHint(cleanToken) };
}

function remove(id, { actor = 'system' } = {}) {
  const r = db.get('SELECT label FROM dns_providers WHERE id = ?', id);
  if (!r) throw httpError(404, 'That DNS provider was not found.');
  db.run('DELETE FROM dns_providers WHERE id = ?', id); // domains linked to it fall back to no provider
  recordEvent({ actor, type: 'dns-provider-removed', summary: `DNS provider removed: ${r.label}.` });
}

/**
 * Create or update the SRV record for a domain through its linked provider, so
 * it points at the server's current game port and the public host. A domain
 * with no provider is left alone.
 * @param {string} serverId
 * @param {string} domain
 * @param {{ actor?: string, fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ skipped: true } | { skipped: false, action: string }>}
 */
async function syncSrvRecord(serverId, domain, { actor = 'system', fetch: doFetch } = {}) {
  const row = db.get('SELECT dns_provider_id FROM server_domains WHERE server_id = ? AND domain = ?', serverId, domain);
  if (!row || !row.dns_provider_id) return { skipped: true };
  const stored = getConfig(row.dns_provider_id);
  if (!stored) throw httpError(409, 'The DNS provider for this domain could not be read. Add it again.');
  const provider = PROVIDERS[stored.kind];
  const server = db.get('SELECT port_game FROM servers WHERE id = ?', serverId);
  const publicHost = settings.getPublicHost();
  if (!provider || !server) throw httpError(404, 'Server or provider not found.');
  if (!publicHost) throw httpError(400, 'Set a public address in Settings before the SRV record can be managed.');
  const deps = { fetch: doFetch };
  const zone = await provider.findZone(stored.config, domain, deps);
  if (!zone) throw httpError(404, `${domain} was not found in that DNS account.`);
  const rec = buildRecord(domain, server.port_game, publicHost);
  // An IP-literal public host needs an A/AAAA record first: the SRV target is the domain itself.
  if (rec.address) {
    await provider.upsertAddress(
      stored.config,
      {
        zoneId: zone.zoneId,
        type: rec.address.type,
        name: rec.address.fqdn,
        value: rec.address.value,
        ttl: rec.address.ttl,
      },
      deps
    );
  }
  const out = await provider.upsertSrv(
    stored.config,
    {
      zoneId: zone.zoneId,
      name: rec.fqdn,
      port: rec.port,
      target: rec.target,
      priority: rec.priority,
      weight: rec.weight,
      ttl: rec.ttl,
    },
    deps
  );
  recordEvent({
    serverId,
    actor,
    type: 'dns-record-synced',
    summary: `SRV record ${out.action} for ${domain}.`,
    details: { domain, port: server.port_game },
  });
  return { skipped: false, action: out.action };
}

module.exports = { PROVIDERS, list, create, remove, getConfig, syncSrvRecord };
