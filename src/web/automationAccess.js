'use strict';

// Who may see and change an automation. An automation runs actions as the
// panel, so changing one needs the same rights as doing those actions by hand:
// every server it names, and every capability its steps use.

const permissions = require('../services/permissions');
const httpError = require('../utils/httpError');
const { ACTIONS } = require('../automations/actions');

/**
 * @typedef {object} AccessDef
 * @property {{ kind: string, serverIds?: string[] }} [targets] always set once the definition is validated
 * @property {Array<{ action: string }>} steps
 */

/**
 * Throws unless the user may create, change, run, or delete this automation.
 * @param {{ user: { id: string, role: string } }} req
 * @param {AccessDef} def
 */
function requireAutomationAccess(req, def) {
  const { user } = req;
  const actions = def.steps.map((s) => ACTIONS[s.action]).filter(Boolean);
  const targets = def.targets || { kind: 'servers', serverIds: [] };
  const { kind } = targets;

  if (kind === 'all') {
    // "Every server" outruns any per-server grant.
    if (user.role !== 'admin') throw httpError(403, 'Only an admin can run an automation on every server.');
    return;
  }

  if (kind === 'panel') {
    if (actions.some((a) => a.adminOnly) && user.role !== 'admin') {
      throw httpError(403, 'Only an admin can run an automation that acts on every server.');
    }
    // Panel-wide work follows the global role: a viewer never reaches it, even with per-server grants.
    if (user.role === 'viewer') throw httpError(403, 'Your role (Viewer) is read-only.');
    return;
  }

  const serverIds = targets.serverIds || [];
  for (const id of serverIds) {
    if (!permissions.effective(user, id).includes('view')) throw httpError(404, 'Server not found.');
  }
  for (const id of serverIds) {
    const perms = permissions.effective(user, id);
    for (const action of actions) {
      const cap = /** @type {import('../services/permissions').Capability} */ (action.capability);
      if (cap && !perms.includes(cap)) {
        const label = permissions.CAPABILITY_INFO[cap].label.toLowerCase();
        throw httpError(403, `You don't have the ${label} permission on this server.`);
      }
    }
  }
}

/** True when the user may change the automation (the check behind every write control). */
function canChange(user, def) {
  try {
    requireAutomationAccess({ user }, def);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the user may see the automation: panel and all-server ones are for
 * everyone, one naming servers only when every one of them is visible, so a
 * hidden server's name never reaches the page.
 * @param {Set<string>} visible a `permissions.visibleServerIds(user)` result
 * @param {AccessDef} def
 */
function isVisibleTo(visible, def) {
  const targets = def.targets || { kind: 'servers', serverIds: [] };
  return targets.kind !== 'servers' || (targets.serverIds || []).every((id) => visible.has(id));
}

module.exports = { requireAutomationAccess, canChange, isVisibleTo };
