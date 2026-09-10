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
 *
 * `--token-out` and `--adapter` default to WETH and the deployed adapter on chain 4663.
 * `--accept-partial-window` allows a deadline that expires inside the execution window; read
 * the refusal text before reaching for it, because it trades one real risk for another.
 * `GOVERNANCE` in the environment overrides the address read from `vault.governance()`.
 *
 * `--amount-in` is in the vault's `usdc()` base units (USDG has 6 decimals, so 5000000 = 5 USDG).
 */

import { execFileSync } from 'node:child_process';

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
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
  if (commitDur === 0n || revealDur === 0n || execWindow === 0n) {
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
  // `\d+`, not `\d{4,}`. The four-digit floor was a false NEGATIVE: `--amount-in 100` produces a
  // correct payload that this check then rejected. It failed safe, but a verifier that reds on
  // good input is one people learn to bypass. Hex bodies are stripped first so the digits inside
  // `0x…` cannot accidentally satisfy a value.
  const rtNums = (rt.replace(/0x[0-9a-fA-F]+/g, ' ').match(/\b\d+\b/g) || []).map((n) => BigInt(n));
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
  console.log(`deadline      ${deadline}  (ttl ${ttl}s)`);
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
