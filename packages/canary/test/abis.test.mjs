// @ts-check
/**
 * Drift guard for the embedded 4-byte selectors.
 *
 * abis.mjs hardcodes selectors so it needs no keccak and no viem at import time. That is only
 * safe if something recomputes them: this file does, with viem, and fails if a Solidity signature
 * ever moves out from under the exit-liveness classifier. A wrong selector there would silently
 * reclassify a real H-1 fault as a benign gate revert — the exact failure this package exists to
 * prevent — so the guard is not optional bookkeeping.
 *
 * Skips itself when viem is absent, matching packages/indexer/test/abis.test.mjs, so a bare
 * checkout still runs the suite. CI installs viem (`npm ci`), so the guard bites there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  REQUEST_EXIT_SELECTOR, EXIT_GATE_SELECTORS, EXIT_FROZEN_SELECTORS, EXIT_FAULT_SELECTORS,
  VAULT_VIEWS, ORACLE_VIEWS, VAULT_WATCH_EVENTS, ERC20_TRANSFER_EVENT, EXIT_SETTLED_EVENT,
  signatureOf,
} from '../src/abis.mjs';

const viem = await import('viem').catch(() => null);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../contracts/out');
const vaultAbiPath = join(OUT, 'VaultCore.sol/VaultCore.json');
const built = existsSync(vaultAbiPath);
const vaultAbi = built ? JSON.parse(readFileSync(vaultAbiPath, 'utf8')).abi ?? [] : [];
const canonical = (item) => `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;

/** Every embedded selector, mapped to the Solidity signature it must equal. */
const EXPECTED = {
  'requestExit(uint256)': REQUEST_EXIT_SELECTOR,
  'ZeroAmount()': '0x1f2a2005',
  'ExitAlreadyQueued()': '0xf2698fc0',
  'InsufficientShares()': '0x39996567',
  'CreatorStakeGate()': '0xa428ab2d',
  'ExitNeedsChildSettlement()': '0x07b1ee59',
  'ChildSettlementPending()': '0xb5ac4fd1',
  'StaleOracle(address)': '0xa2671f4b',
  'Reentrancy()': '0xab143c06',
  'NoQueuedExit()': '0xe752017c',
  'ExecutionStillPending()': '0x885cf1d7',
  'Error(string)': '0x08c379a0',
  'Panic(uint256)': '0x4e487b71',
};

test('every embedded selector matches the keccak of its signature', { skip: !viem && 'viem not installed' }, () => {
  for (const [sig, selector] of Object.entries(EXPECTED)) {
    assert.equal(viem.toFunctionSelector(sig), selector, `selector drift for ${sig}`);
  }
});

test('the classification tables are disjoint — no selector can be both a gate and a fault', () => {
  const tables = [EXIT_GATE_SELECTORS, EXIT_FROZEN_SELECTORS, EXIT_FAULT_SELECTORS];
  const seen = new Set();
  for (const table of tables) {
    for (const sel of Object.keys(table)) {
      assert.ok(!seen.has(sel), `selector ${sel} appears in more than one classification table`);
      seen.add(sel);
    }
  }
  assert.equal(seen.size, 12);
});

test('StaleOracle is NOT filed as a gate — it must never read as a healthy exit', () => {
  assert.ok(!('0xa2671f4b' in EXIT_GATE_SELECTORS));
  assert.ok('0xa2671f4b' in EXIT_FROZEN_SELECTORS);
});

test('the ABI table declares no state-changing function — the canary is read-only by construction', () => {
  for (const frag of [...VAULT_VIEWS, ...ORACLE_VIEWS]) {
    assert.equal(frag.stateMutability, 'view', `${frag.name} is not a view function`);
  }
});

test('watched event signatures match the contracts they are read from', { skip: !viem && 'viem not installed' }, () => {
  // These must equal the Solidity declarations in VaultCore.sol / the ERC20 standard, or getLogs
  // silently matches nothing and every event signal reports a permanent, false "0 events".
  const expected = {
    'ModuleCallFailed(bytes32,address)': VAULT_WATCH_EVENTS[0],
    'SliceEscrowed(address,address,uint256)': VAULT_WATCH_EVENTS[1],
    'Transfer(address,address,uint256)': ERC20_TRANSFER_EVENT,
    'ExitSettled(address,uint256,uint256,uint256,uint256)': EXIT_SETTLED_EVENT,
  };
  for (const [sig, frag] of Object.entries(expected)) {
    assert.equal(signatureOf(frag), sig);
    assert.equal(viem.toEventSelector(sig), viem.toEventSelector(signatureOf(frag)));
  }
});

// ── the real drift guard: compare against the COMPILED contracts, not just against ourselves ──

test('watched events exist on the compiled VaultCore with the same signature', { skip: !built && 'contracts/out absent — run `cd contracts && forge build`' }, () => {
  const declared = new Set(vaultAbi.filter((i) => i.type === 'event').map(canonical));
  for (const frag of [...VAULT_WATCH_EVENTS, EXIT_SETTLED_EVENT]) {
    assert.ok(declared.has(signatureOf(frag)), `${signatureOf(frag)} is not an event on the compiled VaultCore`);
  }
});

test('classified revert selectors correspond to errors the compiled VaultCore can actually throw', { skip: (!built || !viem) && 'needs contracts/out and viem', }, () => {
  const errors = new Set(vaultAbi.filter((i) => i.type === 'error').map(canonical));
  // Every GATE selector must be a real VaultCore error. If one of these silently stopped
  // existing, the classifier would file a live fault as a benign gate and the sentinel would
  // go quiet during an outage.
  for (const [selector, name] of Object.entries(EXIT_GATE_SELECTORS)) {
    const sig = `${name}()`;
    assert.ok(errors.has(sig), `${sig} is no longer an error on VaultCore — the gate classification is stale`);
    assert.equal(viem.toFunctionSelector(sig), selector);
  }
});

test('the views the signals read exist on the compiled VaultCore', { skip: !built && 'contracts/out absent' }, () => {
  const fns = new Map(vaultAbi.filter((i) => i.type === 'function').map((i) => [canonical(i), i]));
  for (const frag of VAULT_VIEWS) {
    const sig = signatureOf(frag);
    const onChain = fns.get(sig);
    assert.ok(onChain, `VaultCore has no ${sig} — the canary would read a reverting selector`);
    assert.equal(onChain.stateMutability, 'view', `${sig} is not a view on the compiled contract`);
  }
});

test('requestExit(uint256) is a real VaultCore function — the sentinel probes a live selector', { skip: !built && 'contracts/out absent' }, () => {
  const fns = vaultAbi.filter((i) => i.type === 'function').map(canonical);
  assert.ok(fns.includes('requestExit(uint256)'));
});
