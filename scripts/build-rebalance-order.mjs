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
 * executable across `[executableAt, executableAt + executionWindow]`. On this vault that window is
 * 86,400 s. A deadline that clears the commit+reveal floor but expires inside the window leaves a
 * proposal that is still `Passed` and still executable while `executeSwap` reverts `Expired()` —
 * the round is burned, the `actionHash` is frozen, and there is no re-execution path. So the
 * default TTL here covers the whole window, and every duration is read from `Governance.configOf`
 * rather than assumed. An earlier version hardcoded 7,200 s and ignored `timelockDuration`
 * entirely; that number is correct on this vault today and a `RuleChange` can move it.
 *
 * WHAT IT CANNOT DO. It cannot make the committed floor safe. `minAmountOut` is fixed now and the
 * fill happens later; a move against you either reverts or fills at a floor the market has left.
 * The script quantifies that exposure; only a smaller `amountIn` reduces it, and sizing is an
 * owner decision.
 *
 * Usage:
 *   node scripts/build-rebalance-order.mjs --vault 0x… --amount-in 5000000 [--fee 100] [--ttl N]
 *
 * `--amount-in` is in the vault's `usdc()` base units (USDG has 6 decimals, so 5000000 = 5 USDG).
 */

import { execFileSync } from 'node:child_process';

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const GOVERNANCE = process.env.GOVERNANCE || '0x790A308f1ac06FeD4C79884BAD25d0C721C5B125';
const BPS = 10000n;

// SwapRouter02's exactInputSingle: the 7-field params struct, WITHOUT the `deadline` member the
// original SwapRouter carried. That difference is why the selector is 0x04e45aaf and not
// 0x414bf389, and the wrong one is rejected by the adapter's allowlist, not by the router.
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

