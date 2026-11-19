'use strict';

// Global analytics API, mounted at /api/analytics behind requireAuth. Every
// response is scoped to the servers the signed-in user may see; unknown or
// hidden ids are dropped silently (or 404 on a detail), never 403.

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const { requireRole } = require('../middleware/auth');
const analytics = require('../../analytics/global');
const servers = require('../../services/servers');

const router = express.Router();

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');
const baseQuery = {
  servers: z
    .string()
    .max(2000)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 200)
        : []
    ),
  deleted: flag,
  range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('30d'),
};
const summaryQuery = z.object(baseQuery);
const onlineQuery = z.object({ ...baseQuery, split: flag });
const serversQuery = z.object({
  ...baseQuery,
  sort: z.enum(['playtime', 'players', 'peak', 'lastActive', 'name']).default('playtime'),
});
const playersQuery = z.object({
  ...baseQuery,
  sort: z.enum(['playtime', 'lastSeen', 'name', 'serverCount']).default('playtime'),
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().min(0).default(0),
});
const rangeQuery = z.object({ range: baseQuery.range });
const hoursQuery = z.object({ ...baseQuery, player: z.string().max(60).optional() });
const idParam = z.string().min(1).max(100);
const keyParam = z
  .string()
  .max(60)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) || /^name:.{1,20}$/.test(v), {
    message: 'Use a player UUID or name:<player name>.',
  });

router.get('/summary', (req, res) => {
  res.json({ ok: true, summary: analytics.summary(req.user, summaryQuery.parse(req.query)) });
});

router.get('/online', (req, res) => {
  res.json({ ok: true, ...analytics.onlineSeries(req.user, onlineQuery.parse(req.query)) });
});

router.get('/servers', (req, res) => {
  res.json({ ok: true, servers: analytics.serverRows(req.user, serversQuery.parse(req.query)) });
});

router.get('/servers/:id', (req, res) => {
  const { range } = rangeQuery.parse(req.query);
  res.json({ ok: true, ...analytics.serverDetail(req.user, idParam.parse(req.params.id), { range }) });
});

router.get('/servers/:id/performance', (req, res) => {
  const { range } = rangeQuery.parse(req.query);
  res.json({ ok: true, ...analytics.performance(req.user, idParam.parse(req.params.id), { range }) });
});

router.get('/players', (req, res) => {
  res.json({ ok: true, ...analytics.playerRows(req.user, playersQuery.parse(req.query)) });
});

router.get('/players/:key', (req, res) => {
  const { range } = rangeQuery.parse(req.query);
  res.json({ ok: true, ...analytics.playerDetail(req.user, keyParam.parse(req.params.key), { range }) });
});

router.get('/hours', (req, res) => {
  const { player, ...rest } = hoursQuery.parse(req.query);
  const key = player ? keyParam.parse(player) : undefined;
  res.json({ ok: true, ...analytics.activityByHour(req.user, { ...rest, player: key }) });
});

router.delete(
  '/deleted-servers/:id',
  requireRole('admin'),
  asyncHandler((req, res) => {
    servers.purgeDeletedServerStats(idParam.parse(req.params.id), { actor: req.user.username });
    res.json({ ok: true });
  })
);

router.use(makeJsonErrorHandler('analytics-global'));

module.exports = router;
