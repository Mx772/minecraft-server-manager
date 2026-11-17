# Pack profiles

A pack profile is recommended server setup for one modpack: small, reviewed changes to its mod
config files (fewer mob spawns, a safer chunk-loading limit, and so on). The panel never
applies a preset on its own: it notices that a pack has suggestions and asks. Only presets the user
turns on are applied (config changes every time the server starts and after a pack upgrade;
server settings once, when the user turns the preset on or chooses Apply Now).

Profiles are data, not code. They can only change values in config files.

## Layout

```
pack-profiles/<platform>/<slug>.json
```

`<platform>` is `curseforge`, `modrinth`, `ftb`, or `gtnh`. `<slug>` is the pack's project slug
(for FTB, its numeric id). The file name must match the `slug` inside the file, and the `id` must be
`<platform>/<slug>`. [`schema.json`](schema.json) describes the format for editors; the panel
validates against the same rules at startup and skips (with a logged warning) any profile that fails.

## Writing one

```json
{
  "id": "curseforge/all-the-mods-10",
  "platform": "curseforge",
  "slug": "all-the-mods-10",
  "projectId": "925200",
  "name": "All the Mods 10",
  "versions": ">=8.0 <9",
  "notes": "Written against 8.6.",
  "presets": [
    {
      "id": "no-radiation",
      "title": "Turn Off Radiation",
      "description": "Stops Mekanism radiation from harming players.",
      "why": "Radiation adds server load and surprises new players.",
      "default": false,
      "patches": [
        {
          "file": "config/mekanism/general.toml",
          "ops": [{ "op": "set", "path": ["general", "radiation"], "value": false, "expect": true }]
        }
      ]
    }
  ]
}
```

- `versions` is optional. It compares the pinned pack version name as a dotted number (`8.6`,
  `2.7.4`) with `>=`, `>`, `<=`, `<`, and `=`. Separate terms with spaces; all must hold. A pack
  whose version name is not a plain dotted number only matches profiles with no `versions`.
- `default` only decides whether a preset is pre-ticked in the review prompt. It never turns a
  preset on by itself.
- A preset has `patches` (config file changes), `settings`, or both. `settings` is an object of
  server settings, such as `{ "VIEW_DISTANCE": 8, "ALLOW_FLIGHT": true }`. Only these keys are
  accepted: `VIEW_DISTANCE`, `SIMULATION_DISTANCE`, `ALLOW_FLIGHT`, `MAX_TICK_TIME`, and
  `USE_AIKAR_FLAGS`. Each value is checked against the panel's own limits for that setting.
- Ops: `set` (change one value), `append` (add a list entry), `removeFrom` (remove a list entry).
  `path` is the key path inside the file. Values are strings, numbers, booleans, or lists of those.
- `expect` records the value the author saw. If the file holds something else, the panel holds the
  change back for review instead of overwriting it.
- If the user has their own copy of a file in Customizations, the panel leaves that file alone.

## Rules

- `file` is a relative path under `config/`, `defaultconfigs/`, or `world/serverconfig/` (`world/`
  means the server's active world folder). No `..`, no absolute paths.
- Only `.toml`, `.json`, and `.properties` files. Scripts and code (`kubejs/`, `scripts/`, `.js`,
  `.zs`, `.jar`) are never accepted.
- Do not copy pack authors' files into a profile. Describe the change, not the file.

## House style

Titles are Title Case. Descriptions and `why` are full sentences that end in a period, in plain
language with no jargon. No dashes as sentence breaks.

## Schema

After changing `src/services/packProfiles/schema.js`, run `node scripts/pack-profiles-schema.js` to
regenerate `schema.json`. A test fails if they disagree.
