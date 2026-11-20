'use strict';

// Live UI check: renders panel pages in a real headless Chromium against a
// THROWAWAY panel, then reports console/page errors, horizontal overflow, and
// writes screenshots at desktop (1280x900) and phone (390x844) widths. View
// tests only see server HTML; this catches client-JS crashes and layout breaks.
//
// Usage:
//   pnpm run ui:shots [-- flags]
//   node scripts/ui-shots.js [flags]
//
// Flags:
//   --path <p>        Page to check, repeatable. Default: / , /servers/:first , /settings
//                     ":first" / ":second" become the seeded server ids.
//                     "path@selector" also checks that element's width and screenshots just
//                     it, e.g. --path '/servers/:first@#domains-card'
//   --selector <s>    Selector applied to every --path that has no "@selector" of its own.
//   --seed <file.js>  CommonJS module exporting async ({ dataDir, serverIds }) => void. It runs
//                     in a child node process (cwd = repo root, DATA_DIR set) before the first
//                     page load, so it can require('./src/db') to insert rows.
//   --servers <n>     Fake servers to seed (default 2).
//   --out <dir>       Screenshot dir (default <tmp>/msm-ui-shots-<timestamp>).
//   --widths <list>   Comma list of desktop,phone (default both).
//   --base <url>      Use an existing panel instead of a throwaway one (no seeding).
//   --user/--pass     Login for --base (or QA_USER / QA_PASS).
//   --keep            Leave the throwaway panel running and its data dir in place.
//
// Browser: CHROME_PATH, else playwright-core's own, else any cached Chromium
// headless shell. Install one with:
//   pnpm exec playwright-core install chromium-headless-shell
//
// The panel serves public/dist when it exists, else raw public/js, so after
// client edits run `pnpm run build` (or delete public/dist) before checking.
//
// Exit code is 1 if any page logged an error or overflowed horizontally.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

const WIDTHS = {
  desktop: { width: 1280, height: 900 },
  phone: { width: 390, height: 844 },
};
const USER = 'uishots';
const PASS = 'ui-shots-pass-123';

