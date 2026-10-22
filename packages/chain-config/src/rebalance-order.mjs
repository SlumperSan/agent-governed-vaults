/**
 * The PURE half of the Rebalance payload builder: bigint arithmetic and ABI byte assembly, no chain
 * call, no `cast`, no `fs`, no `process`. It computes the exact bytes `Governance.execute`'s
 * Rebalance branch decodes and the checks that decide whether an order may be emitted at all.
 *
 * ## Moved from `scripts/build-rebalance-order.mjs`, with no behaviour change
 *
 * The functions below were exported from that script and are still re-exported from it, so every
 * existing import path (`scripts/test/build-rebalance-order-slippage.test.mjs`,
 * `scripts/test/persona-round-sim.test.mjs`) and the CLI itself are untouched. They moved because
 * the reference agent (`packages/reference-agent`) has to build the same payload, and it cannot
 * import from `scripts/`: `Dockerfile` copies `packages` and `apps` and does NOT copy `scripts`, so
 * a `../../../scripts/...` import resolves on a checkout and throws MODULE_NOT_FOUND in the
 * container. This is the `chain-binding.mjs` precedent (`scripts/lib/chain-binding.mjs` re-exports
 * the implementation that lives next to this file). One statement of the encoding, not two.
 *
 * What stays in the script, deliberately: `rebalanceDecodeSig` (reads the compiled artifact with
 * `fs`), the `cast` wrappers, argument parsing and `main()`. Those are the chain-reading and
 * process-owning half.
 *
 * ## One order, one leg
 *
 * The encoder hard-codes a single-order layout: array length `word(1n)`, array offset `word(0x60n)`,
 * order offset `word(0x20n)` and routeData offset `word(0xc0n)`. That is correct for one
 * `exactInputSingle` leg and wrong for several. A multi-leg payload is a new builder, not a flag.
 */

// SwapRouter02's exactInputSingle: the 7-field params struct, WITHOUT the `deadline` member the
// original SwapRouter carried. That difference is why the selector is 0x04e45aaf and not
// 0x414bf389, and the wrong one is rejected by the adapter's allowlist, not by the router.
export const EXACT_INPUT_SINGLE = '0x04e45aaf';
export const EXACT_INPUT_SINGLE_SIG =
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';

/**
 * The ABI types `Governance.execute`'s Rebalance branch decodes a payload into:
 * `(adapter, maxSlippageBps, SwapOrder[])` with `SwapOrder = (tokenIn, tokenOut, amountIn,
 * minAmountOut, deadline, routeData)`. Pinned here so a consumer decodes with the same shape the
 * encoder below assembles; `packages/chain-config/test/rebalance-order.test.mjs` holds it equal to
 * the `executeRebalance` inputs in the compiled `VaultCore` artifact, which is what makes it a
 * pin and not a third hand-typed copy.
 */
export const REBALANCE_PAYLOAD_TYPES = Object.freeze([
  'address',
  'uint256',
  '(address,address,uint256,uint256,uint256,bytes)[]',
]);

/**
 * Card 209: an explicit `--max-slippage-bps N` must be `1..ceilingBps` (VaultCore's
 * MAX_REBALANCE_SLIPPAGE_BPS, read off chain by the caller) -- above that, VaultCore.
 * executeRebalance would revert BadSlippageBound() before this order ever reached the adapter.
 * Exported and pure (no chain call, no process.exit) so it is unit- and mutation-testable
 * directly: scripts/test/build-rebalance-order-slippage.test.mjs.
 */
export function validateOverrideRange(overrideBps, ceilingBps) {
  if (overrideBps < 1n || overrideBps > ceilingBps) {
    return {
      ok: false,
      reason: `--max-slippage-bps ${overrideBps} is outside 1..${ceilingBps} `
        + '(MAX_REBALANCE_SLIPPAGE_BPS, read from chain). VaultCore.executeRebalance would '
        + 'revert BadSlippageBound() before this order ever reached the adapter.',
    };
  }
  return { ok: true };
}

// The fixed buffer and default cap from the card 209 design decision (the rationale is the comment in
// main() of scripts/build-rebalance-order.mjs) -- exported so a test reads the
// same constants this module enforces rather than hand-duplicating "25" and "100" and silently
// drifting from them.
export const DERIVED_BUFFER_BPS = 25n;
export const DERIVED_CAP_BPS = 100n;

