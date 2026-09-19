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
