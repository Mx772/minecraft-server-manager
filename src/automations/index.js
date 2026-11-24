'use strict';

// Public API of the automations engine (replaces services/scheduler.js).

const { ACTIONS } = require('./actions');
const { validateAutomation, automationSchema, shapeError, assertValidCron, MAX_OFFSET_SEC } = require('./schema');
const store = require('./store');
const engine = require('./engine');

module.exports = {
  ACTIONS,
  validateAutomation,
  automationSchema,
  shapeError,
  assertValidCron,
  MAX_OFFSET_SEC,
  createAutomation: store.createAutomation,
  updateAutomation: store.updateAutomation,
  setEnabled: store.setEnabled,
  deleteAutomation: store.deleteAutomation,
  getAutomation: store.getAutomation,
  listAutomations: store.listAutomations,
  listRuns: store.listRuns,
  removeServerFromTargets: store.removeServerFromTargets,
  startAutomations: engine.startAutomations,
  rearmAll: engine.rearmAll,
  runNow: engine.runNow,
  stopAll: engine.stopAll,
  configureEngine: engine.configureEngine,
  nextFire: engine.nextFire,
  cronMinGapMs: engine.cronMinGapMs,
};
