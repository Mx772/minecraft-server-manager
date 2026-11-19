'use strict';

// Opt-in outside reachability check through a public status API (mcsrvstat.us).
// This sends the domain name to a third party, so it refuses to run until an
// admin turns the setting on.

const httpError = require('../../utils/httpError');
const settings = require('../settings');

const API = 'https://api.mcsrvstat.us/3/';
const TIMEOUT_MS = 10_000;

/**
 * @param {string} domain
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, online?: boolean, motd?: string, version?: string|null, players?: {online: number, max: number} }>}
 */
async function check(domain, { fetch: doFetch = globalThis.fetch } = {}) {
  if (!settings.isExternalReachabilityEnabled()) {
    throw httpError(
      403,
      'The outside check is turned off. An admin can turn it on in Settings. It sends the domain name to a public status service.'
    );
  }
  let body;
  try {
    const res = await doFetch(API + encodeURIComponent(domain), {
      headers: { 'User-Agent': 'minecraft-server-manager', Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'The outside status service could not be reached. Try again later.' };
    body = await res.json();
  } catch {
    return { ok: false, reason: 'The outside status service could not be reached. Try again later.' };
  }
  if (!body || body.online !== true) {
    return { ok: true, online: false };
  }
  const motd = Array.isArray(body.motd && body.motd.clean) ? body.motd.clean.join(' ').trim() : '';
  return {
    ok: true,
    online: true,
    motd,
    version: body.version ? String(body.version) : null,
    players: {
      online: Number(body.players && body.players.online) || 0,
      max: Number(body.players && body.players.max) || 0,
    },
  };
}

module.exports = { check };