function parseArgs(argv) {
  const opts = { paths: [], servers: 2, widths: ['desktop', 'phone'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${a}.`);
      return argv[++i];
    };
    if (a === '--path') opts.paths.push(val());
    else if (a === '--selector') opts.selector = val();
    else if (a === '--seed') opts.seed = path.resolve(val());
    else if (a === '--servers') opts.servers = Math.max(1, Math.min(50, Number(val()) || 2));
    else if (a === '--out') opts.out = path.resolve(val());
    else if (a === '--base') opts.base = val().replace(/\/+$/, '');
    else if (a === '--user') opts.user = val();
    else if (a === '--pass') opts.pass = val();
    else if (a === '--keep') opts.keep = true;
    else if (a === '--widths')
      opts.widths = val()
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
    else fail(`Unknown flag ${a}. See the header of scripts/ui-shots.js.`);
  }
  for (const w of opts.widths) if (!WIDTHS[w]) fail(`Unknown width "${w}". Use desktop and/or phone.`);
  if (!opts.paths.length) opts.paths = ['/', '/servers/:first', '/settings'];
  return opts;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run JS in a child node process rooted at the repo with the throwaway DATA_DIR. */
function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

async function waitForPanel(base, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The panel process exited before it was ready.');
    try {
      const res = await fetch(`${base}/login`, { redirect: 'manual' });
      if (res.status === 200 || res.status === 302) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error('The panel did not become ready within 45 seconds.');
}

function killPanel(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) child.kill();
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Find a cached chrome-headless-shell binary, newest install first. */
function findCachedChrome() {
  const bases = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) bases.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  bases.push(
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  );
  if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  const binName = isWin ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const find = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === binName) return path.join(dir, e.name);
    }
    if (depth === 0) return null;
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = find(path.join(dir, e.name), depth - 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const base of bases) {
    let dirs;
    try {
      dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-'));
    } catch {
      continue;
    }
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const hit = find(path.join(base, d), 2);
      if (hit) return hit;
    }
  }
  return null;
}

async function launchBrowser() {
  const { chromium } = require('playwright-core');
  const attempts = [];
  if (process.env.CHROME_PATH) attempts.push(() => chromium.launch({ executablePath: process.env.CHROME_PATH }));
  attempts.push(() => chromium.launch());
  attempts.push(() => {
    const exe = findCachedChrome();
    if (!exe) throw new Error('No cached headless shell found.');
    return chromium.launch({ executablePath: exe });
  });
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      // try the next strategy
    }
  }
  throw new Error(
    'Could not launch a browser. Run `pnpm exec playwright-core install chromium-headless-shell` or set CHROME_PATH to a Chromium binary.'
  );
}

async function login(context, base, user, pass) {
  const req = context.request;
  const setup = await req.post(`${base}/setup`, {
    data: { username: user, password: pass },
    headers: { Accept: 'application/json' },
    failOnStatusCode: false,
  });
  if (setup.ok()) return;
  const res = await req.post(`${base}/login`, {
    form: { username: user, password: pass },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (res.status() !== 302 && res.status() !== 200) {
    throw new Error(`Login failed with status ${res.status()}. Check the credentials.`);
  }
  const cookies = await context.cookies();
  if (!cookies.length) throw new Error('Login did not set a session cookie. Check the credentials.');
}

function slugify(p) {
  const s = p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'home';
}

async function checkPage(browser, base, user, pass, spec, widthName, outDir) {
  const { width, height } = WIDTHS[widthName];
  const context = await browser.newContext({ viewport: { width, height } });
  const result = { page: spec.label, width: widthName, errors: [], overflow: false, shot: null };
  try {
    await login(context, base, user, pass);
    const page = await context.newPage();
    page.on('pageerror', (err) => result.errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      const url = msg.location().url || '';
      if (/favicon/i.test(url) || /favicon/i.test(text)) return;
      result.errors.push(`console: ${text}`);
    });
    await page.goto(base + spec.path, { waitUntil: 'networkidle' });
    const docOverflow = await page.evaluate('document.documentElement.scrollWidth > window.innerWidth');
    let elOverflow = false;
    let target = null;
    if (spec.selector) {
      target = page.locator(spec.selector).first();
      const box = await target.boundingBox().catch(() => null);
      if (!box) result.errors.push(`selector: ${spec.selector} was not found or not visible.`);
      else elOverflow = box.width > width;
    }
    result.overflow = docOverflow || elOverflow;
    const file = path.join(outDir, `${slugify(spec.label)}-${widthName}.png`);
    if (target && !result.errors.some((e) => e.startsWith('selector:'))) await target.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    result.shot = file;
  } catch (err) {
    result.errors.push(`script: ${err.message}`);
  } finally {
    await context.close();
  }
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out || path.join(os.tmpdir(), `msm-ui-shots-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  let panel = null;
  let dataDir = null;
  let base = opts.base;
  let user = opts.user || process.env.QA_USER;
  let pass = opts.pass || process.env.QA_PASS;
  let serverIds = [];
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (opts.keep) return;
    killPanel(panel);
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    if (!base) {
      user = USER;
      pass = PASS;
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-ui-shots-data-'));
      const dataPath = path.join(dataDir, 'data');
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const env = { DATA_DIR: dataPath };
      panel = spawn(process.execPath, ['src/server.js'], {
        cwd: root,
        env: { ...process.env, ...env, PANEL_PORT: String(port), PANEL_HOST: '127.0.0.1' },
        stdio: 'ignore',
        detached: !isWin,
      });
      await waitForPanel(base, panel);

      const seeded = runNode(['scripts/seed-fake-servers.js', String(opts.servers)], env);
      if (seeded.status !== 0) throw new Error(`Seeding fake servers failed.\n${seeded.stderr || seeded.stdout}`);
      const ids = runNode(
        [
          '-e',
          "const db=require('./src/db');console.log(JSON.stringify(db.all('SELECT id FROM servers WHERE deleted_at IS NULL ORDER BY created_at, id').map((r)=>r.id)))",
        ],
        env
      );
      if (ids.status !== 0) throw new Error(`Reading server ids failed.\n${ids.stderr}`);
      serverIds = JSON.parse(ids.stdout.trim().split('\n').pop());

      if (opts.seed) {
        const code =
          'const m=require(process.argv[1]);const f=typeof m==="function"?m:m.default;' +
          'Promise.resolve(f({dataDir:process.env.DATA_DIR,serverIds:JSON.parse(process.argv[2])}))' +
          '.then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1)})';
        const res = runNode(['-e', code, opts.seed, JSON.stringify(serverIds)], env);
        if (res.status !== 0) throw new Error(`The seed module failed.\n${res.stderr || res.stdout}`);
      }
    } else {
      if (!user || !pass) fail('Pass --user and --pass (or set QA_USER and QA_PASS) when using --base.');
    }

    const served = fs.existsSync(path.join(root, 'public', 'dist', 'js'))
      ? 'public/dist/js (built bundle)'
      : 'public/js (raw source)';
    console.log(`Client JS served from ${served}. Panel: ${base}`);
    if (opts.base) console.log('Note: --base means the panel serves whatever build it was started with.');

    const specs = opts.paths.map((raw) => {
      const at = raw.indexOf('@');
      const rawPath = at === -1 ? raw : raw.slice(0, at);
      const selector = at === -1 ? opts.selector : raw.slice(at + 1);
      const resolved = rawPath
        .replace(/:first/g, serverIds[0] || 'missing')
        .replace(/:second/g, serverIds[1] || serverIds[0] || 'missing');
      return { path: resolved, label: resolved, selector };
    });

    const browser = await launchBrowser();
    const results = [];
    try {
      for (const spec of specs) {
        for (const w of opts.widths) results.push(await checkPage(browser, base, user, pass, spec, w, outDir));
      }
    } finally {
      await browser.close();
    }

    console.log('\n' + 'Page'.padEnd(41) + 'Width'.padEnd(10) + 'Errors'.padEnd(8) + 'Overflow');
    for (const r of results) {
      console.log(
        r.page.padEnd(41) +
          ' ' +
          r.width.padEnd(9) +
          ' ' +
          String(r.errors.length).padEnd(7) +
          ' ' +
          (r.overflow ? 'YES' : 'no')
      );
    }
    for (const r of results) {
      for (const e of r.errors) console.log(`\n[${r.page} @ ${r.width}] ${e}`);
    }
    console.log(`\nScreenshots: ${outDir}`);
    for (const r of results) if (r.shot) console.log(`  ${r.shot}`);

    if (opts.keep && panel) {
      console.log(`\nPanel left running at ${base} (login ${user} / ${pass}). Data dir: ${dataDir}`);
      console.log(`Stop it with: kill -- -${panel.pid}   then remove ${dataDir}`);
      panel.unref();
    }

    const bad = results.some((r) => r.errors.length || r.overflow);
    cleanup();
    process.exit(bad ? 1 : 0);
  } catch (err) {
    console.error(err.message);
    cleanup();
    process.exit(2);
  }
}

main();
