'use strict';

// Public API of the automations engine (replaces services/scheduler.js).

const { ACTIONS } = require('./actions');
const {
  validateAutomation,
  validateTemplate,
  automationSchema,
  shapeError,
  assertValidCron,
  MAX_OFFSET_SEC,
} = require('./schema');
const templates = require('./templates');
const store = require('./store');
const engine = require('./engine');
const hooks = require('./hooks');
const fileSteps = require('./fileSteps');

module.exports = {
  ACTIONS,
  validateAutomation,
  validateTemplate,
  exportTemplate: templates.exportTemplate,
  parseImport: templates.parseImport,
  listTemplates: store.listTemplates,
  getTemplate: store.getTemplate,
  createTemplate: store.createTemplate,
  deleteTemplate: store.deleteTemplate,
  templateFromAutomation: store.templateFromAutomation,
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
  planFileStep: fileSteps.planFileStep,
  fileContext: fileSteps.fileContext,
  fileStepWarnings: fileSteps.fileStepWarnings,
  targetServerIds: fileSteps.targetServerIds,
  matchesGlob: fileSteps.matchesGlob,
  emit: hooks.emit,
  configureHooks: hooks.configureHooks,
  startAutomations: engine.startAutomations,
  rearmAll: engine.rearmAll,
  runNow: engine.runNow,
  stopAll: engine.stopAll,
  configureEngine: engine.configureEngine,
  nextFire: engine.nextFire,
  cronMinGapMs: engine.cronMinGapMs,
};
