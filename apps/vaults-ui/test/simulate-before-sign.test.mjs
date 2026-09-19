// @ts-check
/**
 * Simulate-before-sign (frontend security pass A3). Every write in `chain-actions.ts` now runs
 * `publicClient.simulateContract` before `walletClient.writeContract`, so a revert surfaces before
 * a member signs and pays gas rather than after.
 *
 * WHY SOURCE GUARDS, NOT A LIVE ANVIL/MOCK-WALLET RUN. Same constraint as the sibling wiring-guard
 * files: `apps/vaults-ui` has no JSX/TSX loader wired into `node --test`, and `chain-actions.ts`'s
 * `@chain/*` imports only resolve through vite's own aliasing. The frontend security pass that
 * FOUND this defect (`Findings/2026-09-19-frontend-security-pass-EXECUTED.md`) exercised the real
 * function against a real deployed vault with a mocked EIP-1193 provider and logged the actual RPC
 * call order — that is real evidence this fix closes the gap it found, but it was a one-off pass,
 * not committed CI infrastructure, and this file does not attempt to rebuild an anvil-backed
 * integration harness as part of this change. What IS checked here, for real: every error the
 * contracts can revert with is present for decoding (a coupling guard, mutation-tested against the
 * actual Solidity source, not a hand-typed list nobody re-derives), and every write call site is
 * wired through the simulate step rather than signing blind.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CHAIN_ACTIONS = readFileSync(join(APP, 'src/lib/chain-actions.ts'), 'utf8');
const VAULT_CORE_SOL = readFileSync(join(ROOT, 'contracts/src/VaultCore.sol'), 'utf8');
const GOVERNANCE_SOL = readFileSync(join(ROOT, 'contracts/src/Governance.sol'), 'utf8');
const ORACLE_IFACE_SOL = readFileSync(join(ROOT, 'contracts/src/interfaces/IOracleAggregator.sol'), 'utf8');

/** Every `error Name(...)` declaration in a Solidity source, by name. */
function declaredErrors(src) {
  return [...src.matchAll(/^\s*error\s+([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]);
}

/** The `{ type: 'error', name: 'X', ... }` entries actually listed in `KNOWN_ERRORS_ABI`. */
function abiErrorNames() {
  const block = /const KNOWN_ERRORS_ABI = \[([\s\S]*?)\] as const satisfies Abi;/.exec(CHAIN_ACTIONS);
  assert.ok(block, 'KNOWN_ERRORS_ABI block not found in chain-actions.ts — did it move or get renamed?');
  return [...block[1].matchAll(/name:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
}

// ─────────────────── coupling: every contract error is decodable ───────────────────

test('KNOWN_ERRORS_ABI names every error VaultCore.sol declares', () => {
  const declared = declaredErrors(VAULT_CORE_SOL);
  assert.ok(declared.length >= 20, `expected a real error list from VaultCore.sol, got ${declared.length}`);
  const listed = abiErrorNames();
  const missing = declared.filter((n) => !listed.includes(n));
  assert.deepEqual(missing, [], `VaultCore.sol declares errors chain-actions.ts cannot decode: ${missing.join(', ')}`);
});

test('KNOWN_ERRORS_ABI names every error Governance.sol declares', () => {
  const declared = declaredErrors(GOVERNANCE_SOL);
  assert.ok(declared.length >= 20, `expected a real error list from Governance.sol, got ${declared.length}`);
  const listed = abiErrorNames();
  const missing = declared.filter((n) => !listed.includes(n));
  assert.deepEqual(missing, [], `Governance.sol declares errors chain-actions.ts cannot decode: ${missing.join(', ')}`);
});

test('StaleOracle (IOracleAggregator.sol) is decodable — navWad() reaches it from both write paths', () => {
  const declared = declaredErrors(ORACLE_IFACE_SOL);
  assert.ok(declared.includes('StaleOracle'), 'IOracleAggregator.sol no longer declares StaleOracle — did the interface change?');
  assert.ok(abiErrorNames().includes('StaleOracle'));
});

test('MUTATION: a source that dropped one error from VaultCore.sol reds against the real ABI list', () => {
  // Non-vacuity for the coupling test above: prove it actually reds on a real omission, using the
  // ACTUAL listed names (not a fixture that could drift from KNOWN_ERRORS_ABI on its own).
  const listedMinusOne = abiErrorNames().filter((n) => n !== 'CreatorStakeGate');
  const declared = declaredErrors(VAULT_CORE_SOL);
  const missing = declared.filter((n) => !listedMinusOne.includes(n));
  assert.deepEqual(missing, ['CreatorStakeGate'], 'removing one name from the ABI list must be visible as exactly one missing error');
});

test('non-vacuity: the ABI list is not accidentally empty or trivially short', () => {
  assert.ok(abiErrorNames().length >= 50, `KNOWN_ERRORS_ABI has only ${abiErrorNames().length} entries — a truncated list would pass the two tests above vacuously if both source files also shrank together, which they cannot`);
});

// ─────────────────── every write call site routes through simulateThenWrite ───────────────────

for (const fn of ['approve', 'deposit', 'commitVote', 'revealVote', 'requestExit']) {
  test(`the ${fn} call site uses simulateThenWrite, not a direct walletClient.writeContract`, () => {
    const idx = CHAIN_ACTIONS.indexOf(`functionName: '${fn}'`);
    assert.ok(idx >= 0, `functionName: '${fn}' not found in chain-actions.ts`);
    // The call site is the nearest preceding `simulateThenWrite(` or `walletClient.writeContract(`.
    const before = CHAIN_ACTIONS.slice(0, idx);
    const simulateAt = before.lastIndexOf('simulateThenWrite(');
    const directAt = before.lastIndexOf('walletClient.writeContract({');
    assert.ok(simulateAt >= 0, `no simulateThenWrite( found before the '${fn}' call`);
    assert.ok(simulateAt > directAt, `'${fn}' is closer to a direct walletClient.writeContract than to simulateThenWrite — it may have regressed to signing blind`);
  });
}

test('MUTATION: reverting one call site to a direct writeContract is caught', () => {
  // Reconstructs exactly the pre-fix shape for `deposit` and confirms the guard above would red.
  const preFixShape = `
  const depositHash = await walletClient.writeContract({
    address: vault,
    abi: VAULT_WRITE_ABI,
    functionName: 'deposit',
    args: [amountUsdc],
    account,
    chain: TARGET_CHAIN,
  });`;
  const idx = preFixShape.indexOf(`functionName: 'deposit'`);
  const before = preFixShape.slice(0, idx);
  const simulateAt = before.lastIndexOf('simulateThenWrite(');
  const directAt = before.lastIndexOf('walletClient.writeContract({');
  assert.equal(simulateAt, -1, 'RED: the pre-fix shape has no simulateThenWrite at all');
  assert.ok(directAt >= 0, 'RED: the pre-fix shape signs directly');
});

// ─────────────────── describeRevert never invents a name it cannot decode ───────────────────

test('describeRevert is exported and named for what it does, so a future caller cannot mistake it for a UI string', () => {
  assert.match(CHAIN_ACTIONS, /function describeRevert\(err: unknown\): string/, 'describeRevert signature changed or was removed');
  assert.match(CHAIN_ACTIONS, /return err\.shortMessage \?\? err\.message;/, 'the un-decodable fallback must be the real error message, never an invented reason');
});
