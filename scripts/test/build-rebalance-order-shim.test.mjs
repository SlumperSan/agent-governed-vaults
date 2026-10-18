/**
 * Item 8a: `scripts/build-rebalance-order.mjs` is now a thin shim over the pure builder in
 * `packages/chain-config/src/rebalance-order.mjs`. This pins that the shim and the package are one
 * implementation and produce identical bytes, and that the CLI still starts.
 *
 *   - every pure export of the script IS the package's export (same function object, so there is no
 *     second copy to drift), and the constants are equal;
 *   - on the fixed inputs both paths produce the same whole result, and that result digests to what
 *     the pre-move script produced (golden digests in packages/chain-config/test/rebalance-order.test.mjs);
 *   - the payload bytes decode with the real `cast abi-decode`, over the signature read off the
 *     compiled VaultCore ABI, to the fields that were given;
 *   - run as a script it still reaches `main()` through the shim's imports (`--vault` is checked
 *     first, so this makes no chain call and needs no RPC).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as shim from '../build-rebalance-order.mjs';
import * as pkg from '../../packages/chain-config/src/rebalance-order.mjs';
import { FIXED_CASES, ADAPTER, USDC, CIRBTC, stringify } from '../../packages/chain-config/test/rebalance-fixtures.mjs';

const SCRIPT = fileURLToPath(new URL('../build-rebalance-order.mjs', import.meta.url));

test('every pure export of the script is the package export itself, not a copy', () => {
  for (const name of ['validateOverrideRange', 'deriveMaxSlippageBps', 'buildRebalanceOrder']) {
    assert.equal(typeof pkg[name], 'function', `${name} is not exported by the package`);
    assert.strictEqual(shim[name], pkg[name], `${name} on the script is not the package function`);
  }
  assert.equal(shim.DERIVED_BUFFER_BPS, pkg.DERIVED_BUFFER_BPS);
  assert.equal(shim.DERIVED_CAP_BPS, pkg.DERIVED_CAP_BPS);
  assert.equal(typeof shim.rebalanceDecodeSig, 'function', 'rebalanceDecodeSig stays on the script');
});

test('the shim and the package produce identical results on every fixed input', () => {
  for (const [name, input] of Object.entries(FIXED_CASES)) {
    assert.equal(stringify(shim.buildRebalanceOrder(input)), stringify(pkg.buildRebalanceOrder(input)), name);
  }
});

test('the payload decodes with real cast over the compiled signature to the fields that were given', () => {
  const r = shim.buildRebalanceOrder(FIXED_CASES.derived);
  assert.equal(r.ok, true);
  const out = execFileSync('cast', ['abi-decode', '--input', shim.rebalanceDecodeSig(), r.payload], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.equal(out[0].toLowerCase(), ADAPTER.toLowerCase());
  assert.equal(BigInt(out[1].split(/\s+/)[0]), r.chosenSlipBps);
  const order = out[2].toLowerCase();
  assert.ok(order.includes(USDC) && order.includes(CIRBTC), 'the order tuple carries tokenIn and tokenOut');
  assert.ok(order.includes(r.routeData.toLowerCase()), 'the order tuple carries the routeData unchanged');
});

test('run as a script the shim still reaches main(): a missing --vault is refused before any chain call', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, RPC_URL: 'http://127.0.0.1:1' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing required --vault/);
});
