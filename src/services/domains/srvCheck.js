'use strict';

// Pure SRV/DNS evaluation: turns resolver results into one of the badge states
// the Domains card shows. No I/O here, so every state is unit-testable.

const net = require('node:net');

const DEFAULT_JAVA_PORT = 25565;
const RECORD_TTL = 3600;

/**
 * @typedef {object} SrvRecord
 * @property {string} name
 * @property {number} port
 * @property {number} priority
 * @property {number} weight
 */

/**
 * @typedef {object} Evaluation
 * @property {string} state    points-here | wrong-port | different-ip | no-srv-needed | missing-srv | not-found | resolver-error
 * @property {string} badge    badge class: badge-ok | badge-warn | badge-danger | badge-info
 * @property {string} label    Title Case badge text
 * @property {string} message  one or two friendly sentences
 * @property {number|null} ttl TTL in seconds of the answering record, when known
 * @property {{ name: string, fqdn: string, priority: number, weight: number, port: number, target: string, ttl: number, bind: string, address: { type: 'A'|'AAAA', name: string, fqdn: string, value: string, ttl: number }|null }|null} record
 *   the SRV record to create (null when no public host is set to point it at)
 */

const STATES = {
  'points-here': { badge: 'badge-ok', label: 'Points Here' },
  'wrong-port': { badge: 'badge-danger', label: 'Wrong Port' },
  'different-ip': { badge: 'badge-warn', label: 'Different IP' },
  'no-srv-needed': { badge: 'badge-info', label: 'No SRV Needed' },
  'missing-srv': { badge: 'badge-warn', label: 'Missing SRV' },
  'not-found': { badge: 'badge-danger', label: 'Not Found' },
  'resolver-error': { badge: 'badge-danger', label: 'Not Found' },
};

/** The SRV record players need, in the fields most DNS dashboards ask for. */
function buildRecord(domain, gamePort, publicHost) {
  if (!publicHost) return null;
  const fqdn = `_minecraft._tcp.${domain}`;
  const labels = domain.split('.');
  // Dashboards usually want the name relative to the zone; assume a registered
  // domain of two labels, so atm10.example.com becomes _minecraft._tcp.atm10.
  const relative = labels.length > 2 ? `_minecraft._tcp.${labels.slice(0, -2).join('.')}` : '_minecraft._tcp';
  // An SRV target must be a hostname (RFC 2782), never an IP literal. With an IP
  // public host, add an A/AAAA record for the domain and point the SRV at the domain.
  /** @type {'A'|'AAAA'|null} */
  const ipType = net.isIPv6(publicHost) ? 'AAAA' : net.isIPv4(publicHost) ? 'A' : null;
  const target = ipType ? domain : publicHost;
  const address = ipType
    ? {
        type: ipType,
        name: labels.length > 2 ? labels.slice(0, -2).join('.') : '@',
        fqdn: domain,
        value: publicHost,
        ttl: RECORD_TTL,
      }
    : null;
  const srvLine = `${fqdn}. ${RECORD_TTL} IN SRV 0 5 ${gamePort} ${target}.`;
  return {
    name: relative,
    fqdn,
    priority: 0,
    weight: 5,
    port: gamePort,
    target,
    ttl: RECORD_TTL,
    address,
    bind: address ? `${domain}. ${RECORD_TTL} IN ${ipType} ${publicHost}\n${srvLine}` : srvLine,
  };
}

const sameIps = (a, b) => a.some((ip) => b.includes(ip));

/**
 * @param {object} p
 * @param {SrvRecord[]|null} p.srv        SRV answers (null/empty = none)
 * @param {boolean} [p.srvError]          the SRV lookup failed for a reason other than "no record"
 * @param {string[]} [p.targetIps]        A/AAAA of the best SRV target
 * @param {string[]} [p.domainIps]        A/AAAA of the domain itself
 * @param {string[]} [p.publicIps]        the public host's IPs ([] when unknown)
 * @param {string} [p.publicHost]         the panel's public host ('' when unset)
 * @param {number} p.gamePort             this server's host game port
 * @param {number|null} [p.ttl]           TTL of the answering record, when known
 * @param {string} [p.domain]             used in messages
 * @returns {Evaluation}
 */
function evaluate({
  srv,
  srvError = false,
  targetIps = [],
  domainIps = [],
  publicIps = [],
  publicHost = '',
  gamePort,
  ttl = null,
  domain = 'This domain',
}) {
  const out = (state, message, extra = {}) => ({
    state,
    ...STATES[state],
    message,
    ttl,
    record: buildRecord(domain, gamePort, publicHost),
    ...extra,
  });
  const best = srv && srv.length ? [...srv].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0] : null;

  if (srvError) {
    return out(
      'resolver-error',
      'The DNS lookup did not finish. Check the network connection and try again in a minute.',
      { record: null }
    );
  }

  if (best) {
    if (best.port !== gamePort) {
      return out(
        'wrong-port',
        `The SRV record sends players to port ${best.port}, but this server listens on ${gamePort}. Update the record to use port ${gamePort}.`
      );
    }
    if (!publicHost || !publicIps.length) {
      // Nothing to compare the IPs with, so the port is the only thing we can
      // verify. Treat a matching port as pointing here and say what was skipped.
      return out(
        'points-here',
        'The SRV record uses the right port. Set a public address in Settings to also check that it points at this machine.'
      );
    }
    if (!targetIps.length) {
      return out(
        'not-found',
        `The SRV record points at ${best.name}, which does not resolve to an address. Check that name's DNS records.`
      );
    }
    if (!sameIps(targetIps, publicIps)) {
      return out(
        'different-ip',
        `${domain} points at ${targetIps.join(', ')}, but the panel's public address is ${publicIps.join(', ')}. This can be correct behind a proxy or tunnel.`
      );
    }
    return out('points-here', `${domain} points at this server.`);
  }

  // No SRV record: clients fall back to <domain>:25565.
  if (!domainIps.length) {
    return out('not-found', `${domain} was not found in DNS. Check the spelling, or add a record for it.`, {
      record: buildRecord(domain, gamePort, publicHost),
    });
  }
  if (gamePort === DEFAULT_JAVA_PORT) {
    if (publicIps.length && !sameIps(domainIps, publicIps)) {
      return out(
        'different-ip',
        `${domain} points at ${domainIps.join(', ')}, but the panel's public address is ${publicIps.join(', ')}. This can be correct behind a proxy or tunnel.`
      );
    }
    return out(
      'no-srv-needed',
      `${domain} resolves and the game port is ${DEFAULT_JAVA_PORT}, so players do not need an SRV record.`
    );
  }
  return out(
    'missing-srv',
    `${domain} has no SRV record, so players would connect on port ${DEFAULT_JAVA_PORT}. Create the record below to send them to port ${gamePort}.`
  );
}

module.exports = { evaluate, buildRecord, STATES, DEFAULT_JAVA_PORT, RECORD_TTL };
