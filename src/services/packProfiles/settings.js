'use strict';

// Server settings a pack profile preset may change. A profile is community
// data, so only keys on this list are accepted, and each value is checked
// against the field catalog entry for that key (type, min, max).

const { getField } = require('../../config/field-catalog');

/** The only env settings a profile preset may set. */
const ALLOWED_SETTING_KEYS = [
  'VIEW_DISTANCE',
  'SIMULATION_DISTANCE',
  'ALLOW_FLIGHT',
  'MAX_TICK_TIME',
  'USE_AIKAR_FLAGS',
];

/** Why a value is not valid for a setting, or null when it is fine. */
function settingProblem(key, value) {
  const field = getField('env', key);
  if (!ALLOWED_SETTING_KEYS.includes(key) || !field) return 'is not a setting profiles may change';
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : 'must be true or false';
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'must be a whole number';
    if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
    if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
    return null;
  }
  return 'is not a supported setting type';
}

/** Env var text the settings form stores for a value. */
const toEnvValue = (value) => String(value);

module.exports = { ALLOWED_SETTING_KEYS, settingProblem, toEnvValue };
