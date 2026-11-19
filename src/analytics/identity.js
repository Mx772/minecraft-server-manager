'use strict';

// Player identity for analytics: a stable key that survives name changes when
// a UUID is known, and falls back to the (lowercased) name otherwise.

const path = require('node:path');
const db = require('../db');
const { readUsercache } = require('./stats');
const logger = require('../logger')(path.basename(__filename));

/**
 * Grouping key for a player: the lowercased dashed UUID when known, else
 * 'name:' + the lowercased name.
 * @param {string|null|undefined} uuid
 * @param {string} name
 * @returns {string}
 */
function playerKey(uuid, name) {
  if (uuid) return String(uuid).toLowerCase();
  return `name:${String(name || '').toLowerCase()}`;
}

/**
 * Fill player_uuid on a server's sessions that lack one, using the server's
 * usercache.json (name to UUID, case-insensitive).
 * @param {string} serverId
 * @returns {Promise<string|null>} earliest started_at updated, or null
 */
async function resolveSessionUuids(serverId) {
  const byName = new Map();
  for (const [uuid, name] of await readUsercache(serverId)) byName.set(String(name).toLowerCase(), uuid);
  if (!byName.size) return null;
  const rows = db.all(
    'SELECT player, MIN(started_at) AS first FROM player_sessions WHERE server_id = ? AND player_uuid IS NULL GROUP BY player',
    serverId
  );
  let earliest = null;
  for (const row of rows) {
    const uuid = byName.get(String(row.player).toLowerCase());
    if (!uuid) continue;
    db.run(
      'UPDATE player_sessions SET player_uuid = ? WHERE server_id = ? AND player = ? AND player_uuid IS NULL',
      uuid.toLowerCase(),
      serverId,
      row.player
    );
    if (!earliest || row.first < earliest) earliest = row.first;
  }
  if (earliest) logger.debug('Filled session UUIDs from the usercache.', { serverId });
  return earliest;
}

module.exports = { playerKey, resolveSessionUuids };
