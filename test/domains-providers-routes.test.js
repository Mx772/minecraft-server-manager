'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const authService = require('../src/services/auth');
const domains = require('../src/services/domains');
const providers = require('../src/services/dnsProviders');
const cloudflare = require('../src/services/dnsProviders/cloudflare');
const settings = require('../src/services/settings');

const TOKEN = 'cf-super-secret-token-wxyz';
const SID = 'srv_dprov1';
const D = 'atm10.example.com';
let admin;
let operator;

/** Fake Cloudflare. `records` maps "TYPE name" to an existing record. */
function fakeCf({ records = {}, goodToken = true } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({
      method: opts.method,
      path: u.pathname,
      query: u.search,
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    if (u.pathname.endsWith('/user/tokens/verify')) {
      return goodToken
        ? reply({ status: 'active' })
        : { ok: false, status: 401, json: async () => ({ success: false, errors: [{ message: 'bad' }] }) };
    }
    if (u.pathname === '/client/v4/zones')
      return reply(u.searchParams.get('name') === 'example.com' ? [{ id: 'z1', name: 'example.com' }] : []);
    if (u.pathname === '/client/v4/zones/z1/dns_records' && (opts.method || 'GET') === 'GET') {
      const rec = records[`${u.searchParams.get('type')} ${u.searchParams.get('name')}`];
      return reply(rec ? [rec] : []);
    }
    return reply({ id: 'new' });
  };
  return { calls, fetch };
}

const noMiss = () => Object.assign(new Error('x'), { code: 'ENOTFOUND' });
const dns = (srvPort) => ({
  resolveSrv: async () => {
    if (srvPort == null) throw noMiss();
    return [{ name: 'mc.example.com', port: srvPort, priority: 0, weight: 5 }];
  },
  resolve4: async () => [{ address: '198.51.100.4', ttl: 60 }],
  resolve6: async () => {
    throw noMiss();
  },
});

test.before(async () => {
  await app.start();
  admin = await app.adminCookie();
  const u = await authService.createUser(
    { username: 'op_dns', password: 'operatorpass123', role: 'operator' },
    { actor: 't' }
  );
  assert.ok(u.id);
  const r = await app.req('POST', '/login', { body: { username: 'op_dns', password: 'operatorpass123' } });
  operator = (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
  app.seedServer(SID);
  settings.setPublicHost('mc.example.com');
  domains.add(SID, D);
});
test.after(async () => {
  providers._setFetch(undefined);
  domains._setResolver(undefined);
  await app.stop();
});

test('adapter: address records are never proxied, and an existing different record is not overwritten', async () => {
  const f = fakeCf();
  await cloudflare.upsertAddress(
    { token: TOKEN },
    { zoneId: 'z1', type: 'A', name: D, value: '198.51.100.4' },
    { fetch: f.fetch }
  );
  assert.equal(f.calls.find((c) => c.method === 'POST').body.proxied, false);

  const g = fakeCf({ records: { [`A ${D}`]: { id: 'r1', content: '203.0.113.9', proxied: false } } });
  await assert.rejects(
    cloudflare.upsertAddress(
      { token: TOKEN },
      { zoneId: 'z1', type: 'A', name: D, value: '198.51.100.4' },
      { fetch: g.fetch }
    ),
    (e) =>
      e.status === 409 &&
      e.message ===
        `${D} already has an address record pointing at 203.0.113.9. Change it in Cloudflare or remove it first.`
  );
  assert.ok(!g.calls.some((c) => c.method === 'PUT' || c.method === 'POST'));

  const h = fakeCf({ records: { [`A ${D}`]: { id: 'r2', content: '198.51.100.4', proxied: true } } });
  const out = await cloudflare.upsertAddress(
    { token: TOKEN },
    { zoneId: 'z1', type: 'A', name: D, value: '198.51.100.4' },
    { fetch: h.fetch }
  );
  assert.equal(out.action, 'unproxied');
  const put = h.calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.proxied, false);
});

test('adapter: getAddressRecords reports proxied state', async () => {
  const f = fakeCf({ records: { 'A mc.example.com': { id: 'r', content: '1.2.3.4', proxied: true } } });
  const recs = await cloudflare.getAddressRecords(
    { token: TOKEN },
    { zoneId: 'z1', name: 'mc.example.com' },
    { fetch: f.fetch }
  );
  assert.deepEqual(
    recs.map((r) => [r.type, r.content, r.proxied]),
    [['A', '1.2.3.4', true]]
  );
});

test('provider routes are admin-only, verify the token, and never return it', async () => {
  const f = fakeCf();
  providers._setFetch(f.fetch);
  const body = { kind: 'cloudflare', label: 'CF', token: TOKEN };
  assert.equal((await app.req('POST', '/api/dns-providers', { cookie: operator, body })).status, 403);
  assert.equal((await app.req('GET', '/api/dns-providers', { cookie: operator })).status, 403);

  providers._setFetch(fakeCf({ goodToken: false }).fetch);
  const bad = await app.req('POST', '/api/dns-providers', { cookie: admin, body });
  assert.equal(bad.status, 400);
  assert.equal(JSON.stringify(bad.json).includes(TOKEN), false);
  assert.equal(providers.list().length, 0, 'nothing stored when verification fails');

  providers._setFetch(f.fetch);
  const ok = await app.req('POST', '/api/dns-providers', { cookie: admin, body });
  assert.equal(ok.status, 201);
  assert.equal(ok.text.includes(TOKEN), false);
  const kinds = await app.req('GET', '/api/dns-providers/kinds', { cookie: admin });
  assert.deepEqual(kinds.json.kinds, [{ kind: 'cloudflare', label: 'Cloudflare' }]);
  const listed = await app.req('GET', '/api/dns-providers', { cookie: admin });
  assert.equal(listed.text.includes(TOKEN), false);
  assert.deepEqual(listed.json.providers[0], {
    id: ok.json.provider.id,
    kind: 'cloudflare',
    label: 'CF',
    tokenHint: '…wxyz',
    linkedDomains: 0,
  });
});

test('linking is admin-only; an operator with settings can sync; tokens never leak', async () => {
  const id = providers.list()[0].id;
  const url = `/api/servers/${SID}/domains/${D}`;
  const denied = await app.req('PUT', `${url}/provider`, { cookie: operator, body: { providerId: id } });
  assert.equal(denied.status, 403);
  const missing = await app.req('PUT', `${url}/provider`, { cookie: admin, body: { providerId: 'dns_nope' } });
  assert.equal(missing.status, 404);
  const linked = await app.req('PUT', `${url}/provider`, { cookie: admin, body: { providerId: id } });
  assert.equal(linked.status, 200);
  assert.equal(linked.json.domains[0].providerLabel, 'CF');
  assert.deepEqual(linked.json.providers, [{ id, kind: 'cloudflare', label: 'CF' }]);
  assert.equal(linked.text.includes(TOKEN), false);
  assert.equal(db.all("SELECT 1 FROM events WHERE type = 'domain-provider-linked'").length, 1);

  const f = fakeCf();
  providers._setFetch(f.fetch);
  domains._setResolver(dns(25599));
  const sync = await app.req('POST', `${url}/sync`, { cookie: operator });
  assert.equal(sync.status, 200, sync.text);
  assert.equal(sync.json.sync.action, 'created');
  assert.equal(sync.json.result.state, 'points-here');
  assert.equal(sync.text.includes(TOKEN), false);
  const srvCall = f.calls.find((c) => c.method === 'POST');
  assert.equal(srvCall.body.data.port, 25599);
});

test('sync refuses a proxied public-host record and writes nothing', async () => {
  const f = fakeCf({ records: { 'A mc.example.com': { id: 'p', content: '104.21.1.1', proxied: true } } });
  providers._setFetch(f.fetch);
  await assert.rejects(
    domains.sync(SID, D),
    (e) =>
      e.status === 409 &&
      /mc\.example\.com is proxied by Cloudflare, so players cannot connect through it\./.test(e.message)
  );
  assert.ok(!f.calls.some((c) => c.method === 'POST' || c.method === 'PUT'));
});

test('port change auto-syncs linked domains; a failing sync becomes a warning', async () => {
  db.run('UPDATE servers SET port_game = 25601 WHERE id = ?', SID);
  const f = fakeCf();
  providers._setFetch(f.fetch);
  const ok = await domains.afterPortChange(SID, 25599, 25601, { resolver: dns(25599) });
  assert.deepEqual(ok, []);
  assert.equal(f.calls.find((c) => c.method === 'POST').body.data.port, 25601);

  providers._setFetch(async () => {
    throw new Error(`down ${TOKEN}`);
  });
  const warnings = await domains.afterPortChange(SID, 25599, 25601, { resolver: dns(25599) });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    new RegExp(`^${D.replace(/\./g, '\\.')}'s SRV record could not be updated automatically\\.`)
  );
  assert.equal(warnings[0].includes(TOKEN), false);
});

test('unlinking and removing a provider clear the link', async () => {
  const url = `/api/servers/${SID}/domains/${D}/provider`;
  const un = await app.req('PUT', url, { cookie: admin, body: { providerId: null } });
  assert.equal(un.json.domains[0].dnsProviderId, null);
  assert.equal(db.all("SELECT 1 FROM events WHERE type = 'domain-provider-unlinked'").length, 1);
  const id = providers.list()[0].id;
  await app.req('PUT', url, { cookie: admin, body: { providerId: id } });
  const del = await app.req('DELETE', `/api/dns-providers/${id}`, { cookie: admin });
  assert.equal(del.status, 200);
  assert.equal(domains.list(SID).domains[0].dnsProviderId, null);
});
