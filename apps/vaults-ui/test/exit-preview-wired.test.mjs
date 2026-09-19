// @ts-check
/**
 * P-O12: `previewExit` (`apps/web/src/exit-preview.mjs`, math already covered by
 * `apps/web/test/exit-preview.test.mjs`) is actually IMPORTED AND CALLED by the member exit
 * surface, and the one input it needs that no prior read fetched — `VaultCore.costBasisUsdc` — is
 * actually read. Before this wiring, the exit block asked a member to sign `requestExit` with no
 * value, no basket breakdown and no settlement quote anywhere on the page, while the code that
 * could compute all three sat unimported in a sibling app.
 *
 * SOURCE GUARDS, same reason as every sibling wiring test in this file: no JSX/TSX loader in
 * `node --test`, `@atlas/*` only resolves through vite's own aliasing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MEMBER_ACTIONS = readFileSync(join(APP, 'src/components/MemberActions.tsx'), 'utf8');
const CHAIN_ACTIONS = readFileSync(join(APP, 'src/lib/chain-actions.ts'), 'utf8');
const ATLAS = readFileSync(join(APP, 'src/lib/atlas.ts'), 'utf8');
const VITE_CONFIG = readFileSync(join(APP, 'vite.config.ts'), 'utf8');

/** The full `previewExit({ ... })` call source, brace-balanced -- a non-greedy regex stops at the
 *  FIRST `}`, which is inside the nested `basket.map(...)` object literal and truncates before
 *  `costBasisUsdc` is ever reached. */
function previewExitCallSource() {
  const start = MEMBER_ACTIONS.indexOf('previewExit({');
  assert.ok(start >= 0, 'previewExit( call not found');
  let depth = 0;
  for (let i = start + 'previewExit('.length - 1; i < MEMBER_ACTIONS.length; i++) {
    const c = MEMBER_ACTIONS[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return MEMBER_ACTIONS.slice(start, i + 1);
    }
  }
  throw new Error('previewExit( call never closes its braces');
}

// ─────────────────── the alias and the re-export exist ───────────────────

test('vite.config.ts aliases @atlas/exit-preview to apps/web/src/exit-preview.mjs', () => {
  assert.match(VITE_CONFIG, /'@atlas\/exit-preview':\s*atlas\('exit-preview'\)/);
});

test("atlas.ts re-exports previewExit from '@atlas/exit-preview'", () => {
  const m = /^export\s*\{([^}]*)\}\s*from\s*'@atlas\/exit-preview';/m.exec(ATLAS);
  assert.ok(m, "no `export { ... } from '@atlas/exit-preview'` line found");
  assert.ok(m[1].split(',').map((s) => s.trim()).includes('previewExit'), 'previewExit is not in the re-export list');
});

// ─────────────────── previewExit is actually called, not just imported ───────────────────

test('MemberActions.tsx imports previewExit from ../lib/atlas', () => {
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/lib\/atlas';/.exec(MEMBER_ACTIONS);
  assert.ok(importBlock, 'no import block from ../lib/atlas found');
  assert.ok(importBlock[1].includes('previewExit'), 'previewExit is not imported');
});

