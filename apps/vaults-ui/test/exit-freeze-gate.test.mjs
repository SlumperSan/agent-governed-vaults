// @ts-check
/**
 * The member surface never refused an irrevocable Mode-F exit queued while a vault is frozen.
 * `MemberActions.tsx`'s exit button was gated only on `!connected || exit.busy ||
 * !canSign(creatorGate)` -- no reference to `vault.frozen` anywhere in the file. The refusal
 * already existed and was already tested: `apps/web/src/vault-state.mjs`'s `actions(facts).exit`
 * calls this exact trap out by name (TRAP 1 in that file's own header) and this app's
 * `apps/vaults-ui/src/lib/atlas.ts` never imported it -- the only mention of `vault-state.mjs` in
 * the whole `apps/vaults-ui/src` tree was a code comment in `live-vaults.ts`. This is a wiring
 * job through the same seam #350 used for `previewExit`, not a reimplementation.
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

// ─────────────────── the alias and the re-export exist ───────────────────

test('vite.config.ts aliases @atlas/vault-state to apps/web/src/vault-state.mjs', () => {
  assert.match(VITE_CONFIG, /'@atlas\/vault-state':\s*atlas\('vault-state'\)/);
});

test("atlas.ts re-exports actions from '@atlas/vault-state'", () => {
  const m = /^export\s*\{([^}]*)\}\s*from\s*'@atlas\/vault-state';/m.exec(ATLAS);
  assert.ok(m, "no `export { ... } from '@atlas/vault-state'` line found");
  assert.ok(m[1].split(',').map((s) => s.trim()).includes('actions'), 'actions is not in the re-export list');
});

// ─────────────────── actions() is actually called, not just imported ───────────────────

test('MemberActions.tsx imports actions from ../lib/atlas', () => {
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/lib\/atlas';/.exec(MEMBER_ACTIONS);
  assert.ok(importBlock, 'no import block from ../lib/atlas found');
  assert.ok(importBlock[1].includes('actions'), 'actions is not imported');
});

/** The full `actions({ ... })` call source, brace-balanced. */
function actionsCallSource() {
  const start = MEMBER_ACTIONS.indexOf('actions({');
  assert.ok(start >= 0, 'actions( call not found');
  let depth = 0;
  for (let i = start + 'actions('.length - 1; i < MEMBER_ACTIONS.length; i++) {
    const c = MEMBER_ACTIONS[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return MEMBER_ACTIONS.slice(start, i + 1);
    }
  }
  throw new Error('actions( call never closes its braces');
}

test('the facts fed to actions() read frozen from the live vault, not a hardcoded value', () => {
  assert.match(actionsCallSource(), /frozen:\s*vault\.frozen/, 'frozen must come from the live vault prop, not a placeholder');
});

test('exitMode is derived from the live pendingExecution read, not assumed', () => {
  assert.match(
    actionsCallSource(),
    /exitMode:\s*pendingExecution === true \? 'F' : pendingExecution === false \? 'I' : 'unknown'/,
    'exitMode must map from the live pendingExecution read, covering all three states including "not yet read"',
  );
});

test('MUTATION: removing the vaultActions computation is caught', () => {
  const withoutCall = MEMBER_ACTIONS.replace(/const vaultActions: VaultActions \| null =[\s\S]*?\n {6}: null;/, 'const vaultActions = null;');
  assert.notEqual(withoutCall, MEMBER_ACTIONS, 'the mutation target text was not found -- update this test if the surrounding code moved');
  assert.doesNotMatch(withoutCall, /frozen:\s*vault\.frozen/, 'RED: with the call removed, the frozen-wiring guard above must fail');
});

// ─────────────────── the exit button is actually gated on the verdict ───────────────────

/** The `disabled={...}` attribute belonging to the "Request exit" button specifically, not the
 *  adjacent shares-input's own `disabled` prop or the unavailable-exit guard below the button. */
function exitButtonDisabledAttr() {
  const btnStart = MEMBER_ACTIONS.indexOf("{exit.busy ? 'Exiting…' : 'Request exit'}");
  assert.ok(btnStart >= 0, 'Request exit button text not found');
  const btnBlock = MEMBER_ACTIONS.slice(Math.max(0, btnStart - 400), btnStart);
  const m = /disabled=\{[^}]*\}/.exec(btnBlock);
  assert.ok(m, 'no disabled={...} attribute found near the Request exit button');
  return m[0];
}

test('the Request exit button is disabled when vaultActions.exit is unavailable', () => {
  assert.match(exitButtonDisabledAttr(), /!vaultActions\.exit\.available/, 'the exit button must be disabled when the frozen/queued-exit verdict refuses it');
});

