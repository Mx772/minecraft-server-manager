'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const domains = require('../src/services/domains');
const settings = require('../src/services/settings');

let cookie;
const SID = 'srv_dom01';
const D = 'atm10.example.com';
const events = (type) => db.all('SELECT * FROM events WHERE server_id = ? AND type = ?', SID, type);
const api = (method, path, body) => app.req(method, `/api/servers/${SID}/domains${path}`, { cookie, body });

// Stub DNS: srvPort null = no SRV record; ips = what the domain and the public host resolve to.
function dns({ srvPort = null, ip = '198.51.100.4' } = {}) {
  const miss = () => Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  return {
    resolveSrv: async () => {
      if (srvPort === null) throw miss();
      return [{ name: 'mc.example.net', port: srvPort, priority: 0, weight: 5 }];
    },
    resolve4: async () => [{ address: ip, ttl: 120 }],
    resolve6: async () => {
      throw miss();
    },
  };
}

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
  settings.setPublicHost('mc.example.net');
});
test.after(async () => {
  domains._setResolver(undefined);
  await app.stop();
});

test('add validates and normalises, first domain becomes primary, duplicates conflict', async () => {
  for (const bad of [
    '',
    'localhost',
    'http://a.example.com',
    'a.example.com:25565',
    'a.example.com/x',
    '192.168.1.5',
    'a..com',
    '-a.example.com',
  ]) {
    const r = await api('POST', '', { domain: bad });
    assert.equal(r.status, 400, `${bad} should be rejected`);
  }
  const r = await api('POST', '', { domain: ` ${D.toUpperCase()}. ` });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.primary, D);
  assert.equal(r.json.domains[0].isPrimary, true);
  assert.equal((await api('POST', '', { domain: D })).status, 409);
  assert.equal(events('domain-added').length, 1);
});

test('primary switches, and removing the primary promotes another domain', async () => {
  await api('POST', '', { domain: 'other.example.org' });
  let r = await api('PUT', '/other.example.org/primary');
  assert.equal(r.json.primary, 'other.example.org');
  assert.equal(events('domain-primary-changed').length, 1);
  r = await api('DELETE', '/other.example.org');
  assert.equal(r.json.primary, D);
  assert.equal((await api('DELETE', '/missing.example.org')).status, 404);
  assert.equal(events('domain-removed').length, 1);
});

test('domains per server are capped', async () => {
  for (let i = 0; i < domains.MAX_DOMAINS_PER_SERVER; i++) await api('POST', '', { domain: `d${i}.example.org` });
  assert.equal((await api('POST', '', { domain: 'overflow.example.org' })).status, 400);
  for (let i = 0; i < domains.MAX_DOMAINS_PER_SERVER; i++) await api('DELETE', `/d${i}.example.org`);
});

test('a check stores the result and addressFor only trusts verified states', async () => {
  domains._setResolver(dns({ srvPort: 25599 }));
  assert.equal(domains.addressFor(SID), null, 'unchecked domain is not offered');
  const r = await api('POST', `/${D}/check`);
  assert.equal(r.json.result.state, 'points-here');
  assert.equal(domains.addressFor(SID), D);
  assert.equal(r.json.domains[0].check.label, 'Points Here');
});

