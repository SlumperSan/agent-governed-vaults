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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  for (const d of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src']) {
    assert.equal(directives.get(d), "'self'", `${d} is not exactly 'self'`);
  }
  for (const d of ['object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
    assert.equal(directives.get(d), "'none'", `${d} is not 'none'`);
  }
  // Absent by design: each falls back to default-src 'none'. See _headers for why.
  for (const d of ['media-src', 'worker-src']) {
    assert.ok(!directives.has(d), `${d} was added without the element that needs it`);
  }
  const whole = csp[1];
  for (const token of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', '*']) {
    assert.ok(!whole.includes(token), `the policy was widened with ${token}`);
  }
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
