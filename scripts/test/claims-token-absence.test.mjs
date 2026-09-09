/**
 * NO PUBLIC SURFACE NAMES A TOKEN. The absence rule that replaced the launch-fact guards.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A DELETION.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * On 2026-09-05 a token launched and the site flipped to describe it. Several guard legs were
 * written that day to pin the launch facts: `apps/site/test/site.test.mjs` required the address
 * stem, the supply figure and a status chip beside every mention; `apps/site-next/test/site.test.mjs`
 * required a window qualifier and pinned a per-page list of facts each page had to state. Those
 * legs were correct for a site that described a live token.
 *
 * On 2026-09-09 the owner retired that launch, calling it a test, and ordered every token sentence
 * off every public surface until a real relaunch. The positive legs went with the copy they
 * guarded: a leg that REQUIRES a page to state a supply figure cannot survive on a page that must
 * not mention a token at all.
 *
 * DELETING THEM AND STOPPING THERE WOULD HAVE LEFT THE SURFACE UNGUARDED, which is the failure
 * this file exists to prevent. The retired positive legs are replaced by one negative leg, stated
 * over the same surfaces: no page a reader receives may name the token, its address, the launchpad,
 * the curve, or a supply figure. A future edit that reintroduces a token claim goes red here rather
 * than shipping silently, and a relaunch is then a deliberate act that has to come through this
 * file rather than through a copy edit nobody reviewed.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, said plainly so nobody widens it by accident:
 *
 *   `contracts/config/deployments/rwly-robinhood-mainnet.json` KEEPS the address and the readback.
 *   The owner's decision was to retire the launch and keep the record as history. A repository
 *   record of a transaction that happened is not a claim to a reader, and deleting it would destroy
 *   the evidence that the retirement is about. Its own `status` field says the launch was a test,
 *   that it is kept as history, and that no public surface cites it.
 *
 *   `scripts/test/claims-lede-truth.test.mjs` guards 7 and 8 KEEP their RWLY machinery. Both are
 *   already absence rules -- guard 7 bans the protocol as the subject of a transfer verb with the
 *   token as its object, guard 8 asserts the token never appears in `contracts/src` -- and an
 *   absence rule does not go false when copy is removed. Retiring them would narrow the guard
 *   surface, which is the one direction this change is not allowed to move.
 *
 *   `apps/site/README.md` and this file NAME the token in order to forbid it. A document that
 *   explains a ban has to be able to state what is banned, so the walk below is scoped to the
 *   published surfaces and never to the repository at large.
 *
 * THE VACUITY TRAP, WHICH IS THE REAL RISK IN A GUARD SHAPED LIKE THIS. An absence check over an
 * empty file set is green and proves nothing -- a glob that stops matching, a `dist/` that was
 * never built, a page renamed out from under a hard-coded list. This project has shipped that bug
 * before (`SOAK_VAULTS` was read but never set, and an empty `.map()` read as "all clear"). So
 * every group below is enumerated FROM THE FILESYSTEM rather than from a list, and every group
 * asserts a minimum file count before it asserts anything about content. A group that comes back
 * short fails loudly and names the build step that fills it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');

/**
 * Every banned shape, with the reason it is banned rather than merely a string.
 *
 * SPELLED OUT HERE RATHER THAN IMPORTED, and that is safe for the same reason `apps/app/test`
 * relies on: `.mjs` is not in the `PUBLIC_EXT` set of `claims-lede-truth.test.mjs`, so enumerating
 * a banned string in order to ban it cannot red the repository guard. Do not move this list into a
 * `.json` fixture without reading that file's header first.
 *
 * THE TICKER IS MATCHED WITHOUT WORD BOUNDARIES, on purpose. `stRWLY` -- the staking token that
 * was only ever design intent -- contains `RWLY` but has no word boundary in front of it, so
 * `\bRWLY\b` would walk straight past a page full of them. Unanchored is strictly stronger, and it
 * costs nothing here: the project's own name is `RWAlly`, whose letters are r-w-a-l-l-y, and the
 * ticker's are r-w-l-y, so the brand is not a substring match under any casing. The probe below
 * pins that distinction, because the way a ban like this dies is somebody loosening it after it
 * reds on the brand name.
 *
 * `Pons` IS ANCHORED, because it is a short word and an unanchored match would red on any longer
 * word that happens to contain it. There is no such word in this copy today, and the anchor is
 * what keeps that true when the copy changes.
 */
