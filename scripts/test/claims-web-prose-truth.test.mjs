/**
 * Claims truth over the DOMAIN LAYER'S RENDERED PROSE — `apps/web/src/*.mjs`.
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs` walks every public surface in the repository and matches banned
 * claim shapes against it — but its `PUBLIC_EXT` is `.md`, `.html`, `.txt` and `.json`. `.mjs` is
 * not in it, so none of `apps/web/src`'s eleven modules were ever reachable by that guard, or by
 * its sibling config/custody guards. That file's own header (lines ~19-21) records the cost of the
 * gap directly: a banned universal once sat in that guard's own docstring, and the guard could not
 * catch it — `.mjs` was outside `PUBLIC_EXT` — until it was found by hand and named "the sixth
 * instance" of the same pattern.
 *
 * `apps/web/src` is not a random corner of the repo to have missed. It is `notices`, `actions()`'s
 * refusal/warn reasons, `vaultStatus`/`freshness.TIERS`/`proposalPhase`/`oracleHealth` labels, and
 * the deposit/exit preview refusals — the copy a member reads at the exact moments that matter
 * most: a freeze, an irrevocable queue, an unresolvable state. Product's finding
 * (`2026-09-19-sixty-three-member-facing-sentences-no-guard-can-see`) counted 63 such member-facing
 * sentences across the directory's twelve modules on 2026-09-19, all clean against these shapes at
 * the time, none of them guarded before this file. That count is Product's own measurement by their
 * own method (what reaches a member, not every string literal) and this guard does not reproduce
 * it; this guard's own coverage is asserted separately below, from what it actually walks.
 *
 * ## Why this is a SEPARATE file rather than an added `PUBLIC_EXT` entry
 *
 * `.mjs` was deliberately NOT added to `PUBLIC_EXT` in `claims-lede-truth.test.mjs`. That set
 * covers the whole repository — `contracts/`, `scripts/`, `packages/`, every `node_modules`-adjacent
 * tool script, this test suite itself — and adding `.mjs` there would sweep every `.mjs` file in
 * the tree, not just the ones a member ever reads. The predictable result is a flood of hits over
 * code that has nothing to do with member-facing prose (test fixtures, deploy scripts, indexer
 * internals), and a flood is what gets suppressed rather than fixed — the exact failure mode
 * `claims-lede-truth.test.mjs`'s own header describes for widening the vault-side check the same
 * way. So this guard is scoped, explicitly, to the ONE directory whose `.mjs` files are strings a
 * browser renders to a member: `apps/web/src/*.mjs`. Nothing else.
 *
 * ## Why the shape set is IMPORTED, not copied
 *
 * `scripts/lib/claims-shapes.mjs` holds the regexes this file uses. They are the exact same
 * bindings `claims-lede-truth.test.mjs` uses — not a second, independently-maintained copy. Two
 * copies of one rule drift, and the vote-claim/claims-contract history in this repo is what
 * happens when they do. See that lib file's header for why it exists as a separate module rather
 * than this file importing `claims-lede-truth.test.mjs` directly (short version: that would
 * re-execute all eleven of that file's `test()` registrations inside this file's process).
 *
 * ## The hard part: RENDERED STRINGS, not the comments that describe them
 *
 * Every module here documents the domain rules it encodes, and several of those docstrings
 * describe a banned shape IN ORDER TO EXPLAIN why the code refuses it — `vault-state.mjs`'s header
 * literally narrates "TRAP 1" and "TRAP 2" in prose that would trip a naive whole-file regex. A
 * scan of the raw file text cannot tell a sentence a member will read from a sentence written to
 * explain why the code exists; `claims-lede-truth.test.mjs`'s own header is the same shape of
 * problem inside guard 6's docstring, and it is why THIS file's extraction has to be more careful
 * than "read the file and match".
 *
 * The fix: `scripts/lib/extract-string-literals.mjs` tokenizes each module and returns ONLY the
 * static text of its string and template literals — comments, both `//` and `/* *\/`, are walked
 * over and discarded, never collected. A banned shape sitting in a comment therefore cannot red
 * this guard; only a banned shape inside a literal a member can actually receive can. The mutation
 * probe below tests exactly this, in both directions.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 * Two things independently prove this guard actually ran over real prose rather than vacuously
 * passing over nothing, the same discipline `claims-lede-truth.test.mjs`'s own "COVERAGE, NOT A
 * GUARD" section applies to `apps/site/dist`:
 *
 *   1. `apps/web/src` must contain at least one `.mjs` module. If the directory is empty, renamed,
 *      or the walk's path is wrong, this THROWS rather than reporting a pass over zero files.
 *   2. Every module walked must yield at least one non-empty extracted string. A module that
 *      "plainly has strings" (by grep) yielding zero from the tokenizer is a tokenizer bug, and
 *      this throws naming the file rather than silently treating it as clean.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStringLiterals } from '../lib/extract-string-literals.mjs';
import {
  flat,
  sentencesOf,
  AGENT_ACTS,
  maskProductPhrases,
  UNIVERSAL_WEIGHTED,
  STAKE_WEIGHTED,
  SUB_FIVE_QUALIFIER,
  STAKE_BLIND,
  REMEDIATION_STATUS,
  DENIED,
  ONCHAIN_MEMBER_GATE,
  POWER_CLAIM,
  ENUMERATION_FOLLOWS,
  RWLY_ATTRIBUTION,
  RWLY_BACKED_BY_VAULT,
} from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = 'apps/web/src';

/**
 * Every `.mjs` module directly inside `apps/web/src` (not recursive — there are no subdirectories
 * there today, and this module is the domain layer the surface renders, not a place to widen
 * quietly). Enumerated from the filesystem, never from a list, on the same rule
 * `claims-lede-truth.test.mjs`'s header states for the repo-wide walk: a file added today is
 * covered today.
 */
