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
import { readFileSync, existsSync } from 'node:fs';
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
const CONTRACTS_LIB_DIR = join(ROOT, 'contracts/src/lib');

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

/**
 * Every library name a single-library `using X for Y;` declaration binds, in declaration order. A
 * revert bubbling up from inside a `using`-bound library (e.g. `usdc.safeTransferFrom(...)` at
 * VaultCore.sol:420, bound via `using SafeTransferLib for address;` at VaultCore.sol:39) is still
 * a revert on the caller's own call frame, so its errors belong in the same decode set as the
 * contract's own — this is the scan `KNOWN_ERRORS_ABI`'s header comment previously did NOT cover
 * (confirmed gap: `TransferFromFailed`/`TransferFailed`/`ApproveFailed` were absent).
 *
 * Solidity 0.8.13+ also allows the selective form `using {fn1, fn2} for T;`, which this regex
 * cannot parse (the capture group is `[A-Za-z0-9_]+`, and `{` is not in it). Silently returning
 * fewer names than there are `using` declarations would recreate the exact "matches what I chose
 * to scan, not what's reachable" shape this guard exists to close — so this throws on a count
 * mismatch instead of under-reporting.
 */
function usingLibraryNames(src) {
  const names = [...src.matchAll(/using\s+([A-Za-z0-9_]+)\s+for\s+[^;]+;/g)].map((m) => m[1]);
  const totalUsingDeclarations = (src.match(/using\s+[^;]+;/g) ?? []).length;
  if (totalUsingDeclarations !== names.length) {
    throw new Error(
      `usingLibraryNames: found ${totalUsingDeclarations} 'using' declaration(s) but parsed only ${names.length} single-library name(s) — a selective-import form ('using {fn1, fn2} for T;') or other shape this regex cannot parse is present. Extend the parser rather than under-scanning.`,
    );
  }
  return names;
}

/**
 * Resolve `using`-bound library names to their source text under `contracts/src/lib/`. Throws
 * rather than skipping an unresolved name: a silent skip here would make the coupling guard pass
 * vacuously the moment a library moves or is renamed, which is a worse failure mode than a loud
 * one (the exact "guard that can skip is a guard that will" trap this scan exists to avoid).
 */
function readLibrarySources(libDir, names) {
  return names.map((name) => {
    const path = join(libDir, `${name}.sol`);
    if (!existsSync(path)) {
      throw new Error(
        `simulate-before-sign coupling guard: VaultCore.sol binds library '${name}' via 'using', but '${path}' does not exist — update the guard's library resolution before trusting its coverage claim.`,
      );
    }
    return readFileSync(path, 'utf8');
  });
}

/** Union of every error name declared across a set of library source texts. */
function libraryErrorNames(libSources) {
  return libSources.flatMap((src) => declaredErrors(src));
}

/** Every `error Name(...)` declaration in a Solidity source, mapped to its parameter count. */
function declaredErrorArities(src) {
  return Object.fromEntries(
    [...src.matchAll(/^\s*error\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm)].map((m) => {
      const params = m[2].trim();
      return [m[1], params.length === 0 ? 0 : params.split(',').length];
    }),
  );
}

/** The `{ type: 'error', name: 'X', inputs: [...] }` entries in `KNOWN_ERRORS_ABI`, each with its
 * `inputs` arity — a name match alone is not enough: viem decodes by 4-byte selector, which is
 * derived from the full `Name(type1,type2,...)` signature, so an arity mismatch means the entry
 * cannot decode that error at all even though `abiErrorNames()` reports the name as "present". */