test('MUTATION: reverting the button to the pre-fix disabled condition is caught', () => {
  const attr = exitButtonDisabledAttr();
  const preFix = MEMBER_ACTIONS.replace(attr, 'disabled={disabled || exit.busy || !canSign(creatorGate)}');
  assert.notEqual(preFix, MEMBER_ACTIONS, 'mutation target not found -- update this test if the button condition moved');
  const btnStart = preFix.indexOf("{exit.busy ? 'Exiting…' : 'Request exit'}");
  const btnBlock = preFix.slice(Math.max(0, btnStart - 400), btnStart);
  assert.doesNotMatch(btnBlock, /!vaultActions\.exit\.available/, 'RED: the pre-fix button must not gate on the verdict');
});

// ─────────────────── the refusal states its reason, not just a greyed button ───────────────────

test('an unavailable exit verdict renders vaultActions.exit.reason', () => {
  const guardIdx = MEMBER_ACTIONS.indexOf('{vaultActions && !vaultActions.exit.available ? (');
  assert.ok(guardIdx >= 0, 'the unavailable-exit guard was not found');
  const reasonIdx = MEMBER_ACTIONS.indexOf('{vaultActions.exit.reason}', guardIdx);
  assert.ok(reasonIdx >= 0, 'the exit refusal reason must actually be rendered, not just used to disable the button');
  assert.ok(reasonIdx - guardIdx < 800, 'the reason interpolation is implausibly far from its own guard -- check they are still the same block');
});

test('MUTATION: removing the reason paragraph is caught', () => {
  const idx = MEMBER_ACTIONS.indexOf('{vaultActions.exit.reason}');
  assert.ok(idx >= 0, 'reason paragraph not found');
  const lineStart = MEMBER_ACTIONS.lastIndexOf('\n', MEMBER_ACTIONS.lastIndexOf('\n', idx) - 1);
  const lineEnd = MEMBER_ACTIONS.indexOf('\n', idx);
  const withoutParagraph = MEMBER_ACTIONS.slice(0, lineStart) + MEMBER_ACTIONS.slice(lineEnd);
  assert.doesNotMatch(withoutParagraph, /\{vaultActions\.exit\.reason\}/, 'RED: the mutation must actually remove the rendered reason');
});

// ─────────────────── queuedExitShares: the one new chain read ───────────────────

