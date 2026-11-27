'use strict';

// Step conditions: checked right before a step runs. A step whose condition is
// not met is skipped, not failed. The docker and players modules are required
// inside the function and called through their module objects, so tests can stand
// in for them.

const path = require('node:path');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

/**
 * Why a step must be skipped, or null when its condition is met.
 * @param {{ type: string, min?: number }} condition
 * @param {string | null} serverId
 * @returns {Promise<string | null>} a sentence for the run history
 */
async function unmetReason(condition, serverId) {
  if (!serverId) return null; // conditions only exist on server steps
  const info = await require('../docker/containers').inspectStatus(serverId);
  const running = Boolean(info && info.exists && (info.status === 'running' || info.status === 'unhealthy'));
  if (!running) return 'Skipped because the server is not running.';
  if (condition.type === 'server-running') return null;

  let online;
  try {
    online = (await require('../services/players').listOnlineNames(serverId, { throwOnError: true })).length;
  } catch (err) {
    logger.debug('Could not read the player count for a step condition.', {
      serverId,
      err: serializeError(err, { includeStack: false }),
    });
    return 'Skipped because the player count could not be read.';
  }
  if (condition.type === 'no-players') return online === 0 ? null : 'Skipped because players were online.';
  const min = condition.min ?? 1;
  if (online >= min) return null;
  return min === 1
    ? 'Skipped because no players were online.'
    : `Skipped because fewer than ${min} players were online.`;
}

module.exports = { unmetReason };