function abiErrorEntries() {
  const block = /const KNOWN_ERRORS_ABI = \[([\s\S]*?)\] as const satisfies Abi;/.exec(CHAIN_ACTIONS);
  assert.ok(block, 'KNOWN_ERRORS_ABI block not found in chain-actions.ts — did it move or get renamed?');
  const entries = [...block[1].matchAll(/\{\s*type:\s*'error',\s*name:\s*'([A-Za-z0-9_]+)',\s*inputs:\s*\[([^\]]*)\]\s*\}/g)];
  assert.ok(entries.length > 0, 'abiErrorEntries: regex matched zero entries — did the KNOWN_ERRORS_ABI entry shape change?');
  return entries.map((m) => ({ name: m[1], arity: (m[2].match(/\{\s*name:/g) ?? []).length }));
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

test('KNOWN_ERRORS_ABI names every error declared by a library VaultCore.sol or Governance.sol binds via `using`', () => {
  // The gap Security found: KNOWN_ERRORS_ABI's own scan was three hand-named contract files, not
  // what VaultCore.sol/Governance.sol actually bind via `using`, so SafeTransferLib's three errors
  // (reachable directly from deposit()'s usdc.safeTransferFrom(...), VaultCore.sol:420) were
  // silently outside the scan. This test re-derives the library list from source instead of
  // hand-naming it (see the `usingLibraryNames` doc comment for why an under-parse there throws
  // rather than silently scanning fewer libraries than actually exist), so the NEXT library either
  // contract starts `using` is caught the same way. Governance.sol binds none today (confirmed by
  // grep) but is scanned anyway — commitVote/revealVote write to it, so its reachable reverts
  // belong in the same decode set, and leaving it unscanned would recreate this exact asymmetry.
  const names = [...new Set([...usingLibraryNames(VAULT_CORE_SOL), ...usingLibraryNames(GOVERNANCE_SOL)])];
  assert.ok(names.length >= 1, 'expected at least one using-bound library across VaultCore.sol/Governance.sol');
  const declared = libraryErrorNames(readLibrarySources(CONTRACTS_LIB_DIR, names));
  const listed = abiErrorNames();
  const missing = declared.filter((n) => !listed.includes(n));
  assert.deepEqual(
    missing,
    [],
    `a library VaultCore.sol/Governance.sol binds via 'using' declares errors chain-actions.ts cannot decode: ${missing.join(', ')}`,
  );
});

test('KNOWN_ERRORS_ABI entries decode with the same arity Solidity declares', () => {
  // A name match alone is not sufficient: viem's decoder keys off the 4-byte selector, which
  // encodes the full `Name(type1,type2,...)` signature. An entry with the right name but the wrong
  // `inputs` arity silently fails to decode — the exact "wallet-level raw selector" failure mode
  // this whole PR exists to remove, and `abiErrorNames()` alone cannot see it because it only reads
  // the `name:` field. Scoped to VaultCore.sol/Governance.sol/IOracleAggregator.sol, whose errors
  // are already asserted present by name above; the bound-library errors added in this change
  // (TransferFailed/TransferFromFailed/ApproveFailed/ValueOverflow) were arity-checked by hand
  // against SafeTransferLib.sol/Checkpoints.sol when they were added.
  const declaredArities = {
    ...declaredErrorArities(VAULT_CORE_SOL),
    ...declaredErrorArities(GOVERNANCE_SOL),
    ...declaredErrorArities(ORACLE_IFACE_SOL),
  };
  const mismatches = abiErrorEntries()
    .filter((e) => e.name in declaredArities && e.arity !== declaredArities[e.name])
    .map((e) => `${e.name}: ABI lists ${e.arity} input(s), Solidity declares ${declaredArities[e.name]}`);
  assert.deepEqual(mismatches, [], `arity mismatch(es) mean these decode by name only, not by the selector viem actually matches on: ${mismatches.join('; ')}`);
});

test('MUTATION: a `using` binding to a library with an error absent from KNOWN_ERRORS_ABI reds', () => {
  // Fixture only — never touches the real VaultCore.sol or a real lib file, per this file's own
  // mutation-test style above (the writeContract-shape fixture). Proves the new scan-scope logic
  // actually catches a library error that KNOWN_ERRORS_ABI does not list, using a name guaranteed
  // not to already be in that list.
  const fixtureVaultCoreSrc = `
  contract VaultCore {
      using FixtureLib for address;
  }`;
  const fixtureLibSource = `
  library FixtureLib {
      error FixtureUndeclaredError();
  }`;

  const names = usingLibraryNames(fixtureVaultCoreSrc);
  assert.deepEqual(names, ['FixtureLib'], 'RED setup: the fixture must bind exactly one library');

  const declared = libraryErrorNames([fixtureLibSource]);
  const listed = abiErrorNames();
  assert.ok(!listed.includes('FixtureUndeclaredError'), 'fixture error name must not already be a real KNOWN_ERRORS_ABI entry');
  const missing = declared.filter((n) => !listed.includes(n));
  assert.deepEqual(missing, ['FixtureUndeclaredError'], 'RED: a using-bound library error missing from KNOWN_ERRORS_ABI must be caught');
});

test('MUTATION: the same fixture with the `using` binding removed is GREEN', () => {
  // Same fixture, binding removed — nothing left to scan, so nothing can be reported missing.
  // This is the other direction of the mutation test above: prove the guard does not fire when
  // there is genuinely no `using` binding to a library with an undecoded error. Runs through the
  // real `readLibrarySources` (against the real CONTRACTS_LIB_DIR, on an empty name list) rather
  // than asserting on a hand-built empty array, so this exercises the actual production code path
  // on the zero-names case instead of restating it.
  const fixtureVaultCoreSrcNoBinding = `
  contract VaultCore {
      // no using declaration
  }`;
  const names = usingLibraryNames(fixtureVaultCoreSrcNoBinding);
  assert.deepEqual(names, [], 'GREEN setup: the fixture must bind no libraries');
  const declared = libraryErrorNames(readLibrarySources(CONTRACTS_LIB_DIR, names));
  assert.deepEqual(declared, [], 'GREEN: no using binding means nothing to scan, nothing missing');
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