const BANNED = [
  {
    re: /rwly/gi,
    why: 'the token ticker. The launch of 2026-09-05 was retired by the owner on 2026-09-09 as a test, and no public surface names a token until a real relaunch',
  },
  {
    re: /0x2eed8ae7/gi,
    why: 'the retired token address. The record is kept at contracts/config/deployments/rwly-robinhood-mainnet.json as history; no reader-facing page cites it',
  },
  {
    re: /bonding\s+curve/gi,
    why: 'the launch mechanism. Describing a curve on a public page is a token sentence whether or not the ticker is beside it',
  },
  {
    re: /\bPons\b/g,
    why: 'the third-party launchpad the retired launch used',
  },
  {
    re: /1,000,000,000/g,
    why: 'the retired token supply figure',
  },
  {
    re: /\b1e27\b/gi,
    why: 'the retired token supply figure, in the notation the on-chain read returns it in',
  },
  {
    // The base-unit form. It is what `totalSupply` holds in the record, so it is the string somebody
    // pastes when they copy a figure across from the record rather than retyping the human one.
    re: /1000000000000000000000000000/g,
    why: 'the retired token supply figure in base units',
  },
  {
    re: /fixed\s+supply/gi,
    why: 'the phrase that anchors the retired supply figure. Nothing this protocol deployed has a supply, fixed or otherwise',
  },
];

/**
 * Every banned hit in a piece of text, with a little context around each.
 *
 * EXTRACTED AS A PURE FUNCTION SO THE PROBE BELOW CAN PROVE IT BITES. An absence check has exactly
 * two silent failure modes -- reading nothing, and matching nothing it should -- and the file-count
 * floors below close the first. This closes the second.
 *
 * @param {string} text
 * @returns {{term: string, why: string, context: string}[]}
 */
export const tokenHits = (text) => {
  const flat = text.replace(/\s+/g, ' ');
  const out = [];
  for (const { re, why } of BANNED) {
    for (const m of flat.matchAll(re)) {
      const at = m.index ?? 0;
      out.push({ term: m[0], why, context: flat.slice(Math.max(0, at - 70), at + 70).trim() });
    }
  }
  return out;
};

/** Every file under `dir` whose extension is in `exts`, recursively, enumerated from disk. */
const filesUnder = (dir, exts) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.has(path.extname(entry.name))) out.push(full);
    }
  })(dir);
  return out.sort();
};

const SITE_NEXT_DIST = path.join(REPO, 'apps', 'site-next', 'dist');
const CORPUS = path.join(REPO, 'apps', 'site');
const APP_SRC = path.join(REPO, 'apps', 'app', 'src');
const APP_DIST = path.join(REPO, 'apps', 'app', 'dist');

/*
 * THE APP GROUP READS `src` AND ALSO `dist` WHEN IT IS THERE, AND IT DOES NOT RUN THE BUILD.
 *
 * THE FIRST DRAFT RAN IT, and the bug that produced is worth writing down because it is the kind
 * that appears once in ten runs and gets dismissed as flakiness. `apps/app/build.mjs` opens with
 * `rm -rf dist` and then copies `src` over it. `claims-lede-truth.test.mjs` walks the whole
 * repository, deliberately does NOT skip `dist`, and reads each file it enumerated. Under
 * `npm run test:backend` those two run in the same batch, so a build here deletes a file that walk
 * has already listed and has not yet opened -- an ENOENT thrown inside whichever unrelated test
 * happened to be running, which is exactly how it first showed up.
 *
 * SO THE BUILD DOES NOT BELONG IN A GUARD THAT SHARES A PROCESS BATCH WITH A REPOSITORY WALK, and
 * removing it costs nothing here. `build.mjs` is `rm -rf dist` followed by `cp -r src dist` with two
 * existence assertions; there is no transform, so the authored bytes ARE the built bytes. Reading
 * `src` checks the same text the deploy carries, and `dist` is read as well whenever a build has
 * left one, so a divergence between them cannot hide in the gap. `apps/app/test/claims.test.mjs`
 * still builds and asserts against `dist` for the page-specific half; it runs on its own.
 */

/**
 * THE THREE `llms.txt` COPIES ARE NAMED, NOT GLOBBED, and this is the one place a list is right.
 * There are exactly three by design, another leg asserts they are byte-identical, and the property
 * being checked here is that all three exist -- which a glob cannot state, because a glob that finds
 * two is indistinguishable from a site that has two.
 */
const LLMS_COPIES = ['llms.txt', 'apps/site/llms.txt', 'apps/site-next/public/llms.txt'];

/**
 * The surface groups, each with the floor that makes its emptiness loud.
 *
 * The floors are minima and not counts: a page added to the corpus must not red this file, and a
 * page REMOVED from it must. Nine corpus pages exist today; the redesign prerenders two.
 */
