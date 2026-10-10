#!/usr/bin/env node
/**
 * Build and VERIFY a single-hop rebalance order for a live vault, and print the exact payload a
 * governance round would carry. It never broadcasts and never touches a key: SWARM §10 puts every
 * `--broadcast`, funded account and mainnet fund movement with the owner, and this exists so that
 * what the owner signs was checked against the chain first rather than hand-assembled.
 *
 * WHY THIS IS NOT A CONVENIENCE WRAPPER. Three of the order's fields are frozen into the proposal's
 * `actionHash` at propose time and cannot be changed before execution:
 *
 *   - `amountIn`      — sized here, spent hours later
 *   - `minAmountOut`  — a price floor committed before the fill
 *   - `deadline`      — must outlive the ENTIRE execution window, not merely reach it
 *
 * THE DEADLINE IS THE TRAP, AND IT IS WORSE THAN "must outlive the round". A passed proposal is
 * executable across `[executableAt, executableAt + executionWindow]`, and `executionWindow` is a
 * per-vault config value this script READS rather than assumes -- `--vault` is an argument, so
 * "on this vault" has no referent here. A deadline that clears the commit+reveal floor but
 * expires inside the window leaves a
 * proposal that is still `Passed` and still executable while `executeSwap` reverts `Expired()` —
 * the round is burned, the `actionHash` is frozen, and there is no re-execution path.
 *
 * AND THE WINDOW IS NOT AT A FIXED OFFSET FROM `createdAt`. `Governance.finalize` stamps
 * `executableAt = block.timestamp + timelockDuration` when FINALIZE IS MINED, and finalize is
 * permissionless and gated only on `block.timestamp >= revealDeadline`, so nothing obliges anyone
 * to call it promptly. `createdAt + commit + reveal + timelock` is therefore a LOWER BOUND on
 * `executableAt`, and this script does not claim otherwise: it sizes the default TTL to cover the
 * window measured from that bound with an hour of propose margin, and says at the end that a late
 * finalize slides the real window out from under the deadline. An earlier version printed "covers
 * the whole 86400s window" as a flat assertion, true only if finalize landed at exactly
 * `revealDeadline`.
 *
 * Every duration is read from `Governance.configOf`, and the Governance address from
 * `vault.governance()` rather than hardcoded. An earlier version hardcoded both the 7,200 s floor
 * and the contract; a wrong contract returns an all-zero config, which silently disarms every
 * timing check here while the script still exits 0 with a full payload.
 *
 * WHAT IT CANNOT DO. It cannot make the committed floor safe. `minAmountOut` is fixed now and the
 * fill happens later; a move against you either reverts or fills at a floor the market has left.
 * The script quantifies that exposure; only a smaller `amountIn` reduces it, and sizing is an
 * owner decision.
 *
 * Usage:
 *   node scripts/build-rebalance-order.mjs --vault 0x… --amount-in 5000000
 *     [--fee 100] [--ttl N] [--token-out 0x…] [--adapter 0x…] [--accept-partial-window]
 *     [--max-slippage-bps N] [--allow-below-derived] [--floor-buffer-bps N]
 *
 * `--token-out` and `--adapter` default to WETH and the deployed adapter on chain 4663.
 * `--accept-partial-window` allows a deadline that expires inside the execution window; read
 * the refusal text before reaching for it, because it trades one real risk for another.
 * `GOVERNANCE` in the environment overrides the address read from `vault.governance()`.
 *
 * `--max-slippage-bps N` overrides the DEFAULT DERIVED `maxSlippageBps` encoded into the payload
 * (see the CTO-decision comment near the derivation, card 209, below). The default is never the
 * contract's ceiling: it computes `ceil(poolFeeBps + measuredExecutionGapBps) + 25 bps` from this
 * order's own pool and oracle reads, and refuses above a 100 bps cap unless `N` is passed
 * explicitly. `N` must be `1..MAX_REBALANCE_SLIPPAGE_BPS`, read from chain, and above that this
 * refuses before `VaultCore.executeRebalance` would revert `BadSlippageBound()`. `N` below the
 * derived minimum also refuses -- it would just revert `SwapSlippage()` once `minAmountOut` is
 * computed against it -- unless `--allow-below-derived` is passed too.
 *
 * `--floor-buffer-bps` DEFAULTS TO 100, UNCHANGED FROM BEFORE CARD 209, AND THAT DEFAULT WAS SIZED
 * AGAINST THE OLD 200 BPS CEILING DEFAULT. The default DERIVED maxSlippageBps is now typically well
 * under 100 (a real pool fee plus a small measured gap plus 25 bps), so `--floor-buffer-bps 100`
 * will usually be AT OR ABOVE the derived value and this script will REFUSE on the coherence check
 * below rather than emit an order it cannot back. This is intentional -- refusing beats silently
 * emitting an order with no real buffer -- but it means most real invocations now need an explicit,
 * smaller `--floor-buffer-bps` (this script prints the derived value so you can choose one under
 * it), or an explicit `--max-slippage-bps` wide enough to leave room for 100. Whether
 * `--floor-buffer-bps`'s OWN default should also change is a separate decision this card does not
 * make -- it trades one real risk (oracle drift between propose and execute) against another
 * (tolerance to sandwich extraction) and is not something to pick silently in this diff.
 *
 * `RPC_URL` in the environment overrides the default, which is `https://rpc.mainnet.chain.robinhood.com`
 * — Robinhood MAINNET, chain 4663, not a testnet. Every call this script makes against it is
 * read-only (see the `cast` helpers below); it broadcasts nothing and holds no key. The resolved
 * RPC is printed as the first line of output either way.
 *
 * `--amount-in` is in the vault's `usdc()` base units (USDG has 6 decimals, so 5000000 = 5 USDG).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const BPS = 10000n;

// SwapRouter02's exactInputSingle: the 7-field params struct, WITHOUT the `deadline` member the
// original SwapRouter carried. That difference is why the selector is 0x04e45aaf and not
// 0x414bf389, and the wrong one is rejected by the adapter's allowlist, not by the router.
const EXACT_INPUT_SINGLE = '0x04e45aaf';
const EXACT_INPUT_SINGLE_SIG =
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';

/**
 * The exact `abi.decode` shape Governance.execute's Rebalance branch destructures a payload
 * into (contracts/src/Governance.sol), read off the COMPILED CONTRACT
 * (contracts/out/VaultCore.sol/VaultCore.json's `executeRebalance` ABI -- typed identically,
 * since Governance.sol's Rebalance branch calls `IVaultExecution.executeRebalance` with the
 * decoded values) rather than typed out by hand here a second time. Card 207: this script's own
 * hand-assembled payload below used to omit `maxSlippageBps` entirely -- a 2-field payload that
 * decoded on-chain as garbage and its own round-trip check decoded with the same stale 2-field
 * signature, so the check passed on a payload that would Panic(0x41) on Governance.execute.
 * Exported so scripts/test/build-rebalance-order-slippage.test.mjs reads the same signature this
 * script's own round-trip check uses, rather than typing a third copy.
 */
