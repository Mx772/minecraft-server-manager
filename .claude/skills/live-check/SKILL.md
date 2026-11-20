---
name: live-check
description: Render panel pages in a real headless browser to catch client-JS errors, horizontal overflow and layout breaks. Use when checking a UI change renders, doing a live check, screenshotting the panel, verifying a page in a browser, or before calling frontend work done.
---

# Live check

View tests only see server HTML. A real render catches what they miss: bundled client JS that throws on
load (TDZ), stray `null` text, and overflow at phone width.

## When to use

Any change under `views/`, `public/js/`, `assets/css/`, or a route that renders a page. Run it before
calling the work done.

## The command

```bash
pnpm run build                     # dist is served when present, so rebuild after client edits
pnpm run ui:shots                  # defaults: /, /servers/:first, /settings at desktop + phone
pnpm run ui:shots -- --path '/servers/:first@#domains-card' --widths phone
```

It boots a throwaway panel (temp `DATA_DIR`, free port), seeds fake servers, creates an admin, renders
each page at 1280x900 and 390x844, prints a table of console errors and overflow, and writes PNGs to
`<tmp>/msm-ui-shots-<timestamp>/`. Flags: `--path` (repeatable, `:first`/`:second` = seeded ids,
`path@selector` checks and screenshots one element), `--selector`, `--seed`, `--servers`, `--out`,
`--widths`, `--base/--user/--pass` (existing panel), `--keep`. The header of `scripts/ui-shots.js` has the details.

Terminal-browser panes do not open inside VS Code's terminal, so this headless script is the default.
If no browser is found: `pnpm exec playwright-core install chromium-headless-shell` or set `CHROME_PATH`.

## Seeding specific data

`--seed file.js` runs a CommonJS module in a child process (cwd = repo root, `DATA_DIR` set) before the
first page load:

```js
// seed.js
module.exports = async ({ dataDir, serverIds }) => {
  const db = require('/abs/path/to/repo/src/db');
  db.run('UPDATE servers SET description = ? WHERE id = ?', 'Long description...', serverIds[0]);
};
```

Use an absolute path to `src/db` when the seed file lives outside the repo.

## Reading results

- Read the PNGs, phone width especially.
- Treat any console error, page error or overflow as a failure (exit code 1), even if the page looks fine.

## Common causes

- TDZ error: module-level init that runs before a later `const` is declared.
- `append(null)` printing a literal "null".
- Grid or flex children missing `min-w-0`, causing overflow.
- A Tailwind class that is not written as a full literal is never emitted. Fix it, then `pnpm run build:css`.
- Stale `public/dist`: rebuild with `pnpm run build` or delete `public/dist` to serve raw `public/js`.

## Cleanup

The script kills the panel and deletes the temp data dir on exit and Ctrl-C. With `--keep` it leaves
both and prints the URL, credentials, and how to stop it.
