/**
 * Claims truth over the MEMBER-FACING SURFACE — `apps/vaults-ui/src/components/*.tsx` and
 * `apps/vaults-ui/src/lib/*.ts`/`*.tsx` (cards P-O13/P-O21).
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs` walks `.md`/`.html`/`.txt`/`.json` (`PUBLIC_EXT`).
 * `claims-web-prose-truth.test.mjs` (#322/card #68) additionally walks `apps/web/src/*.mjs`, the
 * domain layer. Neither reaches `apps/vaults-ui` at all: it is not `PUBLIC_EXT`, and it is not
 * `.mjs` under `apps/web/src`. That leaves the app a member actually opens — the one that renders
 * `MemberActions.tsx`'s deposit/exit/vote flows, exit-fee caveats, refusal reasons, and
 * performance-fee warnings (see recent work on P-O12/#350) — with ZERO claims-guard coverage. A
 * banned shape planted in a `.tsx` string literal or JSX text child currently reds nothing.
 *
 * ## Scope, deliberately narrow, matching #322's own reasoning for its scope
 *
 * `apps/vaults-ui/src/components/*.tsx` and `apps/vaults-ui/src/lib/*.ts`/`*.tsx` — non-recursive,
 * the same convention `claims-web-prose-truth.test.mjs` uses for `apps/web/src` ("there are no
 * subdirectories there today, and this module is the domain layer the surface renders, not a place
 * to widen quietly"). `apps/vaults-ui/src/lib` DOES have a subdirectory, `atlas-modules/` (plus its
 * own nested `chain/`) — deliberately NOT walked: everything directly inside it today is a `.d.ts`
 * type-declaration file, which is erased before anything ships and is never itself rendered to a
 * member. `.d.ts` is also excluded explicitly (not just by non-recursion) so a future one dropped
 * directly into `src/lib` does not silently join the walk and red tripwire 2 as a fake "extracted
 * zero strings" tokenizer bug — a `.d.ts` genuinely has near-zero runtime string content, and that
 * would be a false alarm about this guard, not a finding about the app.
 *
 * ## Why a NEW file, and a NEW extractor, rather than extending `claims-web-prose-truth.test.mjs`
 * or `extract-string-literals.mjs`
 *
 * The root glob is not the reason. The reason is that the EXTRACTION MECHANISM differs: `.mjs` is
 * plain JS with no JSX, so `extract-string-literals.mjs`'s hand-rolled lexer only has to tell
 * string/template literals apart from comments — a small, bounded lexical surface, by that file's
 * own header. TSX is not that surface: tag nesting, `{...}` expression containers holding
 * arbitrary nested code, and `{/* *\/}` JSX comments are a grammar. `scripts/lib/extract-tsx-text.mjs`
 * (new, this PR) uses the `typescript` package's own parser instead of hand-rolling a JSX-aware
 * lexer — see that file's header for the full reasoning, including why depending on `typescript`
 * here is NOT the same objection #322 raised against `@babel/parser` (that one was an undeclared
 * transitive; `typescript` is a direct `devDependency` of `apps/vaults-ui`, and is now also
 * declared at the repo root so this guard's own dependency is where the guard runs). Bolting a
 * second, JSX-capable extraction path onto `extract-string-literals.mjs` would make #322's `.mjs`
 * guard depend on `typescript` for a scope it does not cover; a second test file bolted onto
 * `claims-web-prose-truth.test.mjs` would blur what THAT file's own header spends several
 * paragraphs establishing as narrowly `apps/web/src/*.mjs`. Two files, two extractors, one shared
 * shape module (`scripts/lib/claims-shapes.mjs`, imported unchanged) is the smaller diff.
 *
 * ## The hard part is bigger here than in #322: JSX TEXT CHILDREN, not just string literals
 *
 * `extract-string-literals.mjs` only had to find string/template literals, because that is where
 * ALL of `apps/web/src`'s member-facing text lives — it is plain JS building objects and strings.
 * `apps/vaults-ui`'s components are JSX: a large share of the actual rendered prose sits directly
 * as TEXT BETWEEN TAGS, never inside a string at all. Confirmed by reading the real files before
 * writing this guard: `Holdings.tsx` renders `A LEG WHOSE PRICE COULD NOT BE READ SHOWS "—", NOT
 * "$0.00"` as JSX children, not a string; `MemberActions.tsx` renders "A proposal is past its
 * commit deadline: this exit QUEUES — irrevocably, no cancel" and the two-signature deposit-escrow
 * paragraph the same way. A guard that only extracted string/template literals — i.e. one that
 * reused `extract-string-literals.mjs` unmodified against `.tsx` source — would pass over the
 * highest-risk prose in this app while reporting full coverage. `extract-tsx-text.mjs` therefore
 * returns JSX text alongside string/template-literal text, and this file's own coverage tripwires
 * (below) specifically guard against JSX-text extraction silently collapsing to zero.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 * Same discipline as #322's own "COVERAGE, NOT A GUARD" section:
 *
 *   1. The two directories combined must yield at least one `.tsx`/`.ts` module. If either moves,
 *      is renamed, or this guard's paths are wrong, this THROWS rather than reporting a pass over
 *      zero files.
 *   2. Every module walked must yield at least one non-empty extracted item (string OR JSX text
 *      combined) — a module extracting to nothing is a tokenizer/parser defect, not a clean file.
 *   3. JSX TEXT SPECIFICALLY must clear a floor across the whole walk (`MIN_JSX_TEXT_SEGMENTS`).
 *      Tripwire 2 alone would NOT catch a bug that zeroes out JSX-text extraction while leaving
 *      string-literal extraction intact (e.g. `ScriptKind.TS` picked instead of `ScriptKind.TSX`
 *      for every file, or a visitor that never reaches `SyntaxKind.JsxText`) — every file here also
 *      has ordinary string literals (`className`, `type="text"`, error messages), so tripwire 2
 *      would stay green while the exact prose this guard exists to catch went unread. This is a
 *      floor, not a hardcoded count of today's segments, for the same staleness reason #322's
 *      `MIN_PAGES`/`MIN_STRINGS` are floors rather than exact numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTsxText } from '../lib/extract-tsx-text.mjs';
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

/**
 * The two root directories this guard walks, each NON-RECURSIVE (see header). `components` is
 * `.tsx` only (there is no plain `.ts` file there today, and a component that render nothing is
 * not this app's shape); `lib` is `.ts` and `.tsx` (it holds both, e.g. `wallet.tsx`), excluding
 * `.d.ts` explicitly.
 */