export function rebalanceDecodeSig() {
  const artifactPath = path.join(ROOT, 'contracts', 'out', 'VaultCore.sol', 'VaultCore.json');
  const abi = JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
  const fn = abi.find((e) => e.type === 'function' && e.name === 'executeRebalance');
  if (!fn) throw new Error('executeRebalance not found in the compiled VaultCore ABI');
  const typeOf = (input) => {
    if (input.type.startsWith('tuple')) {
      const suffix = input.type.slice('tuple'.length);
      return `(${input.components.map(typeOf).join(',')})${suffix}`;
    }
    return input.type;
  };
  return `f(${fn.inputs.map(typeOf).join(',')})`;
}

function cast(...args) {
  return execFileSync('cast', [...args, '--rpc-url', RPC], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  }).trim();
}

/**
 * The pure subcommands. `cast sig`, `cast keccak` and `cast abi-decode` compute rather than query
 * and REJECT `--rpc-url` outright, so they cannot share the helper above. The split is also the
 * honest signal: nothing these return is evidence about the chain, only about the encoding.
 */
function castPure(...args) {
  return execFileSync('cast', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
}

/** A `cast call` returning one value, with the trailing `[1.23e4]` annotation stripped. */
function call(to, sig, ...args) {
  return cast('call', to, sig, ...args).split('\n')[0].split(/\s+/)[0].trim();
}

/**
 * A bigint from a `cast` scalar. Empty input throws rather than becoming 0n: `BigInt('')` is 0n,
 * and a zero that came from a failed read is indistinguishable from a zero the chain returned —
 * which in this script would silently produce a wrong `minAmountOut`.
 */
function big(v) {
  const t = String(v).replace(/\[.*\]$/, '').trim();
  if (t === '') throw new Error('expected a number from cast, got empty output');
  return BigInt(t);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === null) throw new Error(`missing required --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}

/** Like `arg`, but returns `null` on absence instead of throwing or requiring a fallback -- for
 * flags that are genuinely optional and whose absence is a meaningful, distinct branch (an
 * override that was not supplied), not a default value. */
function argOpt(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

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

// The fixed buffer and default cap from the CTO decision below (card 209) -- exported so a test
// reads the same constants this script enforces rather than hand-duplicating "25" and "100" and
// silently drifting from them.
export const DERIVED_BUFFER_BPS = 25n;
export const DERIVED_CAP_BPS = 100n;

/**
 * Card 209's maxSlippageBps derivation (see the CTO-decision comment in main(), below, for the
 * full rationale), isolated into a PURE function -- no chain call, no process.exit -- so every
 * refusal branch is unit- and mutation-testable directly against plain bigint inputs instead of
 * through a simulated chain: scripts/test/build-rebalance-order-slippage.test.mjs.
 *
 * `grossOut` MUST BE THE POOL'S EXPECTED FILL BEFORE ITS OWN TRADING FEE (spot from slot0, no fee
 * subtracted) -- NOT the fee-adjusted `expectedOut` this script also computes and prints. Feeding
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
  // execute (see the "WHY A BUFFER IS NOT OPTIONAL POLISH" comment in main(), below).
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

function fail(msg) {
  console.error(`\nREFUSING TO EMIT AN ORDER: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const vault = arg('vault');
  const amountIn = BigInt(arg('amount-in'));
  const feeTier = BigInt(arg('fee', '100'));

  if (amountIn <= 0n) fail('--amount-in must be positive');

  console.log(`RPC       ${RPC}`);
  console.log(`chainId   ${cast('chain-id')}`);
  console.log(`block     ${big(cast('block-number'))}`);
  console.log(`vault     ${vault}\n`);

  // ---- the vault, read from the vault --------------------------------------------------------
  const usdc = call(vault, 'usdc()(address)');
  const oracle = call(vault, 'oracle()(address)');
  const idle = big(call(vault, 'idleUsdc()(uint256)'));

  console.log(`usdc      ${usdc}`);
  console.log(`oracle    ${oracle}`);
  console.log(`idleUsdc  ${idle}\n`);

  if (amountIn > idle) {
    fail(
      `--amount-in ${amountIn} exceeds idleUsdc ${idle}. VaultCore.executeRebalance reverts `
        + 'InsufficientAssetBalance() before it ever reaches the adapter.',
    );
  }

  // ---- the contract's ceiling, and any explicit override, validated against it EARLY ----------
  // MAX_REBALANCE_SLIPPAGE_BPS is the RAIL VaultCore enforces (`BadSlippageBound()` outside
  // `(0, ceilingBps]`), read off chain rather than restated. It is not this script's default --
  // see the CTO-decision comment below, where the actual value used (`chosenSlipBps`) is derived.
  const ceilingBps = big(call(vault, 'MAX_REBALANCE_SLIPPAGE_BPS()(uint256)'));
  console.log(`MAX_REBALANCE_SLIPPAGE_BPS (ceiling)  ${ceilingBps}\n`);

  const allowBelowDerived = process.argv.includes('--allow-below-derived');
  const overrideRaw = argOpt('max-slippage-bps');
  let overrideBps = null;
  if (overrideRaw !== null) {
    try {
      overrideBps = BigInt(overrideRaw);
    } catch {
      fail(`--max-slippage-bps ${overrideRaw} is not an integer.`);
    }
    const rangeCheck = validateOverrideRange(overrideBps, ceilingBps);
    if (!rangeCheck.ok) fail(rangeCheck.reason);
  }

  // ---- governance timing, read live ----------------------------------------------------------
  // The DURATIONS were already read live. The CONTRACT they are read from used to be a hardcoded
  // constant, which is the same defect one level up: `VaultCore.governance` is `immutable` and the
  // vault will name it for one call, so ask the vault. If the constant had ever been wrong -- a
  // second deployment, a different vault -- `configOf` on an unrelated Governance returns an
  // all-zero struct, both timing guards below compare against 0 and pass, and the script exits 0
  // with a full payload for an order that `propose()` would reject outright on `vaultRegistered`.
  const governance = process.env.GOVERNANCE || call(vault, 'governance()(address)');

  const cfgRaw = cast(
    'call', governance,
    'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32)', vault,
  ).split('\n').filter((l) => l.trim() !== '').map((l) => big(l));
  if (cfgRaw.length < 4) {
    fail(`configOf returned ${cfgRaw.length} values, expected 8. Reading ${governance} for ${vault}.`);
  }
  const [commitDur, revealDur, timelockDur, execWindow] = cfgRaw;

  // `_validateConfig` requires commitDuration >= 1 hours, revealDuration >= 1 hours and
  // executionWindow >= 1 hours, so a registered vault CANNOT have a zero here. A zero is not a
  // fast vault, it is an unregistered one -- the wrong Governance, or the wrong vault.
  // `>= 1 hours`, not `!= 0`: the justification below cites _validateConfig's FLOORS, so the test
  // has to be those floors. `commit=1, reveal=1, execWindow=1` is equally impossible for a
  // registered vault and a `!= 0` test waved it through with a 3,603 s default ttl.
  const HOUR = 3600n;
  if (commitDur < HOUR || revealDur < HOUR || execWindow < HOUR) {
    fail(
      `configOf(${vault}) on ${governance} returns commit=${commitDur} reveal=${revealDur} `
        + `executionWindow=${execWindow}. Governance._validateConfig forbids a zero in any of `
        + 'them, so this vault is not registered with this Governance and propose() would revert '
        + 'on vaultRegistered. Every timing check below would silently compare against zero.',
    );
  }

  const roundFloor = commitDur + revealDur + timelockDur;
  const windowEnd = roundFloor + execWindow;

  console.log(`governance        ${governance}`);
  console.log(`commitDuration    ${commitDur}`);
  console.log(`revealDuration    ${revealDur}`);
  console.log(`timelockDuration  ${timelockDur}`);
  console.log(`executionWindow   ${execWindow}`);
  console.log(
    `=> earliest execution createdAt+${roundFloor}; window at least ${execWindow}s from there\n`,
  );

  // Default: cover the whole window, plus margin for the gap between running this and proposing.
  const PROPOSE_MARGIN = 3600n;
  const ttl = BigInt(arg('ttl', String(windowEnd + PROPOSE_MARGIN)));
  const acceptShort = process.argv.includes('--accept-partial-window');

  // ---- CHECKED BEFORE ANYTHING IS EMITTED ----------------------------------------------------
  // An earlier version printed the payload and `actionHash` and THEN refused, so a reader
  // scrolling or grepping for `actionHash` got a rejected payload that looked usable.
  if (ttl <= roundFloor) {
    fail(
      `--ttl ${ttl}s does not even reach the earliest execution at createdAt+${roundFloor}s `
        + `(commit ${commitDur} + reveal ${revealDur} + timelock ${timelockDur}). The adapter `
        + 'would revert Expired() on an order governance had already passed.',
    );
  }
  // `>=` and not `>`: at exactly `windowEnd` the deadline covers the window only if propose is
  // broadcast in the same second as this run, which is the very gap PROPOSE_MARGIN exists for.
  if (ttl < windowEnd + PROPOSE_MARGIN && !acceptShort) {
    fail(
      `--ttl ${ttl}s does not cover the execution window with margin. Earliest execution is `
        + `createdAt+${roundFloor}s and the window runs at least ${execWindow}s from there, so a `
        + `deadline needs ${windowEnd + PROPOSE_MARGIN}s to cover it with ${PROPOSE_MARGIN}s of `
        + 'propose latency. Expiring inside the window leaves a proposal that is still Passed and '
        + 'still executable while executeSwap reverts Expired(): the round is burned with no '
        + 'retry, because actionHash is frozen.\n\n'
        + '    If you want a SHORTER deadline on purpose, pass --accept-partial-window. That is a\n'
        + '    real trade and not merely a nag: a longer deadline widens the interval over which\n'
        + '    the frozen minAmountOut can be left behind by the market, which is this script\'s\n'
        + '    other primary hazard. Shorter is defensible when one holder drives the whole round\n'
        + '    and can execute promptly.',
    );
  }

  // ---- the output asset -----------------------------------------------------------------------
  const tokenOut = arg('token-out', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'); // WETH on 4663
  const unitOut = big(call(vault, 'assetUnit(address)(uint256)', tokenOut));
  if (unitOut === 0n) {
    fail(
      `${tokenOut} is not in this vault's basket (assetUnit reads 0). executeRebalance rejects it `
        + 'with BadSwapToken() before the oracle is consulted.',
    );
  }

  // ---- the adapter, and the selector it will accept ---------------------------------------------
  const adapter = arg('adapter', '0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E');
  if (call(vault, 'isAllowedAdapter(address)(bool)', adapter) !== 'true') {
    fail(
      `vault ${vault} does not allow adapter ${adapter}. isAllowedAdapter is constructor-only, so `
        + 'this is the wrong adapter for this vault and no transaction can change that.',
    );
  }
  const router = call(adapter, 'router()(address)');
  if (call(adapter, 'allowedSelector(bytes4)(bool)', EXACT_INPUT_SINGLE) !== 'true') {
    fail(
      `adapter ${adapter} does not allow ${EXACT_INPUT_SINGLE} (SwapRouter02 exactInputSingle). `
        + 'The allowlist is fixed at construction (EX-1), so no other route data can be used.',
    );
  }
  // Deliberately not claimed: that this is the ONLY selector the adapter allows. That is a
  // universal over 2^32 values and cannot be established by sampling. What IS established is that
  // the four SwapRouter/SwapRouter02 entry points were probed and only this one returned true.
  console.log(`adapter   ${adapter}  (router ${router}, selector ${EXACT_INPUT_SINGLE} allowed)\n`);

  // ---- the pool this order would actually execute against -------------------------------------
  // Moved ahead of the slippage derivation: the derivation below needs this pool's own fee and its
  // own expected fill, both read from the chain, before it can compute anything.
  const factory = call(router, 'factory()(address)');
  const pool = call(factory, 'getPool(address,address,uint24)(address)', usdc, tokenOut, feeTier);
  if (/^0x0{40}$/i.test(pool)) fail(`no pool for that pair at fee ${feeTier}`);

  const liquidity = big(call(pool, 'liquidity()(uint128)'));
  if (liquidity === 0n) {
    fail(
      `pool ${pool} (fee ${feeTier}) has liquidity() == 0. A nonzero token balance is not the same `
        + 'as active in-range liquidity, and on this chain the two disagree.',
    );
  }
  const poolIn = big(call(usdc, 'balanceOf(address)(uint256)', pool));
  console.log(`pool      ${pool}  fee ${feeTier}`);
  console.log(`liquidity ${liquidity}`);
  console.log(`usdc side ${poolIn}`);

  // Parts per million, and a plain 1-in-N ratio when even that truncates. Integer PERCENT sent a
  // 5 USDG order against a multi-million-unit pool straight to "0%", which reads as "measured and
  // negligible" when nothing had been measured at all; basis points did the same one decimal
  // place further down. This is a DEPTH RATIO, not a quote — a real quote needs the Quoter, which
  // is a state-mutating staticcall and is not deployed on every chain.
  const ppmOfPool = poolIn === 0n ? 1000000n : (amountIn * 1000000n) / poolIn;
  const ratio = poolIn === 0n ? 0n : poolIn / amountIn;
  console.log(
    ppmOfPool > 0n
      ? `order is ${ppmOfPool} ppm of the pool's usdc side (depth ratio, NOT a quote)`
      : `order is under 1 ppm of the pool's usdc side: 1 part in ${ratio} (depth ratio, NOT a quote)`,
  );

  // The pool's OWN fee, read from the pool itself -- never the CLI `--fee` used only to look it up
  // via getPool. `getPool` is keyed by fee tier so the two should always agree, but the derivation
  // below is a launch-parameter input and reads it from the contract that actually charges it.
  const poolFeeRawPpm = big(call(pool, 'fee()(uint24)'));
  const poolFeeBps = (poolFeeRawPpm + 99n) / 100n; // ppm -> bps, rounded up -- printed only; the
  // authoritative copy of this arithmetic lives in deriveMaxSlippageBps, called below.

  // WHAT THE POOL WOULD ACTUALLY PAY, from slot0. `grossOut` (pre-fee) feeds the slippage
  // derivation below; `expectedOut` (net of the pool's own fee) is what the swap would actually
  // deliver, and is only for this print -- buildRebalanceOrder (below) recomputes it internally
  // for the real affordability check against `minAmountOut`.
  //
  // NOT A QUOTE. It is spot from `sqrtPriceX96` less the pool fee, with no tick-crossing and no
  // price impact — sound only because this order is a rounding error against the pool's depth
  // (printed above). A real quote needs the Quoter, a state-mutating staticcall, not deployed here.
  const slot0 = cast('call', pool, 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)')
    .split('\n')[0].split(/\s+/)[0].trim();
  const sqrtP = BigInt(slot0);
  const token0 = call(pool, 'token0()(address)');
  const Q192 = 1n << 192n;
  // price of token1 in token0 units, scaled: (sqrtP^2 / 2^192)
  const usdcIsToken0 = token0.toLowerCase() === usdc.toLowerCase();
  const num = sqrtP * sqrtP;
  // out = in * (price) adjusted for which side usdc is on -- PRE-FEE. Fed to the slippage
  // derivation as `grossOut`; see that function's docstring for why it must stay pre-fee.
  const grossOut = usdcIsToken0
    ? (amountIn * num) / Q192
    : (amountIn * Q192) / num;
  const expectedOut = (grossOut * (1000000n - poolFeeRawPpm)) / 1000000n;

  console.log(`pool fee (on chain)         ${poolFeeRawPpm} ppm  (${poolFeeBps} bps)`);
  console.log(`pool spot would pay ~${expectedOut} net of fee, ~${grossOut} gross (slot0; NOT a quote)\n`);

  // ---- the oracle side of the H-4 bound ---------------------------------------------------------
  const priceOutWad = big(call(oracle, 'priceWad(address)(uint256)', tokenOut));
  if (priceOutWad === 0n) {
    fail(
      `oracle.priceWad(${tokenOut}) is 0. The slippage derivation below needs a live oracle price `
        + 'for the output asset and this cannot fall back to anything -- fix the oracle or wait '
        + 'for it to report a price before building this order.',
    );
  }

  // `_valueWad(usdc, amt)` is `amt * usdcScalar()` — oracle-independent, and NOT `amt * price /
  // assetUnit(usdc)`. `assetUnit(usdc)` is 0 by construction: VaultCore forbids the settlement
  // token in the basket. An earlier version divided by a hardcoded 1e6 fallback that was taken on
  // every run; it happened to agree on this vault and would be wrong on any non-6-decimal
  // settlement token, which the constructor permits.
  const usdcScalar = big(call(vault, 'usdcScalar()(uint256)'));

  // ---- CTO DECISION 2026-09-23 (card 209): derive maxSlippageBps, never default to the ceiling --
  //
  // Security, reviewing PR #375 (card 207), found that this script always encoded the contract's
  // ceiling `MAX_REBALANCE_SLIPPAGE_BPS` (200 bps / 2%) as the payload's `maxSlippageBps`, with no
  // override. The ceiling is a safety RAIL VaultCore enforces (`require(maxSlippageBps > 0 &&
  // maxSlippageBps <= MAX_REBALANCE_SLIPPAGE_BPS)`), not a default: hard-wiring the builder to the
  // rail means the contract's bound is the only protection left, and every real rebalance
  // authorises the worst loss the contract will tolerate regardless of pool depth or order size.
  //
  // `maxSlippageBps` bounds, AT EXECUTION TIME and against the vault's OWN oracle:
  //   _valueWad(tokenOut, minAmountOut) * BPS >= _valueWad(tokenIn, amountIn) * (BPS - maxSlippageBps)
  // (`VaultCore.executeRebalance`, H-4). The separate `received >= minAmountOut` check is a
  // measured-delta defence against a lying router (EX-3), not the slippage bound itself.
  //
  // DEFAULT is DERIVED, per order: `ceil(poolFeeBps + measuredExecutionGapBps) + 25 bps`.
  //   - `poolFeeBps` is read from the POOL itself (`pool.fee()`, above) -- never a constant.
  //   - `measuredExecutionGapBps` is how far this order's own PRE-FEE expected fill (`grossOut`,
  //     from slot0, above) sits below the oracle value of the input, in bps of that oracle value.
  //     Zero when the pool's spot price is at or above oracle value -- the gap is a shortfall, not
  //     a quote. Pre-fee, deliberately: the fee is already counted once via `poolFeeBps`, and
  //     measuring the gap from a fee-adjusted fill would count it twice (see
  //     deriveMaxSlippageBps's docstring) -- which would have quietly doubled the margin the MEV
  //     rationale below claims.
  //   - the 25 bps buffer is fixed, not a CLI knob.
  // Capped at 100 bps by default: a derivation above the cap REFUSES rather than silently widening,
  // unless `--max-slippage-bps N` is passed explicitly (validated against the chain ceiling above,
  // before any of this order's numbers were even assembled). An explicit `N` below the derived
  // minimum also refuses -- it would just revert `SwapSlippage()` once `minAmountOut` is computed
  // against it -- unless `--allow-below-derived` is passed too.
  //
  // NO SILENT FALLBACK: if the derivation cannot be computed -- no oracle price (checked above), no
  // pool fee, no expected fill -- this script refuses. It never falls back to the ceiling or to a
  // constant.
  //
  // MEV RATIONALE. A sandwich can extract at most the slack between the tolerance this order grants
  // and the real cost of executing it. Real cost is roughly one pool fee plus the real (pre-fee)
  // price gap; this order's tolerance is exactly (fee + gap) + 25 bps, so the slack available to an
  // attacker is bounded by ~25 bps, against which the attacker pays the pool fee TWICE (a front-run
  // leg and a back-run leg) plus gas on top -- unprofitable at the order sizes a launch vault
  // trades. THAT ASSUMPTION IS EXPLICIT, STATED, AND NOT ALWAYS TRUE: it weakens as an order grows
  // relative to pool depth (see the "over 1% of one side" warning below), because both price impact
  // and the slack available to an attacker grow with order size while the attacker's own cost --
  // the pool fee -- does not grow proportionally as fast against a sufficiently deep pool.
  const floorBufferBps = BigInt(arg('floor-buffer-bps', '100'));
  const deadline = big(cast('block', 'latest', '--field', 'timestamp')) + ttl;

  const order = buildRebalanceOrder({
    adapter, usdc, tokenOut, amountIn,
    unitOut, priceOutWad, usdcScalar,
    poolFeeRawPpm, grossOut,
    overrideBps, allowBelowDerived,
    floorBufferBps,
    deadline,
    BPS,
  });

  console.log('--- maxSlippageBps derivation ----------------------------------------------------');
  if (order.derivation && order.derivation.poolFeeBps !== undefined) {
    console.log(`poolFeeBps                  ${order.derivation.poolFeeBps}`);
    console.log(`measuredExecutionGapBps     ${order.derivation.measuredExecutionGapBps}`);
    console.log(`buffer                      ${DERIVED_BUFFER_BPS}`);
    console.log(`derived (fee+gap+buffer)    ${order.derivation.derivedSlipBps}`);
    console.log(`default cap                 ${DERIVED_CAP_BPS}`);
    console.log(`ceiling (chain)             ${ceilingBps}`);
  }
  if (!order.ok) fail(order.reason);
  const chosenSlipBps = order.chosenSlipBps;
  console.log(
    order.derivation.usedOverride
      ? `chosen                      ${chosenSlipBps}  (--max-slippage-bps override)\n`
      : `chosen                      ${chosenSlipBps}  (derived default)\n`,
  );

  console.log(`chosen maxSlippageBps       ${chosenSlipBps}`);
  console.log(`priceWad(tokenOut)          ${priceOutWad}`);
  console.log(`usdcScalar()                ${usdcScalar}`);
  console.log(`bare oracle floor           ${order.bareFloor}`);
  console.log(`minAmountOut                ${order.minAmountOut}  (+${floorBufferBps} bps)`);
  console.log(
    `  => survives a fall in tokenOut's oracle price of up to ${floorBufferBps} bps before\n`
    + '     MinOutTooLow(); a bare floor survives ZERO and reverts on any fall at all.\n',
  );
  console.log(`  => ${order.headroomBps} bps of headroom above minAmountOut before SwapSlippage()\n`);

  const bpsOfPool = ppmOfPool / 100n;
  if (bpsOfPool > 100n) {
    console.log(
      '  WARNING: over 1% of one side. The oracle bound is the ONLY slippage protection here, and '
        + 'it is measured against the oracle, not against depth. This is also where the MEV '
        + 'rationale above weakens: both price impact and an attacker\'s extractable slack grow '
        + 'with order size relative to pool depth.',
    );
  }
  console.log();

  // ---- verify the encoding, independent of buildRebalanceOrder's own construction -------------
  const derivedSelector = castPure('sig', EXACT_INPUT_SINGLE_SIG).trim();
  if (derivedSelector.toLowerCase() !== EXACT_INPUT_SINGLE) {
    fail(
      `keccak of "${EXACT_INPUT_SINGLE_SIG}" is ${derivedSelector}, not ${EXACT_INPUT_SINGLE}. The `
        + 'struct shape in this script does not match the one the adapter allowlists.',
    );
  }

  // Compare the VALUES, not just the adapter's presence. An earlier version substring-matched the
  // adapter address, which also appears inside routeData as `recipient` — so it would have passed
  // on a payload whose amounts were wrong. The decode signature itself is read off the compiled
  // contract (rebalanceDecodeSig, above) rather than hand-typed here a second time -- that
  // hand-typed second copy is what drifted from Governance.execute's real 3-field decode in the
  // first place (card 207).
  const decodeSig = rebalanceDecodeSig();
  const rt = castPure('abi-decode', '--input', decodeSig, order.payload);
  // `\d+`, not `\d{4,}`. The four-digit floor was a false NEGATIVE: `--amount-in 100` produces a
  // correct payload that this check then rejected. It failed safe, but a verifier that reds on
  // good input is one people learn to bypass. Hex bodies are stripped first so the digits inside
  // `0x…` cannot accidentally satisfy a value.
  const rtNums = (rt.replace(/0x[0-9a-fA-F]+/g, ' ').match(/\b\d+\b/g) || []).map((n) => BigInt(n));
  for (const [label, want] of [
    ['maxSlippageBps', chosenSlipBps],
    ['amountIn', amountIn],
    ['minAmountOut', order.minAmountOut],
    ['deadline', deadline],
  ]) {
    if (!rtNums.includes(want)) {
      fail(`payload did not round-trip: ${label} ${want} is absent from the decode:\n${rt}`);
    }
  }
  console.log(`round-trip decode ok (maxSlippageBps, amountIn, minAmountOut and deadline all recovered)\n`);

  const actionHash = castPure('keccak', order.payload).trim();

  console.log('--- the order -------------------------------------------------------------------');
  console.log(`tokenIn       ${usdc}`);
  console.log(`tokenOut      ${tokenOut}`);
  console.log(`amountIn      ${amountIn}`);
  console.log(`maxSlippageBps ${chosenSlipBps}   <-- DERIVED by default (card 209); see derivation above`);
  console.log(`minAmountOut  ${order.minAmountOut}   <-- FROZEN NOW, FILLED HOURS LATER`);
  // STATE THE COVERAGE, ALWAYS. An earlier version printed "covers the whole 86400s window" as a
  // flat assertion and that was false; removing it left NOTHING, so an --accept-partial-window run
  // emitted output byte-identical to a fully-covered one and a pasted payload carried no evidence
  // of which produced it. Both are wrong. The arithmetic is already done, so print it.
  const covered = ttl > roundFloor ? ttl - roundFloor : 0n;
  const coverPct = execWindow === 0n ? 0n : (covered * 100n) / execWindow;
  console.log(`deadline      ${deadline}  (ttl ${ttl}s)`);
  console.log(
    `              covers ${covered}s of the ${execWindow}s window (${coverPct}%)`
    + `${acceptShort ? '  <-- --accept-partial-window WAS PASSED' : ''}`,
  );
  console.log(
    '              measured from the EARLIEST possible executableAt; a late finalize slides the\n'
    + '              real window later and this deadline does not move with it.',
  );
  console.log(`recipient     ${adapter}   <-- the ADAPTER, which measures its own balance delta`);
  console.log(`\nactionHash    ${actionHash}`);
  console.log(`\npayload\n${order.payload}\n`);

  console.log('--- what is still uncontrolled --------------------------------------------------');
  console.log(
    'The H-4 bound is re-evaluated at EXECUTE time against the oracle price THEN, and the value of\n'
    + 'the INPUT leg is oracle-independent, so the bound reduces to a condition on one price only:\n'
    + `this order survives a fall in tokenOut's oracle price of up to ${floorBufferBps} bps between\n`
    + 'propose and execute, and reverts MinOutTooLow() beyond that. A BARE floor survives zero -\n'
    + 'any fall at all - which is why --floor-buffer-bps must be passed below the chosen\n'
    + 'maxSlippageBps printed above (its old 100 bps default was sized against the old 200 bps\n'
    + 'ceiling default and will usually be incoherent with a derived value now -- see the usage\n'
    + 'comment at the top of this file).\n'
    + '\n'
    + 'The buffer is paid for on the other side: the swap must actually deliver minAmountOut, so\n'
    + `too large a buffer reverts SwapSlippage() instead. Measured above at ${order.headroomBps} bps of\n`
    + 'headroom against what the pool would pay at spot. Never set minAmountOut BELOW the bare\n'
    + 'floor: that is the region H-4 rejects outright, since the bound is a minimum on what you\n'
    + 'must receive.\n'
    + '\n'
    + 'maxSlippageBps ITSELF is now DERIVED per order rather than fixed at the ceiling (card 209):\n'
    + `${chosenSlipBps} bps here, against a ${ceilingBps} bps ceiling. The MEV rationale for why that\n`
    + 'is still safe is written above the derivation, and it names its own order-size assumption --\n'
    + 'it weakens as this order grows relative to the pool\'s depth.\n'
    + '\n'
    + 'THE DEADLINE DOES NOT COVER A FIXED WINDOW, and an earlier version of this script asserted\n'
    + 'that it did. `Governance.finalize` sets `executableAt = block.timestamp + timelockDuration`\n'
    + 'at the moment finalize is MINED, not at createdAt, and finalize is permissionless and only\n'
    + 'gated on `block.timestamp >= revealDeadline` -- nothing obliges anyone to call it promptly.\n'
    + `So createdAt+${roundFloor} is a LOWER BOUND on executableAt, and the real window slides\n`
    + 'later by however long finalize is delayed while this deadline does not move. Finalize an\n'
    + 'hour late and you lose an hour of coverage off the end.\n'
    + '\n'
    + 'Two anchors, both under your control, and the only two things that make the coverage real:\n'
    + '  1. broadcast propose promptly after this run -- the deadline is anchored to the block\n'
    + `     timestamp AT THIS RUN, so every second until propose eats the ${PROPOSE_MARGIN}s margin;\n`
    + '  2. call finalize as soon as the reveal deadline passes, not whenever convenient.',
  );
  console.log('\nThis script has broadcast nothing and holds no key. SWARM §10: the owner signs.');
}

// Run only when invoked as a script, not when imported. scripts/test/build-rebalance-order-
// slippage.test.mjs imports this module for its pure, exported functions (validateOverrideRange,
// deriveMaxSlippageBps, buildRebalanceOrder, rebalanceDecodeSig) -- an unconditional main() would
// call process.exit(1) inside the TEST process on the very first missing-`--vault` check.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
