# Override behavior spike (issue #4)

A throwaway CI experiment. It checks how `itzg/minecraft-server` treats modpack override files and
user customizations across a restart and a pack upgrade. It uses two tiny fake packs
(`v1.mrpack`, `v2.mrpack`) and `SETUP_ONLY=true`, so the container exits after setup and no
Minecraft server ever runs.

**This branch (`spike/override-behavior`) is not meant to be merged.** Read the results, then delete it.

## Running

CI runs on every push to the branch, or on demand through `workflow_dispatch`. Avoid running it on a
low-memory dev box. Locally it would be:

    spike/override-behavior/make-packs.sh /tmp/packs
    spike/override-behavior/run.sh /tmp/packs /tmp/out

## Reading the results

The job summary and the `summary.md` artifact hold one table per question:

- Q1: after a restart on the same pack, is the user's edit to an override file kept?
- Q2: on upgrade, is the edit overwritten, is `removed-in-v2.toml` deleted, is `fake-mod-1.0.jar`
  replaced by 2.0, and does `hand-added.jar` survive?
- Q3: after the upgrade boot, does each customization mechanism win (`spike.toml` is `custom` and
  `spike.js` is `// custom`)?
- Q4: does the `/config` sync with `COPY_CONFIG_DEST=/data` delete files missing from its source
  (`unrelated.toml`, `canary.txt`)? This is safety-critical.
- Q5: are customization files rewritten on every start (mtime across the restart step)?
- Q6: in the `sync-env-substitution` scenario, are `${CFG_*}` placeholders substituted into a synced
  `.toml` file (live `bridge.toml` has the secret, `${NOT_PREFIXED}` stays literal, and the source
  copy is unchanged)?
- Q7: does the sync preserve the source file's mtime on the destination (`spike.toml` and
  `bridge.toml`, after install1 and after the upgrade)? Both mtimes are printed.

A "NO" is a finding, not a failure. The job fails only on infrastructure problems (container exit
code other than 0, or setup not producing expected files). `results.tsv` is the raw data, and each
step's full container log is in the artifact (`<scenario>/<step>.log`).

The CurseForge scenarios are best-effort and run only when the `CF_API_KEY` secret exists.