const ROOTS = [
  { dir: 'apps/vaults-ui/src/components', exts: ['.tsx'] },
  { dir: 'apps/vaults-ui/src/lib', exts: ['.ts', '.tsx'] },
];

/**
 * Every `.tsx`/`.ts` module directly inside the two roots above. Enumerated from the filesystem,
 * never from a list, on the same rule the other two claims guards use: a file added today is
 * covered today.
 */
const vaultsUiModules = () => {
  const found = [];
  for (const { dir, exts } of ROOTS) {
    const abs = path.join(REPO, dir);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith('.d.ts') && exts.some((ext) => e.name.endsWith(ext)))
      .map((e) => `${dir}/${e.name}`);
    found.push(...entries);
  }
  // Tripwire 1 — see header.
  assert.ok(
    found.length > 0,
    `${ROOTS.map((r) => r.dir).join(' and ')} yielded zero .ts/.tsx modules. Either the member-facing ` +
      "surface moved, or this guard's paths are wrong — either way this must FAIL rather than " +
      'report a silent pass over zero coverage.',
  );
  return found;
};

/**
 * Every module's file path alongside its extracted text, flattened into one haystack per file the
 * same way both other claims guards flatten hard-wrapped prose — so a banned shape split across a
 * JSX text child and an adjacent expression, or across several string-literal fragments, still
 * matches as one run of text. `strings` and `jsxText` are combined for the shape checks (a member
 * reads both the same way) but counted separately for the coverage tripwires below.
 */
const modulesWithExtractedText = () =>
  vaultsUiModules().map((file) => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    const { strings, jsxText } = extractTsxText(source, file);
    // Tripwire 2 — see header.
    assert.ok(
      strings.length + jsxText.length > 0,
      `${file}: extracted ZERO string literals or JSX text. This file plainly renders something ` +
        '(it is why this guard exists) — a zero extraction means extract-tsx-text.mjs failed to ' +
        'parse it, and treating that as "nothing to check" is exactly the silent skip this guard ' +
        'exists to refuse. Fix the extractor rather than let this pass.',
    );
    return {
      file,
      jsxTextCount: jsxText.length,
      text: flat([...strings, ...jsxText].join(' ')),
    };
  });

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('apps/vaults-ui/src/{components,lib} has at least one .ts/.tsx module to guard', () => {
  assert.ok(vaultsUiModules().length > 0);
});

