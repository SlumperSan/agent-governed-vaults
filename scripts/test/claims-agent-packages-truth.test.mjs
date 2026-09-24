/**
 * Claims truth over `packages/reference-agent/src` and `packages/agent-sdk/src` — the two
 * directories an integrator copies verbatim, per the launch checklist's Engineering item C5.
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs` walks the repository by extension (`PUBLIC_EXT` =
 * `.md`/`.html`/`.txt`/`.json`); `.mjs` is deliberately excluded there (see that file's own
 * header and `claims-web-prose-truth.test.mjs`'s header for why: widening `PUBLIC_EXT` to `.mjs`
 * would sweep `contracts/`, `scripts/`, every tool script in the tree). `claims-web-prose-truth
 * .test.mjs` closed the `.mjs` gap for exactly one directory — `apps/web/src`, the domain layer
 * the web frontend renders. Neither guard reaches `packages/reference-agent/src` or
 * `packages/agent-sdk/src`: both are entirely `.mjs`, both are code an INTEGRATOR reads and
 * copies as a starting point (the reference agent literally exists to be copied), and a false
 * claim in either — e.g. the `exitFeeBpsOf` misstatement the launch checklist's own evidence
 * names as the shape of harm here (Tasks/launch-engineering-13-...md, card 92) — ships silently.
 *
 * ## Why this is its OWN file, scoped to these two directories only
 *
 * Same reasoning as `claims-web-prose-truth.test.mjs`: role-scoped, not extension-scoped.
 * `packages/reference-agent/src` and `packages/agent-sdk/src` are grouped in one file because
 * they share the same role — code an integrator reads and copies — and the launch checklist
 * names them together (C5). Neither corpus is `apps/web/src`, so this cannot simply widen that
 * file's `WEB_SRC` constant; a wrong widening there would also start walking `apps/web/src`'s own
 * sibling directories if any appear later, which is the drift this repository's guards exist to
 * avoid.
 *
 * ## Why the shape set is IMPORTED, not copied
 *
 * `scripts/lib/claims-shapes.mjs` — the same bindings every sibling claims guard uses.
 *
 * ## RENDERED STRINGS, not the comments that describe them
 *
 * `scripts/lib/extract-string-literals.mjs` tokenizes each module and returns ONLY string/
 * template-literal text — comments are walked over and discarded. Several modules here document
 * the domain rules they encode in prose (e.g. `policy.mjs`'s refusal reasoning), which would trip
 * a naive whole-file regex. The mutation probe below tests exactly this, in both directions.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 *   1. Each of the two directories must contain at least one `.mjs` module. If either is empty,
 *      renamed, or this guard's path is wrong, this THROWS rather than reporting a pass over zero
 *      files for that directory.
 *   2. Every module walked must yield at least one non-empty extracted string, or this throws
 *      naming the file, on the same reasoning `claims-web-prose-truth.test.mjs` applies.
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
const CORPUS_DIRS = ['packages/reference-agent/src', 'packages/agent-sdk/src'];

/**
 * Every `.mjs` module directly inside each corpus directory. Enumerated from the filesystem,
 * never from a list, on the same rule every sibling claims guard's header states: a file added
 * today is covered today.
 */
const corpusModules = () => {
  const found = [];
  for (const dir of CORPUS_DIRS) {
    const abs = path.join(REPO, dir);
    const here = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => `${dir}/${e.name}`);
    // Tripwire 1 — see header. Per-directory, so one directory silently emptying cannot hide
    // behind the other still having files.
    assert.ok(
      here.length > 0,
      `${dir} yielded zero .mjs modules. Either this package moved, or this guard's path is ` +
        'wrong — either way this must FAIL rather than report a silent pass over zero coverage.',
    );
    found.push(...here);
  }
  return found;
};

/** Every module's file path alongside its extracted string-literal text, flattened into one
 * haystack per file. */
const modulesWithExtractedText = () =>
  corpusModules().map((file) => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    const strings = extractStringLiterals(source);
    // Tripwire 2 — see header.
    assert.ok(
      strings.length > 0,
      `${file}: extracted ZERO string literals. Treating that as "nothing to check" is exactly ` +
        'the silent skip this guard exists to refuse — fix the tokenizer rather than let this pass.',
    );
    return { file, text: flat(strings.join(' ')) };
  });

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('packages/reference-agent/src and packages/agent-sdk/src each have at least one .mjs module', () => {
  for (const dir of CORPUS_DIRS) {
    const abs = path.join(REPO, dir);
    const here = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs'));
    assert.ok(here.length > 0, `${dir} yielded zero .mjs modules`);
  }
});

const MIN_MODULES = 10;
const MIN_STRINGS = 150;

test('coverage: this guard actually walks a non-trivial slice of both packages', () => {
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
  const names = modules.map((m) => m.file);
  // Both directories represented, not just one carrying the whole floor.
  for (const dir of CORPUS_DIRS) {
    assert.ok(names.some((n) => n.startsWith(`${dir}/`)), `no module from ${dir} was walked`);
  }
});

test('no rendered string in either package says an AI agent pools capital or governs a vault', () => {
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

test('no rendered string in either package claims a single universal weighted-vote regime', () => {
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

test('every "stake-weighted" string in either package carries its sub-five-member qualifier', () => {
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

test('no rendered string in either package describes the sub-five regime as stake-blind', () => {
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

test('no rendered string in either package claims the contracts screen who may deposit', () => {
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

test("the operator's lack of power is enumerated, never claimed as a universal, in either package", () => {
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

test('no rendered string in either package attributes protocol fees, governance or entitlement to RWLY', () => {
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

test('no rendered string in either package claims a fee bypasses the operator as a person', () => {
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
      'anyone who stays (see claims-lede-truth.test.mjs guard 9). The ROUTING form is true; the\n' +
      'IDENTITY form is not.\n' +
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

  const renderedBad = [
    '// A module that refuses this shape in its own docs:',
    "export const bad = { reason: 'AI agents pool USDC into spot crypto index baskets.' };",
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

test('probe: this guard reds rather than passes if a corpus directory yields no modules at all', () => {
  const emptyDir = path.join(REPO, CORPUS_DIRS[0], '__does-not-exist__');
  assert.throws(
    () => readdirSync(emptyDir, { withFileTypes: true }),
    /ENOENT/,
    'sanity check on the probe itself: a missing directory must throw, not return []',
  );
  const assertNonEmpty = (found, dir) => {
    assert.ok(found.length > 0, `${dir} yielded zero .mjs modules`);
  };
  assert.throws(() => assertNonEmpty([], CORPUS_DIRS[0]), /zero \.mjs modules/);
  assertNonEmpty(['packages/reference-agent/src/agent.mjs'], CORPUS_DIRS[0]); // does not throw
});