test('history records state changes only, not repeat results', async () => {
  db.run('DELETE FROM events WHERE type = ?', 'domain-dns-changed');
  domains._setResolver(dns({ srvPort: 25599 }));
  await api('POST', `/${D}/check`);
  assert.equal(events('domain-dns-changed').length, 0, 'same state again');
  domains._setResolver(dns({ srvPort: 25566 }));
  await api('POST', `/${D}/check`);
  await api('POST', `/${D}/check`);
  const ev = events('domain-dns-changed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, `${D} now points to the wrong port.`);
  assert.equal(domains.addressFor(SID), null);
});

test('a first-ever check records no change event', async () => {
  db.run('DELETE FROM events WHERE type = ?', 'domain-dns-changed');
  await api('POST', '/fresh.example.org', undefined); // unknown route shape, ignored
  await api('POST', '', { domain: 'fresh.example.org' });
  domains._setResolver(dns({ srvPort: 25599 }));
  await api('POST', '/fresh.example.org/check');
  assert.equal(events('domain-dns-changed').length, 0);
  await api('DELETE', '/fresh.example.org');
});

test('afterPortChange warns for a record still on the old port', async () => {
  db.run('UPDATE servers SET port_game = 25600 WHERE id = ?', SID);
  const warnings = await domains.afterPortChange(SID, 25599, 25600, { resolver: dns({ srvPort: 25599 }) });
  assert.deepEqual(warnings, [`${D} still points to the old port. Update its SRV record.`]);
  const ok = await domains.afterPortChange(SID, 25599, 25600, { resolver: dns({ srvPort: 25600 }) });
  assert.deepEqual(ok, []);
});

test('reachability: panel mode uses the pinger and explains a failure; external mode is gated', async () => {
  let r = await api('POST', `/${D}/reachability`, { mode: 'panel' });
  assert.equal(r.status, 200);
  const okPing = await domains.reachability(SID, D, {
    ping: async () => ({ ok: true, latencyMs: 12, motd: 'hi', version: '1.21', players: { online: 1, max: 5 } }),
  });
  assert.equal(okPing.ok, true);
  assert.equal(okPing.hint, undefined);
  const bad = await domains.reachability(SID, D, {
    ping: async () => ({ ok: false, reason: 'The connection was refused.' }),
  });
  assert.match(bad.hint, /not proof/);

  settings.setExternalReachabilityEnabled(false);
  let called = 0;
  const fetchStub = async () => {
    called++;
    return { ok: true, json: async () => ({ online: true }) };
  };
  await assert.rejects(domains.reachability(SID, D, { mode: 'external', fetch: fetchStub }), (e) => e.status === 403);
  assert.equal(called, 0, 'no outside request without the opt-in');
  r = await api('POST', `/${D}/reachability`, { mode: 'external' });
  assert.equal(r.status, 403);

  settings.setExternalReachabilityEnabled(true);
  const out = await domains.reachability(SID, D, {
    mode: 'external',
    fetch: async (url, opts) => {
      assert.match(String(url), /api\.mcsrvstat\.us\/3\/atm10\.example\.com$/);
      assert.equal(opts.headers['User-Agent'], 'minecraft-server-manager');
      return {
        ok: true,
        json: async () => ({
          online: true,
          motd: { clean: ['Hello'] },
          version: '1.21',
          players: { online: 2, max: 10 },
        }),
      };
    },
  });
  assert.deepEqual({ online: out.online, motd: out.motd }, { online: true, motd: 'Hello' });
  settings.setExternalReachabilityEnabled(false);
});

test('settings API reads and writes the outside-check opt-in (admin)', async () => {
  let r = await app.req('GET', '/api/settings', { cookie });
  assert.equal(r.json.externalReachabilityCheck, false);
  r = await app.req('POST', '/api/settings', { cookie, body: { externalReachabilityCheck: true } });
  assert.equal(r.json.externalReachabilityCheck, true);
  assert.equal(r.json.publicHost, 'mc.example.net', 'toggle alone leaves the public host');
  r = await app.req('POST', '/api/settings', { cookie, body: { publicHost: 'mc.example.net' } });
  assert.equal(r.json.externalReachabilityCheck, true, 'saving the host leaves the toggle');
  await app.req('POST', '/api/settings', { cookie, body: { externalReachabilityCheck: false } });
});

test('checkEverything swallows a failing domain and keeps going', async () => {
  domains._setResolver({
    resolveSrv: async () => {
      throw new Error('boom');
    },
    resolve4: async () => [],
    resolve6: async () => [],
  });
  const r = await domains.checkEverything();
  assert.equal(r.failed, 0, 'resolver errors are results, not exceptions');
  assert.ok(r.checked >= 1);
});

test('list exposes Bedrock info when a Bedrock port is mapped', () => {
  assert.equal(domains.list(SID).bedrock, null);
  db.run('UPDATE servers SET port_bedrock = 19133 WHERE id = ?', SID);
  assert.deepEqual(domains.list(SID).bedrock, { port: 19133 });
  db.run('UPDATE servers SET port_bedrock = NULL WHERE id = ?', SID);
});

test('domain rows cascade away with the server', () => {
  db.run('DELETE FROM servers WHERE id = ?', SID);
  assert.equal(db.all('SELECT 1 FROM server_domains WHERE server_id = ?', SID).length, 0);
});