/**
 * Tripwires on the guard's own coverage — floors, not exact counts, for the staleness reason both
 * sibling claims guards give for their own MIN_* constants.
 */
const MIN_MODULES = 8;
const MIN_WORDS = 500;
/** Tripwire 3 — see header: specifically guards against JSX-text extraction silently collapsing to
 * zero while string-literal extraction stays intact, which tripwire 2 alone cannot catch. */
const MIN_JSX_TEXT_SEGMENTS = 40;

test('coverage: this guard actually walks a non-trivial slice of apps/vaults-ui/src', () => {
  const modules = modulesWithExtractedText();
  const totalWords = modules.reduce((n, { text }) => n + (text.trim() ? text.split(' ').length : 0), 0);
  const totalJsxSegments = modules.reduce((n, { jsxTextCount }) => n + jsxTextCount, 0);
  assert.ok(
    modules.length >= MIN_MODULES,
    `only ${modules.length} modules walked, fewer than the ${MIN_MODULES} floor — coverage regressed`,
  );
  assert.ok(
    totalWords >= MIN_WORDS,
    `only ~${totalWords} extracted words walked, fewer than the ${MIN_WORDS} floor — coverage regressed`,
  );
  assert.ok(
    totalJsxSegments >= MIN_JSX_TEXT_SEGMENTS,
    `only ${totalJsxSegments} JSX text segments walked, fewer than the ${MIN_JSX_TEXT_SEGMENTS} floor — ` +
      'JSX-text extraction may have silently collapsed (wrong ScriptKind, or a visitor that never ' +
      'reaches SyntaxKind.JsxText) while string-literal extraction stayed intact and masked it.',
  );
});