const webSrcModules = () => {
  const dir = path.join(REPO, WEB_SRC);
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => `${WEB_SRC}/${e.name}`);
  // Tripwire 1 — see header. A guard scoped to a directory that turns out to be empty passes over
  // nothing, and a pass over nothing reads identically to a pass over everything checked.
  assert.ok(
    found.length > 0,
    `${WEB_SRC} yielded zero .mjs modules. Either the domain layer moved, or this guard's path is ` +
      'wrong — either way this must FAIL rather than report a silent pass over zero coverage.',
  );
  return found;
};

/**
 * Modules verified to carry NO code-level string or template literal at all — grepped by hand,
 * not merely observed by the tokenizer, so this is a claim about the FILE, not a workaround for
 * the tokenizer. Every one of the eleven original modules this guard was built against has
 * member-facing string literals (refusal reasons, labels, notices), which is what makes a
 * zero-string extraction from any of THOSE a tokenizer defect rather than a clean file — tripwire
 * 2's whole premise. `size-impact.mjs` (#183) breaks that premise honestly: it is pure
 * constant-liquidity math returning structured `{ok, pastEdge, ...}` objects, never a thrown or
 * returned prose string — every word a member reads about it is composed in
 * `apps/vaults-ui/src/components/MemberActions.tsx`, which this guard does not and should not
 * reach (`.tsx` is outside `WEB_SRC` by design — see this file's header on scope). Add a file here
 * ONLY after confirming by hand (not by trusting a red test) that it has zero `'`/`"`/`` ` ``
 * outside its comments; a module added here that DOES have real strings would hide them from
 * every check below, which is why the bar is "verified", not "convenient".
 */
const NO_STRING_LITERALS_VERIFIED = new Set(['apps/web/src/size-impact.mjs']);

/**
 * Every module's file path alongside its extracted string-literal text, flattened into one
 * haystack per file the same way `claims-lede-truth.test.mjs` flattens hard-wrapped prose — so a
 * banned shape split across two adjacent string-literal fragments (common here: many refusal
 * reasons are built from several `'...' + '...'` pieces) still matches as one run of text.
 */