/**
 * Card 209's maxSlippageBps derivation (see the rationale comment in scripts/build-rebalance-order.mjs main() for the
 * full rationale), isolated into a PURE function -- no chain call, no process.exit -- so every
 * refusal branch is unit- and mutation-testable directly against plain bigint inputs instead of
 * through a simulated chain: scripts/test/build-rebalance-order-slippage.test.mjs.
 *
 * `grossOut` MUST BE THE POOL'S EXPECTED FILL BEFORE ITS OWN TRADING FEE (spot from slot0, no fee
 * subtracted) -- NOT the fee-adjusted `expectedOut` the CLI also computes and prints. Feeding
 * the fee-adjusted figure here would count the pool fee twice (once explicitly as `poolFeeBps`,
 * once again embedded in the gap measured against a fee-adjusted fill), silently doubling the
 * "attacker pays the fee twice" MEV margin this function's caller depends on being accurate.
 *
 * `overrideBps` and `allowBelowDerived` are `null`/`false` for the no-override, default-derived
 * path. NO SILENT FALLBACK: a missing/zero `priceOutWad`, `poolFeeRawPpm`, or `grossOut` refuses
 * rather than deriving from a partial or zeroed input.
 */
export function deriveMaxSlippageBps({
  poolFeeRawPpm,
  valueInWad,
  unitOut,
  priceOutWad,
  grossOut,
  overrideBps = null,
  allowBelowDerived = false,
  BPS = 10000n,
}) {
  if (priceOutWad === null || priceOutWad === undefined || priceOutWad === 0n) {
    return { ok: false, reason: 'oracle price is 0 or missing; cannot derive maxSlippageBps without it.' };
  }
  if (poolFeeRawPpm === null || poolFeeRawPpm === undefined) {
    return { ok: false, reason: 'pool fee is missing; cannot derive maxSlippageBps without it.' };
  }
  if (grossOut === null || grossOut === undefined) {
    return { ok: false, reason: 'expected fill (grossOut) is missing; cannot derive maxSlippageBps without it.' };
  }

  const poolFeeBps = (poolFeeRawPpm + 99n) / 100n; // ppm -> bps, rounded up
  // The oracle-implied output at ZERO slippage discount: what amountIn is worth, in tokenOut
  // units, at today's oracle price.
  const oracleFloorZeroSlip = (valueInWad * unitOut + priceOutWad - 1n) / priceOutWad;
  // How far the pool's own PRE-FEE expected fill sits below that, in bps of it -- zero, never
  // negative, when the pool's spot price is at or above oracle value. Pre-fee, not post-fee: the
  // pool's trading fee is already counted once via poolFeeBps above, so measuring the gap from a
  // fee-adjusted figure would count it twice.
  const measuredExecutionGapBps = grossOut >= oracleFloorZeroSlip
    ? 0n
    : ((oracleFloorZeroSlip - grossOut) * BPS + oracleFloorZeroSlip - 1n) / oracleFloorZeroSlip;
  const derivedSlipBps = poolFeeBps + measuredExecutionGapBps + DERIVED_BUFFER_BPS;
  const base = { poolFeeBps, measuredExecutionGapBps, derivedSlipBps };

  if (overrideBps !== null && overrideBps !== undefined) {
    if (overrideBps < derivedSlipBps && !allowBelowDerived) {
      return {
        ok: false,
        ...base,
        reason: `--max-slippage-bps ${overrideBps} is below the derived minimum ${derivedSlipBps} bps `
          + `(pool fee ${poolFeeBps} + execution gap ${measuredExecutionGapBps} + `
          + `${DERIVED_BUFFER_BPS} bps buffer). A tolerance tighter than the pool can actually `
          + 'deliver just reverts SwapSlippage() once minAmountOut is computed against it. Pass '
          + '--allow-below-derived to force it anyway.',
      };
    }
    return { ok: true, ...base, chosenSlipBps: overrideBps, usedOverride: true };
  }

  if (derivedSlipBps > DERIVED_CAP_BPS) {
    return {
      ok: false,
      ...base,
      reason: `derived maxSlippageBps ${derivedSlipBps} bps (pool fee ${poolFeeBps} + execution gap `
        + `${measuredExecutionGapBps} + ${DERIVED_BUFFER_BPS} bps buffer) exceeds the `
        + `${DERIVED_CAP_BPS} bps default cap. Pass --max-slippage-bps N explicitly (1..ceiling) `
        + 'to accept a wider tolerance than the default derivation allows.',
    };
  }
  return { ok: true, ...base, chosenSlipBps: derivedSlipBps, usedOverride: false };
}

/** One 32-byte ABI word, from an address string or a bigint. */
function word(v) {
  const hex = typeof v === 'string' ? BigInt(v).toString(16) : v.toString(16);
  return hex.padStart(64, '0');
}

/** Right-pad a hex body to a whole number of 32-byte words, as `bytes` tails are encoded. */
function pad32(hex) {
  const rem = hex.length % 64;
  return rem === 0 ? hex : hex + '0'.repeat(64 - rem);
}

