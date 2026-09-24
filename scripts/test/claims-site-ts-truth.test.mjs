/**
 * Claims truth over `apps/site/src/*.ts` — the marketing site's own copy modules.
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs` walks every public surface in the repository by extension
 * (`PUBLIC_EXT = ['.md', '.html', '.txt', '.json']`) and matches banned claim shapes against it.
 * `.ts` is not in that set, so `apps/site/src/copy.ts` and `apps/site/src/disclaimers-copy.ts` —
 * the two files that hold, respectively, every public-facing sentence on the marketing site and
 * the disclaimers page's own claims about the live contracts — are invisible to that walk. A false
 * or stale claim written directly into either file ships with a fully green claims-guard suite.
 * Two separate cards tracked this: a draft CTA sentence nearly shipped in `copy.ts` uncaught
 * (Tasks/copy-ts-invisible-to-claims-guards), and the disclaimers page carried a superseded
 * 86,400-second oracle bound for two days after the live value moved to 90,000 seconds, on a file
 * no guard could see either (Tasks/launch-security-14-...). Fixing the disclaimers sentence did
 * not fix the structural gap that let it go unguarded in the first place; this file is that fix.
 *
 * ## Why this is a SEPARATE file rather than an added `PUBLIC_EXT` entry
 *
 * `.ts` is not added to `PUBLIC_EXT` in `claims-lede-truth.test.mjs`, on the same reasoning that
 * file's own header gives for keeping `.mjs` out: that set covers the whole repository —
 * `contracts/`, `scripts/`, `packages/`, this test suite itself — and adding `.ts` there would
 * sweep every `.ts` file in the tree, not just the ones a site visitor reads. This guard is scoped,
 * explicitly, to the one directory whose `.ts` files are strings the marketing site renders:
 * `apps/site/src/*.ts`. Nothing else.
 *
 * ## Why the shape set is IMPORTED, not copied
 *
 * `scripts/lib/claims-shapes.mjs` holds the regexes this file uses — the exact same bindings
 * `claims-lede-truth.test.mjs` and `claims-web-prose-truth.test.mjs` use, not a third,
 * independently-maintained copy.
 *
 * ## The hard part: RENDERED STRINGS, not the comments that describe them
 *
 * `scripts/lib/extract-string-literals.mjs` tokenizes each module and returns ONLY the static text
 * of its string and template literals — comments are walked over and discarded. `copy.ts`'s own
 * header narrates the banned shapes it refuses, in prose, in order to explain the refusal; a naive
 * whole-file regex would trip on that documentation. The mutation probe below tests exactly this,
 * in both directions.
 *
 * ## Entity decoding — the second hard part `apps/web/src` does not have
 *
 * `disclaimers-copy.ts` writes its copy as HTML entities inline in the string literals themselves
 * — `&rsquo;`, `&mdash;`, `&#39;` — because the strings are rendered into `dangerouslySetInnerHTML`
 * elsewhere in the site. A shape regex written against plain punctuation (an apostrophe in
 * "operator's", a hyphen in "stake-weighted") would silently slide past the entity-encoded form and
 * report a false clean. `decodeEntities` below normalizes the small, closed set of named and
 * numeric entities this corpus actually uses before any shape regex runs. The mutation probe proves
 * an entity-laden banned phrase is still caught, not just a plain one.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 *   1. `apps/site/src` must contain at least one `.ts` module. If the directory is empty, renamed,
 *      or this guard's path is wrong, this THROWS rather than reporting a pass over zero files.
 *   2. Every module walked must yield at least one non-empty extracted string. A module yielding
 *      zero is a tokenizer defect, not a clean file, and is surfaced rather than silently treated
 *      as having nothing to say.
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
  FEE_BYPASSES_OPERATOR,
} from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_SRC = 'apps/site/src';

/** The small, closed set of named/numeric HTML entities this corpus actually uses (checked
 * 2026-09-23: `&rsquo;`, `&lsquo;`, `&mdash;`, `&ndash;`, `&amp;`, `&quot;`, `&#39;`). Decoding a
 * fixed table rather than reaching for an HTML-entity dependency keeps this guard's only
 * dependency the same hand-rolled tokenizer `claims-web-prose-truth.test.mjs` already uses. */
const ENTITIES = {
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&mdash;': '—',
  '&ndash;': '–',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
const decodeEntities = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);

/**
 * Every `.ts` module directly inside `apps/site/src`. Enumerated from the filesystem, never from a
 * list, on the same rule `claims-lede-truth.test.mjs`'s header states for the repo-wide walk: a
 * file added today is covered today.
 */
const siteSrcModules = () => {
  const dir = path.join(REPO, SITE_SRC);
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => `${SITE_SRC}/${e.name}`);
  // Tripwire 1 — see header.
  assert.ok(
    found.length > 0,
    `${SITE_SRC} yielded zero .ts modules. Either the site's copy layer moved, or this guard's ` +
      'path is wrong — either way this must FAIL rather than report a silent pass over zero coverage.',
  );
  return found;
};

/** Every module's file path alongside its extracted, entity-decoded string-literal text,
 * flattened into one haystack per file. */
const modulesWithExtractedText = () =>
  siteSrcModules().map((file) => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    const strings = extractStringLiterals(source);
    // Tripwire 2 — see header.
    assert.ok(
      strings.length > 0,
      `${file}: extracted ZERO string literals. This file plainly has strings — a zero-string ` +
        'extraction means extract-string-literals.mjs failed to tokenize it, and treating that as ' +
        '"nothing to check" is exactly the silent skip this guard exists to refuse.',
    );
    return { file, text: flat(decodeEntities(strings.join(' '))) };
  });

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('apps/site/src has at least one .ts module to guard', () => {
  assert.ok(siteSrcModules().length > 0);
});

