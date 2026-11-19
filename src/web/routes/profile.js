'use strict';

// Pack profile API. Mounted at /api/servers/:id/profile (mergeParams gives this
// router access to :id). Reads are open to anyone who can view the server;
// writes need the `settings` capability (set at the mount).
//
// A write that changes files on a server that has started before backs the
// server up first. That can take minutes on a large pack, so those writes answer
// 202 { taskId } and the task's result is the usual JSON body. Everything else
// answers the body directly.

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler');
const { makeJsonErrorHandler } = require('../middleware/jsonErrorHandler');
const httpError = require('../../utils/httpError');
const serversService = require('../../services/servers');
const packProfiles = require('../../services/packProfiles');
const tasks = require('../../services/tasks');

const router = express.Router({ mergeParams: true });

const changesBody = z.object({
  changes: z
    .array(z.object({ presetId: z.string().min(1).max(100), enabled: z.boolean() }))
    .min(1)
    .max(50),
});

const reviewBody = z.object({ enable: z.array(z.string().min(1).max(100)).max(50) });

const replaceBody = z.object({ presetId: z.string().min(1).max(100), path: z.string().min(1).max(300) });

const RUNNING = ['running', 'starting', 'unhealthy', 'stalled'];

/** Apply results the UI needs after an action that may have changed files or settings. */
function applyShape(server, out) {
  const changedFiles = out ? out.changedFiles : [];
  const rebuildNeeded = Boolean(out && out.rebuildNeeded);
  return {
    applied: out ? out.applied : 0,
    held: out ? out.held : 0,
    changedFiles,
    settingsChanged: out ? out.settingsChanged : 0,
    restartNeeded: RUNNING.includes(server.status) && changedFiles.length > 0,
    rebuildNeeded,
  };
}

function mustGet(req) {
  const server = serversService.getServer(req.params.id);
  if (!server) throw httpError(404, 'Server not found.');
  return server;
}

/** 404 unless the server has a profile; 400 unless every id is one of its presets. */
function mustKnow(serverId, ids) {
  const profile = packProfiles.profileFor(serverId);
  if (!profile) throw httpError(404, 'This server has no recommended settings profile.');
  const known = new Set(profile.presets.map((p) => p.id));
  if (ids.some((id) => !known.has(id)))
    throw httpError(400, 'One of those settings groups is not part of this profile.');
  return profile;
}

/**
 * Run `work` and answer with its body, backing the server up first when it needs
 * one (see the header). Input is validated by the caller before this, so a bad
 * request still answers 400 instead of failing inside a task.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {any} server
 * @param {boolean} touchesFiles
 * @param {() => Promise<object>} work
 */
async function withBackup(req, res, server, touchesFiles, work) {
  if (!touchesFiles || !packProfiles.needsBackup(server.id)) return res.json(await work());
  const actor = req.user.username;
  const taskId = tasks.run(
    `Applying recommended settings on ${server.display_name}…`,
    { serverId: server.id, actor },
    async (t) => {
      t.step('Backing up the server first…');
      await packProfiles.backupBeforeChange(server.id, { actor, task: t });
      t.step('Applying recommended settings…');
      return work();
    }
  );
  res.status(202).json({ ok: true, taskId });
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
    const server = mustGet(req);
    const { changes } = changesBody.parse(req.body);
    mustKnow(
      server.id,
      changes.map((c) => c.presetId)
    );
    await withBackup(req, res, server, packProfiles.changesTouchFiles(server.id, changes), async () => {
      const { out, ...state } = await packProfiles.savePresets(server.id, changes, { actor: req.user.username });
      return { ok: true, ...applyShape(server, out), ...state };
    });
  })
);

router.post(
  '/review',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    const { enable } = reviewBody.parse(req.body);
    mustKnow(server.id, enable);
    // "Not Now" (nothing enabled) only records the answer.
    await withBackup(req, res, server, enable.length > 0, async () => {
      const { out, ...state } = await packProfiles.review(server.id, enable, { actor: req.user.username });
      return { ok: true, ...applyShape(server, out), ...state };
    });
  })
);

router.post(
  '/replace-file',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    const { presetId, path } = replaceBody.parse(req.body);
    mustKnow(server.id, [presetId]);
    await withBackup(req, res, server, true, async () => {
      const { changedFiles, rebuildNeeded, ...state } = await packProfiles.replaceFile(server.id, presetId, path, {
        actor: req.user.username,
      });
      return {
        ok: true,
        restartNeeded: RUNNING.includes(server.status) && changedFiles.length > 0,
        rebuildNeeded,
        ...state,
      };
    });
  })
);

router.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const server = mustGet(req);
    mustKnow(server.id, []);
    const anyOn = packProfiles.presetsFor(server.id).presets.some((p) => p.enabled);
    await withBackup(req, res, server, anyOn, async () => {
      const out = await packProfiles.apply(server.id, {
        trigger: 'manual',
        actor: req.user.username,
        withSettings: true,
      });
      return { ok: true, ...applyShape(server, out), ...packProfiles.presetsFor(server.id) };
    });
  })
);

router.use(makeJsonErrorHandler('profile'));

module.exports = router;
