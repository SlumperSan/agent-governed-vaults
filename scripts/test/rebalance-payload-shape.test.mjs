/**
 * Regression guard for card 207: scripts/smoke-test.mjs's buildPayload() encoded a 2-field
 * Rebalance payload while Governance.execute's Rebalance branch decodes 3
 * (`abi.decode(payload, (address, uint256, IExecutionAdapter.SwapOrder[]))`, since
 * `maxSlippageBps` was added). A 2-field encode decodes on that contract as garbage -- the
 * array's offset word gets read as `maxSlippageBps` and everything downstream shifts --
 * reproduced live as a bare Panic(0x41) that says nothing about its cause. Before this file,
 * scripts/gate.mjs only `node --check`s scripts/smoke-test.mjs, so nothing caught it.
 *
 * This test does NOT hand-maintain a second copy of the field list -- that is what drifted the
 * first time. Instead it:
 *
 *   1. runs the REAL, unmodified scripts/smoke-test.mjs end to end through the existing
 *      fake-chain harness (run-smoke-child.mjs / cast-fixture-chain.mjs, built for card 176)
 *      and reads the exact `cast abi-encode` signature + args buildPayload() invoked, off a log
 *      entry the fixture now records (cast-fixture-chain.mjs's `abi-encode` handler);
 *   2. re-derives the REAL ABI bytes from that captured sig+args via the real `cast` binary --
 *      the fixture's own `fakeAbiEncode` is a placeholder hex string with no real ABI meaning
 *      (see its docstring), so it cannot be decoded and is deliberately not used here;
 *   3. derives the canonical decode signature FROM THE COMPILED CONTRACT
 *      (contracts/out/VaultCore.sol/VaultCore.json's `executeRebalance` ABI -- typed
 *      identically to the three params Governance.sol's Rebalance branch destructures the
 *      payload into) rather than typing the tuple out by hand a second time;
 *   4. decodes the real payload bytes against that derived signature with real `cast
 *      abi-decode`, so a field-count mismatch fails HERE, at the encode/decode boundary,
 *      instead of six hours into a wall-clock testnet run as an unexplained Panic(0x41).
 *
 * Lives in scripts/test/, matched by the `scripts/test/*.test.mjs` glob in package.json's
 * `test:backend`, which `npm run gate` runs -- so this runs in CI on every PR.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSmokeChild, FIXTURES, ROOT } from './lib/run-smoke-child.mjs';

const CAST = process.env.CAST ?? 'cast';
function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8' }).trim();
}

/**
 * A canonical ABI type string from a forge ABI input descriptor, recursing into `components`
 * for tuples. This is the mechanism that lets step 3 above read the field list off the
 * artifact instead of retyping it -- a hand-typed copy is the exact shape of bug card 207
 * found (the encoder's field list and the contract's decode drifted apart).
 */
function typeOf(input) {
  if (input.type.startsWith('tuple')) {
    const suffix = input.type.slice('tuple'.length); // '', '[]', or '[N]'
    return `(${input.components.map(typeOf).join(',')})${suffix}`;
  }
  return input.type;
}