test('ExitGateInputs carries queuedExitShares, and readExitGateInputs reads VaultCore.queuedExitShares(member)', () => {
  assert.match(CHAIN_ACTIONS, /interface ExitGateInputs \{[\s\S]*?readonly queuedExitShares: bigint \| null;/);
  assert.match(CHAIN_ACTIONS, /read\('queuedExitShares',\s*\[member\]\)/);
});

test('MUTATION: dropping queuedExitShares from the Promise.allSettled batch is caught', () => {
  const withoutRead = CHAIN_ACTIONS.replace(/\n\s*read\('queuedExitShares', \[member\]\),/, '');
  assert.notEqual(withoutRead, CHAIN_ACTIONS, 'the mutation target text was not found -- update this test if the read list moved');
  assert.doesNotMatch(withoutRead, /read\('queuedExitShares',\s*\[member\]\)/, 'RED: with the read removed, the guard above must fail');
});

test('vaultActions facts derive hasQueuedExit from the live queuedExitShares read, not a hardcoded false', () => {
  assert.match(actionsCallSource(), /hasQueuedExit:\s*exitGate\.queuedExitShares > 0n/, 'hasQueuedExit must be threaded from the live read');
});

// ─────── a FAILED queuedExitShares read must not collapse into "not queued" (Security finding) ───────
// `(exitGate.queuedExitShares ?? 0n) > 0n` reads a null (a reverted/failed call) the same as a
// genuine zero -- a member whose read failed would silently pass the "already queued" check as if
// it had succeeded and come back clean. Same shape as every other vanishing-disclosure defect this
// repo has found: a failed read is not an absence, and only ONE of the two renders as safe.

test('vaultActions is null (not computed with a defaulted fact) when queuedExitShares failed to read', () => {
  const m = /const vaultActions: VaultActions \| null =\s*\n\s*([^\n]*)\n/.exec(MEMBER_ACTIONS);
  assert.ok(m, 'vaultActions declaration not found');
  assert.match(m[1], /exitGate\.queuedExitShares !== null/, 'the guard must require a successfully-read queuedExitShares before computing any verdict');
});

test('MUTATION: dropping the queuedExitShares-not-null guard from vaultActions is caught', () => {
  const guardLine = /exitGate && shares !== null && exitGate\.queuedExitShares !== null/;
  assert.match(MEMBER_ACTIONS, guardLine, 'the three-part guard was not found as expected');
  const mutated = MEMBER_ACTIONS.replace(guardLine, 'exitGate && shares !== null');
  assert.notEqual(mutated, MEMBER_ACTIONS, 'mutation target not found');
  assert.doesNotMatch(mutated, /exitGate\.queuedExitShares !== null/, 'RED: the pre-fix guard must not require a successful read');
});

test('a failed queuedExitShares read renders its own stated-unknown message, not silence', () => {
  assert.match(MEMBER_ACTIONS, /queuedExitUnread/, 'the unread-queued-exit state must be tracked and rendered');
  assert.match(
    MEMBER_ACTIONS,
    /Whether you already have a queued exit could not be read from chain/,
    'the failed-read case must state that it is unknown, not stay silent',
  );
});

test('MUTATION: removing the queuedExitUnread message is caught', () => {
  const idx = MEMBER_ACTIONS.indexOf('Whether you already have a queued exit could not be read from chain');
  assert.ok(idx >= 0, 'message not found');
  const lineStart = MEMBER_ACTIONS.lastIndexOf('\n', MEMBER_ACTIONS.lastIndexOf('\n', idx) - 1);
  const lineEnd = MEMBER_ACTIONS.indexOf('\n', idx);
  const withoutMsg = MEMBER_ACTIONS.slice(0, lineStart) + MEMBER_ACTIONS.slice(lineEnd);
  assert.doesNotMatch(withoutMsg, /Whether you already have a queued exit could not be read from chain/, 'RED: the mutation must actually remove the message');
});

// ─────────────────── the settlement preview's frozen dependency must be explicit ───────────────────
// `previewExit` itself has no `frozen` parameter; today's basket is single-asset, so a frozen
// vault's one leg goes unpriced and `valueComplete` happens to go false -- correct total, wrong
// reason. `usdcPay` and any OTHER, still-healthy leg's value have no relationship to `frozen` at
// all. Security's finding: make the dependency explicit rather than relying on that coincidence.

test('preview is explicitly gated on !vault.frozen, not left to fall out of pricing', () => {
  const m = /const preview: ExitPreview \| null =\s*\n\s*([^\n]*)\n/.exec(MEMBER_ACTIONS);
  assert.ok(m, 'preview declaration not found');
  assert.match(m[1], /!vault\.frozen && exitGate && shares !== null/, 'preview must require !vault.frozen before calling previewExit at all');
});

test('MUTATION: dropping the !vault.frozen guard from preview is caught', () => {
  const guardLine = /!vault\.frozen && exitGate && shares !== null/;
  assert.match(MEMBER_ACTIONS, guardLine, 'the frozen guard was not found as expected');
  const mutated = MEMBER_ACTIONS.replace(guardLine, 'exitGate && shares !== null');
  assert.notEqual(mutated, MEMBER_ACTIONS, 'mutation target not found');
  assert.doesNotMatch(mutated, /!vault\.frozen && exitGate/, 'RED: the pre-fix preview must not depend on frozen at all');
});

test('a frozen vault renders an explicit no-preview message ahead of the table, not a computed one', () => {
  const frozenIdx = MEMBER_ACTIONS.indexOf('{vault.frozen ? (');
  assert.ok(frozenIdx >= 0, 'the frozen-preview guard was not found');
  const msgIdx = MEMBER_ACTIONS.indexOf('No preview while frozen', frozenIdx);
  assert.ok(msgIdx >= 0, 'the frozen case must render its own explicit message');
  const previewNullIdx = MEMBER_ACTIONS.indexOf('preview == null', frozenIdx);
  assert.ok(previewNullIdx > msgIdx, 'the frozen branch must be checked BEFORE the preview==null/table branches, not after');
});

test('MUTATION: removing the frozen-preview branch is caught', () => {
  const start = MEMBER_ACTIONS.indexOf('{vault.frozen ? (');
  assert.ok(start >= 0, 'frozen branch not found');
  const end = MEMBER_ACTIONS.indexOf(') : preview == null ? (', start);
  assert.ok(end >= 0, 'end of frozen branch not found');
  const withoutBranch = MEMBER_ACTIONS.slice(0, start) + '{preview == null ? (' + MEMBER_ACTIONS.slice(end + ') : preview == null ? ('.length);
  assert.doesNotMatch(withoutBranch, /No preview while frozen/, 'RED: the mutation must actually remove the frozen branch');
});
