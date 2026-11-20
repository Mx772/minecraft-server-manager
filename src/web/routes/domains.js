'use strict';

// Custom domains API. Mounted at /api/servers/:id/domains (mergeParams gives
// this router access to :id). Reading needs only access to the server; every
// change and every check needs the settings capability (mount-level
// requireCapForWrites in api.js).

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const domains = require('../../services/domains');
const { requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const actorOf = (req) => req.user.username;
const addBody = z.object({ domain: z.string().trim().min(1, 'Enter a domain.').max(300) });
const providerBody = z.object({ providerId: z.string().min(1).max(64).nullable() });
const reachBody = z.object({ mode: z.enum(['panel', 'external']).default('panel') });

router.get('/', (req, res) => {
  res.json({ ok: true, ...domains.list(req.params.id) });
});

router.post(
  '/',
  asyncHandler((req, res) => {
    const { domain } = addBody.parse(req.body);
    res.status(201).json({ ok: true, ...domains.add(req.params.id, domain, { actor: actorOf(req) }) });
  })
);

router.delete(
  '/:domain',
  asyncHandler((req, res) => {
    res.json({ ok: true, ...domains.remove(req.params.id, req.params.domain, { actor: actorOf(req) }) });
  })
);

router.put(
  '/:domain/primary',
  asyncHandler((req, res) => {
    res.json({ ok: true, ...domains.setPrimary(req.params.id, req.params.domain, { actor: actorOf(req) }) });
  })
);

router.post(
  '/:domain/check',
  asyncHandler(async (req, res) => {
    const result = await domains.check(req.params.id, req.params.domain, { actor: actorOf(req) });
    res.json({ ok: true, result, ...domains.list(req.params.id) });
  })
);

router.post(
  '/:domain/reachability',
  asyncHandler(async (req, res) => {
    const { mode } = reachBody.parse(req.body || {});
    res.json({ ok: true, reachability: await domains.reachability(req.params.id, req.params.domain, { mode }) });
  })
);

// A provider token can write records across a whole DNS zone, so linking one is admin-only.
router.put(
  '/:domain/provider',
  requireRole('admin'),
  asyncHandler((req, res) => {
    const { providerId } = providerBody.parse(req.body || {});
    res.json({
      ok: true,
      ...domains.setProvider(req.params.id, req.params.domain, providerId, { actor: actorOf(req) }),
    });
  })
);

router.post(
  '/:domain/sync',
  asyncHandler(async (req, res) => {
    const out = await domains.sync(req.params.id, req.params.domain, { actor: actorOf(req) });
    res.json({ ok: true, ...out, ...domains.list(req.params.id) });
  })
);

module.exports = router;
