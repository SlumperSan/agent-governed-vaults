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
  VAULT_VIEWS, ORACLE_VIEWS, CHAINLINK_ORACLE_VIEWS, AGGREGATOR_V3_VIEWS, CHAINLINK_FEED_IDENTITY_VIEWS,
  VAULT_WATCH_EVENTS, ERC20_TRANSFER_EVENT, EXIT_SETTLED_EVENT,
  signatureOf,
} from '../src/abis.mjs';

const viem = await import('viem').catch(() => null);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../contracts/out');
const vaultAbiPath = join(OUT, 'VaultCore.sol/VaultCore.json');
const built = existsSync(vaultAbiPath);
const vaultAbi = built ? JSON.parse(readFileSync(vaultAbiPath, 'utf8')).abi ?? [] : [];
const canonical = (item) => `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;

const oracleAbiPath = join(OUT, 'ChainlinkOracle.sol/ChainlinkOracle.json');
const oracleBuilt = existsSync(oracleAbiPath);
const oracleAbi = oracleBuilt ? JSON.parse(readFileSync(oracleAbiPath, 'utf8')).abi ?? [] : [];

const feedAbiPath = join(OUT, 'IAggregatorV3.sol/IAggregatorV3.json');
const feedBuilt = existsSync(feedAbiPath);
const feedAbi = feedBuilt ? JSON.parse(readFileSync(feedAbiPath, 'utf8')).abi ?? [] : [];

// `description()` is declared as its own interface inside ChainlinkOracle.sol, because the
// constructor reaches it by raw staticcall rather than through IAggregatorV3.
const descAbiPath = join(OUT, 'ChainlinkOracle.sol/IAggregatorV3Description.json');
const descBuilt = existsSync(descAbiPath);
const descAbi = descBuilt ? JSON.parse(readFileSync(descAbiPath, 'utf8')).abi ?? [] : [];

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
  for (const frag of [...VAULT_VIEWS, ...ORACLE_VIEWS, ...CHAINLINK_ORACLE_VIEWS, ...AGGREGATOR_V3_VIEWS, ...CHAINLINK_FEED_IDENTITY_VIEWS]) {
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

/**
 * THE GUARD THAT WAS MISSING.
 *
 * `VAULT_VIEWS` has been cross-checked against the compiled `VaultCore` since this file existed,
 * but the oracle table was only ever checked for `stateMutability === 'view'` — against itself,
 * never against a contract. That is precisely how the C-6 pivot left the oracle signal calling
 * `assetConfig`/`latestPrice` on a `ChainlinkOracle` that has neither: nothing in CI could tell.
 *
 * A signal reading a function the deployed contract does not have degrades once and then goes
 * silent forever, which is the worst failure a monitor has. This closes the compile-time half of
 * that; `signal.mjs`'s `detectorBroken()` and the transition tracker's escalation close the
 * runtime half.
 */
test('every ChainlinkOracle view the live oracle signal reads exists on the compiled contract', { skip: !oracleBuilt && 'contracts/out absent — run `cd contracts && forge build`' }, () => {
  const fns = new Map(oracleAbi.filter((i) => i.type === 'function').map((i) => [canonical(i), i]));
  for (const frag of CHAINLINK_ORACLE_VIEWS) {
    const sig = signatureOf(frag);
    const onChain = fns.get(sig);
    assert.ok(onChain, `ChainlinkOracle has no ${sig} — the oracle signal would read a reverting selector and go blind`);
    assert.equal(onChain.stateMutability, 'view', `${sig} is not a view on the compiled contract`);
    assert.deepEqual(
      onChain.outputs.map((o) => o.type), frag.outputs.map((o) => o.type),
      `${sig} return shape drifted — the signal would mis-decode the feed config`,
    );
  }
});

test('the retired aggregator views are NOT on ChainlinkOracle — the flavor split is real, not cosmetic', { skip: !oracleBuilt && 'contracts/out absent' }, () => {
  const fns = new Set(oracleAbi.filter((i) => i.type === 'function').map((i) => i.name));
  // If either of these ever appears, the flavor probe in oracle-health.mjs needs rethinking:
  // it distinguishes the two oracles by exactly this absence.
  assert.ok(!fns.has('assetConfig'), 'ChainlinkOracle now has assetConfig — the oracle flavor probe is no longer sound');
  assert.ok(!fns.has('sourcesFor'), 'ChainlinkOracle now has sourcesFor — the oracle flavor probe is no longer sound');
});

test('StaleOracle is an error ChainlinkOracle can actually throw — the freeze classification is live', { skip: (!oracleBuilt || !viem) && 'needs contracts/out and viem' }, () => {
  const errors = new Set(oracleAbi.filter((i) => i.type === 'error').map(canonical));
  assert.ok(errors.has('StaleOracle(address)'), 'ChainlinkOracle no longer declares StaleOracle(address)');
  assert.equal(viem.toFunctionSelector('StaleOracle(address)'), Object.keys(EXIT_FROZEN_SELECTORS)[0]);
});

/**
 * The same guard, one layer out. `AGGREGATOR_V3_VIEWS` is where `latestRoundData`'s five-field
 * tuple ORDER lives, and the oracle signal consumes different fields of that tuple for different
 * purposes: `updatedAt` (4th) is an asset feed's staleness, while the sequencer gate reads `answer`
 * (2nd) and `startedAt` (3rd) and must ignore `updatedAt` entirely. Confusing the 3rd and 4th
 * fields produces a detector that reads healthy straight through a grace period — a silent failure
 * during the exact hour member confusion peaks. Pin the shape against the compiled interface rather
 * than against this file's own opinion of it.
 */
test('the Chainlink feed tuple matches the compiled IAggregatorV3 — field ORDER is load-bearing', { skip: !feedBuilt && 'contracts/out absent — run `cd contracts && forge build`' }, () => {
  const fns = new Map(feedAbi.filter((i) => i.type === 'function').map((i) => [canonical(i), i]));
  for (const frag of AGGREGATOR_V3_VIEWS) {
    const sig = signatureOf(frag);
    const onChain = fns.get(sig);
    assert.ok(onChain, `IAggregatorV3 has no ${sig} — the oracle signal would read a reverting selector`);
    assert.equal(onChain.stateMutability, 'view');
    assert.deepEqual(
      onChain.outputs.map((o) => o.type), frag.outputs.map((o) => o.type),
      `${sig} return shape drifted`,
    );
    assert.deepEqual(
      onChain.outputs.map((o) => o.name), frag.outputs.map((o) => o.name),
      `${sig} field NAMES drifted — startedAt and updatedAt are adjacent uint256s and are not interchangeable`,
    );
  }
});

/**
 * The feed-identity table, split by what can actually be pinned.
 *
 * `decimals()` and `description()` are the HARM legs, and both are read by `ChainlinkOracle`'s own
 * constructor — `decimals()` through `IAggregatorV3`, `description()` through the
 * `IAggregatorV3Description` interface declared alongside it for the raw staticcall. Those two are
 * cross-checked against the compiled contracts here for the same reason the ChainlinkOracle table
 * is: a signal reading a selector the target does not implement goes blind, and this file is the
 * only place that can notice at build time.
 *
 * `aggregator()` and `phaseId()` are NOT checkable this way and are not pretended otherwise: they
 * belong to Chainlink's `EACAggregatorProxy`, which is not in this tree and is not ours to compile.
 * Their runtime failure is covered instead — `signals/feed-identity.mjs` reports a feed answering
 * neither as DETECTOR BROKEN, and test/feed-identity.test.mjs pins that.
 */
test('the feed-identity HARM legs exist on the compiled contracts the oracle itself reads them through', { skip: (!feedBuilt || !descBuilt) && 'contracts/out absent — run `cd contracts && forge build`' }, () => {
  const declared = new Map(
    [...feedAbi, ...descAbi].filter((i) => i.type === 'function').map((i) => [canonical(i), i]),
  );
  for (const name of ['decimals', 'description']) {
    const frag = CHAINLINK_FEED_IDENTITY_VIEWS.find((f) => f.name === name);
    const sig = signatureOf(frag);
    const onChain = declared.get(sig);
    assert.ok(onChain, `${sig} is not on IAggregatorV3/IAggregatorV3Description — the harm leg would read a reverting selector and go blind`);
    assert.equal(onChain.stateMutability, 'view');
    assert.deepEqual(
      onChain.outputs.map((o) => o.type), frag.outputs.map((o) => o.type),
      `${sig} return shape drifted — feed-identity would mis-decode the value it compares against the cached scale`,
    );
  }
});

test('the feed-identity IDENTITY legs are the EACAggregatorProxy signatures, and are recorded as unpinnable', () => {
  // Self-referential on purpose, and labelled as such: there is no compiled EACAggregatorProxy in
  // this repo to check against. The assertion is here so a rename is at least deliberate.
  assert.deepEqual(
    CHAINLINK_FEED_IDENTITY_VIEWS.map(signatureOf).sort(),
    ['aggregator()', 'decimals()', 'description()', 'phaseId()'],
  );
});
