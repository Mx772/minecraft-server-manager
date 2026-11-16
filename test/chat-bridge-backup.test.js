'use strict';

// The live chat-bridge config holds the real bot token once the image has filled
// the placeholder in, so backup zips must leave it out while keeping the rest
// (including the placeholder-only copy under customizations/).

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
require('../src/db/migrate').migrate();
const db = require('../src/db');

const containers = require('../src/docker/containers');
containers.inspectStatus = async () => ({ exists: false });
containers.execCapture = async () => '';
const indexer = require('../src/storage/indexer');
indexer.diskFree = async () => ({ free: 1e15 });
indexer.scheduleScan = () => {};

const { dataPath } = require('../src/storage/pathGuard');
const backups = require('../src/services/backups');

const TOKEN = 'live-token-value-that-must-not-be-backed-up';
const CFG = 'config/discord_chat_mod-common.toml';

function zipContents(file) {
  return new Promise((resolve, reject) => {
    const out = {};
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function setup(id, port, { bridge }) {
  db.run(
    `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
     VALUES (?, 'B', 'FABRIC', ?, ?, 'x', 1024, 1536)`,
    id,
    port,
    port + 1000
  );
  if (bridge) {
    db.run(
      "INSERT INTO integrations (server_id, kind, enabled, config_json) VALUES (?, 'discord-chat-bridge', 1, '{}')",
      id
    );
  }
}

test('a server without the panel bridge keeps its own config in backups', async () => {
  const id = 'srv_cbbackup_manual';
  setup(id, 25993, { bridge: false });
  const abs = dataPath('servers', id, CFG);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'hand = "configured"\n');
  const b = await backups.createBackup(id, { reason: 'manual', actor: 'tester' });
  assert.equal((await zipContents(dataPath(b.rel_path)))[CFG], 'hand = "configured"\n');
});

test('a backup omits the live bridge config but keeps everything else', async () => {
  const id = 'srv_cbbackup';
  setup(id, 25991, { bridge: true });
  const files = {
    [CFG]: `discordBotToken = "${TOKEN}"\n`,
    'config/other.toml': 'a=1\n',
    [`customizations/${CFG}`]: 'discordBotToken = "${CFG_DISCORD_BOT_TOKEN}"\n',
    'world/level.dat': 'LEVEL',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = dataPath('servers', id, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const b = await backups.createBackup(id, { reason: 'manual', actor: 'tester' });
  const contents = await zipContents(dataPath(b.rel_path));
  assert.equal(CFG in contents, false);
  assert.ok(!JSON.stringify(contents).includes(TOKEN));
  assert.equal(contents['config/other.toml'], 'a=1\n');
  assert.equal(contents[`customizations/${CFG}`], 'discordBotToken = "${CFG_DISCORD_BOT_TOKEN}"\n');
  assert.equal(contents['world/level.dat'], 'LEVEL');
});
