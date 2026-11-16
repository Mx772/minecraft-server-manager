'use strict';

// Pack profile API. Mounted at /api/servers/:id/profile (mergeParams gives this
// router access to :id). Reads are open to anyone who can view the server;
// writes need the `settings` capability (set at the mount).

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const httpError = require('../../utils/httpError');
const serversService = require('../../services/servers');
const packProfiles = require('../../services/packProfiles');

const router = express.Router({ mergeParams: true });

const changesBody = z.object({
  changes: z
    .array(z.object({ presetId: z.string().min(1).max(100), enabled: z.boolean() }))
    .min(1)
    .max(50),
});

function mustGet(req) {
  const server = serversService.getServer(req.params.id);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    mustGet(req);
    res.json({ ok: true, ...packProfiles.presetsFor(req.params.id) });
  })
);

router.post(
  '/presets',
  asyncHandler(async (req, res) => {
    mustGet(req);
    const { changes } = changesBody.parse(req.body);
    const out = packProfiles.setPresets(req.params.id, changes, { actor: req.user.username });
    res.json({ ok: true, ...out });
  })
);

router.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    if (!packProfiles.profileFor(server.id)) throw httpError(404, 'This server has no recommended settings profile.');
    const out = await packProfiles.apply(server.id, { trigger: 'manual', actor: req.user.username });
    const running = ['running', 'starting', 'unhealthy', 'stalled'].includes(server.status);
    res.json({
      ok: true,
      applied: out.applied,
      held: out.held,
      changedFiles: out.changedFiles,
      restartNeeded: running && out.changedFiles.length > 0,
      ...packProfiles.presetsFor(server.id),
    });
  })
);

router.use(makeJsonErrorHandler('profile'));

module.exports = router;
