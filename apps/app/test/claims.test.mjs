/**
 * Claims guard for the built app.rwally.com page.
 *
 * IT ASSERTS AGAINST dist/, NOT src/, and that is the whole point. The reader
 * receives the build output; a check that reads the source proves the author's
 * intention rather than the deploy's content. So this file runs the build
 * first, then reads what the build produced.
 *
 * WHY THE BANNED SHAPES CAN BE WRITTEN OUT HERE. `.mjs` is not in the
 * `PUBLIC_EXT` set of `scripts/test/claims-lede-truth.test.mjs`, so this file
 * is not itself walked as public prose and enumerating a banned string in order
 * to ban it cannot red the repository guard. That is the same exemption that
 * guard's own header relies on, and it is stated here so nobody moves these
 * strings into a `.json` fixture and discovers the consequence in CI.
 *
 * HOW THIS FILE RUNS, because for its first weeks it did not. It is `npm run
 * test:app` at the repository root, which `.github/workflows/ci.yml` and
 * `scripts/gate.mjs` each invoke as a step of their own, ordered immediately
 * before `npm run test:backend`. `scripts/test/test-wiring-truth.test.mjs`
 * fails if any `*.test.mjs` in the repository stops being covered by a wired
 * script, and fails if either pipeline stops invoking this one -- where
 * "invoking" is read narrowly and on purpose: it searches the value of ci.yml's
 * `run:` keys with comments removed, and gate.mjs's `args:` array literals with
 * comments removed. Deleting a step and leaving its `name:`, its `title:` or
 * the paragraph explaining it behind is therefore caught. What that guard
 * cannot establish is that the step it found is reachable -- an `if:`, a
 * `--quick` skip or a job outside the required set would all still satisfy it.
 * Only a green CI run and a green `npm run gate` show this file executing.
 *
 * IT IS DELIBERATELY NOT A GLOB INSIDE `test:backend`, and the reason is a
 * measured race. The `execFileSync` below is `rm -rf dist` followed by
 * `cp -r src dist`. The repository-wide walks that `test:backend` runs
 * enumerate files first and read them after, and they deliberately do not skip
 * `dist`. Batched into one `node --test` invocation with them, this build
 * deletes a path an unrelated guard has already listed and not yet opened, and
 * that guard throws ENOENT: 1 failure in 25 batched runs, which is the rate
 * that gets dismissed as flakiness rather than diagnosed.
 * `scripts/test/claims-token-absence.test.mjs` carries the same finding at its
 * `apps/app` group, and dropped its own build because of it.
 *
 * WHAT THIS FILE DOES NOT COVER, said plainly rather than left to be inferred:
 *
 *   1. IT IS A SHAPE CHECK, NOT A TRUTH CHECK. It can tell that a banned string
 *      is absent and that a required sentence is present. It cannot tell that a
 *      new sentence is true. The repository guard has the same limit and says
 *      so; no guard here is a proof of absence.
 *
 * The repository guard DOES walk this page once it is built, because `dist` is
 * deliberately not in that file's `SKIP_DIRS` and `.html` is in its
 * `PUBLIC_EXT`. This file is the narrow, page-specific half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(APP, 'dist');

// Build before asserting. The output is gitignored, so on a fresh checkout it
// does not exist, and a test that skipped on a missing dist would go green in
// exactly the case it is here to catch.
execFileSync(process.execPath, [path.join(APP, 'build.mjs')], { stdio: 'pipe' });

const read = (rel) => readFileSync(path.join(DIST, rel), 'utf8');

const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';

// The empty state, exactly as it must read. Whitespace is collapsed on both
// sides so a hard wrap in the markup does not break the match.
//
// IT USED TO PIN A COUNT, AND THE COUNT WENT STALE WITHOUT ANYTHING GOING RED.
// The pinned sentence was "No vaults have been created yet. vaultCount() reads
// 0 on chain 4663." That became false when vault #1 was created, and falser
// again at vault #2, while this guard stayed green the whole time: it is a
// static string match against the built HTML and reads no chain, so it can
// only tell you the sentence is PRESENT, never that it is TRUE.
//
// The replacement is a claim about this table rather than about the chain. No
// createVault call can falsify "this table lists no vaults"; only writing the
// row-rendering code can, and whoever writes it will be editing this line
// anyway. That is the property to preserve when changing this string: pin
// something the deployment controls, not something the world does.
const EMPTY_STATE = 'This table lists no vaults. vaultCount() above is read live from chain 4663 and is the count that matters.';

const flat = (s) => s.replace(/\s+/g, ' ');

/**
 * The banned shapes.
 *
 * Every one of them is either a claim the owner withdrew, a category of thing
 * this deployment does not have, or a typographic mark the owner rejected.
 * Matched case-insensitively and by shape rather than by one capitalisation.
 */