test('MemberActions.tsx calls previewExit(', () => {
  assert.match(MEMBER_ACTIONS, /previewExit\(\{/, 'previewExit is imported but never called');
});

test('MUTATION: removing the previewExit call is caught', () => {
  const withoutCall = MEMBER_ACTIONS.replace(/const preview: ExitPreview \| null =[\s\S]*?\n {6}: null;/, 'const preview = null;');
  assert.notEqual(withoutCall, MEMBER_ACTIONS, 'the mutation target text was not found -- update this test if the surrounding code moved');
  assert.doesNotMatch(withoutCall, /previewExit\(\{/, 'RED: with the call removed, the call-guard above must fail');
});

// ─────────────────── the preview result is actually rendered ───────────────────

test('MemberActions.tsx renders preview.usdcPay / preview.slices / preview.payoutValueWad', () => {
  for (const field of ['preview.usdcPay', 'preview.slices', 'preview.payoutValueWad', 'preview.feeBps']) {
    assert.ok(MEMBER_ACTIONS.includes(field), `${field} is computed by previewExit but never rendered`);
  }
});

// ─────────── the perf-fee-cannot-be-bounded caveat (independent read on #350, REJECT) ───────────
// `previewExit` sets `perfFee: null` when the ceiling cannot be bounded (costBasisUsdc unread, an
// unpriced leg, or a child unwind) -- a real, reachable state, not a theoretical one. The first
// version of this file rendered nothing at all for it: no caveat on the USDC row, no warning
// paragraph, so a member saw a bare "Total value: $X" that looked final and was not.

test('the USDC-leg caveat names the unbounded-fee case specifically, matching apps/web/index.html', () => {
  assert.match(
    MEMBER_ACTIONS,
    /could not be bounded from the data here, so these are pre-fee/,
    'the index.html-equivalent caveat text is missing from the USDC leg',
  );
  assert.match(MEMBER_ACTIONS, /className=\{preview\.perfFee === null \? 'tag-warn' : 'dim'\}/, 'the caveat must be visually flagged (tag-warn), not styled as routine dim text');
});

test('a standalone warning paragraph fires specifically when perfFee cannot be bounded but a real total is shown', () => {
  const idx = MEMBER_ACTIONS.indexOf('The Total above is pre-fee, not a receipt');
  assert.ok(idx >= 0, 'the standalone Total-row warning is missing');
  const start = MEMBER_ACTIONS.lastIndexOf('{preview?.ok &&', idx);
  assert.ok(start >= 0, 'could not find the guarding condition before the warning');
  const guard = MEMBER_ACTIONS.slice(start, idx);
  assert.match(guard, /preview\.perfFee === null/, 'the warning must be gated on perfFee === null');
  assert.match(guard, /preview\.valueComplete/, 'must not fire when the total cannot be priced at all (a different, already-labelled case)');
  assert.match(guard, /!preview\.coversFromChildren/, 'must not duplicate the child-unwind warning');
  assert.match(guard, /preview\.payoutValueWad > 0n/, 'must not fire when there is no payout to warn about');
});

test('MUTATION: reverting to the pre-fix two-way branch (bounded-nonzero vs everything else) drops the caveat, caught', () => {
  const preFix = MEMBER_ACTIONS.replace(
    /<span className=\{preview\.perfFee === null[\s\S]*?<\/span>/,
    "<span className=\"dim\">idle stables{preview.perfFee !== null && preview.perfFee.maxUsdc > 0n ? ', before the performance fee below' : ''}</span>",
  );
  assert.notEqual(preFix, MEMBER_ACTIONS, 'mutation target not found -- update this test if the branch moved');
  assert.doesNotMatch(preFix, /could not be bounded from the data here/, 'RED: the pre-fix shape must not carry the caveat');
});

test('MUTATION: removing the standalone warning paragraph is caught', () => {
  const idx = MEMBER_ACTIONS.indexOf('The Total above is pre-fee, not a receipt');
  const withoutWarning = MEMBER_ACTIONS.slice(0, idx - 400) + MEMBER_ACTIONS.slice(MEMBER_ACTIONS.indexOf('{exit.message', idx));
  assert.doesNotMatch(withoutWarning, /The Total above is pre-fee/, 'RED: the mutation must actually remove the warning');
});

// ─────────────────── costBasisUsdc: the one new chain read ───────────────────

test("ExitGateInputs carries costBasisUsdc, and readExitGateInputs reads VaultCore.costBasisUsdc(member)", () => {
  assert.match(CHAIN_ACTIONS, /interface ExitGateInputs \{[\s\S]*?readonly costBasisUsdc: bigint \| null;/);
  assert.match(CHAIN_ACTIONS, /read\('costBasisUsdc',\s*\[member\]\)/);
});

test('MUTATION: dropping costBasisUsdc from the Promise.allSettled batch is caught', () => {
  const withoutRead = CHAIN_ACTIONS.replace(/\n\s*read\('costBasisUsdc', \[member\]\),/, '');
  assert.notEqual(withoutRead, CHAIN_ACTIONS, 'the mutation target text was not found -- update this test if the read list moved');
  assert.doesNotMatch(withoutRead, /read\('costBasisUsdc',\s*\[member\]\)/, 'RED: with the read removed, the guard above must fail');
});

test('MemberActions.tsx passes costBasisUsdc through to previewExit, not a hardcoded value', () => {
  assert.match(previewExitCallSource(), /costBasisUsdc:\s*exitGate\.costBasisUsdc/, 'costBasisUsdc must be threaded from the live read, not a placeholder');
});

// ─────────────────── the decimals derivation is sound, not a guess ───────────────────

test('the basket mapped into previewExit derives decimals from assetUnit, never a hardcoded number', () => {
  assert.match(previewExitCallSource(), /decimals:\s*Math\.round\(Math\.log10\(Number\(leg\.assetUnit\)\)\)/, 'decimals must be derived from the live assetUnit read, not assumed (e.g. hardcoded 18 or 8)');
});
