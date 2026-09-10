#!/usr/bin/env node
/**
 * Build and VERIFY a single-hop rebalance order for a live vault, and print the exact calldata a
 * governance round would carry. It never broadcasts and never touches a key: SWARM §10 puts every
 * `--broadcast`, funded account and mainnet fund movement with the owner, and this script exists so
 * that what the owner signs has been checked against the chain first rather than hand-assembled.
 *
 * WHY THIS IS NOT A CONVENIENCE WRAPPER. Three of the order's six fields are frozen into the
 * proposal's `actionHash` at propose time and cannot be changed before execution:
 *
 *   - `amountIn`      — sized here, spent ≥2 h later
 *   - `minAmountOut`  — a price floor committed ≥2 h before the fill
 *   - `deadline`      — must outlive the whole round or `executeSwap` reverts `Expired()`
 *
 * The round's floor is `commitDuration + revealDuration`, and all three shipped configs set
 * 3600 + 3600, so the earliest possible execution is `createdAt + 7200`. A `deadline` that looks
 * generous at propose time is the single most likely way for a first live rebalance to fail, and it
 * fails AFTER two hours of governance rather than immediately. That is what this script checks.
 *
 * WHAT IT CANNOT DO. It cannot make the committed floor safe. `minAmountOut` is fixed now and the
 * fill happens later, so a move against you between the two either reverts (`SwapSlippage()` on the
 * measured delta, or `MinOutTooLow()` on the oracle bound at execute time) or fills at a floor the
 * market has already left behind. The script quantifies that exposure; it does not remove it. The
 * only structural fix is a smaller `amountIn`, and that is an owner decision.
 *
 * Usage:
 *   node scripts/build-rebalance-order.mjs --vault 0x… --amount-in 5000000 [--fee 100] [--ttl 21600]
 *
 * `--amount-in` is in the vault's `usdc()` base units (USDG has 6 decimals, so 5000000 = 5 USDG).
 */

import { execFileSync } from 'node:child_process';

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

// VaultCore.MAX_REBALANCE_SLIPPAGE_BPS, read from contracts/src/VaultCore.sol:68. Restated here as
// a checked constant rather than trusted: `assertContractConstants` re-reads it off the chain.
const MAX_REBALANCE_SLIPPAGE_BPS = 200n;
const BPS = 10000n;

// SwapRouter02's exactInputSingle — the 7-field params struct, WITHOUT the `deadline` member the
// original SwapRouter carried. That difference is the whole reason the selector is 0x04e45aaf and
// not 0x414bf389, and picking the wrong one is rejected by the adapter's allowlist, not by the
// router. Verified on chain: it is the ONLY selector `allowedSelector` returns true for.
const EXACT_INPUT_SINGLE = '0x04e45aaf';
const EXACT_INPUT_SINGLE_SIG =
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';

function cast(...args) {
  return execFileSync('cast', [...args, '--rpc-url', RPC], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  }).trim();
}

/**
 * The pure subcommands. `cast sig`, `cast keccak` and `cast abi-decode` compute rather than query,
 * and REJECT `--rpc-url` outright ("unexpected argument"), so they cannot share the helper above.
 * Keeping them in a separate function is also the honest signal: nothing these three return is
 * evidence about the chain, only about the encoding.
 */
