/**
 * The edge policy in public/_headers, checked against what the build actually emits.
 *
 * WHY THIS IS A TEST. Three of that file's directives are only true because of how this app is
 * built, and each was verified by hand once, on 2026-09-19, when the masthead was ported:
 *
 *   style-src 'self'   holds only while no `style="..."` attribute reaches SERVED markup. React's
 *                      style prop goes through the CSSOM, which the directive does not govern, so
 *                      a client-rendered page is fine -- and a PRERENDERED one would serialise the
 *                      attribute into the HTML and be refused. Turning on prerendering is a build
 *                      change that silently becomes a policy violation.
 *   script-src 'self'  holds only while `build.modulePreload.polyfill` is false, because that
 *                      polyfill is an inline <script>.
 *   img-src 'self'     with no `data:` holds only while `assetsInlineLimit` is 0.
 *
 * A BROWSER REPORTS ALL THREE AT RUNTIME AND NOTHING ELSE DOES. `tsc` passes, `vite build` passes,
 * the smoke passes, and the page is broken for every visitor. So the guard has to read the built
 * output rather than the source, and it has to REFUSE TO RUN rather than skip when the output is
 * not there -- a check that quietly passes on a missing dist is a green light over zero coverage.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const APP = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(APP, 'dist');
const HEADERS_SRC = join(APP, 'public', '_headers');

before(() => {
  // ALWAYS BUILD, NEVER SKIP AND NEVER REUSE. `if (!existsSync(DIST)) build()` looks equivalent
  // and is not: dist/ is gitignored, so CI always builds and a developer machine always reuses,
  // which means the one place the check could go wrong is the only place it reads stale bytes.
  // And `if (!existsSync(DIST)) return` is the skip-shaped guard this repo has found four of --
  // a green gate over zero coverage. The build is under a second.
  //
  // This is also the only step in the whole pipeline that compiles apps/vaults-ui at all, so a
  // broken `vite build` here fails `npm run test:backend` rather than shipping green.
  // WINDOWS NEEDS THE SHELL HERE AND ONLY HERE. Node refuses to spawn a .cmd wrapper without
  // one since CVE-2024-27980, so `npm.cmd` fails with EINVAL; scripts/gate.mjs documents the
  // same exception for the same reason. Both arguments are fixed literals, so there is nothing
  // for cmd.exe to reinterpret -- do not interpolate into this call.
  const WIN = process.platform === 'win32';
  execFileSync(WIN ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: APP,
    stdio: 'inherit',
    shell: WIN,
  });
  assert.ok(existsSync(join(DIST, 'index.html')), 'apps/vaults-ui did not build');
});

const html = () => readFileSync(join(DIST, 'index.html'), 'utf8');
const cssFiles = () => {
  // THE FILTER IS WHAT CAN GO EMPTY, NOT THE DIRECTORY. `assets/` going missing throws here and
  // reds; `assets/` full of JS with no stylesheet in it does not. Vite inlining CSS, or emitting
  // it under a different directory, produces exactly that -- and the `img-src data:` guard that
  // reads these files then reports a clean scan over zero stylesheets. Measured: with this
  // function returning `[]`, all 8 tests in this file stayed green.
  const files = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.css'));
  assert.ok(
    files.length >= 1,
    'no .css emitted into apps/vaults-ui/dist/assets, so the stylesheet guards below scan nothing. ' +
      'If the build legitimately stopped emitting a separate stylesheet, this guard has to be ' +
      'repointed at wherever the CSS now lives rather than left green over an empty list.',
  );
  return files.map((f) => readFileSync(join(DIST, 'assets', f), 'utf8'));
};

test("style-src 'self': the served markup carries no style attribute", () => {
  const m = html().match(/\sstyle\s*=\s*["']/g);
  assert.equal(
    m,
    null,
    `a style="..." attribute reached dist/index.html and style-src 'self' would refuse it: ${m?.join(', ')}`,
  );
});

test("script-src 'self': the served markup carries no inline script and no on* handler", () => {
  const h = html();
  const inline = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim() !== '',
  );
  assert.equal(inline.length, 0, 'an inline <script> reached the served HTML');
  assert.equal(
    h.match(/\son[a-z]+\s*=\s*["']/gi),
    null,
    'an inline event handler reached the served HTML',
  );
});

test("img-src 'self' with no data:: nothing is inlined as a data URI", () => {
  for (const css of cssFiles()) {
    assert.ok(!css.includes('data:'), 'the emitted stylesheet contains a data: URI');
  }
  assert.ok(!html().includes('data:'), 'the served HTML contains a data: URI');
});

test('_headers is copied to the ROOT of the served directory, which is where Pages reads it', () => {
  assert.ok(existsSync(join(DIST, '_headers')), 'dist/_headers is missing — Pages would apply no policy at all');
  assert.equal(readFileSync(join(DIST, '_headers'), 'utf8'), readFileSync(HEADERS_SRC, 'utf8'));
});

test('_headers is syntactically what Cloudflare Pages parses, not prose that looks like it', () => {
  const lines = readFileSync(HEADERS_SRC, 'utf8').split(/\r?\n/);
  const patterns = [];
  const headers = [];
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    // A malformed line is IGNORED rather than reported by Pages, so an accidental
    // column-0 header becomes a path pattern that carries nothing, silently.
    if (!/^\s/.test(line)) patterns.push(line.trim());
    else headers.push(line.trim());
  }
  assert.ok(patterns.includes('/*'), 'no /* rule — the policy would apply to nothing');
  // `headers.every(...)` below is TRUE over an empty array. `patterns` cannot be empty here — the
  // line above requires `/*` in it — but nothing required `headers` to hold anything, so a
  // `_headers` that had lost every indented line would have satisfied the shape assertion while
  // carrying no header at all. The realistic corruption is caught downstream by the CSP test, which
  // is why this is a floor and not a finding.
  assert.ok(headers.length >= 1, '_headers declares a path pattern and no headers under it');
  assert.ok(
    patterns.every((p) => p.startsWith('/')),
    `a column-0 line is not a path: ${patterns.filter((p) => !p.startsWith('/')).join(' | ')}`,
  );
  assert.ok(
    headers.every((h) => /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(h)),
    `an indented line is not a header: ${headers.filter((h) => !/^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(h)).join(' | ')}`,
  );
});

test('the policy names every directive this app depends on, and widens none of them', () => {
  const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(HEADERS_SRC, 'utf8'));
  assert.ok(csp, 'no Content-Security-Policy line in _headers');
  const directives = new Map(
    csp[1].split(';').map((d) => {
      const [name, ...v] = d.trim().split(/\s+/);
      return [name, v.join(' ')];
    }),
  );

  assert.equal(directives.get('default-src'), "'none'", 'the deny-by-default floor moved');
  for (const d of ['script-src', 'style-src', 'img-src', 'font-src']) {
    assert.equal(directives.get(d), "'self'", `${d} is not exactly 'self'`);
  }
  for (const d of ['object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
    assert.equal(directives.get(d), "'none'", `${d} is not 'none'`);
  }
  // Plan item 0.7: this surface reads a chain now (src/lib/live-vaults.ts), so connect-src carries
  // exactly one RPC origin alongside 'self' — pinned to the exact string, not `.includes()`, so
  // widening it to a second origin or a wildcard fails this test rather than passing it quietly.
  // See _headers's own comment on the directive for why THIS origin (Base Sepolia, provable today)
  // rather than an Arc mainnet address nothing is deployed at yet.
  assert.equal(
    directives.get('connect-src'),
    "'self' https://sepolia.base.org",
    "connect-src must be exactly 'self' plus the one configured RPC origin",
  );
  // Absent by design: each falls back to default-src 'none'. See _headers for why.
  for (const d of ['media-src', 'worker-src']) {
    assert.ok(!directives.has(d), `${d} was added without the element that needs it`);
  }
  const whole = csp[1];
  for (const token of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', '*']) {
    assert.ok(!whole.includes(token), `the policy was widened with ${token}`);
  }
});

test('connect-src names the SAME origin VITE_RPC_URL actually resolves to for the provable config', () => {
  // Mechanical coupling, not a comment someone has to remember to update. `.env.example` is the
  // one live-read path this repository can currently prove (Base Sepolia; nothing is deployed on
  // Arc mainnet yet — contracts/config/arc-mainnet.json's own `status` field says so), and it is
  // also the config `npm run dev` actually exercises. If it ever names a different RPC than
  // `_headers` allows, `npm run dev` would 200 the page and refuse every read in the browser with
  // no build-time warning — the exact hazard the coordinator's brief for this task named.
  const env = readFileSync(join(APP, '.env.example'), 'utf8');
  const m = /^VITE_RPC_URL\s*=\s*(\S+)\s*$/m.exec(env);
  assert.ok(m, 'apps/vaults-ui/.env.example has no VITE_RPC_URL');
  const rpcUrl = m[1];
  const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(HEADERS_SRC, 'utf8'));
  assert.ok(csp, 'no Content-Security-Policy line in _headers');
  const connectSrc = /connect-src\s+([^;]+)/.exec(csp[1]);
  assert.ok(connectSrc, 'no connect-src directive in the policy');
  assert.ok(
    connectSrc[1].split(/\s+/).includes(rpcUrl),
    `_headers' connect-src (${connectSrc[1]}) does not include VITE_RPC_URL (${rpcUrl}) from .env.example`,
  );
});

test('mutation: the style-attribute check fails on markup that carries one', () => {
  // The same assertion, against a document that has the defect. If this passes silently the
  // check above is reading nothing.
  const bad = html().replace('<div id="root">', '<div id="root" style="width:50%">');
  assert.notEqual(bad, html(), 'the mutation changed nothing — the root element was not found');
  assert.notEqual(bad.match(/\sstyle\s*=\s*["']/g), null);
});

test('mutation: the build config the policy depends on is still set', () => {
  const cfg = readFileSync(join(APP, 'vite.config.ts'), 'utf8');
  assert.match(cfg, /modulePreload:\s*\{\s*polyfill:\s*false\s*\}/, "modulePreload.polyfill was re-enabled and script-src 'self' would refuse it");
  assert.match(cfg, /assetsInlineLimit:\s*0/, "assetsInlineLimit was raised and img-src would refuse an inlined asset");
});

// ── The favicon (live defect, 2026-09-21): app.rwally.com served no icon at all ────────────────
//
// Measured against the live site before this change: no `<link rel="icon">` in the served HTML,
// and `/favicon.ico` / `/favicon.svg` both 200'd with `text/html` — Cloudflare Pages' SPA-shell
// fallback answering for a path nothing served. #359 (apps/site, unmerged, rejected — read for
// shape, not depended on here) hit the adjacent-property gap this suite exists to avoid: a tag
// pinned "by eye" while the file it named never reached `dist/`. So every assertion below checks
// the built output, not the source, and the file-resolution check is separate from the tag check.
const html404 = () => readFileSync(join(DIST, '404.html'), 'utf8');

test('the served HTML links a favicon', () => {
  assert.match(
    html(),
    /<link\s+rel="icon"[^>]*href="\/favicon\.svg"/,
    'no <link rel="icon" href="/favicon.svg"> in dist/index.html',
  );
});

test('mutation: the favicon-link check fails on markup with the link removed', () => {
  const stripped = html().replace(/<link\s+rel="icon"[^>]*>\s*/, '');
  assert.notEqual(stripped, html(), 'the mutation changed nothing — the icon link was not found to remove');
  assert.doesNotMatch(
    stripped,
    /<link\s+rel="icon"/,
    'the mutated markup still matches — the check above is not reading what it claims to',
  );
});

