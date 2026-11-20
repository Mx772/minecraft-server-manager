'use strict';

// DNS provider API (stored API tokens used to manage SRV records). Admin-only:
// a token can edit a whole DNS zone. Tokens are never returned.

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const dnsProviders = require('../../services/dnsProviders');

const router = express.Router();

const createBody = z.object({
  kind: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1, 'Give the provider a name.').max(80),
  token: z.string().trim().min(1, 'An API token is required.').max(512),
});

router.get('/kinds', (req, res) => {
  res.json({ ok: true, kinds: dnsProviders.kinds() });
});

router.get('/', (req, res) => {
  res.json({ ok: true, providers: dnsProviders.list() });
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createBody.parse(req.body);
    const provider = await dnsProviders.verifyAndCreate(input, { actor: req.user.username });
    res.status(201).json({ ok: true, provider });
  })
);

router.delete(
  '/:id',
  asyncHandler((req, res) => {
    dnsProviders.remove(req.params.id, { actor: req.user.username });
    res.json({ ok: true, providers: dnsProviders.list() });
  })
);

module.exports = router;