const groups = () => {
  return [
    {
      name: 'apps/site-next/dist (the pages rwally.com serves)',
      // `.xml` IS IN THIS SET BECAUSE THE SITEMAP CARRIED A TOKEN REFERENCE and was cleaned in the
      // same change. A guard that protects the pages but not the sitemap leaves the one file whose
      // regression nobody would notice by reading the site.
      files: filesUnder(SITE_NEXT_DIST, new Set(['.html', '.txt', '.xml'])),
      floor: 3,
      fix: 'run `npm run build --workspace apps/site-next` first; CI and `npm run gate` both build it before this suite',
    },
    {
      name: 'apps/site (the nine corpus pages)',
      files: readdirSync(CORPUS)
        .filter((f) => f.endsWith('.html'))
        .sort()
        .map((f) => path.join(CORPUS, f)),
      floor: 9,
      fix: 'a corpus page was deleted. The corpus is the checked prose every other surface quotes from',
    },
    {
      name: 'the three llms.txt copies',
      files: LLMS_COPIES.map((f) => path.join(REPO, f)),
      floor: 3,
      fix: 'one of the three copies is missing. They are byte-identical by design',
    },
    {
      name: 'apps/app (app.rwally.com, src plus dist when a build has left one)',
      files: [...filesUnder(APP_SRC, new Set(['.html'])), ...filesUnder(APP_DIST, new Set(['.html']))],
      floor: 1,
      fix: 'apps/app/src carries no HTML page at all',
    },
  ];
};

test('every public surface group is non-empty, so the absence check below is not vacuous', () => {
  for (const g of groups()) {
    for (const f of g.files) {
      assert.ok(existsSync(f), `${g.name}: ${rel(f)} does not exist. ${g.fix}`);
    }
    assert.ok(
      g.files.length >= g.floor,
      `${g.name}: found ${g.files.length} file(s), expected at least ${g.floor}. An absence check over ` +
        `an empty set is green and proves nothing. ${g.fix}`,
    );
  }
});

test('no public surface names a token, its address, the launchpad, the curve or a supply figure', () => {
  let scanned = 0;
  let bytes = 0;
  const failures = [];

  for (const g of groups()) {
    for (const f of g.files) {
      const text = readFileSync(f, 'utf8');
      scanned += 1;
      bytes += text.length;
      for (const hit of tokenHits(text)) {
        failures.push(`  ${rel(f)}: ${JSON.stringify(hit.term)} — ${hit.why}\n      …${hit.context}…`);
      }
    }
  }

  // PRINTED, NOT ONLY ASSERTED, on the same reasoning as every other counted leg in this repository:
  // a number that appears only on failure is a number nobody watches move.
  console.log(`\n  token-absence: ${scanned} public surfaces scanned, ${bytes} bytes\n`);
  assert.ok(bytes > 0, 'every public surface read as empty; the walk is reading the wrong place');

  assert.deepEqual(
    failures,
    [],
    'A public surface names a token.\n' +
      'The owner retired the 2026-09-05 launch on 2026-09-09, calling it a test, and no reader-facing\n' +
      'page names a token until a real relaunch. If a relaunch is what you are doing, this leg is the\n' +
      'place the decision gets made: change it deliberately, with the record beside it, rather than\n' +
      'adding a sentence to a page and finding out here.\n' +
      failures.join('\n'),
  );
});

/**
 * PROBE: the ban bites on every shape it names, and spares the brand.
 *
 * WITHOUT THIS THE LEG ABOVE IS UNFALSIFIED in its second failure mode. The first (reading nothing)
 * is closed by the floors; this closes the second (matching nothing). The `spared` list is not
 * decoration: `RWAlly` is the project's own name and appears on every page, so a ban that reds on it
 * would have to be loosened under pressure until it protected nothing.
 */
test('probe: the token ban catches every banned shape and spares the brand', () => {
  for (const bad of [
    'RWLY is live.',
    'the rwly ticker',
    'stRWLY staking is design intent',
    'the token is at 0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9',
    'launched on a bonding curve quoted in ETH',
    'launched on Pons, a third-party launchpad',
    'a fixed supply of 1,000,000,000',
    'totalSupply() returns 1e27',
  ]) {
    assert.notEqual(tokenHits(bad).length, 0, `the ban no longer catches: ${bad}`);
  }

  for (const ok of [
    'RWAlly is the AI agent trading index on Robinhood Chain.',
    'The contracts carry no proxy, no upgrade path, no pause function and no admin key.',
    'Seven immutable contracts are on chain id 4663, and the response is deterministic.',
    'The vault holds a corresponding position in each constituent.',
    'The minimum deposit is 2,500 USDC and the cap is 50,000 USDC.',
  ]) {
    assert.deepEqual(tokenHits(ok), [], `the ban reds approved copy: ${ok}`);
  }

  // The line-break case, which is how a banned phrase survives a naive check: the pages are wrapped,
  // so "bonding\n  curve" and "fixed\n  supply" have to match as readily as the single-space forms.
  assert.notEqual(tokenHits('launched on a bonding\n      curve').length, 0, 'a wrapped "bonding curve" escapes the ban');
  assert.notEqual(tokenHits('a fixed\n      supply').length, 0, 'a wrapped "fixed supply" escapes the ban');
});
