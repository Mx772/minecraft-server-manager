'use strict';

// Customizations API. Mounted at /api/servers/:id/customizations (mergeParams
// gives this router access to :id).

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const customizations = require('../../services/customizations');

const router = express.Router({ mergeParams: true });

// requireAuth guarantees req.user on every /api request.
const actorOf = (req) => req.user.username;
const pathsBody = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(customizations.MAX_FILES) });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, customizations: await customizations.list(req.params.id) });
  })
);

router.post(
  '/add',
  asyncHandler(async (req, res) => {
    const { paths } = pathsBody.parse(req.body);
    const out = await customizations.add(req.params.id, paths, { actor: actorOf(req) });
    res.json({ ok: out.failed === 0, ...out });
  })
);

router.post(
  '/remove',
  asyncHandler(async (req, res) => {
    const { paths } = pathsBody.parse(req.body);
    const out = await customizations.remove(req.params.id, paths, { actor: actorOf(req) });
    res.json({ ok: out.failed === 0, ...out });
  })
);

router.post(
  '/keep-current',
  asyncHandler(async (req, res) => {
    const { paths } = pathsBody.parse(req.body);
    const out = await customizations.keepCurrent(req.params.id, paths, { actor: actorOf(req) });
    res.json({ ok: out.failed === 0, ...out });
  })
);

router.post(
  '/restore',
  asyncHandler(async (req, res) => {
    const { paths } = pathsBody.parse(req.body);
    const out = await customizations.restore(req.params.id, paths, { actor: actorOf(req) });
    res.json({ ok: out.failed === 0, ...out });
  })
);

router.use(makeJsonErrorHandler('customizations'));

module.exports = router;