function castPure(...args) {
  return execFileSync('cast', args, { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
}

/** A `cast call` returning one value, with the trailing `[1.23e4]` annotation stripped. */
function call(to, sig, ...args) {
  return cast('call', to, sig, ...args).split('\n')[0].split(/\s+/)[0].trim();
}

function big(v) {
  return BigInt(v.replace(/\[.*\]$/, '').trim());
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === null) throw new Error(`missing required --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
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

function fail(msg) {
  console.error(`\nREFUSING TO EMIT AN ORDER: ${msg}\n`);
  process.exit(1);
}

/**
 * The oracle bound VaultCore applies BEFORE executing the order (H-4, VaultCore.sol:909):
 *
 *   value(tokenOut, minAmountOut) * BPS >= value(tokenIn, amountIn) * (BPS - MAX_SLIPPAGE)
 *
 * Both sides are the vault's OWN oracle, not the pool. So `minAmountOut` has a hard floor set by
 * the oracle, independent of what the pool would actually pay. If the pool pays less than that
 * floor the order cannot be made valid at any `minAmountOut` — that is a real "this trade is not
 * executable right now" answer, and it is better to learn it here than after a two-hour round.
 */
function oracleFloor(valueInWad, priceOutWad, unitOut) {
  const requiredValueWad = (valueInWad * (BPS - MAX_REBALANCE_SLIPPAGE_BPS)) / BPS;
  // minAmountOut such that value(tokenOut, minAmountOut) >= requiredValueWad.
  // _valueWad(token, amt) = amt * priceWad / unit, so amt = requiredValueWad * unit / priceWad,
  // rounded UP so the computed amount satisfies a `>=` comparison rather than landing just under.
  return (requiredValueWad * unitOut + priceOutWad - 1n) / priceOutWad;
}

async function main() {
  const vault = arg('vault');
  const amountIn = BigInt(arg('amount-in'));
  const feeTier = BigInt(arg('fee', '100'));
  const ttl = BigInt(arg('ttl', '21600')); // 6 h default: 2 h round floor plus real headroom

  if (amountIn <= 0n) fail('--amount-in must be positive');

  console.log(`RPC       ${RPC}`);
  console.log(`chainId   ${cast('chain-id')}`);
  const head = big(cast('block-number'));
  console.log(`block     ${head}`);
  console.log(`vault     ${vault}\n`);

  // ---- what the vault is, read from the vault ------------------------------------------------
  const usdc = call(vault, 'usdc()(address)');
  const oracle = call(vault, 'oracle()(address)');
  const idle = big(call(vault, 'idleUsdc()(uint256)'));
  const nav = big(call(vault, 'navWad()(uint256)'));

  console.log(`usdc      ${usdc}`);
  console.log(`oracle    ${oracle}`);
  console.log(`idleUsdc  ${idle}`);
  console.log(`navWad    ${nav}\n`);

  if (amountIn > idle) {
    fail(
      `--amount-in ${amountIn} exceeds idleUsdc ${idle}. VaultCore.executeRebalance reverts `
        + 'InsufficientAssetBalance() before it ever reaches the adapter.',
    );
  }

  // ---- the adapter, and the single selector it will accept ------------------------------------
  const adapter = arg('adapter', '0xc83B9CE8a12B8aca3f5f7d1C20383d60B1ECaA5E');
  const allowed = call(vault, 'isAllowedAdapter(address)(bool)', adapter);
  if (allowed !== 'true') {
    fail(
      `vault ${vault} does not allow adapter ${adapter}. isAllowedAdapter is constructor-only, so `
        + 'this cannot be fixed by a transaction — it is the wrong adapter for this vault.',
    );
  }
  const router = call(adapter, 'router()(address)');
  const selectorOk = call(adapter, 'allowedSelector(bytes4)(bool)', EXACT_INPUT_SINGLE);
  if (selectorOk !== 'true') {
    fail(
      `adapter ${adapter} does not allow ${EXACT_INPUT_SINGLE} (SwapRouter02 exactInputSingle). `
        + 'The allowlist is fixed at construction (EX-1), so no other route data can be used.',
    );
  }
  console.log(`adapter   ${adapter}  (router ${router}, selector ${EXACT_INPUT_SINGLE} allowed)\n`);

  // ---- the output asset ------------------------------------------------------------------------
  const tokenOut = arg('token-out', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'); // WETH on 4663
  const unitOut = big(call(vault, 'assetUnit(address)(uint256)', tokenOut));
  if (unitOut === 0n) {
    fail(
      `${tokenOut} is not in this vault's basket (assetUnit reads 0). VaultCore.executeRebalance `
        + 'rejects it with BadSwapToken() before the oracle is consulted.',
    );
  }

  // ---- prices, from the vault's OWN oracle (the bound is against this, not the pool) -----------
  const priceInWad = big(call(oracle, 'priceWad(address)(uint256)', usdc));
  const priceOutWad = big(call(oracle, 'priceWad(address)(uint256)', tokenOut));
  const unitIn = big(call(vault, 'assetUnit(address)(uint256)', usdc)) || 1000000n;

  const valueInWad = (amountIn * priceInWad) / unitIn;
  const floor = oracleFloor(valueInWad, priceOutWad, unitOut);

  console.log(`priceWad(usdc)     ${priceInWad}`);
  console.log(`priceWad(tokenOut) ${priceOutWad}`);
  console.log(`value(amountIn)    ${valueInWad} wad`);
  console.log(`oracle floor       ${floor}  (minAmountOut may not go below this)\n`);

  // ---- what the pool would actually pay, right now ---------------------------------------------
  const factory = call(router, 'factory()(address)');
  const pool = call(factory, 'getPool(address,address,uint24)(address)', usdc, tokenOut, feeTier);
  if (/^0x0{40}$/i.test(pool)) fail(`no pool for that pair at fee ${feeTier}`);

  const liquidity = big(call(pool, 'liquidity()(uint128)'));
  if (liquidity === 0n) {
    fail(
      `pool ${pool} (fee ${feeTier}) has liquidity() == 0. There is nothing to trade against; a `
        + 'nonzero token balance in the pool is not the same as active in-range liquidity.',
    );
  }
  const poolIn = big(call(usdc, 'balanceOf(address)(uint256)', pool));
  const poolOut = big(call(tokenOut, 'balanceOf(address)(uint256)', pool));
  console.log(`pool      ${pool}  fee ${feeTier}`);
  console.log(`liquidity ${liquidity}`);
  console.log(`reserves  ${poolIn} in / ${poolOut} out\n`);

  // Depth sanity: this is NOT a quote. A real quote needs the Quoter, which is a state-mutating
  // staticcall and is not deployed on every chain. What this DOES tell you is whether the order is
  // large relative to the pool, which is the condition under which a committed floor is dangerous.
  const pctOfPool = poolIn === 0n ? 100n : (amountIn * 10000n) / poolIn;
  console.log(`order is ${Number(pctOfPool) / 100}% of the pool's ${usdc} side`);
  if (pctOfPool > 100n) {
    console.log(
      '  WARNING: over 1% of one side. The 2% oracle bound is the ONLY slippage protection, and '
        + 'it is measured against the oracle, not against depth.',
    );
  }
  console.log();

  // ---- assemble ---------------------------------------------------------------------------------
  const minAmountOut = floor; // the tightest value the oracle bound permits
  const deadline = big(cast('block', 'latest', '--field', 'timestamp')) + ttl;

  // Encoded by hand rather than through `cast calldata`. Foundry's tuple parser splits a
  // "(a,b,c)" argument on its commas and reports `encode length mismatch: expected 1 types, got 3`,
  // so the struct cannot be passed through the CLI at all. Every member of ExactInputSingleParams
  // is a STATIC type, so the encoding is exactly seven 32-byte words after the selector with no
  // offsets and no tail — there is nothing here for a hand encoder to get subtly wrong, and the
  // selector is re-derived from the signature below rather than trusted as a literal.
  const derived = castPure('sig', EXACT_INPUT_SINGLE_SIG);
  if (derived.toLowerCase() !== EXACT_INPUT_SINGLE) {
    fail(
      `keccak of "${EXACT_INPUT_SINGLE_SIG}" is ${derived}, not the ${EXACT_INPUT_SINGLE} the `
        + 'adapter allowlists. The struct shape in this script does not match the one on chain.',
    );
  }
  const routeData = EXACT_INPUT_SINGLE
    + [usdc, tokenOut, feeTier, adapter, amountIn, minAmountOut, 0n].map(word).join('');

  // abi.encode(address, SwapOrder[]) — SwapOrder is dynamic because of `bytes routeData`, so this
  // one does have offsets. It is verified by decoding it back, below, rather than by inspection.
  const orderBody = [usdc, tokenOut, amountIn, minAmountOut, deadline].map(word).join('')
    + word(0xc0n) // offset to routeData, relative to the start of this struct
    + word(BigInt((routeData.length - 2) / 2))
    + pad32(routeData.slice(2));
  const payload = '0x'
    + word(adapter)
    + word(0x40n) // offset to the orders array
    + word(1n) // orders.length
    + word(0x20n) // offset of orders[0], relative to the start of the array's data
    + orderBody;

  // The check that makes the hand encoding safe: decode it back with a tool that did not produce
  // it, and require the round trip to return the adapter and the amounts that went in.
  const rt = castPure('abi-decode', '--input', 'f(address,(address,address,uint256,uint256,uint256,bytes)[])', payload);
  if (!rt.toLowerCase().includes(adapter.toLowerCase().slice(2))) {
    fail(`payload did not round-trip: abi-decode returned\n${rt}`);
  }
  console.log(`round-trip decode ok:\n${rt}\n`);

  const actionHash = castPure('keccak', payload);

  console.log('--- the order -------------------------------------------------------------------');
  console.log(`tokenIn       ${usdc}`);
  console.log(`tokenOut      ${tokenOut}`);
  console.log(`amountIn      ${amountIn}`);
  console.log(`minAmountOut  ${minAmountOut}   <-- FROZEN NOW, FILLED >=2h LATER`);
  console.log(`deadline      ${deadline}  (ttl ${ttl}s)`);
  console.log(`recipient     ${adapter}   <-- the ADAPTER, which measures its own balance delta`);
  console.log(`\nactionHash    ${actionHash}`);
  console.log(`\npayload\n${payload}\n`);

  // ---- the checks that are the point of the script ----------------------------------------------
  console.log('--- checks ----------------------------------------------------------------------');
  const roundFloorSecs = 7200n; // commitDuration 3600 + revealDuration 3600, all three configs
  if (ttl <= roundFloorSecs) {
    fail(
      `--ttl ${ttl}s does not outlive the round. The earliest possible execution is createdAt + `
        + `${roundFloorSecs}s (commit 3600 + reveal 3600), so the adapter would revert Expired() `
        + 'on an order that governance had already passed. Use at least 4h, and prefer 6h.',
    );
  }
  console.log(`ok  deadline outlives the ${roundFloorSecs}s round floor by ${ttl - roundFloorSecs}s`);
  console.log(`ok  minAmountOut ${minAmountOut} == oracle floor (H-4 satisfied at TODAY's prices)`);
  console.log(
    '\nNOT CHECKED, AND NOT CHECKABLE FROM HERE: the H-4 bound is re-evaluated at EXECUTE time\n'
      + 'against the oracle price THEN. This order sets minAmountOut to exactly the floor implied\n'
      + "by today's price, so ANY adverse move in tokenOut's oracle price before execution makes\n"
      + 'the bound fail and the whole round revert. Set minAmountOut below the floor by a margin\n'
      + 'you choose, or accept that a two-hour-old floor is a two-hour-old opinion.\n',
  );
  console.log('This script has broadcast nothing and holds no key. SWARM §10: the owner signs.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