function fail(msg) {
  console.error(`\nREFUSING TO EMIT AN ORDER: ${msg}\n`);
  process.exit(1);
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

  // ---- governance timing, read live ----------------------------------------------------------
  // Every one of these is a `RuleChange` away from moving, and the failure they cause happens
  // AFTER a multi-hour round rather than at propose time, so none of them is hardcoded.
  const cfgRaw = cast(
    'call', GOVERNANCE,
    'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16)', vault,
  ).split('\n').map((l) => big(l));
  const [commitDur, revealDur, timelockDur, execWindow] = cfgRaw;

  const roundFloor = commitDur + revealDur + timelockDur;
  const windowEnd = roundFloor + execWindow;

  console.log(`commitDuration    ${commitDur}`);
  console.log(`revealDuration    ${revealDur}`);
  console.log(`timelockDuration  ${timelockDur}`);
  console.log(`executionWindow   ${execWindow}`);
  console.log(`=> executable from createdAt+${roundFloor} to createdAt+${windowEnd}\n`);

  // Default: cover the WHOLE window, plus margin for the gap between running this and proposing.
  const PROPOSE_MARGIN = 3600n;
  const ttl = BigInt(arg('ttl', String(windowEnd + PROPOSE_MARGIN)));

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
  if (ttl < windowEnd) {
    fail(
      `--ttl ${ttl}s reaches the execution window but expires inside it. The window is `
        + `[createdAt+${roundFloor}, createdAt+${windowEnd}] and this deadline covers only `
        + `${ttl - roundFloor}s of ${execWindow}s. Miss that slot and the proposal stays Passed `
        + 'and executable while executeSwap reverts Expired(): the round is burned with no '
        + `re-execution path, because actionHash is frozen. Use at least ${windowEnd + PROPOSE_MARGIN}.`,
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

  // ---- the H-4 oracle bound ---------------------------------------------------------------------
  // VaultCore.executeRebalance requires, BEFORE executing:
  //   _valueWad(tokenOut, minAmountOut) * BPS >= _valueWad(tokenIn, amountIn) * (BPS - MAX_SLIPPAGE)
  // Both sides use the vault's OWN oracle, so minAmountOut has a floor unrelated to what the pool
  // would pay. MAX_REBALANCE_SLIPPAGE_BPS is read off the chain rather than restated.
  const maxSlipBps = big(call(vault, 'MAX_REBALANCE_SLIPPAGE_BPS()(uint256)'));
  const priceOutWad = big(call(oracle, 'priceWad(address)(uint256)', tokenOut));

  // `_valueWad(usdc, amt)` is `amt * usdcScalar()` — oracle-independent, and NOT `amt * price /
  // assetUnit(usdc)`. `assetUnit(usdc)` is 0 by construction: VaultCore forbids the settlement
  // token in the basket. An earlier version divided by a hardcoded 1e6 fallback that was taken on
  // every run; it happened to agree on this vault and would be wrong on any non-6-decimal
  // settlement token, which the constructor permits.
  const usdcScalar = big(call(vault, 'usdcScalar()(uint256)'));
  const valueInWad = amountIn * usdcScalar;

  // minOut such that minOut * priceOut / unitOut >= valueIn * (BPS - slip) / BPS, rounded UP at
  // each step so the emitted value satisfies a `>=` rather than landing one wei under it.
  const requiredValueWad = (valueInWad * (BPS - maxSlipBps) + BPS - 1n) / BPS;
  const minAmountOut = (requiredValueWad * unitOut + priceOutWad - 1n) / priceOutWad;

  console.log(`MAX_REBALANCE_SLIPPAGE_BPS  ${maxSlipBps}`);
  console.log(`priceWad(tokenOut)          ${priceOutWad}`);
  console.log(`usdcScalar()                ${usdcScalar}`);
  console.log(`value(amountIn)             ${valueInWad} wad`);
  console.log(`oracle floor                ${minAmountOut}\n`);

  // ---- what the pool can actually pay ------------------------------------------------------------
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

  // Basis points, not percent: integer percent truncates a 5 USDG order against a multi-million
  // pool straight to "0%", which reads as "measured and negligible" when nothing was measured.
  // This is a DEPTH RATIO, not a quote — a real quote needs the Quoter, which is a state-mutating
  // staticcall and is not deployed on every chain.
  // Parts per million, and printed as a fraction when even that truncates. Integer PERCENT sent a
  // 5 USDG order against a multi-million-unit pool straight to "0%", which reads as "measured and
  // negligible" when nothing had been measured at all.
  const ppmOfPool = poolIn === 0n ? 1000000n : (amountIn * 1000000n) / poolIn;
  const ratio = poolIn === 0n ? 0n : poolIn / amountIn;
  console.log(
    ppmOfPool > 0n
      ? `order is ${ppmOfPool} ppm of the pool's usdc side (depth ratio, NOT a quote)`
      : `order is under 1 ppm of the pool's usdc side: 1 part in ${ratio} (depth ratio, NOT a quote)`,
  );
  const bpsOfPool = ppmOfPool / 100n;
  if (bpsOfPool > 100n) {
    console.log(
      '  WARNING: over 1% of one side. The oracle bound is the ONLY slippage protection here, and '
        + 'it is measured against the oracle, not against depth.',
    );
  }
  console.log();

  // ---- assemble ------------------------------------------------------------------------------
  const derived = castPure('sig', EXACT_INPUT_SINGLE_SIG).trim();
  if (derived.toLowerCase() !== EXACT_INPUT_SINGLE) {
    fail(
      `keccak of "${EXACT_INPUT_SINGLE_SIG}" is ${derived}, not ${EXACT_INPUT_SINGLE}. The struct `
        + 'shape in this script does not match the one the adapter allowlists.',
    );
  }

  const deadline = big(cast('block', 'latest', '--field', 'timestamp')) + ttl;

  // Every member of ExactInputSingleParams is STATIC, so this is seven words after the selector
  // with no offsets and no tail. `cast calldata` cannot be used: it splits a "(a,b,c)" argument on
  // its commas and reports `encode length mismatch: expected 1 types, got 3`.
  const routeData = EXACT_INPUT_SINGLE
    + [usdc, tokenOut, feeTier, adapter, amountIn, minAmountOut, 0n].map(word).join('');

  // abi.encode(address, SwapOrder[]). SwapOrder is dynamic because of `bytes routeData`, so this
  // one has offsets, and it is verified by decoding it back rather than by inspection.
  const orderBody = [usdc, tokenOut, amountIn, minAmountOut, deadline].map(word).join('')
    + word(0xc0n)
    + word(BigInt((routeData.length - 2) / 2))
    + pad32(routeData.slice(2));
  const payload = '0x' + word(adapter) + word(0x40n) + word(1n) + word(0x20n) + orderBody;

  // Compare the VALUES, not just the adapter's presence. An earlier version substring-matched the
  // adapter address, which also appears inside routeData as `recipient` — so it would have passed
  // on a payload whose amounts were wrong.
  const rt = castPure(
    'abi-decode', '--input',
    'f(address,(address,address,uint256,uint256,uint256,bytes)[])', payload,
  );
  const rtNums = (rt.match(/\b\d{4,}\b/g) || []).map((n) => BigInt(n));
  for (const [label, want] of [['amountIn', amountIn], ['minAmountOut', minAmountOut], ['deadline', deadline]]) {
    if (!rtNums.includes(want)) {
      fail(`payload did not round-trip: ${label} ${want} is absent from the decode:\n${rt}`);
    }
  }
  console.log(`round-trip decode ok (amountIn, minAmountOut and deadline all recovered)\n`);

  const actionHash = castPure('keccak', payload).trim();

  console.log('--- the order -------------------------------------------------------------------');
  console.log(`tokenIn       ${usdc}`);
  console.log(`tokenOut      ${tokenOut}`);
  console.log(`amountIn      ${amountIn}`);
  console.log(`minAmountOut  ${minAmountOut}   <-- FROZEN NOW, FILLED HOURS LATER`);
  console.log(`deadline      ${deadline}  (ttl ${ttl}s, covers the whole ${execWindow}s window)`);
  console.log(`recipient     ${adapter}   <-- the ADAPTER, which measures its own balance delta`);
  console.log(`\nactionHash    ${actionHash}`);
  console.log(`\npayload\n${payload}\n`);

  console.log('--- what is still uncontrolled --------------------------------------------------');
  console.log(
    'The H-4 bound is re-evaluated at EXECUTE time against the oracle price THEN. This order sets\n'
    + "minAmountOut to exactly the floor implied by today's price, so ANY fall in tokenOut's oracle\n"
    + 'price before execution makes the bound fail and the round revert.\n'
    + '\n'
    + 'If you want margin, raise minAmountOut ABOVE this floor, never below it. Below the floor is\n'
    + 'precisely the region H-4 rejects: the bound is a MINIMUM on what you must receive, so a\n'
    + 'lower figure fails it outright with MinOutTooLow(). Note that raising it trades one failure\n'
    + 'for another - too high and the swap reverts SwapSlippage() on the measured delta instead -\n'
    + 'and that there is no flag for it here on purpose: changing it means changing the payload,\n'
    + 'and the payload is what the actionHash binds.\n'
    + '\n'
    + 'The deadline is anchored to the block timestamp AT THIS RUN, not at propose time, so every\n'
    + `second between running this and broadcasting propose eats into the ${PROPOSE_MARGIN}s margin.`,
  );
  console.log('\nThis script has broadcast nothing and holds no key. SWARM §10: the owner signs.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
