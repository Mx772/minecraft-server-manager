'use strict';

// Cloudflare's published proxy ranges. A name that resolves into these is behind
// the orange-cloud proxy, which only carries web traffic, not Minecraft.
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// (copied 2026-11-19; Cloudflare changes these rarely).

const net = require('node:net');

const V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const V6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const list = new net.BlockList();
for (const c of V4) {
  const [ip, bits] = c.split('/');
  list.addSubnet(ip, Number(bits), 'ipv4');
}
for (const c of V6) {
  const [ip, bits] = c.split('/');
  list.addSubnet(ip, Number(bits), 'ipv6');
}

/** @param {string} ip */
function isCloudflareProxyIp(ip) {
  const kind = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return kind ? list.check(ip, kind) : false;
}

module.exports = { isCloudflareProxyIp };