/**
 * The rest of card 209's pipeline, downstream of `deriveMaxSlippageBps`: pick `chosenSlipBps`,
 * check `--floor-buffer-bps` stays under it (not under the ceiling -- that was the same bug one
 * level down), build `minAmountOut` against `chosenSlipBps`, confirm the pool can actually pay it,
 * and assemble the exact payload bytes `Governance.execute`'s Rebalance branch decodes -- with
 * `chosenSlipBps`, never the ceiling, as the second head word. PURE (no chain call, no
 * process.exit) and exported so the payload's `maxSlippageBps` word is asserted directly against
 * the value that was actually derived, rather than only against the pure derivation in isolation
 * -- a regression that re-wired the payload assembly to a different variable (the original shape
 * of card 209's bug) would not be caught by testing `deriveMaxSlippageBps` alone.
 */
export function buildRebalanceOrder({
  adapter,
  usdc,
  tokenOut,
  amountIn,
  unitOut,
  priceOutWad,
  usdcScalar,
  poolFeeRawPpm,
  grossOut,
  overrideBps = null,
  allowBelowDerived = false,
  floorBufferBps,
  deadline,
  BPS = 10000n,
}) {
  const valueInWad = amountIn * usdcScalar;
  const derivation = deriveMaxSlippageBps({
    poolFeeRawPpm, valueInWad, unitOut, priceOutWad, grossOut, overrideBps, allowBelowDerived, BPS,
  });
  if (!derivation.ok) return { ok: false, derivation, reason: derivation.reason };

  const chosenSlipBps = derivation.chosenSlipBps;

  if (floorBufferBps >= chosenSlipBps) {
    return {
      ok: false,
      derivation,
      reason: `--floor-buffer-bps ${floorBufferBps} is at or above the chosen maxSlippageBps ${chosenSlipBps}. `
        + 'The oracle bound allows the swap to come in that far below oracle value; a buffer that '
        + 'large demands more from the pool than the bound leaves room for, and the swap reverts '
        + 'SwapSlippage() instead. Stay well inside it.',
    };
  }

  // minOut such that minOut * priceOut / unitOut >= valueIn * (BPS - chosenSlipBps) / BPS, rounded
  // UP at each step so the emitted value satisfies a `>=` rather than landing one wei under it,
  // then widened by floorBufferBps for tolerance to an oracle price fall between propose and
  // execute (see the floor-buffer commentary in scripts/build-rebalance-order.mjs main()).
  const requiredValueWad = (valueInWad * (BPS - chosenSlipBps) + BPS - 1n) / BPS;
  const bareFloor = (requiredValueWad * unitOut + priceOutWad - 1n) / priceOutWad;
  const minAmountOut = (bareFloor * (BPS + floorBufferBps) + BPS - 1n) / BPS;

  // Affordability, using the FEE-ADJUSTED expected fill (unlike the gap measurement above, which
  // deliberately uses the pre-fee grossOut) -- this checks what the swap would actually deliver
  // net of the pool's own fee, which is the real quantity `received >= minAmountOut` compares
  // against at execution time.
  const expectedOut = (grossOut * (1000000n - poolFeeRawPpm)) / 1000000n;
  if (expectedOut < minAmountOut) {
    return {
      ok: false,
      derivation,
      minAmountOut,
      expectedOut,
      reason: `the pool would pay about ${expectedOut} and minAmountOut is ${minAmountOut}, so the swap `
        + `reverts SwapSlippage() on the measured delta. The +${floorBufferBps} bps buffer is not `
        + 'affordable at this pool price. Lower --floor-buffer-bps, accept less tolerance to an '
        + 'oracle fall, or use a deeper fee tier.',
    };
  }
  const headroomBps = minAmountOut === 0n ? 0n : ((expectedOut - minAmountOut) * BPS) / minAmountOut;

  // Every member of ExactInputSingleParams is STATIC, so this is seven words after the selector
  // with no offsets and no tail. The pool's own fee (poolFeeRawPpm, read on chain), not the CLI
  // --fee value used only to locate the pool.
  const routeData = EXACT_INPUT_SINGLE
    + [usdc, tokenOut, poolFeeRawPpm, adapter, amountIn, minAmountOut, 0n].map(word).join('');

  // abi.encode(address, uint256, SwapOrder[]) -- THREE head words (adapter, chosenSlipBps, offset
  // to the array), not two (card 207). SwapOrder is dynamic because of `bytes routeData`, so the
  // array itself has offsets. The second head word is `chosenSlipBps` -- the DERIVED or explicitly
  // overridden value from `deriveMaxSlippageBps`, above -- not the chain ceiling (card 209).
  const orderBody = [usdc, tokenOut, amountIn, minAmountOut, deadline].map(word).join('')
    + word(0xc0n)
    + word(BigInt((routeData.length - 2) / 2))
    + pad32(routeData.slice(2));
  const payload = '0x' + word(adapter) + word(chosenSlipBps) + word(0x60n) + word(1n) + word(0x20n) + orderBody;

  return {
    ok: true,
    derivation,
    chosenSlipBps,
    bareFloor,
    minAmountOut,
    expectedOut,
    headroomBps,
    routeData,
    payload,
  };
}
