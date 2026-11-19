'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const slp = require('../src/services/domains/slp');

test('VarInt round-trips, including multi-byte values', () => {
  for (const n of [0, 1, 127, 128, 255, 25565, 2097151, 2147483647]) {
    const buf = slp.encodeVarInt(n);
    assert.deepEqual(slp.decodeVarInt(buf), { value: n, bytes: buf.length });
  }
  assert.equal(slp.decodeVarInt(Buffer.from([0x80])), null, 'truncated number');
  assert.throws(() => slp.decodeVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])));
});

test('flattenChat handles strings, extra components and § codes', () => {
  const status = slp.parseStatus({
    description: { text: '§aHello ', extra: [{ text: 'there' }, '!'] },
    version: { name: 'Paper 1.21' },
    players: { online: 2, max: 20 },
  });
  assert.deepEqual(status, { motd: 'Hello there!', version: 'Paper 1.21', players: { online: 2, max: 20 } });
});

const str = (s) => Buffer.concat([slp.encodeVarInt(Buffer.byteLength(s)), Buffer.from(s)]);
const packet = (id, payload) => {
  const body = Buffer.concat([slp.encodeVarInt(id), payload]);
  return Buffer.concat([slp.encodeVarInt(body.length), body]);
};

/** A fake server speaking SLP. `chunk` splits each write into pieces of that many bytes. */
async function fakeServer({ chunk = 0, statusJson, garbage = false, silent = false } = {}) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let answered = false;
    const send = async (data) => {
      if (!chunk) return sock.write(data);
      for (let i = 0; i < data.length; i += chunk) {
        sock.write(data.subarray(i, i + chunk));
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    sock.on('data', (d) => {
      if (silent) return;
      buf = Buffer.concat([buf, d]);
      if (garbage) return sock.write(Buffer.alloc(200000, 0xff));
      let pkt;
      while ((pkt = slp.takePacket(buf))) {
        buf = pkt.rest;
        if (pkt.id === 0x00 && pkt.payload.length === 0 && !answered) {
          answered = true;
          send(packet(0x00, str(JSON.stringify(statusJson))));
        } else if (pkt.id === 0x01) {
          send(packet(0x01, pkt.payload));
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

const STATUS = {
  description: { text: 'A Test Server' },
  version: { name: 'Paper 1.21.1', protocol: 767 },
  players: { online: 3, max: 20 },
};
const noSrv = { resolveSrv: async () => [] };

test('ping reads the status and latency from a fake server', async () => {
  const s = await fakeServer({ statusJson: STATUS });
  try {
    const r = await slp.ping({ host: '127.0.0.1', port: s.port, resolver: noSrv });
    assert.equal(r.ok, true);
    assert.equal(r.motd, 'A Test Server');
    assert.equal(r.version, 'Paper 1.21.1');
    assert.deepEqual(r.players, { online: 3, max: 20 });
    assert.equal(typeof r.latencyMs, 'number');
  } finally {
    await s.close();
  }
});

test('ping copes with the response arriving in tiny fragments', async () => {
  const s = await fakeServer({ statusJson: STATUS, chunk: 3 });
  try {
    const r = await slp.ping({ host: '127.0.0.1', port: s.port, resolver: noSrv, timeoutMs: 4000 });
    assert.equal(r.ok, true);
    assert.equal(r.motd, 'A Test Server');
  } finally {
    await s.close();
  }
});

test('ping times out on a server that never answers', async () => {
  const s = await fakeServer({ silent: true });
  try {
    const r = await slp.ping({ host: '127.0.0.1', port: s.port, resolver: noSrv, timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /did not answer in time/);
  } finally {
    await s.close();
  }
});

test('ping rejects oversized garbage responses', async () => {
  const s = await fakeServer({ garbage: true });
  try {
    const r = await slp.ping({ host: '127.0.0.1', port: s.port, resolver: noSrv, timeoutMs: 2000 });
    assert.equal(r.ok, false);
  } finally {
    await s.close();
  }
});

test('ping reports a refused connection in plain words', async () => {
  const s = await fakeServer({ statusJson: STATUS });
  const port = s.port;
  await s.close();
  const r = await slp.ping({ host: '127.0.0.1', port, resolver: noSrv });
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused/);
});
