/**
 * Item 8a: the pure Rebalance payload builder lives in `packages/chain-config/src/rebalance-order.mjs`
 * so the reference agent can import it (the Dockerfile copies `packages` and not `scripts`).
 *
 * Three pins:
 *   1. `REBALANCE_PAYLOAD_TYPES` equals the `executeRebalance` inputs in the compiled VaultCore
 *      artifact, so the constant is a pin and not a third hand-typed copy of the shape.
 *   2. The builder's payload decodes, with viem over those types, back to the adapter, the chosen
 *      slippage, and every order field it was given, and the routeData selector is the one the
 *      adapter allowlists.
 *   3. Golden digests of the whole builder result, captured from `scripts/build-rebalance-order.mjs`
 *      BEFORE the move (origin/protocol/main 0d7306378). A byte moved in the encoder or a changed
 *      rounding step turns this red; the cast-decoded and shim-equality checks are in
 *      scripts/test/build-rebalance-order-shim.test.mjs, because `cast` is a script-side tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import {
  REBALANCE_PAYLOAD_TYPES,
  EXACT_INPUT_SINGLE,
  buildRebalanceOrder,
} from '../src/rebalance-order.mjs';
import { ADAPTER, USDC, CIRBTC, BASE, FIXED_CASES, stringify, sha256 } from './rebalance-fixtures.mjs';

const ARTIFACT = new URL('../../../contracts/out/VaultCore.sol/VaultCore.json', import.meta.url);

/** sha256 of the stringified builder result, from the PRE-move scripts/build-rebalance-order.mjs. */
const GOLDEN_SHA256 = {
  derived: 'b90f45c97da7dd12b24051844e0d71abbdf8ddc6584e665d9a7dac5accfc55d7',
  override: '909f14f03f537e8977c01604e5fdd5c1c399494f98af6af768adaee93f20ff3b',
  refusedAboveCap: 'c7e149acc2b4551daeaf7addffc70d5513b8fede9ed60b4a2498b7d05f50e97b',
  oddFee: 'f2ec04a39113257b752256e6ff00fc23a4598fcabf34c90362afc7a21cc073ab',
  gapRounding: 'dcf8b7d3ef905f4ae052af6046089b2df0c9ebf8cdf1584357e65458b91b6110',
  exactGap: '369bce6e0d800689bd1ec73120e2520a8725d4133b1c23aa5b3d3a3a2f7c3b6b',
  bufferAtChosen: 'cf7dc172bdf551407266ed6fa0246f14a82f0fe9e10cb819c067e5c9a7b5cb23',
  unaffordable: '0b2c9e8da091e8c321c06a26c98c7e533c762ab2e5513440689f8fb6be7032a2',
  bigAmount: '6aa1053785cc28f00810c104b53147cc63120e9111fdd2d6127740190a61062d',
};

test('REBALANCE_PAYLOAD_TYPES equals the executeRebalance inputs in the compiled VaultCore artifact', (t) => {
  if (!existsSync(ARTIFACT)) return t.skip('contracts/out/VaultCore.sol is absent, run `forge build` (CI does)');
  const abi = JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi;
  const fn = abi.find((e) => e.type === 'function' && e.name === 'executeRebalance');
  assert.ok(fn, 'executeRebalance not found in the compiled VaultCore ABI');
  const typeOf = (i) =>
    i.type.startsWith('tuple') ? `(${i.components.map(typeOf).join(',')})${i.type.slice('tuple'.length)}` : i.type;
  assert.deepEqual([...REBALANCE_PAYLOAD_TYPES], fn.inputs.map(typeOf));
});

test('the built payload decodes over REBALANCE_PAYLOAD_TYPES back to every field it was given', () => {
  const r = buildRebalanceOrder(FIXED_CASES.derived);
  assert.equal(r.ok, true);
  const [adapter, slip, orders] = decodeAbiParameters(
    parseAbiParameters(REBALANCE_PAYLOAD_TYPES.join(',')),
    r.payload,
  );
  assert.equal(adapter.toLowerCase(), ADAPTER.toLowerCase());
  assert.equal(slip, r.chosenSlipBps, 'the second head word is the CHOSEN slippage, never the ceiling');
  assert.equal(orders.length, 1);
  const [tokenIn, tokenOut, amountIn, minAmountOut, deadline, routeData] = orders[0];
  assert.equal(tokenIn.toLowerCase(), USDC);
  assert.equal(tokenOut.toLowerCase(), CIRBTC);
  assert.equal(amountIn, BASE.amountIn);
  assert.equal(minAmountOut, r.minAmountOut);
  assert.equal(deadline, BASE.deadline);
  assert.equal(routeData, r.routeData);
  assert.ok(routeData.startsWith(EXACT_INPUT_SINGLE), 'routeData opens with the allowlisted selector');
});

test('byte identity: every fixed case digests to what the pre-move builder produced', () => {
  for (const [name, input] of Object.entries(FIXED_CASES)) {
    assert.equal(sha256(stringify(buildRebalanceOrder(input))), GOLDEN_SHA256[name], `case ${name} changed`);
  }
});
