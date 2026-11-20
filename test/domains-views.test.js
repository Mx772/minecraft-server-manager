'use strict';

// Server-rendered pieces of custom domains: the Overview Domains card and
// address picker, the Settings opt-in toggle, and the public status page.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const db = require('../src/db');
const statusPage = require('../src/integrations/statusPage');

let cookie;
const SID = 'srv_domv01';
const D = 'atm10.example.com';
const html = { Accept: 'text/html' };

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
  db.run(
    `INSERT INTO server_domains (server_id, domain, is_primary, last_state, last_check_json) VALUES (?, ?, 1, 'points-here', ?)`,
    SID,
    D,
    JSON.stringify({
      state: 'points-here',
      badge: 'badge-ok',
      label: 'Points Here',
      message: 'ok',
      ttl: 300,
      record: null,
    })
  );
});
test.after(async () => {
  await app.stop();
});

test('overview lists a verified primary domain first and renders the Domains card', async () => {
  const r = await app.req('GET', `/servers/${SID}`, { cookie, headers: html });
  assert.equal(r.status, 200);
  assert.match(r.text, /data-domains-card="srv_domv01"/);
  assert.match(r.text, /<h3 class="font-semibold">Domains<\/h3>/);
  assert.match(r.text, /Add Domain/);
  const options = [...r.text.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(options[0], D);
  assert.match(r.text, /Players can type this name in Minecraft/);
  assert.match(r.text, /data-domains-initial>[^<]*atm10\.example\.com/);
});

test('settings page renders the outside-check toggle', async () => {
  const r = await app.req('GET', '/settings', { cookie, headers: html });
  assert.equal(r.status, 200);
  assert.match(r.text, /id="external-reachability-check"/);
  assert.match(r.text, /Check Domains From Outside/);
  assert.match(r.text, /id="network"/);
  assert.match(r.text, /id="set-domain"/);
  assert.match(r.text, /<h3 class="text-sm font-semibold text-ink">DNS Providers<\/h3>/);
  assert.match(r.text, /id="dns-providers-table"/);
  assert.match(r.text, /id="dns-providers-data">\[/);
  assert.match(r.text, /id="dns-provider-kinds">[^<]*cloudflare/i);
  assert.doesNotMatch(r.text, /Custom Domains/);
});

test('public status page shows the verified address', async () => {
  statusPage.setStatusPage(SID, { enabled: true, slug: 'domv-page' });
  const r = await app.req('GET', '/status/domv-page', { headers: html });
  assert.equal(r.status, 200);
  assert.match(r.text, /id="status-address"[^>]*>atm10\.example\.com</);
});

test('provider controls are flagged admin-only on the Domains card', async () => {
  const admin = await app.req('GET', `/servers/${SID}`, { cookie, headers: html });
  assert.match(admin.text, /data-admin="true"/);
  const dnsProviders = require('../src/services/dnsProviders');
  assert.ok(Array.isArray(dnsProviders.list()));
  // A signed-out request never reaches the card, let alone the provider controls.
  const anon = await app.req('GET', `/servers/${SID}`, { headers: html });
  assert.doesNotMatch(anon.text, /data-admin=/);
});