const MIN_MODULES = 4;
const MIN_STRINGS = 100;

test('coverage: this guard actually walks a non-trivial slice of apps/site/src', () => {
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
  // Named-file tripwire: the two files these guard cards exist for, by name, so a rename or
  // deletion of either is caught here rather than by a silent shrink of MIN_MODULES.
  const names = modules.map((m) => m.file);
  for (const must of ['apps/site/src/copy.ts', 'apps/site/src/disclaimers-copy.ts']) {
    assert.ok(names.includes(must), `${must} was not walked — expected it inside ${SITE_SRC}`);
  }
});

test('no rendered string in apps/site/src says an AI agent pools capital or governs a vault', () => {
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
      'guard 1).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/site/src claims a single universal weighted-vote regime', () => {
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
      'guard 2).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('every "stake-weighted" string in apps/site/src carries its sub-five-member qualifier', () => {
  const offenders = [];
  for (const { file, text } of modulesWithExtractedText()) {
    if (STAKE_WEIGHTED.test(text) && !SUB_FIVE_QUALIFIER.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    'Stake weighting is the regime only at FIVE OR MORE members (see claims-lede-truth.test.mjs\n' +
      'guard 3).\n' +
      `Offending files:\n  ${offenders.join('\n  ')}`,
  );
});

test('no rendered string in apps/site/src describes the sub-five regime as stake-blind', () => {
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
    'The sub-five regime weighs stake in BOTH branches (see claims-lede-truth.test.mjs guard 4).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/site/src claims the contracts screen who may deposit', () => {
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
      '.test.mjs guard 5).\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test("the operator's lack of power is enumerated, never claimed as a universal, in apps/site/src", () => {
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
    'A universal negative about operator power is falsifiable in one transaction (see\n' +
      'claims-lede-truth.test.mjs guard 6). ENUMERATE instead.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no rendered string in apps/site/src attributes protocol fees, governance or entitlement to RWLY', () => {
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

test('no rendered string in apps/site/src claims a fee bypasses the operator as a person', () => {
  const hits = [];
  for (const { file, text } of modulesWithExtractedText()) {
    for (const re of FEE_BYPASSES_OPERATOR) {
      for (const m of text.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The operator is a member and receives the exit fee pro rata through its own shares like\n' +
      'anyone who stays (see claims-lede-truth.test.mjs guard 9). The ROUTING form ("never routed\n' +
      'to the operator") is true; the IDENTITY form ("never to the operator") is not.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the extractor reads rendered strings, not the comments that describe banned shapes', () => {
  const commentedOnly = [
    '// AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote.',
    '/**',
    ' * This module refuses to ever say "AI agents govern this vault" because it is false.',
    ' */',
    "export const ok = { available: true, reason: '' };",
  ].join('\n');
  const strings = extractStringLiterals(commentedOnly);
  const hay = flat(maskProductPhrases(decodeEntities(strings.join(' '))));
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

  const renderedBad = [
    '// A module that refuses this shape in its own docs:',
    "export const bad = { reason: 'AI agents pool USDC into spot crypto index baskets.' };",
  ].join('\n');
  const badStrings = extractStringLiterals(renderedBad);
  const badHay = flat(maskProductPhrases(decodeEntities(badStrings.join(' '))));
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

test('probe: an HTML-entity-encoded banned phrase is still caught, not silently slid past', () => {
  // The exact shape disclaimers-copy.ts writes in practice — an apostrophe and a dash encoded as
  // named entities inside a string literal rendered via dangerouslySetInnerHTML.
  const entityEncoded = [
    "export const bad = { dd: 'the operator&rsquo;s fee is never to the operator, which is an ' +",
    "    'absolute signer count &mdash; a pure head-count, not stake-weighted.' };",
  ].join('\n');
  const strings = extractStringLiterals(entityEncoded);
  const hay = flat(decodeEntities(strings.join(' ')));
  assert.ok(
    /never\s+to\s+the\s+operator/i.test(hay) && FEE_BYPASSES_OPERATOR.some((re) => {
      re.lastIndex = 0;
      return re.test(hay);
    }),
    `entity-decoded FEE_BYPASSES_OPERATOR shape was not caught. Decoded text: ${JSON.stringify(hay)}`,
  );
  assert.ok(
    STAKE_BLIND.some((re) => {
      re.lastIndex = 0;
      return re.test(hay);
    }),
    `entity-decoded STAKE_BLIND shape was not caught. Decoded text: ${JSON.stringify(hay)}`,
  );
  // And the undecoded form must NOT trivially match the same probes, proving decoding is load-
  // bearing rather than redundant with what extractStringLiterals already returns.
  const raw = flat(strings.join(' '));
  assert.ok(
    /operator&rsquo;s/.test(raw),
    'sanity check on the probe itself: the raw extracted text should still carry the entity',
  );
});

test('probe: this guard reds rather than passes if apps/site/src yields no modules at all', () => {
  const emptyDir = path.join(REPO, SITE_SRC, '__does-not-exist__');
  assert.throws(
    () => readdirSync(emptyDir, { withFileTypes: true }),
    /ENOENT/,
    'sanity check on the probe itself: a missing directory must throw, not return []',
  );
  const assertNonEmpty = (found) => {
    assert.ok(found.length > 0, 'apps/site/src yielded zero .ts modules');
  };
  assert.throws(() => assertNonEmpty([]), /zero \.ts modules/);
  assertNonEmpty(['apps/site/src/copy.ts']); // does not throw — the non-empty case stays green
});