test('no rendered string/JSX text in apps/vaults-ui/src says an AI agent pools capital or governs a vault', () => {
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

test('no rendered string/JSX text in apps/vaults-ui/src claims a single universal weighted-vote regime', () => {
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

test('every "stake-weighted" string/JSX text in apps/vaults-ui/src carries its sub-five-member qualifier', () => {
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

test('no rendered string/JSX text in apps/vaults-ui/src describes the sub-five regime as stake-blind', () => {
  // No RECORD_DIRS exemption here (same as claims-web-prose-truth.test.mjs's guard 4): apps/vaults-ui
  // has no dated-findings directory — every string/JSX text here is a present-tense claim a member
  // reads right now, never a dated record.
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

test('no rendered string/JSX text in apps/vaults-ui/src claims the contracts screen who may deposit', () => {
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

test("the operator's lack of power is enumerated, never claimed as a universal, in apps/vaults-ui/src", () => {
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

test('no rendered string/JSX text in apps/vaults-ui/src attributes protocol fees, governance or entitlement to RWLY', () => {
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

test('probe: the extractor reads rendered string literals, not the comments that describe banned shapes', () => {
  const commentedOnly = [
    '// AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote.',
    '/**',
    ' * This module refuses to ever say "AI agents govern this vault" because it is false — see',
    ' * the discussion of why "no on-chain authority" would be a banned universal claim.',
    ' */',
    "const ok = () => ({ available: true, reason: '', severity: 'ok' });",
  ].join('\n');
  const { strings, jsxText } = extractTsxText(commentedOnly, 'probe.ts');
  const hay = flat(maskProductPhrases([...strings, ...jsxText].join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(
    hit,
    false,
    'The guard reddened on a code COMMENT describing a banned shape, not a rendered string. ' +
      `Extracted (should be near-empty prose, no banned shape): ${JSON.stringify([...strings, ...jsxText])}`,
  );

  const renderedBad = [
    '// A module that refuses this shape in its own docs:',
    "const bad = { reason: 'AI agents pool USDC into spot crypto index baskets.' };",
  ].join('\n');
  const bad = extractTsxText(renderedBad, 'probe.ts');
  const badHay = flat(maskProductPhrases([...bad.strings, ...bad.jsxText].join(' ')));
  const badHit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(badHay);
  });
  assert.equal(
    badHit,
    true,
    'The guard failed to catch the banned shape when it sits in an ACTUAL rendered string ' +
      `literal rather than a comment. Extracted: ${JSON.stringify([...bad.strings, ...bad.jsxText])}`,
  );
});

test('probe: the extractor reads a rendered JSX text child, and skips a block-comment docstring describing the same shape', () => {
  const docstringOnly = [
    '/**',
    ' * This component refuses to ever render "AI agents pool USDC into spot crypto index baskets',
    ' * and govern rebalances by weighted vote" — see the guard that bans that universal claim.',
    ' */',
    'export function Panel() {',
    "  return <section><p className=\"note\">Nothing controversial here.</p></section>;",
    '}',
  ].join('\n');
  const { strings, jsxText } = extractTsxText(docstringOnly, 'probe.tsx');
  const hay = flat(maskProductPhrases([...strings, ...jsxText].join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(
    hit,
    false,
    'The guard reddened on a block-comment DOCSTRING describing a banned shape, not a rendered ' +
      `JSX child. Extracted: ${JSON.stringify([...strings, ...jsxText])}`,
  );

  const renderedBadJsx = [
    'export function Panel() {',
    '  return (',
    '    <section>',
    '      <p>AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote.</p>',
    '    </section>',
    '  );',
    '}',
  ].join('\n');
  const bad = extractTsxText(renderedBadJsx, 'probe.tsx');
  assert.ok(bad.jsxText.length > 0, 'expected the JSX text child to be extracted at all');
  const badHay = flat(maskProductPhrases([...bad.strings, ...bad.jsxText].join(' ')));
  const badHit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(badHay);
  });
  assert.equal(
    badHit,
    true,
    'The guard failed to catch the banned shape when it sits in an ACTUAL rendered JSX text ' +
      `child rather than a comment. Extracted: ${JSON.stringify([...bad.strings, ...bad.jsxText])}`,
  );
});

test('probe: a JSX comment ({/* ... */}) describing a banned shape stays GREEN — it is not a JsxExpression with content', () => {
  const jsxCommentOnly = [
    'export function Panel() {',
    '  return (',
    '    <section>',
    '      {/* AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote. */}',
    '      <p className="note">Fine.</p>',
    '    </section>',
    '  );',
    '}',
  ].join('\n');
  const { strings, jsxText } = extractTsxText(jsxCommentOnly, 'probe.tsx');
  const hay = flat(maskProductPhrases([...strings, ...jsxText].join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(
    hit,
    false,
    'The guard reddened on a {/* JSX comment */} describing a banned shape, not a rendered ' +
      `child. Extracted: ${JSON.stringify([...strings, ...jsxText])}`,
  );
});

test('probe: a plain .ts angle-bracket type assertion does not get misparsed as JSX', () => {
  // `<string>someValue` is a legal type assertion in plain TS, and would either throw or
  // mis-tokenize if parsed under ScriptKind.TSX. atlas.ts/chain-actions.ts/chains.ts/live-vaults.ts
  // are real `.ts` files in this app (not `.tsx`), so this is not a hypothetical.
  const src = [
    'const raw: unknown = 1;',
    'const n = <number>raw;',
    "export const reason = 'a plain ts string literal, not JSX';",
  ].join('\n');
  const { strings } = extractTsxText(src, 'probe.ts');
  assert.deepEqual(strings, ['a plain ts string literal, not JSX']);
});

test('probe: this guard reds rather than passes if the vaults-ui surface yields no modules at all', () => {
  const emptyDir = path.join(REPO, 'apps/vaults-ui/src/components', '__does-not-exist__');
  assert.throws(
    () => readdirSync(emptyDir, { withFileTypes: true }),
    /ENOENT/,
    'sanity check on the probe itself: a missing directory must throw, not return []',
  );
  const assertNonEmpty = (found) => {
    assert.ok(found.length > 0, 'apps/vaults-ui/src/{components,lib} yielded zero .ts/.tsx modules');
  };
  assert.throws(() => assertNonEmpty([]), /zero \.ts\/\.tsx modules/);
  assertNonEmpty(['apps/vaults-ui/src/components/MemberActions.tsx']); // does not throw
});