const BANNED = [
  { name: 'x402', re: /x402/i, why: 'There is no x402 payment surface on this deployment, by owner decision of 2026-09-05.' },
  { name: 'airdrop', re: /\bair\s?drops?\b/i, why: 'No token distribution is promised, designed or scheduled anywhere in this repository.' },
  { name: 'presale', re: /\bpre-?sales?\b/i, why: 'Nothing is for sale on this page and nothing is being raised.' },
  { name: 'coming soon', re: /\bcoming\s+soon\b/i, why: 'A date nobody has committed to. Say what is true today and what reads 0.' },
  { name: 'em-dash', re: /—/, why: 'The owner does not want em-dashes in copy. Use a comma, a colon, or two sentences.' },
];

test('the built page carries the empty-state sentence verbatim', () => {
  const html = flat(read('index.html'));
  assert.ok(
    html.includes(EMPTY_STATE),
    'The empty state is the one sentence this page exists to say, and it must be STATIC MARKUP.\n' +
      'If it is written by app.js from the fetch result then it vanishes whenever the RPC is\n' +
      'unreachable, which is precisely when a reader most needs to be told what is true.\n' +
      `Expected to find: "${EMPTY_STATE}"`,
  );
});

test('the built page names the factory address', () => {
  const html = read('index.html');
  assert.ok(
    html.includes(FACTORY),
    'The empty state points at a live vaultCount() read. A reader who wants to check that number\n' +
      'for themselves needs the address to call it on, on the same page, without leaving to find it.\n' +
      `Expected to find: ${FACTORY}`,
  );
});

test('no banned claim shape survives into the built page', () => {
  const hits = [];
  for (const rel of ['index.html', 'app.css', 'app.js', '_headers']) {
    if (!existsSync(path.join(DIST, rel))) continue;
    const text = flat(read(rel));
    for (const b of BANNED) {
      const m = text.match(b.re);
      if (!m) continue;
      const at = text.indexOf(m[0]);
      hits.push(`  ${rel}: ${b.name} -> "${text.slice(Math.max(0, at - 40), at + 60).trim()}"\n      ${b.why}`);
    }
  }
  assert.deepEqual(hits, [], `Banned shapes in the build output:\n${hits.join('\n')}`);
});

test('the build carries the headers file, so the deploy is not policy-free', () => {
  assert.ok(
    existsSync(path.join(DIST, '_headers')),
    'Cloudflare Pages reads _headers from the root of the served directory. Without it the\n' +
      'deploy serves with no Content-Security-Policy and reports no error of any kind.',
  );
  const headers = read('_headers');
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    'connect-src',
    'https://rpc.mainnet.chain.robinhood.com',
    "img-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
  ]) {
    assert.ok(headers.includes(directive), `_headers is missing: ${directive}`);
  }
});

test('the page has no inline script and no inline style, which the CSP would block', () => {
  const html = read('index.html');
  // An opening <script> with no src is an inline block. <script src=...> is fine.
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>/i.test(html);
  assert.equal(inlineScript, false, "script-src 'self' blocks an inline <script>, silently.");
  assert.equal(/<style[\s>]/i.test(html), false, "style-src 'self' blocks an inline <style> block, silently.");
  assert.equal(/\sstyle="/i.test(html), false, "style-src 'self' blocks a style=\"...\" attribute, silently.");
});

test('the page makes no request to any origin but itself and the chain RPC', () => {
  const html = read('index.html');
  const css = read('app.css');
  const js = read('app.js');

  // Every absolute URL that a browser would FETCH rather than navigate to. An
  // <a href> is navigation and is not covered by connect-src, so hyperlinks to
  // rwally.com, GitHub and the explorer are deliberately not in this net.
  const fetched = [
    ...css.matchAll(/url\(\s*['"]?(https?:\/\/[^'")]+)/gi),
    ...html.matchAll(/<link[^>]+href=["'](https?:\/\/[^"']+)/gi),
    ...html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)/gi),
    ...html.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)/gi),
    ...js.matchAll(/fetch\(\s*['"](https?:\/\/[^'"]+)/gi),
  ].map((m) => m[1]);

  const foreign = fetched.filter((u) => !u.startsWith('https://rpc.mainnet.chain.robinhood.com'));
  assert.deepEqual(
    foreign,
    [],
    'This page loads no third-party asset, and the CSP enforces that. Anything here would be\n' +
      `blocked at the edge with no visible error:\n  ${foreign.join('\n  ')}`,
  );
});
