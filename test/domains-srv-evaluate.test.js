'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/services/domains/srvCheck');
const { gather } = require('../src/services/domains/resolve');

const D = 'atm10.example.com';
const base = { domain: D, publicHost: 'mc.example.net', publicIps: ['198.51.100.4'], gamePort: 25570 };
const srv = (port, name = 'mc.example.net') => [{ name, port, priority: 0, weight: 5 }];

test('points here: SRV port matches and the target resolves to the public IPs', () => {
  const r = evaluate({ ...base, srv: srv(25570), targetIps: ['198.51.100.4'] });
  assert.equal(r.state, 'points-here');
  assert.equal(r.badge, 'badge-ok');
  assert.equal(r.label, 'Points Here');
});

test('wrong port names both ports', () => {
  const r = evaluate({ ...base, srv: srv(25566), targetIps: ['198.51.100.4'] });
  assert.equal(r.state, 'wrong-port');
  assert.equal(r.badge, 'badge-danger');
  assert.match(r.message, /sends players to port 25566, but this server listens on 25570/);
  assert.equal(r.record.port, 25570);
});

test('different IP is a warning that names both addresses', () => {
  const r = evaluate({ ...base, srv: srv(25570), targetIps: ['203.0.113.9'] });
  assert.equal(r.state, 'different-ip');
  assert.equal(r.badge, 'badge-warn');
  assert.match(r.message, /203\.0\.113\.9/);
  assert.match(r.message, /198\.51\.100\.4/);
});

test('no SRV needed: the domain resolves and the port is 25565', () => {
  const r = evaluate({ ...base, gamePort: 25565, srv: [], domainIps: ['198.51.100.4'] });
  assert.equal(r.state, 'no-srv-needed');
  assert.equal(r.badge, 'badge-info');
  assert.equal(r.label, 'No SRV Needed');
});

test('missing SRV carries the exact record to create', () => {
  const r = evaluate({ ...base, srv: [], domainIps: ['198.51.100.4'] });
  assert.equal(r.state, 'missing-srv');
  assert.equal(r.badge, 'badge-warn');
  assert.deepEqual(
    {
      name: r.record.name,
      priority: r.record.priority,
      weight: r.record.weight,
      port: r.record.port,
      target: r.record.target,
    },
    { name: '_minecraft._tcp.atm10', priority: 0, weight: 5, port: 25570, target: 'mc.example.net' }
  );
  assert.equal(r.record.fqdn, `_minecraft._tcp.${D}`);
  assert.equal(r.record.bind, `_minecraft._tcp.${D}. 3600 IN SRV 0 5 25570 mc.example.net.`);
});

test('not found: nothing resolves at all', () => {
  const r = evaluate({ ...base, srv: [], domainIps: [] });
  assert.equal(r.state, 'not-found');
  assert.equal(r.badge, 'badge-danger');
  assert.equal(r.label, 'Not Found');
});

test('resolver error gives a retry message, not a verdict', () => {
  const r = evaluate({ ...base, srv: [], srvError: true });
  assert.equal(r.state, 'resolver-error');
  assert.equal(r.badge, 'badge-danger');
  assert.match(r.message, /try again/i);
});

test('no public host: a matching SRV port is accepted with a note', () => {
  const r = evaluate({ domain: D, gamePort: 25570, publicHost: '', publicIps: [], srv: srv(25570), targetIps: [] });
  assert.equal(r.state, 'points-here');
  assert.match(r.message, /public address/i);
  assert.equal(r.record, null);
});

function stubResolver({ srv, a = {}, aaaa = {} }) {
  const lookup = (table) => async (name) => {
    const v = table[name];
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    return v;
  };
  return {
    resolveSrv: lookup(srv || {}),
    resolve4: lookup(a),
    resolve6: lookup(aaaa),
  };
}

test('gather + evaluate end to end with a stub resolver', async () => {
  const resolver = stubResolver({
    srv: { [`_minecraft._tcp.${D}`]: [{ name: 'mc.example.net', port: 25570, priority: 0, weight: 5 }] },
    a: { 'mc.example.net': [{ address: '198.51.100.4', ttl: 300 }] },
  });
  const facts = await gather(D, { publicHost: 'mc.example.net', resolver });
  assert.deepEqual(facts.targetIps, ['198.51.100.4']);
  assert.deepEqual(facts.publicIps, ['198.51.100.4']);
  assert.equal(facts.ttl, 300);
  assert.equal(evaluate({ ...facts, gamePort: 25570, domain: D }).state, 'points-here');
});

test('gather treats an IP literal public host as-is and ENOTFOUND as "no record"', async () => {
  const resolver = stubResolver({ a: { [D]: ['198.51.100.4'] } });
  const facts = await gather(D, { publicHost: '198.51.100.4', resolver });
  assert.deepEqual(facts.publicIps, ['198.51.100.4']);
  assert.deepEqual(facts.srv, []);
  assert.equal(facts.srvError, false);
  assert.equal(evaluate({ ...facts, gamePort: 25565, domain: D }).state, 'no-srv-needed');
});

test('gather flags a resolver failure other than "no record"', async () => {
  const boom = Object.assign(new Error('x'), { code: 'ESERVFAIL' });
  const resolver = stubResolver({ srv: { [`_minecraft._tcp.${D}`]: boom }, a: { [D]: boom } });
  const facts = await gather(D, { publicHost: '', resolver });
  assert.equal(facts.srvError, true);
  assert.equal(evaluate({ ...facts, gamePort: 25565, domain: D }).state, 'resolver-error');
});

test('IPv4 public host: SRV targets the domain and an A record is suggested', () => {
  const r = evaluate({ ...base, publicHost: '198.51.100.4', srv: [], domainIps: ['198.51.100.4'] });
  assert.equal(r.record.target, D);
  assert.deepEqual(r.record.address, { type: 'A', name: 'atm10', fqdn: D, value: '198.51.100.4', ttl: 3600 });
  assert.equal(r.record.bind, `${D}. 3600 IN A 198.51.100.4\n_minecraft._tcp.${D}. 3600 IN SRV 0 5 25570 ${D}.`);
});

test('IPv6 public host gives an AAAA record, and an apex domain uses @', () => {
  const r = evaluate({
    ...base,
    domain: 'example.com',
    publicHost: '2001:db8::1',
    srv: [],
    domainIps: ['2001:db8::1'],
  });
  assert.equal(r.record.address.type, 'AAAA');
  assert.equal(r.record.address.name, '@');
  assert.equal(r.record.target, 'example.com');
});

test('hostname public host has no address record', () => {
  const r = evaluate({ ...base, srv: [], domainIps: ['198.51.100.4'] });
  assert.equal(r.record.address, null);
  assert.equal(r.record.target, 'mc.example.net');
});

test('SRV target equal to the domain compares through targetIps against an IP public host', () => {
  const r = evaluate({
    ...base,
    publicHost: '198.51.100.4',
    srv: srv(25570, D),
    targetIps: ['198.51.100.4'],
  });
  assert.equal(r.state, 'points-here');
});