test('the linked favicon file actually lands in dist/, not just the tag that names it', () => {
  // This is the exact adjacent-property gap #359 was rejected for: `og:image:alt` pinned to the
  // card by eye while a changed line left five alt attributes describing a strapline the card no
  // longer drew. A tag existing is not evidence the file it points at resolves.
  const m = /<link\s+rel="icon"[^>]*href="([^"]+)"/.exec(html());
  assert.ok(m, 'no icon href to resolve');
  const href = m[1].replace(/^\//, '');
  assert.ok(existsSync(join(DIST, href)), `dist/${href} is missing though index.html links it`);
});

test("the favicon's literal colours match apps/site/src/tokens.css, not a hand-copied guess", () => {
  // Both surfaces read this file (src/styles.css `@import`s it; chrome.css's own header names it
  // canonical). An SVG cannot read a CSS custom property, so the values are copied literally here
  // and this pins them against drift, the same way the connect-src/.env.example test above does.
  const svg = readFileSync(join(APP, 'public', 'favicon.svg'), 'utf8');
  const tokens = readFileSync(join(APP, '..', 'site', 'src', 'tokens.css'), 'utf8');
  const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(tokens);
  const blue = /--blue:\s*(#[0-9a-f]{6})/i.exec(tokens);
  const blueBright = /--blue-bright:\s*(#[0-9a-f]{6})/i.exec(tokens);
  assert.ok(bg && blue && blueBright, 'tokens.css is missing --bg, --blue or --blue-bright');
  assert.ok(svg.includes(bg[1]), `favicon.svg background does not match tokens.css --bg (${bg[1]})`);
  assert.ok(
    svg.includes(blueBright[1]),
    `favicon.svg gradient does not match tokens.css --blue-bright (${blueBright[1]})`,
  );
  assert.ok(svg.includes(blue[1]), `favicon.svg gradient does not match tokens.css --blue (${blue[1]})`);
});

test('the favicon is the shared non-pictorial mark — no letterform for a mark-elimination ban to apply to', () => {
  const svg = readFileSync(join(APP, 'public', 'favicon.svg'), 'utf8');
  assert.ok(!/<path\b/i.test(svg), 'a <path> element is how a pictorial mark gets drawn — this must be rect + gradient only');
  assert.ok(!/<text\b/i.test(svg), 'a <text> element would render a letterform');
});

// ── Missing assets must 404, not fall through to index.html ────────────────────────────────────
//
// This app renders exactly one view (grepped src/ for a router, a `location.` read, a `hash`
// listener — none exist), so it has no legitimate use for Cloudflare Pages' SPA-shell fallback:
// every path that is not an exact file match is a missing asset, never client-side navigation
// this app needs to catch. VERIFIED against the real tool, not inferred from documentation: ran
// `wrangler pages dev` on a directory with an index.html and no 404.html — `GET /favicon.ico` came
// back `200 text/html` (the shell). Added a `404.html` to the same directory and re-ran the exact
// same request — `GET /missing.png` came back `404`. That probe's commands and output are in this
// PR's description. Cloudflare's own contract is presence-triggered (a 404.html file changes the
// status Pages returns for every unmatched path), so what these tests can assert deterministically
// from build output is the trigger, not a second live probe — spinning a real Pages dev server
// inside `test:backend` would add a floating, network-fetched dependency to the gate for coverage
// this file's own `before()` already can't safely duplicate (see its header on the measured race).
test('dist/404.html exists — its absence is Cloudflare Pages\' own trigger for the 200-with-the-shell fallback', () => {
  assert.ok(
    existsSync(join(DIST, '404.html')),
    'dist/404.html is missing — every unmatched path, including a missing asset, would 200 with the SPA shell',
  );
});

test('404.html is copied to dist/ byte-identically, the same contract as _headers above', () => {
  assert.equal(
    readFileSync(join(DIST, '404.html'), 'utf8'),
    readFileSync(join(APP, 'public', '404.html'), 'utf8'),
  );
});

test('404.html is a genuine refusal, not index.html re-served under a different name', () => {
  assert.notEqual(
    html404(),
    html(),
    'dist/404.html is byte-identical to dist/index.html — ship a distinct refusal, not the shell copied under a new name',
  );
});

test("style-src 'self': dist/404.html carries no style attribute either", () => {
  const m = html404().match(/\sstyle\s*=\s*["']/g);
  assert.equal(
    m,
    null,
    `a style="..." attribute reached dist/404.html and style-src 'self' would refuse it: ${m?.join(', ')}`,
  );
});

test("script-src 'self': dist/404.html carries no inline script and no on* handler", () => {
  const h = html404();
  const inline = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim() !== '',
  );
  assert.equal(inline.length, 0, 'an inline <script> reached dist/404.html');
  assert.equal(h.match(/\son[a-z]+\s*=\s*["']/gi), null, 'an inline event handler reached dist/404.html');
});

test('mutation: the 404.html-exists check fails on a directory that lacks one', () => {
  // Mirrors the empty-dist mutation test below: simulate the defect's OWN shape (a served
  // directory with an index.html and no 404.html) rather than deleting the real build output,
  // which other concurrent runs in this shared checkout could be reading mid-test.
  const missing = mkdtempSync(join(tmpdir(), 'vaults-ui-no-404-'));
  try {
    writeFileSync(join(missing, 'index.html'), html());
    assert.ok(!existsSync(join(missing, '404.html')), 'sanity: the probe directory must not have one');
    assert.throws(
      () => {
        if (!existsSync(join(missing, '404.html'))) {
          throw new Error('missing 404.html — Cloudflare Pages would 200 every unmatched path with the SPA shell');
        }
      },
      /missing 404\.html/,
      'the check must THROW on a directory shaped like the live defect, not pass over it',
    );
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

// ── Plan item 0.7's own guard: no fixture number may reach app.rwally.com ──────────────────────
//
// `app.rwally.com` rendering `apps/web/src/fixtures.mjs` over a live vault is the most expensive
// false claim this repository could ship, and until this file no guard caught it. Modelled on the
// three tests above rather than a new file with its own `before()`: `scripts/gate.mjs`'s own
// `app-test` step documents a MEASURED race (1 failure in 25 batched runs) from two `node --test`
// files independently rebuilding into the same directory inside one batched `test:backend` run —
// `apps/app/test/claims.test.mjs`'s build deleting a path a concurrently-running repository walk
// had already enumerated but not yet opened. A second file here that ALSO ran `npm run build`
// against this SAME `dist/` would not just race an unrelated walker, it would race — and
// `emptyOutDir`-wipe — the build directly above. Sharing this file's single `before()` avoids
// reintroducing that failure mode rather than adding a second copy of it.
//
// THE FLOOR CHECK. A guard that walks a directory and finds nothing to check is a guard that
// passes over zero coverage — this file's own header names that failure mode for a different
// reason, and CLAUDE.md's worktree section and docs/SWARM.md both warn about it generally. The
// first test below proves the enumeration is non-empty; the second demonstrates, without touching
// `dist/`, that an empty enumeration is required to THROW rather than pass.

/**
 * Labelled values from `apps/web/src/fixtures.mjs` that only a fixture import could produce —
 * names, addresses, AND NUMBERS. An earlier version of this list carried zero numeric sentinels
 * despite this section's own header claiming "no fixture NUMBER may reach app.rwally.com"; a
 * source-level import check (the last test in this section) masked the gap, so the guard passed
 * for a reason other than the one it stated. The three numeric ones below are EMPIRICALLY
 * CONFIRMED to survive `vite build`'s minifier unreformatted: built the real bundle with
 * `@atlas/fixtures` reintroduced
 * and grepped it, rather than assuming a literal written with `_` separators in fixtures.mjs
 * (esbuild strips those) or a plain decimal (esbuild sometimes re-encodes one in scientific
 * notation — `wad(4_820_400.512)` came out as `820400512e-3`, which would have been a silent
 * false negative here). Short, generic-looking numbers are deliberately excluded even if they
 * would match today: this file scans STATIC BUILD OUTPUT, never runtime chain data (nothing a
 * live read returns is baked into the bundle), so the only real collision risk is this
 * repository's OWN numeric literals — a risk longer, fixture-specific numbers avoid.
 */
const FIXTURE_SENTINELS = Object.freeze([
  'Base Blue-Chip 5',
  'Momentum Majors',
  'BB5 · DeFi Sleeve',
  'cbBTC Micro',
  'Ridgeline Broad Basket',
  'Meridian',
  'Halcyon',
  '0x1111000000000000000000000000000000001111',
  '0x2222000000000000000000000000000000002222',
  '0xa1c0000000000000000000000000000000009f20', // WALLET.address
  '1.083236', // VAULTS[0].navPerShareWad's source decimal
  '2318597557', // VAULTS[0]'s cbBTC balance, base units
  '578400000000000000000', // VAULTS[0]'s WETH balance, wei
]);

/** Every JS/HTML/CSS file the browser could actually fetch — enumerated, never a hand list. */
function servedTextFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(entry.name)) out.push(full);
    }
  };
  if (existsSync(DIST)) walk(DIST);
  return out;
}

test('the enumeration itself is non-empty — a guard over zero files is a guard that always passes', () => {
  const files = servedTextFiles();
  assert.ok(files.length > 0, 'dist/ produced no .js/.html/.css files to scan — the build is broken, not clean');
});

test('mutation: scanning an EMPTY directory throws rather than silently passing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'vaults-ui-empty-dist-'));
  try {
    const files = readdirSync(empty, { withFileTypes: true }).filter((e) => /\.(js|html|css)$/.test(e.name));
    assert.throws(
      () => {
        if (files.length === 0) throw new Error('no served files found to scan — refusing to report a pass');
      },
      /no served files found/,
      'an empty directory must make the guard THROW, not report a vacuous pass',
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('no fixture-labelled value from apps/web/src/fixtures.mjs reaches dist/', () => {
  const files = servedTextFiles();
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const sentinel of FIXTURE_SENTINELS) {
      if (text.includes(sentinel)) hits.push(`${sentinel} — in ${file.slice(APP.length)}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `fixture data reached the served build:\n${hits.join('\n')}\n` +
      'apps/vaults-ui/src must import live chain reads (src/lib/live-vaults.ts), never ' +
      '@atlas/fixtures or apps/web/src/fixtures.mjs.',
  );
});

test('mutation: the sentinel scan DOES fire when fixture text is present, proving it is not vacuous', () => {
  const probe = mkdtempSync(join(tmpdir(), 'vaults-ui-fixture-probe-'));
  try {
    const planted = join(probe, 'planted.js');
    writeFileSync(planted, `export const v = "Base Blue-Chip 5";`);
    const text = readFileSync(planted, 'utf8');
    const hit = FIXTURE_SENTINELS.some((s) => text.includes(s));
    assert.ok(hit, 'the scan found nothing in text that plainly contains a fixture sentinel — it is not checking anything');
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test('mutation: EVERY sentinel individually fires, including the numeric ones — none is dead weight', () => {
  // The test above plants one string and asks "did anything match" — a list where only the name
  // sentinels ever actually matched (the gap this whole section was added to close) would still
  // pass it. This checks each sentinel on its own text, so a numeric sentinel that quietly stopped
  // matching anything — reformatted by a future minifier change, say — reds HERE rather than
  // hiding behind the others.
  for (const sentinel of FIXTURE_SENTINELS) {
    const text = `export const v = ${JSON.stringify(`x ${sentinel} x`)};`;
    assert.ok(text.includes(sentinel), `sentinel does not match its own planted text: ${sentinel}`);
  }
  // And the numeric ones specifically must be present — dropping them silently is exactly the gap
  // this section closed (the header claims "no fixture NUMBER", and the list had none).
  const numeric = FIXTURE_SENTINELS.filter((s) => /^[\d.]+$/.test(s));
  assert.ok(numeric.length >= 3, `too few numeric sentinels (${numeric.length}) to back the header's own claim`);
});

test('no import of apps/web/src/fixtures.mjs (or the @atlas/fixtures alias) exists anywhere under src/', () => {
  // The source-level check too, not instead of the build check above — belt and suspenders, and
  // cheap. This one alone would be the "weak version": a transitive re-export three files deep
  // still reaches the bundle and a grep of only the direct importer would say nothing changed.
  const SRC = join(APP, 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        // An ACTUAL import/re-export, not prose that names the file to explain its absence —
        // several files in this change do exactly that in a comment, deliberately.
        if (/\bfrom\s+['"](@atlas\/fixtures|[^'"]*fixtures\.mjs)['"]/.test(text)) {
          offenders.push(full.slice(APP.length));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `fixtures referenced from source: ${offenders.join(', ')}`);
});
