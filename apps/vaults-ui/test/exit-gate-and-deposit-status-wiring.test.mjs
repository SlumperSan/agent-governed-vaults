// @ts-check
/**
 * Wiring guards for connect-and-sign's two additions beyond deposit/vote/exit's happy path:
 * the creator withdrawal gate + exit-fee ceiling (`wallet-refusals.mjs`, #341) and deposit
 * status (`deposit-status.mjs`, #340), both now read live and gated in `MemberActions.tsx`.
 *
 * WHY SOURCE GUARDS FOR THE .ts/.tsx PIECES. Same reason as
 * `proposal-panel-delegated-weight.test.mjs`: this app has no JSX/TSX loader wired into
 * `node --test`, and `@atlas/*`/`@chain/*` only resolve through vite's own aliasing, not plain
 * Node module resolution. `pendingDeposit`'s FIELD ORDER, the one place this card's own new code
 * has real branching risk rather than a call into an already-tested pure module, gets a real
 * value assertion below instead — it needs no alias, `packages/canary/src/abis.mjs` is a plain
 * `.mjs` file importable directly.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_VIEWS } from '../../../packages/canary/src/abis.mjs';
import { formatUnits, parseUnits } from '../../web/src/format.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MEMBER_ACTIONS = join(APP, 'src/components/MemberActions.tsx');
const CHAIN_ACTIONS = join(APP, 'src/lib/chain-actions.ts');
const ATLAS = join(APP, 'src/lib/atlas.ts');
const VITE_CONFIG = join(APP, 'vite.config.ts');
const VAULT_CORE_SOL = join(ROOT, 'contracts/src/VaultCore.sol');

// ─────────────────── pendingDeposit field order — a real value assertion ───────────────────

test('pendingDeposit VAULT_VIEWS entry declares (amountUsdc, availableAt) in that order', () => {
  const frag = VAULT_VIEWS.find((f) => f.name === 'pendingDeposit');
  assert.ok(frag, 'no pendingDeposit entry in VAULT_VIEWS');
  assert.deepEqual(
    frag.outputs.map((o) => [o.name, o.type]),
    [['amountUsdc', 'uint256'], ['availableAt', 'uint64']],
    'pendingDeposit output order must match VaultCore.sol\'s PendingDeposit struct declaration ' +
      '(amountUsdc, availableAt) — Solidity\'s auto-getter for a struct mapping returns fields in ' +
      'declaration order, and a caller destructuring by POSITION (chain-actions.ts\'s ' +
      'readDepositStatusInputs) would silently swap the amount and the timestamp if this drifted',
  );
});

test('VaultCore.sol\'s PendingDeposit struct really is declared (amountUsdc, availableAt) — the fact the assertion above assumes', () => {
  const src = readFileSync(VAULT_CORE_SOL, 'utf8');
  const start = src.indexOf('struct PendingDeposit');
  assert.ok(start >= 0, 'PendingDeposit struct not found in VaultCore.sol — did it move or rename?');
  const end = src.indexOf('}', start);
  const block = src.slice(start, end);
  assert.match(block, /uint256\s+amountUsdc;[\s\S]*uint64\s+availableAt;/, 'struct field order changed');
});

test('the other four new VAULT_VIEWS entries wallet-refusals.mjs/deposit-status.mjs need are present, with the right shape', () => {
  const byName = Object.fromEntries(VAULT_VIEWS.map((f) => [f.name, f]));
  for (const [name, outType] of [
    ['nonCreatorMemberCount', 'uint256'],
    ['lastDepositTime', 'uint256'],
    ['exitFeeMaxBps', 'uint256'],
    ['exitFeeDecayPeriod', 'uint256'],
  ]) {
    assert.ok(byName[name], `VAULT_VIEWS has no ${name}`);
    assert.equal(byName[name].outputs[0].type, outType);
    assert.equal(byName[name].stateMutability, 'view');
  }
  // lastDepositTime takes the member address; the other three take none.
  assert.deepEqual(byName.lastDepositTime.inputs.map((i) => i.type), ['address']);
  assert.deepEqual(byName.nonCreatorMemberCount.inputs, []);
});

// ── contracts/out is optional here — packages/canary/test/abis.test.mjs is the drift guard that
// cross-checks these signatures against the compiled contract; skip only defers to it, never
// substitutes for it (that file's own header explains why the skip is safe).
const vaultAbiPath = join(ROOT, 'contracts/out/VaultCore.sol/VaultCore.json');
test(
  'the compiled VaultCore\'s pendingDeposit ALSO returns (amountUsdc, availableAt) in that order',
  { skip: !existsSync(vaultAbiPath) && 'contracts/out absent — run `cd contracts && forge build`' },
  () => {
    const abi = JSON.parse(readFileSync(vaultAbiPath, 'utf8')).abi ?? [];
    const frag = abi.find((f) => f.type === 'function' && f.name === 'pendingDeposit');
    assert.ok(frag, 'compiled VaultCore has no pendingDeposit function');
    assert.deepEqual(frag.outputs.map((o) => o.type), ['uint256', 'uint64']);
  },
);

// ─────────────────────── chain-actions.ts: the tuple destructure itself ───────────────────────

test('readDepositStatusInputs destructures the pendingDeposit tuple as [amountUsdc, availableAt]', () => {
  const src = readFileSync(CHAIN_ACTIONS, 'utf8');
  const start = src.indexOf('export async function readDepositStatusInputs');
  assert.ok(start >= 0, 'readDepositStatusInputs not found — did it move or get renamed?');
  const end = src.indexOf('\n}', start);
  const block = src.slice(start, end);
  assert.match(
    block,
    /pendingAmountUsdc:\s*pending\[0\]/,
    'pendingAmountUsdc must read pending[0] (amountUsdc is the FIRST struct field)',
  );
  assert.match(
    block,
    /availableAt:\s*Number\(pending\[1\]\)/,
    'availableAt must read pending[1] (availableAt is the SECOND struct field)',
  );
});

test('NON-VACUITY: the destructure regexes do not match a swapped-order reconstruction', () => {
  const swapped = `
export async function readDepositStatusInputs(publicClient, vault, member) {
  const [pending, sharesOf] = await Promise.all([...]);
  return { pendingAmountUsdc: pending[1], availableAt: Number(pending[0]), sharesOf };
}`;
  assert.doesNotMatch(swapped, /pendingAmountUsdc:\s*pending\[0\]/);
});

// ───────────────────────── MemberActions.tsx: the exit gate is wired in ─────────────────────────

test('the "Request exit" button is disabled when the creator gate refuses', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  const start = src.indexOf("'Request exit'");
  assert.ok(start >= 0, "'Request exit' button not found — did it move or get renamed?");
  // The disabled expression is on the <button> that CONTAINS this label, i.e. just before it.
  const buttonStart = src.lastIndexOf('<button', start);
  const block = src.slice(buttonStart, start);
  assert.match(
    block,
    /disabled=\{[^}]*!canSign\(creatorGate\)[^}]*\}/,
    'Request exit must be disabled while the creator gate would revert the call — ' +
      'otherwise a creator who would drop below 5% pays gas to learn that from the contract instead',
  );
});

test('NON-VACUITY: the same regex fails on the pre-wiring disabled expression', () => {
  const preFix = `<button type="button" className="btn" disabled={disabled || exit.busy} onClick={() => void handleExit()}>
          {exit.busy ? 'Exiting…' : 'Request exit'}
        </button>`;
  assert.doesNotMatch(preFix, /disabled=\{[^}]*!canSign\(creatorGate\)[^}]*\}/);
});

test('the exit fee ceiling is computed via exitFeeCeiling, not re-derived locally', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  assert.match(src, /exitFeeCeiling\(\{/, 'MemberActions must call exitFeeCeiling rather than computing a ceiling itself');
  assert.match(src, /creatorGateRefusal\(\{/, 'MemberActions must call creatorGateRefusal rather than re-deriving the 5% rule itself');
});

test('sendRevealVote still throws when the custody state is not CUSTODY_READY (unchanged safety guard)', () => {
  const src = readFileSync(CHAIN_ACTIONS, 'utf8');
  const start = src.indexOf('export async function sendRevealVote');
  assert.ok(start >= 0);
  const end = src.indexOf('\n}', start);
  const block = src.slice(start, end);
  assert.match(block, /if\s*\(!canReveal\(state\)\s*\|\|\s*state\.status\s*!==\s*'ready'\)\s*\{\s*throw/);
});

// ───────────────────────────────── atlas.ts / vite.config.ts wiring ─────────────────────────────────

test('atlas.ts re-exports the wallet-refusals and deposit-status surface MemberActions imports', () => {
  const src = readFileSync(ATLAS, 'utf8');
  assert.match(src, /canSign,\s*requestExitPricingRefusal,\s*creatorGateRefusal,\s*exitFeeCeiling.*from\s*'@atlas\/wallet-refusals'/s);
  assert.match(src, /classifyDepositStatus.*from\s*'@atlas\/deposit-status'/s);
});

test('vite.config.ts aliases @atlas/wallet-refusals and @atlas/deposit-status to apps/web/src', () => {
  const src = readFileSync(VITE_CONFIG, 'utf8');
  assert.match(src, /'@atlas\/wallet-refusals':\s*atlas\('wallet-refusals'\)/);
  assert.match(src, /'@atlas\/deposit-status':\s*atlas\('deposit-status'\)/);
});

// ────────────── "Use full balance": a WAD bigint must never reach the input as-is ──────────────
// A prior revision did `setExitInput(String(shares))` — shares is a raw WAD bigint, so a plain
// String() puts the already-scaled integer in the box, and handleExit's own parseUnits(_, 18)
// scales it AGAIN: one share (1e18) becomes 1e36, and every "use full balance" exit reverts.

test('real round-trip: formatUnits(shares, 18) then parseUnits(_, 18) reproduces the exact bigint, for whole, fractional and dust amounts', () => {
  for (const shares of [1n, 1_000_000_000_000_000_000n, 2_500_000_000_000_000_000n, 123_456_789_012_345_678n, 999_999_999_999_999_999_999n]) {
    const display = formatUnits(shares, 18, { minFrac: 0, maxFrac: 18, group: false });
    const parsed = parseUnits(display, 18, { unit: 'shares' });
    assert.ok(parsed.ok, `parseUnits rejected formatUnits' own output '${display}': ${parsed.ok ? '' : parsed.error}`);
    assert.equal(parsed.value, shares, `round trip broke for ${shares}: displayed '${display}', re-parsed to ${parsed.value}`);
  }
});

test('the OLD String(shares) path really does overscale by 1e18 — the defect this fix removes, reproduced rather than asserted', () => {
  const shares = 2_500_000_000_000_000_000n; // 2.5 WAD shares
  const buggy = parseUnits(String(shares), 18, { unit: 'shares' });
  assert.ok(buggy.ok);
  assert.equal(buggy.value, shares * 10n ** 18n, 'String(shares) fed through parseUnits(_, 18) must overscale by exactly 1e18 -- confirms the bug this test guards against was real');
});

test('"Use full balance" formats shares through formatUnits, not String()', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  const start = src.indexOf('Use full balance');
  assert.ok(start >= 0, "'Use full balance' button not found — did it move or get renamed?");
  const onClickStart = src.lastIndexOf('onClick', start);
  const block = src.slice(onClickStart, start);
  assert.match(
    block,
    /setExitInput\(formatUnits\(shares,\s*18/,
    'must format the raw WAD bigint through formatUnits before it reaches the (decimal-string) input',
  );
  assert.doesNotMatch(
    block,
    /setExitInput\(String\(shares\)\)/,
    'setExitInput(String(shares)) puts an unscaled integer where a decimal amount is expected — parseUnits(_, 18) then scales it again',
  );
});

// ─────────────────────── Deposit refused while a pending deposit is outstanding ───────────────────────
// VaultCore.sol:429: `require(pendingDeposit[msg.sender].amountUsdc == 0, PendingExists())`. A
// second deposit during the four-hour observation window always reverts — the UI must refuse it
// before a signature is requested, not let a member pay gas to learn it from the contract.

test('the Deposit button is disabled while depositStatus is unread, waiting, or available (a pending deposit)', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  const start = src.indexOf("{deposit.busy ? 'Depositing…' : 'Deposit'}");
  assert.ok(start >= 0, "Deposit button label not found — did it move or get renamed?");
  const buttonStart = src.lastIndexOf('<button', start);
  const block = src.slice(buttonStart, start);
  assert.match(block, /disabled=\{[^}]*depositBlocked[^}]*\}/, 'Deposit must be disabled by depositBlocked');
  const guard = src.slice(src.indexOf('const depositBlocked'), src.indexOf('const depositBlocked') + 400);
  for (const state of ['depositStatus == null', "depositStatus.state === 'unknown'", "depositStatus.state === 'waiting'", "depositStatus.state === 'available'"]) {
    assert.ok(guard.includes(state), `depositBlocked must cover ${state}`);
  }
});

test('NON-VACUITY: the pre-fix Deposit button (gated only on addrs) does not match the depositBlocked regex', () => {
  const preFix = `<button type="button" className="btn" disabled={disabled || deposit.busy || !addrs} onClick={() => void handleDeposit()}>
          {deposit.busy ? 'Depositing…' : 'Deposit'}
        </button>`;
  assert.doesNotMatch(preFix, /disabled=\{[^}]*depositBlocked[^}]*\}/);
});

// ─────────────────────── the exit-fee ceiling must never silently disappear ───────────────────────
// exitFeeCeiling can resolve to {kind:'unknown'} when its tenure inputs aren't read. A JSX branch
// that renders only the 'allowed' case makes the unknown state indistinguishable from "no fee
// applies" -- absence read as a fact. Read exitGate becoming reachable-while-partial (#345's
// Promise.allSettled fix) is exactly what makes this state reachable in ordinary operation.

test('the exit-fee ceiling renders an explicit message for BOTH exitFee === null and exitFee.kind === \'unknown\'', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  const start = src.indexOf('exit.error ? <p className="note tag-warn">{exit.error}</p>');
  const sectionStart = src.indexOf('<h3>Exit</h3>');
  assert.ok(sectionStart >= 0 && start > sectionStart);
  const block = src.slice(sectionStart, start);
  assert.match(block, /exitFee\s*==\s*null\s*\?/, 'must render something when exitFee has not been read yet (exitGate still null)');
  assert.match(block, /exitFee\.kind\s*===\s*'unknown'\s*\?/, "must render something when exitFee resolved to 'unknown'");
});

test('NON-VACUITY: the pre-fix allowed-only branch matches neither required pattern', () => {
  const preFix = `{exitFee?.kind === 'allowed' ? <p className="note dim">{exitFee.reason}</p> : null}`;
  assert.doesNotMatch(preFix, /exitFee\s*==\s*null\s*\?/);
  assert.doesNotMatch(preFix, /exitFee\.kind\s*===\s*'unknown'\s*\?/);
});