const modulesWithExtractedText = () =>
  webSrcModules().map((file) => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    const strings = extractStringLiterals(source);
    // Tripwire 2 — see header. Every OTHER module here has member-facing string literals (that is
    // the entire reason this guard exists), so a module extracting to nothing is a tokenizer
    // defect, not a clean file, and must be surfaced rather than silently treated as having
    // nothing to say — UNLESS it is on the narrow, hand-verified exemption list above, in which
    // case it still counts toward coverage below (an entry present with zero strings), it just
    // contributes none of its own.
    if (strings.length === 0 && NO_STRING_LITERALS_VERIFIED.has(file)) return { file, text: '' };
    assert.ok(
      strings.length > 0,
      `${file}: extracted ZERO string literals. This file plainly has strings (it is why this ` +
        'guard exists) — a zero-string extraction means extract-string-literals.mjs failed to ' +
        'tokenize it, and treating that as "nothing to check" is exactly the silent skip this ' +
        'guard exists to refuse. Fix the tokenizer rather than let this pass, or add the file to ' +
        'NO_STRING_LITERALS_VERIFIED above if you have confirmed by hand it truly has none.',
    );
    return { file, text: flat(strings.join(' ')) };
  });

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('apps/web/src has at least one .mjs module to guard', () => {
  assert.ok(webSrcModules().length > 0);
});

/**
 * A tripwire on the guard's own coverage, the same role `MIN_PAGES` plays in
 * `claims-lede-truth.test.mjs`'s "every prerendered page is inside the walk" test: not a fact
 * asserted for its own sake, but a floor that catches this guard silently walking far less than it
 * should (a broken glob, a directory that shrank to near-nothing) without hardcoding today's exact
 * counts, which would make this test the next thing that goes stale.
 */
const MIN_MODULES = 8;
const MIN_STRINGS = 200;

test('coverage: this guard actually walks a non-trivial slice of apps/web/src', () => {
  const modules = modulesWithExtractedText();
  const totalStrings = modules.reduce((n, { text }) => n + (text.trim() ? text.split(' ').length : 0), 0);
  assert.ok(
    modules.length >= MIN_MODULES,
    `only ${modules.length} modules walked, fewer than the ${MIN_MODULES} floor — coverage regressed`,
  );
  assert.ok(
    totalStrings >= MIN_STRINGS,
    `only ~${totalStrings} extracted words walked, fewer than the ${MIN_STRINGS} floor — coverage regressed`,
  );
});

