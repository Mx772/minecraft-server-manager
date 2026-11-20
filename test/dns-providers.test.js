'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const providers = require('../src/services/dnsProviders');
const cloudflare = require('../src/services/dnsProviders/cloudflare');
const settings = require('../src/services/settings');

const TOKEN = 'cf-secret-token-abcd';

test('create stores the token encrypted and list never leaks it', () => {
  const p = providers.create({ kind: 'cloudflare', label: 'My Cloudflare', token: TOKEN }, { actor: 't' });
  assert.equal(p.tokenHint, '…abcd');
  const raw = db.get('SELECT * FROM dns_providers WHERE id = ?', p.id);
  assert.ok(!raw.config_cipher.includes(TOKEN));
  const listed = providers.list();
  assert.equal(JSON.stringify(listed).includes(TOKEN), false);
  assert.deepEqual(
    listed.find((x) => x.id === p.id),
    { id: p.id, kind: 'cloudflare', label: 'My Cloudflare', tokenHint: '…abcd', linkedDomains: 0 }
  );
  assert.equal(providers.getConfig(p.id).config.token, TOKEN);
  assert.throws(() => providers.create({ kind: 'nope', label: 'x', token: 'y' }), /not supported/);
  providers.remove(p.id);
  assert.equal(providers.list().length, 0);
});

/** A fake Cloudflare that records calls. */
function fakeCloudflare({ existing = null } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({
      method: opts.method,
      path: u.pathname + u.search,
      body: opts.body ? JSON.parse(opts.body) : null,
      auth: opts.headers.Authorization,
    });
    const reply = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    if (u.pathname === '/client/v4/zones')
      return reply(u.searchParams.get('name') === 'example.com' ? [{ id: 'zone1', name: 'example.com' }] : []);
    if (u.pathname === '/client/v4/zones/zone1/dns_records' && opts.method === 'GET')
      return reply(existing ? [existing] : []);
    return reply({ id: 'rec1' });
  };
  return { calls, fetch };
}

test('cloudflare finds the zone and creates an SRV record', async () => {
  const f = fakeCloudflare();
  const zone = await cloudflare.findZone({ token: TOKEN }, 'atm10.example.com', { fetch: f.fetch });
  assert.deepEqual(zone, { zoneId: 'zone1', zoneName: 'example.com' });
  const out = await cloudflare.upsertSrv(
    { token: TOKEN },
    { zoneId: 'zone1', name: '_minecraft._tcp.atm10.example.com', port: 25570, target: 'mc.example.net' },
    { fetch: f.fetch }
  );
  assert.equal(out.action, 'created');
  const post = f.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/client/v4/zones/zone1/dns_records');
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(post.body, {
    type: 'SRV',
    name: '_minecraft._tcp.atm10.example.com',
    ttl: 3600,
    data: { priority: 0, weight: 5, port: 25570, target: 'mc.example.net' },
  });
});

test('cloudflare updates an existing record with PUT', async () => {
  const f = fakeCloudflare({ existing: { id: 'rec9' } });
  const out = await cloudflare.upsertSrv(
    { token: TOKEN },
    { zoneId: 'zone1', name: '_minecraft._tcp.x.example.com', port: 1, target: 't' },
    { fetch: f.fetch }
  );
  assert.equal(out.action, 'updated');
  assert.ok(f.calls.some((c) => c.method === 'PUT' && c.path === '/client/v4/zones/zone1/dns_records/rec9'));
});

test('cloudflare errors are friendly and never include the token', async () => {
  const denied = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ success: false, errors: [{ message: TOKEN }] }),
  });
  await assert.rejects(
    cloudflare.verify({ token: TOKEN }, { fetch: denied }),
    (e) => !e.message.includes(TOKEN) && /rejected/.test(e.message)
  );
  const down = async () => {
    throw new Error(`connect failed with ${TOKEN}`);
  };
  await assert.rejects(
    cloudflare.verify({ token: TOKEN }, { fetch: down }),
    (e) => !e.message.includes(TOKEN) && /Could not reach/.test(e.message)
  );
});

test('syncSrvRecord is a no-op without a provider and upserts with one', async () => {
  db.run(
    `INSERT OR IGNORE INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES ('srv_dnsp', 'P', 'PAPER', 25571, 26571, 'x', 1024, 1536)`
  );
  db.run("INSERT INTO server_domains (server_id, domain) VALUES ('srv_dnsp', 'atm10.example.com')");
  assert.deepEqual(await providers.syncSrvRecord('srv_dnsp', 'atm10.example.com'), { skipped: true });

  settings.setPublicHost('mc.example.net');
  const p = providers.create({ kind: 'cloudflare', label: 'CF', token: TOKEN });
  db.run("UPDATE server_domains SET dns_provider_id = ? WHERE server_id = 'srv_dnsp'", p.id);
  const f = fakeCloudflare();
  const out = await providers.syncSrvRecord('srv_dnsp', 'atm10.example.com', { fetch: f.fetch });
  assert.deepEqual(out, { skipped: false, action: 'created' });
  assert.equal(f.calls.find((c) => c.method === 'POST').body.data.port, 25571);
  providers.remove(p.id);
  assert.equal(db.get("SELECT dns_provider_id FROM server_domains WHERE server_id = 'srv_dnsp'").dns_provider_id, null);
});

test('cloudflare upsertAddress creates an A record, and turns the proxy off on a matching one', async () => {
  const f = fakeCloudflare();
  const out = await cloudflare.upsertAddress(
    { token: TOKEN },
    { zoneId: 'zone1', type: 'A', name: 'atm10.example.com', value: '198.51.100.4' },
    { fetch: f.fetch }
  );
  assert.equal(out.action, 'created');
  const post = f.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, {
    type: 'A',
    name: 'atm10.example.com',
    content: '198.51.100.4',
    ttl: 3600,
    proxied: false,
  });
  const g = fakeCloudflare({ existing: { id: 'recA', content: '198.51.100.4', proxied: true } });
  const up = await cloudflare.upsertAddress(
    { token: TOKEN },
    { zoneId: 'zone1', type: 'A', name: 'atm10.example.com', value: '198.51.100.4' },
    { fetch: g.fetch }
  );
  assert.equal(up.action, 'unproxied');
  assert.ok(g.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/dns_records/recA')));
});

test('syncSrvRecord with an IP public host also upserts the address record and targets the domain', async () => {
  settings.setPublicHost('198.51.100.4');
  const p = providers.create({ kind: 'cloudflare', label: 'CF2', token: TOKEN });
  db.run("UPDATE server_domains SET dns_provider_id = ? WHERE server_id = 'srv_dnsp'", p.id);
  const f = fakeCloudflare();
  await providers.syncSrvRecord('srv_dnsp', 'atm10.example.com', { fetch: f.fetch });
  const posts = f.calls.filter((c) => c.method === 'POST').map((c) => c.body);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].type, 'A');
  assert.equal(posts[1].type, 'SRV');
  assert.equal(posts[1].data.target, 'atm10.example.com');
  providers.remove(p.id);
  settings.setPublicHost('');
});