test('Rebalance payload: buildPayload() encodes exactly what VaultCore.executeRebalance decodes', () => {
  // ---- the canonical shape, read off the compiled contract, not hand-typed ----
  const artifactPath = path.join(ROOT, 'contracts', 'out', 'VaultCore.sol', 'VaultCore.json');
  assert.ok(fs.existsSync(artifactPath), `compiled artifact missing at ${artifactPath} -- run forge build`);
  const abi = JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
  const fn = abi.find((e) => e.type === 'function' && e.name === 'executeRebalance');
  assert.ok(fn, 'executeRebalance not found in the VaultCore ABI -- has it been renamed?');
  assert.equal(fn.inputs.length, 3,
    `VaultCore.executeRebalance now takes ${fn.inputs.length} params, not 3 -- Governance.sol's `
    + 'Rebalance decode and this test both need updating for the new shape, not just this count.');
  assert.equal(fn.inputs[0].type, 'address', 'param 0 of executeRebalance is no longer address');
  assert.equal(fn.inputs[1].type, 'uint256', 'param 1 of executeRebalance is no longer uint256');
  assert.equal(fn.inputs[1].name, 'maxSlippageBps', 'param 1 of executeRebalance is no longer maxSlippageBps');
  const decodeSig = `f(${fn.inputs.map(typeOf).join(',')})`;

  // ---- the expected adapter address, read off the same fixture deploy JSON smoke-test.mjs itself loads ----
  const deployJson = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'deploy-run-latest.json'), 'utf8'));
  const adapterTx = deployJson.transactions.find(
    (t) => t.transactionType === 'CREATE' && t.contractName === 'AggregationRouterAdapter',
  );
  assert.ok(adapterTx, 'fixture deploy JSON has no AggregationRouterAdapter CREATE entry');
  // The fixture's own comment says its addresses are "never dialled" through cast -- true for
  // every other consumer, but this test is the first to feed one through real `cast
  // abi-encode`/`abi-decode`, which requires a full 20-byte address. Left-pad rather than edit
  // the shared fixture file: the fixture's addresses stay exactly as every other test reads
  // them, and this normalization is local to the one place that newly needs 40 hex digits.
  const expectedAdapter = '0x' + adapterTx.contractAddress.slice(2).padStart(40, '0');

  // ---- the REAL sig+args buildPayload() invoked, from the REAL unmodified script's own run ----
  const r = runSmokeChild({ scenario: 'happy' });
  assert.equal(r.status, 0, `happy-path run did not exit 0.\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  // buildPayload() is the only abi-encode call in scripts/smoke-test.mjs whose signature starts
  // with 'f(address,' -- the commit-vote commitment's is 'f(uint256,address,bool,bytes32)'.
  const encodeCalls = r.callLog.filter((e) => e.kind === 'abi-encode' && e.sig?.startsWith('f(address,'));
  assert.equal(encodeCalls.length, 1,
    `expected exactly one Rebalance-shaped abi-encode call, found ${encodeCalls.length}: `
    + `${JSON.stringify(encodeCalls)}`);
  const { sig: realSig, args: realArgs } = encodeCalls[0];
  // Same left-pad as expectedAdapter above, applied only to the address-typed arg (index 0):
  // buildPayload() sourced it from the same short-form fixture address, and it needs the same
  // 40 hex digits to go through real `cast abi-encode`.
  const isAddr = /^0x[0-9a-fA-F]+$/.test(realArgs[0]);
  assert.ok(isAddr, `expected arg 0 of the captured abi-encode call to be an address, got: ${realArgs[0]}`);
  const paddedArgs = ['0x' + realArgs[0].slice(2).padStart(40, '0'), ...realArgs.slice(1)];

  // ---- re-derive the REAL ABI bytes from that captured invocation, via the real cast binary ----
  const payload = cast(['abi-encode', realSig, ...paddedArgs]);

  // ---- the actual regression check: decode the REAL payload against the REAL contract shape ----
  let decoded;
  assert.doesNotThrow(() => {
    decoded = cast(['abi-decode', '--input', decodeSig, payload]);
  }, `buildPayload() invoked abi-encode with signature '${realSig}', which does not decode as `
    + `VaultCore.executeRebalance's real (${decodeSig}) shape -- this is the exact Panic(0x41) `
    + `drift card 207 found. Payload: ${payload}`);

  const lines = decoded.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, 3, `expected 3 decoded values (adapter, maxSlippageBps, orders), got ${lines.length}: ${decoded}`);
  const [decodedAdapter, decodedSlippage, decodedOrders] = lines;
  assert.equal(decodedAdapter.toLowerCase(), expectedAdapter.toLowerCase(),
    'decoded adapter does not match the deployed adapter -- fields shifted despite the decode not throwing');

  const slippageBps = BigInt(decodedSlippage);
  const vaultCoreSrc = fs.readFileSync(path.join(ROOT, 'contracts', 'src', 'VaultCore.sol'), 'utf8');
  const boundMatch = vaultCoreSrc.match(/MAX_REBALANCE_SLIPPAGE_BPS\s*=\s*(\d+)/);
  assert.ok(boundMatch, 'could not read MAX_REBALANCE_SLIPPAGE_BPS out of contracts/src/VaultCore.sol');
  const maxBound = BigInt(boundMatch[1]);
  assert.ok(slippageBps > 0n && slippageBps <= maxBound,
    `decoded maxSlippageBps ${slippageBps} is outside VaultCore's (0, ${maxBound}] bound -- `
    + 'VaultCore.executeRebalance would revert BadSlippageBound() on this payload');

  assert.equal(decodedOrders, '[]', `expected zero orders (the no-op rebalance), got: ${decodedOrders}`);
});