test('no rendered string in apps/web/src says an AI agent pools capital or governs a vault', () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    const hay = maskProductPhrases(text);
    for (const re of AGENT_ACTS) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'Members pool and vote; an AI operator does neither on-chain (see claims-lede-truth.test.mjs\n' +
      'guard 1 for the full reasoning and the approved replacement wording).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/web/src claims a single universal weighted-vote regime', () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const re of UNIVERSAL_WEIGHTED) {
      for (const m of text.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    '`Governance.finalize` has THREE quorum regimes, not one (see claims-lede-truth.test.mjs\n' +
      'guard 2). Say "ratify every rebalance by on-chain vote" and qualify any weighting claim.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('every "stake-weighted" string in apps/web/src carries its sub-five-member qualifier', () => {
  const offenders = [];
  for (const { file, text } of modulesWithExtractedText()) {
    if (STAKE_WEIGHTED.test(text) && !SUB_FIVE_QUALIFIER.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    'Stake weighting is the regime only at FIVE OR MORE members (see claims-lede-truth.test.mjs\n' +
      'guard 3). Qualify in the same file, e.g. "stake-weighted at five or more members".\n' +
      `Offending files:\n  ${offenders.join('\n  ')}`,
  );
});

test('no rendered string in apps/web/src describes the sub-five regime as stake-blind', () => {
  // No RECORD_DIRS exemption here (unlike claims-lede-truth.test.mjs's guard 4): that exemption is
  // for dated findings under docs/audit and docs/reviews, and apps/web/src has no such directory —
  // every string here is a present-tense claim a member reads right now, never a dated record.
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const re of STAKE_BLIND) {
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        if (REMEDIATION_STATUS.test(text.slice(Math.max(0, i - 200), i + 200))) continue;
        if (DENIED.test(text.slice(Math.max(0, i - 60), i))) continue;
        hits.push({ file, quote: m[0] });
      }
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The sub-five regime weighs stake in BOTH branches, H-8/CM-7 (see claims-lede-truth.test.mjs\n' +
      'guard 4). Calling it stake-blind, or a pure/absolute signer count, describes the PRE-fix\n' +
      'code.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/web/src claims the contracts screen who may deposit', () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const m of text.matchAll(ONCHAIN_MEMBER_GATE)) {
      if (/\b(?:adapter|oracle|venue|target|selector|factory|token|asset)s?\s+(?:allowlist|allow-list|whitelist)/i.test(m[0])) {
        continue;
      }
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The only allowlists in contracts/src are for ADAPTERS and ORACLES (see claims-lede-truth\n' +
      '.test.mjs guard 5). Vault #1\'s member allowlist is frontend-only, the same class as the\n' +
      'geofence: never imply the contracts enforce it.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test("the operator's lack of power is enumerated, never claimed as a universal, in apps/web/src", () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const m of text.matchAll(POWER_CLAIM)) {
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
      if (ENUMERATION_FOLLOWS.test(after)) continue; // the approved, checkable form
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'A universal negative about operator power is falsifiable in one transaction — the operator\n' +
      'IS the sole recipient of the 10% performance fee (see claims-lede-truth.test.mjs guard 6).\n' +
      'ENUMERATE instead: "confers no authority to vote, execute, pause, reprice, or move member\n' +
      `funds".\nOffending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/web/src attributes protocol fees, governance or entitlement to RWLY', () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const re of RWLY_ATTRIBUTION) {
      for (const m of text.matchAll(re)) hits.push({ file, quote: m[0] });
    }
    for (const s of sentencesOf(text)) {
      if (/\bRWLY\b/.test(s) && RWLY_BACKED_BY_VAULT.test(s)) hits.push({ file, quote: s.trim().slice(0, 160) });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'RWLY is design intent only, never the object of a protocol transfer verb and never a\n' +
      'governance/entitlement subject (see claims-lede-truth.test.mjs guard 7).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the extractor reads rendered strings, not the comments that describe banned shapes', () => {
  // The banned shape sitting inside a CODE COMMENT — the exact situation this guard exists to
  // avoid reddening on, since several real modules (vault-state.mjs's TRAP 1/TRAP 2 narration,
  // this file's own header) document banned shapes in prose in order to explain why they are
  // banned. If a comment can red this guard, the guard is unusable and the first author it
  // inconveniences will disable it rather than rewrite their documentation.
  const commentedOnly = [
    '// AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote.',
    '/**',
    ' * This module refuses to ever say "AI agents govern this vault" because it is false — see',
    ' * the discussion of why "no on-chain authority" would be a banned universal claim.',
    ' */',
    "const ok = () => ({ available: true, reason: '', severity: 'ok' });",
  ].join('\n');
  const strings = extractStringLiterals(commentedOnly);
  const hay = flat(maskProductPhrases(strings.join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(
    hit,
    false,
    'The guard reddened on a code COMMENT describing a banned shape, not a rendered string. ' +
      `Extracted (should be near-empty prose, no banned shape): ${JSON.stringify(strings)}`,
  );

  // ...and the SAME banned shape, moved into an actual rendered string literal in the same file,
  // must still be caught. This is the direction that matters most: a guard that reads nothing is
  // the same guard, by a different route, as one that reads everything and ignores it.
  const renderedBad = [
    '// A module that refuses this shape in its own docs:',
    "const bad = { reason: 'AI agents pool USDC into spot crypto index baskets.' };",
  ].join('\n');
  const badStrings = extractStringLiterals(renderedBad);
  const badHay = flat(maskProductPhrases(badStrings.join(' ')));
  const badHit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(badHay);
  });
  assert.equal(
    badHit,
    true,
    'The guard failed to catch the banned shape when it sits in an ACTUAL rendered string ' +
      `literal rather than a comment. Extracted: ${JSON.stringify(badStrings)}`,
  );
});

test('probe: this guard reds rather than passes if apps/web/src yields no modules at all', () => {
  const emptyDir = path.join(REPO, WEB_SRC, '__does-not-exist__');
  assert.throws(
    () => readdirSync(emptyDir, { withFileTypes: true }),
    /ENOENT/,
    'sanity check on the probe itself: a missing directory must throw, not return []',
  );
  // webSrcModules() itself asserts found.length > 0 over the REAL directory; this probe proves the
  // shape of that guard independently, over a directory manufactured to be empty, so the assertion
  // is exercised on both sides rather than only ever seeing the real (non-empty) case.
  const assertNonEmpty = (found) => {
    assert.ok(found.length > 0, 'apps/web/src yielded zero .mjs modules');
  };
  assert.throws(() => assertNonEmpty([]), /zero \.mjs modules/);
  assertNonEmpty(['apps/web/src/fees.mjs']); // does not throw — the non-empty case stays green
});
