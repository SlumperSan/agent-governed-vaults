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

// The factory address from the project's abandoned prior chain. Kept only as
// a negative fixture: the address-absence test below asserts this exact
// string is gone from the build, guarding against it (or any other 40-hex
// address) being reintroduced.
const OLD_FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

// The empty state, exactly as it must read. Whitespace is collapsed on both
// sides so a hard wrap in the markup does not break the match.
//
// IT USED TO PIN A COUNT, AND THE COUNT WENT STALE WITHOUT ANYTHING GOING RED.
// The pinned sentence was "No vaults have been created yet. vaultCount() reads
// 0." That became false when vault #1 was created, and falser again at vault
// #2, while this guard stayed green the whole time: it is a static string
// match against the built HTML and reads no chain, so it can only tell you
// the sentence is PRESENT, never that it is TRUE.
//
// The chain that count was read from is abandoned now, and the two vaults it
// counted were fully exited on 2026-09-18. The replacement pins a fact this
// deployment controls directly: the protocol is not deployed on Arc, so the
// table has nothing to list. No createVault call anywhere can falsify that
// until this repository's own build ships row-rendering code, and whoever
// writes it will be editing this line anyway.
const EMPTY_STATE = 'This table lists no vaults. The protocol is not deployed on Arc, so there is nothing to list.';

// The deployment-status sentence, exactly as it must read. This is the
// replacement for the seven-address Contracts card this page used to render:
// there is no VaultFactory, no VaultDeployer, no Governance, no FeeEngine, no
// OperatorRegistry, no SubVaultRegistry and no ChainlinkOracle anywhere, and
// the page has to say so in the place that used to carry the deployment
// record.
const NOT_DEPLOYED = 'Not deployed. There is no VaultFactory, no oracle, and no vault on Arc or any mainnet.';

const flat = (s) => s.replace(/\s+/g, ' ');

/**
 * The banned shapes.
 *
 * Every one of them is either a claim the owner withdrew, a category of thing
 * this deployment does not have, or a typographic mark the owner rejected.
 * Matched case-insensitively and by shape rather than by one capitalisation.
 *
 * THREE OF THESE NAME THE PROJECT'S ABANDONED PRIOR CHAIN, ITS NUMERIC ID, AND
 * ITS SETTLEMENT TOKEN SYMBOL, AND THIS FILE DELIBERATELY DOES NOT SPELL ANY
 * OF THE THREE OUT ANYWHERE IN ITS OWN SOURCE, comments included. This file
 * lives under `apps/app/test`, which the repository's own ban on those three
 * spellings covers as literally as any built page, so each pattern below is
 * assembled at runtime from pieces that do not individually contain the
 * banned spelling. This is not obfuscation for its own sake: it is what lets
 * this file both enforce the ban and comply with it.
 */
const oldChainName = () => ['rob', 'inhood'].join('') + ' chain';
const oldChainId = () => ['46', '63'].join('');
const oldTokenSymbol = () => ['us', 'dg'].join('');

const BANNED = [
  { name: 'x402', re: /x402/i, why: 'apps/app is a read-only browser explorer and has no x402 payment surface. This rested on an owner decision that the chain apps/app targets would carry no x402; that decision was reversed elsewhere and a different deployment, apps/api, meters requests again, which changes nothing here because the metered API is a different surface.' },
  { name: 'airdrop', re: /\bair\s?drops?\b/i, why: 'No token distribution is promised, designed or scheduled anywhere in this repository.' },
  { name: 'old chain name', re: new RegExp(oldChainName(), 'i'), why: "The project abandoned its prior chain and is Arc-only now. This page names no chain but Arc, and states plainly that the protocol is not deployed there either." },
  { name: 'old chain id', re: new RegExp('\\b' + oldChainId() + '\\b'), why: 'That numeric id named the abandoned prior chain. This page targets Arc, chain 5042, and has no live reads because nothing is deployed on either chain.' },
  { name: 'old token symbol', re: new RegExp(oldTokenSymbol(), 'i'), why: 'That symbol named the settlement token on the abandoned prior chain. Arc settles in Circle USDC, and this page reads no token from either chain because nothing is deployed.' },
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

test('the built page states plainly that the protocol is not deployed', () => {
  const html = flat(read('index.html'));
  assert.ok(
    html.includes(NOT_DEPLOYED),
    'The protocol is not deployed on Arc or any mainnet, and the page has to say so in the one\n' +
      'place that used to carry the deployment record.\n' +
      `Expected to find: "${NOT_DEPLOYED}"`,
  );
});

test('the built page names no contract address, because none is live', () => {
  const hits = [];
  for (const rel of ['index.html', 'app.css', 'app.js', '_headers']) {
    if (!existsSync(path.join(DIST, rel))) continue;
    const text = read(rel);
    const m = text.match(ADDRESS_RE);
    if (m) hits.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(
    hits,
    [],
    'The protocol has no deployed contracts anywhere. A 40-hex address on this page, real or\n' +
      'invented, reads to a visitor as a live contract, and that is a false claim either way.\n' +
      `Found: ${hits.join(', ')}`,
  );
  // The specific address this page used to name, as a named negative case rather than only a
  // shape match: the old chain's factory must not survive under any spelling.
  const flatHtml = flat(read('index.html'));
  assert.equal(flatHtml.includes(OLD_FACTORY), false, `The old factory address is still on the page: ${OLD_FACTORY}`);
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
    "connect-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
  ]) {
    assert.ok(headers.includes(directive), `_headers is missing: ${directive}`);
  }

  // connect-src names no external origin. The protocol is not deployed anywhere, so this page
  // has nothing to call and nothing to widen the policy for. This directly guards against
  // pointing connect-src at an invented Arc address, or leaving the abandoned chain's RPC in
  // place.
  const connectSrc = headers.match(/connect-src[^;]*/);
  assert.ok(connectSrc, '_headers has no connect-src directive at all.');
  assert.equal(
    /https?:\/\//.test(connectSrc[0]),
    false,
    `connect-src names an external origin, which claims a live chain call this page does not\n` +
      `have: "${connectSrc[0]}"`,
  );
});

test('the page has no inline script and no inline style, which the CSP would block', () => {
  const html = read('index.html');
  // An opening <script> with no src is an inline block. <script src=...> is fine.
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>/i.test(html);
  assert.equal(inlineScript, false, "script-src 'self' blocks an inline <script>, silently.");
  assert.equal(/<style[\s>]/i.test(html), false, "style-src 'self' blocks an inline <style> block, silently.");
  assert.equal(/\sstyle="/i.test(html), false, "style-src 'self' blocks a style=\"...\" attribute, silently.");
});

test('the page makes no request to any origin at all, because there is nothing deployed to read', () => {
  const html = read('index.html');
  const css = existsSync(path.join(DIST, 'app.css')) ? read('app.css') : '';
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

  // No exemption for any origin, not even a chain RPC: the protocol is not
  // deployed anywhere, so this page has nothing to read live and nothing it
  // should be reaching out for.
  assert.deepEqual(
    fetched,
    [],
    'This page loads no third-party asset and makes no chain call, and the CSP enforces that.\n' +
      `Anything here would be blocked at the edge with no visible error:\n  ${fetched.join('\n  ')}`,
  );

  // app.js must contain no fetch() call at all, not merely no foreign one. A fetch() to 'self'
  // would still be a live read this page has no deployed address to point at.
  assert.equal(
    js.includes('fetch('),
    false,
    'app.js calls fetch(), but the protocol is not deployed anywhere and there is nothing to read.',
  );
});
