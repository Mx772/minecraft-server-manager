'use strict';

// Java Edition Server List Ping, the way a client does it: resolve the
// _minecraft._tcp SRV record first, connect, send handshake + status request,
// read the JSON status, then (optionally) a ping for latency. No dependencies.

const net = require('node:net');
const { defaultResolver, withTimeout } = require('./resolve');

const MAX_RESPONSE_BYTES = 64 * 1024;
const PROTOCOL_VERSION = 767; // any value works for a status request
const DEFAULT_PORT = 25565;

/** @param {number} value */
function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/**
 * Read a VarInt at `offset`. Returns null when the buffer ends mid-number.
 * Throws on a number longer than 5 bytes (garbage).
 * @param {Buffer} buf
 * @param {number} [offset]
 * @returns {{ value: number, bytes: number } | null}
 */
function decodeVarInt(buf, offset = 0) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    result |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value: result >>> 0, bytes: i + 1 };
  }
  throw new Error('The server sent data that is not a Minecraft response.');
}

const encodeString = (s) => {
  const data = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarInt(data.length), data]);
};

/** Length-prefix a packet body. */
const frame = (body) => Buffer.concat([encodeVarInt(body.length), body]);

function handshakePacket(host, port) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  return frame(
    Buffer.concat([Buffer.from([0x00]), encodeVarInt(PROTOCOL_VERSION), encodeString(host), portBuf, encodeVarInt(1)])
  );
}

const statusRequestPacket = () => frame(Buffer.from([0x00]));

function pingPacket(payload) {
  const body = Buffer.alloc(9);
  body[0] = 0x01;
  body.writeBigInt64BE(BigInt(payload), 1);
  return frame(body);
}

/**
 * Pull one complete packet off the front of `buf`.
 * @returns {{ id: number, payload: Buffer, rest: Buffer } | null} null until the whole packet has arrived
 */
function takePacket(buf) {
  const len = decodeVarInt(buf, 0);
  if (!len) return null;
  if (len.value > MAX_RESPONSE_BYTES) throw new Error('The server sent an unexpectedly large response.');
  if (buf.length < len.bytes + len.value) return null;
  const body = buf.subarray(len.bytes, len.bytes + len.value);
  const id = decodeVarInt(body, 0);
  if (!id) throw new Error('The server sent an incomplete response.');
  return { id: id.value, payload: body.subarray(id.bytes), rest: buf.subarray(len.bytes + len.value) };
}

/** Flatten a chat component (string, object with text/extra, or array) to plain text. */
function flattenChat(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenChat).join('');
  if (typeof node === 'object') {
    let out = typeof node.text === 'string' ? node.text : '';
    if (Array.isArray(node.extra)) out += node.extra.map(flattenChat).join('');
    return out;
  }
  return String(node);
}

const stripCodes = (s) => s.replace(/§[0-9a-fk-or]/gi, '');

/** Turn the status JSON into the fields the panel shows. */
function parseStatus(json) {
  return {
    motd: stripCodes(flattenChat(json.description)).trim(),
    version: json.version && typeof json.version.name === 'string' ? stripCodes(json.version.name) : null,
    players: {
      online: Number(json.players && json.players.online) || 0,
      max: Number(json.players && json.players.max) || 0,
    },
  };
}

/** Where a client would connect: the SRV target when one exists, else host:port. */
async function resolveTarget(host, port, resolver) {
  if (net.isIP(host) || port !== DEFAULT_PORT) return { host, port };
  try {
    const records = await withTimeout(resolver.resolveSrv(`_minecraft._tcp.${host}`), 3000);
    if (records && records.length) {
      const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: String(best.name).replace(/\.$/, ''), port: Number(best.port) };
    }
  } catch {
    /* no SRV record or a resolver hiccup: fall back to the plain address */
  }
  return { host, port };
}

/**
 * Ping a Java server.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {number} [opts.timeoutMs]
 * @param {import('./resolve').ResolverLike} [opts.resolver]
 * @param {boolean} [opts.measureLatency]  send a ping/pong after the status (default true)
 * @returns {Promise<{ ok: true, latencyMs: number|null, motd: string, version: string|null, players: {online: number, max: number} } | { ok: false, reason: string }>}
 */
async function ping({
  host,
  port = DEFAULT_PORT,
  timeoutMs = 5000,
  resolver = defaultResolver(),
  measureLatency = true,
}) {
  const target = await resolveTarget(host, port, resolver);
  return new Promise((resolve) => {
    let settled = false;
    /** @type {Buffer} */
    let buf = Buffer.alloc(0);
    let status = null;
    let pingSentAt = 0;
    const startedAt = Date.now();
    const socket = net.connect({ host: target.host, port: target.port });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const fail = (reason) => finish({ ok: false, reason });
    const succeed = (latencyMs) => finish({ ok: true, latencyMs, ...status });

    const timer = setTimeout(() => {
      // A server that answered the status but never ponged is still reachable.
      if (status) return succeed(null);
      fail('The server did not answer in time.');
    }, timeoutMs);
    timer.unref();

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(Buffer.concat([handshakePacket(host, port), statusRequestPacket()]));
    });
    socket.on('error', (err) => {
      const code = err && err.code;
      if (code === 'ECONNREFUSED')
        return fail('The connection was refused. The server may be stopped, or the port may be closed.');
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return fail('The address could not be found in DNS.');
      if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return fail('The address could not be reached.');
      fail('Could not connect to the server.');
    });
    socket.on('close', () => {
      if (status) return succeed(null);
      fail('The server closed the connection without answering.');
    });
    socket.on('data', (/** @type {Buffer} */ chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_RESPONSE_BYTES + 16) return fail('The server sent an unexpectedly large response.');
      try {
        for (let pkt = takePacket(buf); pkt; pkt = takePacket(buf)) {
          buf = pkt.rest;
          if (pkt.id === 0x00 && !status) {
            const str = decodeVarInt(pkt.payload, 0);
            if (!str) throw new Error('The server sent an incomplete response.');
            const text = pkt.payload.subarray(str.bytes, str.bytes + str.value).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              throw new Error('The server sent a status the panel could not read.');
            }
            if (!json || typeof json !== 'object')
              throw new Error('The server sent a status the panel could not read.');
            status = parseStatus(json);
            if (!measureLatency) return succeed(Date.now() - startedAt);
            pingSentAt = Date.now();
            socket.write(pingPacket(pingSentAt));
          } else if (pkt.id === 0x01 && status) {
            return succeed(Date.now() - pingSentAt);
          } else {
            throw new Error('The server sent an unexpected response.');
          }
        }
      } catch (err) {
        fail(err.message);
      }
    });
  });
}

module.exports = {
  ping,
  encodeVarInt,
  decodeVarInt,
  handshakePacket,
  statusRequestPacket,
  pingPacket,
  takePacket,
  flattenChat,
  parseStatus,
  MAX_RESPONSE_BYTES,
};
