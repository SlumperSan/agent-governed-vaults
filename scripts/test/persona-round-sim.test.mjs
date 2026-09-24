// @ts-check
/**
 * Proves the seeded round (`Obsidian Vault/Agent-Governed Vaults/Decisions/
 * Seed agent personas 2026-09-23.md`) on a local anvil fork — real `DeployTestnet.s.sol`, real
 * SafeL2 v1.4.1, real Governance/VaultCore bytecode — the slow/fork suite `node --test` picks up
 * alongside `scripts/test/safe-route-fork.test.mjs`, which this file follows for its fork-plumbing
 * pattern (see `scripts/test/lib/safe-fork-chain.mjs` and this file's own
 * `scripts/test/lib/persona-fork-chain.mjs`).
 *
 * WHY BASE SEPOLIA, NOT ARC (full finding:
 * `Obsidian Vault/Agent-Governed Vaults/Findings/2026-09-23-arc-fork-persona-sim.md`). Arc's own
 * USDC (`0x3600...0000`) calls a native precompile at `0x1800...0000/0001` that anvil cannot
 * execute — `transfer`/`transferFrom` revert on ANY plain anvil fork of Arc, before anything else
 * in this spec could be exercised. This file forks Base Sepolia instead, exactly as
 * `safe-fork-chain.mjs` already does for card 208, and layers ARC'S OWN launch parameters
 * (`contracts/config/arc-mainnet.json`'s `smoke` block — gov timings, the 100 USDC minimum
 * deposit, the exit fee) onto every vault created here, so governance behaves as the live Arc
 * vault will. Base Sepolia's OWN chain config (`contracts/config/base-sepolia.json`) supplies only
 * what a fork of THAT chain can actually deploy against: its real USDC, its real Chainlink
 * WETH/USD feed, its real deployed router.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly rather than left to be inferred:
 *   - Arc's native-USDC transfer path — untestable on any anvil fork today (the finding above).
 *   - Arc's own router/pool liquidity for cirBTC — Vault 1's rebalance below probes Base Sepolia's
 *     WETH/USDC pool only, and NO SWAP EVER EXECUTES in this suite: see that test's own comment
 *     for why (a fork-clock artifact — the forked feed's `updatedAt` never advances while
 *     `evm_increaseTime` collapses ARC's real commit+reveal windows, so by execute() time on THIS
 *     fork the feed reads stale regardless of pool liquidity; this says nothing about live Arc,
 *     where the feed keeps publishing and a real execute() reads a genuinely fresh price).
 *   - Real wall-clock governance timing — every commit/reveal/timelock window is fast-forwarded
 *     via `evm_increaseTime`, as every other fork suite in this repository already does.
 *   - A basket-asset settlement leg. Every exit's "in-kind" assertion below covers the USDC leg
 *     only (`ExitSettled.usdcPaid`, cross-checked against the chain-read formula) — no vault in
 *     this suite ever holds a nonzero basket-asset balance (the rebalance above never executes a
 *     swap), so no exit here pays out a WETH slice, and nothing asserts that path.
 *
 * THE SPEC CORRECTION THIS FILE EXISTS TO PROVE (2026-09-23, corrected from an earlier draft of
 * the persona-seeding decision): "The Safe does not need to deposit first." `_checkCreatorGate`
 * (`VaultCore.sol:601-607`) is called ONLY from the creator's own exit path, and only once a
 * non-creator member already holds shares — never from `deposit`/`activate`. Every vault below is
 * created by a Safe that NEVER deposits, and Ballast/Momentum deposit and activate first, with the
 * Safe holding exactly 0 shares throughout — asserted explicitly, not merely assumed.
 *
 * PERSONA POLICIES (`scripts/lib/persona-policies.mjs`) ARE PURE FUNCTIONS, CALLED FOR EVERY
 * DECISION. Nothing here hardcodes "Ballast votes yes" — every deposit, vote and exit decision
 * below is the return value of a `decide(readout)`-shaped policy function, fed a readout this file
 * assembles from real chain reads. No LLM call anywhere in this suite.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  requireBin, startFork, generateThrowawayAccount, setEthBalance, dealErc20, deployProtocol,
  deploySafe, readSafe, cast, REPO, BASE_SEPOLIA_CHAIN_ID,
} from './lib/safe-fork-chain.mjs';
import * as chain from './lib/persona-fork-chain.mjs';
import * as policy from '../lib/persona-policies.mjs';
import { deriveMaxSlippageBps } from '../build-rebalance-order.mjs';

const ARC_SMOKE = chain.readArcSmokeParams(REPO); // contracts/config/arc-mainnet.json .smoke
const BASE_CFG = chain.readBaseSepoliaConfig(REPO); // contracts/config/base-sepolia.json
// `BASE_CFG.assets[0]` is the DEPRECATED legacy OracleAggregator block (base-sepolia.json's own
// `legacyAssetsNote`) — the launch path, and what DeployTestnet.s.sol actually deploys against, is
// `chainlinkOracle.assets[0]`. Its heartbeat is read fresh off each fork's DEPLOYED oracle
// (`chain.readOracleHeartbeat`, below, per-fork) rather than copied from this file, since it is
// what `priceWad` on that specific deployment actually enforces.
const WETH = BASE_CFG.chainlinkOracle.assets[0].asset; // Base Sepolia's real WETH — stands in for cirBTC's basket slot

// Two ports: the shared fork (Vault 1 + Vault 2) and Vault 3's OWN ISOLATED fork. Vault 3 needs
// its own fork/deploy because it deliberately pushes chain time past the WETH feed's heartbeat —
// sharing a fork with Vault 1/2 would leave their oracle reads stale too, and (more importantly)
// Vault 1's own real-swap-derivation probe needs a genuinely FRESH oracle to be a meaningful
// attempt, not one already poisoned by an unrelated test's warp. Ranges chosen to avoid
// `safe-route-fork.test.mjs` (8940+), `safe-tx-builder-fork.test.mjs` (9440+) and
// `safe-tx-builder-refusals.test.mjs` (9940+).
const PORT = 10500 + (process.pid % 400);
const PORT3 = 10950 + (process.pid % 400);
const ONE_ETH = 10n ** 18n;
const DEPOSIT_USDC = BigInt(ARC_SMOKE.minDepositUsdc); // ARC's 100 USDC minimum — the spec's "each deposits exactly 100 USDC"
const REBALANCE_PTYPE = '0'; // Governance.ProposalType.Rebalance

let fork, broadcaster, dep, usdc, sharedSafe, vault1, vault2;

before(async () => {
  for (const bin of ['anvil', 'forge', 'cast']) requireBin(bin);
  fork = await startFork({ port: PORT });
  broadcaster = generateThrowawayAccount();
  setEthBalance(fork.rpcUrl, broadcaster.address, `0x${(100n * ONE_ETH).toString(16)}`);
  dep = deployProtocol(fork.rpcUrl, broadcaster.privateKey); // real, unmodified DeployTestnet.s.sol
  usdc = BASE_CFG.usdc;
  console.log(`[persona-round-sim] shared fork: WETH oracle age at start ${chain.oracleFeedAgeSeconds(fork.rpcUrl, dep.aggregator, WETH)}s, heartbeat ${chain.readOracleHeartbeat(fork.rpcUrl, dep.aggregator, WETH)}s`);

  // ONE Safe (1-of-1, "the Arc shape") creates BOTH Vault 1 and Vault 2 below — the spec's "≥3
  // vaults created THROUGH a Safe" with a single owner key, reading a fresh nonce per call. Vault
  // 3 runs on its own isolated fork (see PORT3 above) and necessarily gets its own Safe there — a
  // Safe deployed on one anvil fork does not exist on another.
  const owner = generateThrowawayAccount();
  setEthBalance(fork.rpcUrl, owner.address, `0x${(10n * ONE_ETH).toString(16)}`);
  const address = deploySafe(fork.rpcUrl, broadcaster.privateKey, [owner.address], 1);
  sharedSafe = { address, ownerKey: owner.privateKey };

  // BOTH vaults are created HERE, up front, while the oracle is fresh — not lazily inside each
  // vault's own test. `VaultFactory.createVault` -> `_requireOracleCoversBasket` calls
  // `oracle.priceWad(WETH)` AT CREATION TIME (VaultFactory.sol) regardless of whether the vault
  // will ever hold that asset; Vault 1's own round advances chain time by ~172800s
  // (commitDuration+revealDuration) via `evm_increaseTime`, which alone exceeds the fork's WETH
  // feed's 86400s heartbeat — so a vault CREATED after Vault 1's round runs would find the shared
  // fork's oracle already stale and revert `OracleMissingAsset`, even though neither vault here
  // ever holds a nonzero WETH balance. Creating both before either round starts sidesteps this
  // entirely; it does not weaken "the Safe need not deposit first" (creation and deposit are
  // still fully separate steps, asserted separately in each vault's own setup test).
  vault1 = bootstrapVault(sharedSafe, { rpcUrl: fork.rpcUrl, deployment: dep });
  vault2 = bootstrapVault(sharedSafe, { rpcUrl: fork.rpcUrl, deployment: dep });
});

after(() => { fork?.stop(); });

/** Creates and registers one vault through `safe` with ARC's own smoke/gov params — the shared
 *  setup every vault below uses, so the ONLY thing that differs between them is what happens to
 *  it afterward. Takes `deployment`/`rpcUrl` explicitly so it also works against Vault 3's own
 *  isolated fork, not only the shared one closed over by module scope. */
function bootstrapVault(safe, { rpcUrl, deployment, broadcasterPrivateKey = broadcaster.privateKey }) {
  const vault = chain.createVaultViaSafe({
    rpcUrl, safe: safe.address, ownerPrivateKey: safe.ownerKey, broadcasterPrivateKey,
    factory: deployment.factory, usdc, tokens: [WETH], aggregator: deployment.aggregator, adapter: deployment.adapter,
    smoke: ARC_SMOKE, chainId: BASE_SEPOLIA_CHAIN_ID,
  });
  chain.registerVaultViaSafe({
    rpcUrl, safe: safe.address, ownerPrivateKey: safe.ownerKey, broadcasterPrivateKey,
    governance: deployment.governance, vault, gov: ARC_SMOKE.gov, chainId: BASE_SEPOLIA_CHAIN_ID,
  });
  return vault;
}

/** `keccak256("StaleOracle(address)")`'s first 4 bytes — used to tighten the frozen-oracle
 *  assertions below to the SPECIFIC revert this test is about, not any revert. */
const STALE_ORACLE_SELECTOR = cast(['sig', 'StaleOracle(address)']).trim().toLowerCase();

// ═══════════════════════════ Vault 3: a frozen oracle blocks a deposit ═══════════════════════════
// Its OWN isolated fork (PORT3) and its OWN deploy — see the comment on PORT3 above for why.

test('Vault 3: a frozen oracle (warped past the heartbeat) blocks a second-mint deposit', async (t) => {
  const fork3 = await startFork({ port: PORT3 });
  t.after(() => fork3.stop());
  const broadcaster3 = generateThrowawayAccount();
  setEthBalance(fork3.rpcUrl, broadcaster3.address, `0x${(100n * ONE_ETH).toString(16)}`);
  const dep3 = deployProtocol(fork3.rpcUrl, broadcaster3.privateKey);

  const owner3 = generateThrowawayAccount();
  setEthBalance(fork3.rpcUrl, owner3.address, `0x${(10n * ONE_ETH).toString(16)}`);
  const safe3 = { address: deploySafe(fork3.rpcUrl, broadcaster3.privateKey, [owner3.address], 1), ownerKey: owner3.privateKey };
  const vault3 = bootstrapVault(safe3, { rpcUrl: fork3.rpcUrl, deployment: dep3, broadcasterPrivateKey: broadcaster3.privateKey });
  const heartbeat3 = chain.readOracleHeartbeat(fork3.rpcUrl, dep3.aggregator, WETH);
  console.log(`[persona-round-sim] Vault 3: oracle age at fork start ${chain.oracleFeedAgeSeconds(fork3.rpcUrl, dep3.aggregator, WETH)}s, heartbeat ${heartbeat3}s`);

  const member = generateThrowawayAccount();
  setEthBalance(fork3.rpcUrl, member.address, `0x${(10n * ONE_ETH).toString(16)}`);
  dealErc20(fork3.rpcUrl, usdc, member.address, DEPOSIT_USDC * 2n);

  // First deposit + activation: totalShares is 0 going in, so `_mintShares` takes the
  // `ts == 0 ? amountWad : ...` branch and never calls `navWad()` — this succeeds regardless of
  // oracle state. `activate()` ALSO sets `windowCleared[member] = true` as a side effect
  // (`_activatePending`, VaultCore.sol) — no separate `skipWindow()` call is needed for the
  // member's NEXT deposit to take the immediate-mint path.
  chain.approveAndDeposit(fork3.rpcUrl, member.privateKey, usdc, vault3, DEPOSIT_USDC);
  const pending = chain.readPendingDeposit(fork3.rpcUrl, vault3, member.address);
  chain.fastForward(fork3.rpcUrl, Math.max(1, pending.availableAt - chain.chainNow(fork3.rpcUrl)));
  chain.activate(fork3.rpcUrl, broadcaster3.privateKey, vault3, member.address);
  assert.ok(chain.sharesOf(fork3.rpcUrl, vault3, member.address) > 0n, 'the first deposit, oracle-independent, must succeed');
  assert.doesNotThrow(() => chain.oraclePriceWad(fork3.rpcUrl, dep3.aggregator, WETH), 'sanity: the oracle must read as fresh at this point, before any deliberate warp');

  // `navWad()` only calls `oracle.priceWad(asset)` for a basket asset whose `assetBalance[asset]`
  // is nonzero (VaultCore.sol's NAV walk) — with a purely-idle-USDC vault, the SECOND deposit's
  // `_mintShares -> navWad()` call would never touch the oracle at all, and the freeze below would
  // block nothing. `seedAssetBalance` is a deliberate, labelled fork adaptation (its own doc
  // comment in persona-fork-chain.mjs) that gives this vault a real WETH holding, internally AND
  // in real token custody, WHILE THE ORACLE IS STILL FRESH, so navWad() genuinely depends on it
  // from here on.
  const wethUnits = 1n * 10n ** 18n; // 1 WETH
  dealErc20(fork3.rpcUrl, WETH, vault3, wethUnits);
  chain.seedAssetBalance(fork3.rpcUrl, vault3, WETH, wethUnits);
  assert.doesNotThrow(() => chain.oraclePriceWad(fork3.rpcUrl, dep3.aggregator, WETH), 'still fresh: the seed step above must not itself have touched staleness');

  chain.fastForward(fork3.rpcUrl, heartbeat3 + 3600); // heartbeat + 1h margin

  assert.throws(
    () => chain.oraclePriceWad(fork3.rpcUrl, dep3.aggregator, WETH),
    (err) => new RegExp(STALE_ORACLE_SELECTOR, 'i').test(err.message),
    'sanity: the oracle read itself must now revert with StaleOracle specifically before asserting the deposit is blocked by it',
  );

  const result = chain.tryApproveAndDeposit(fork3.rpcUrl, member.privateKey, usdc, vault3, DEPOSIT_USDC);
  assert.equal(result.ok, false, 'a second, immediate-mint deposit must revert while the oracle is stale (the vault now genuinely holds a basket asset priced by it)');
  assert.match(result.error, new RegExp(STALE_ORACLE_SELECTOR, 'i'), `expected the StaleOracle selector (${STALE_ORACLE_SELECTOR}) in the revert, got: ${result.error}`);
  assert.equal(chain.sharesOf(fork3.rpcUrl, vault3, member.address), DEPOSIT_USDC * (10n ** 12n), 'the blocked deposit must not have minted anything — share count unchanged from the first (oracle-independent) deposit');
});

// ═══════════════════════════════ Vault 1: the real round ═══════════════════════════════

let ballast, momentum;
let ballastActivatedAt, momentumActivatedAt, momentumExitedAtGlobal, pid1;

test('Vault 1 setup: a Safe that never deposits creates + registers the vault, then Ballast and Momentum deposit and activate', async (t) => {
  // vault1 was already created + registered in before() — see its comment for why (oracle
  // freshness at creation time).

  // THE SPEC CORRECTION: assert the Safe holds zero shares BEFORE either member deposits, so the
  // "need not deposit first" claim is checked, not assumed.
  assert.equal(chain.sharesOf(fork.rpcUrl, vault1, sharedSafe.address), 0n, 'the Safe must hold 0 shares before any member deposits');

  ballast = generateThrowawayAccount();
  momentum = generateThrowawayAccount();
  for (const acct of [ballast, momentum]) setEthBalance(fork.rpcUrl, acct.address, `0x${(10n * ONE_ETH).toString(16)}`);
  dealErc20(fork.rpcUrl, usdc, ballast.address, DEPOSIT_USDC);
  dealErc20(fork.rpcUrl, usdc, momentum.address, DEPOSIT_USDC);

  const minDeposit = BigInt(chain.callOne(fork.rpcUrl, vault1, 'minDepositUsdc()(uint256)'));
  const ballastDecision = policy.ballastDepositDecide({ minDepositUsdc: minDeposit });
  assert.equal(ballastDecision.action, 'deposit');
  assert.equal(ballastDecision.amountUsdc, DEPOSIT_USDC, 'Ballast deposits exactly ARC minDepositUsdc (100 USDC)');

  await t.test('Ballast deposits (first-time: pending, no shares yet)', () => {
    chain.approveAndDeposit(fork.rpcUrl, ballast.privateKey, usdc, vault1, ballastDecision.amountUsdc);
    const pending = chain.readPendingDeposit(fork.rpcUrl, vault1, ballast.address);
    assert.equal(pending.amountUsdc, DEPOSIT_USDC);
    assert.equal(chain.sharesOf(fork.rpcUrl, vault1, ballast.address), 0n, 'no shares until activation');
    assert.equal(chain.sharesOf(fork.rpcUrl, vault1, sharedSafe.address), 0n, 'the Safe still holds 0 shares — a member depositing does not touch it');
  });

  await t.test('Momentum deposits (first-time: pending, no shares yet)', () => {
    chain.approveAndDeposit(fork.rpcUrl, momentum.privateKey, usdc, vault1, DEPOSIT_USDC);
    const pending = chain.readPendingDeposit(fork.rpcUrl, vault1, momentum.address);
    assert.equal(pending.amountUsdc, DEPOSIT_USDC);
  });

  await t.test('both activate after the 4h observation window; the Safe STILL holds 0 shares', () => {
    const bPending = chain.readPendingDeposit(fork.rpcUrl, vault1, ballast.address);
    chain.fastForward(fork.rpcUrl, Math.max(1, bPending.availableAt - chain.chainNow(fork.rpcUrl)));
    chain.activate(fork.rpcUrl, broadcaster.privateKey, vault1, ballast.address);
    ballastActivatedAt = chain.chainNow(fork.rpcUrl);
    assert.ok(chain.sharesOf(fork.rpcUrl, vault1, ballast.address) > 0n, "Ballast's activation must mint shares");

    const mPending = chain.readPendingDeposit(fork.rpcUrl, vault1, momentum.address);
    const now = chain.chainNow(fork.rpcUrl);
    if (mPending.availableAt > now) chain.fastForward(fork.rpcUrl, mPending.availableAt - now);
    chain.activate(fork.rpcUrl, broadcaster.privateKey, vault1, momentum.address);
    momentumActivatedAt = chain.chainNow(fork.rpcUrl);
    assert.ok(chain.sharesOf(fork.rpcUrl, vault1, momentum.address) > 0n, "Momentum's activation must mint shares");

    assert.equal(chain.sharesOf(fork.rpcUrl, vault1, sharedSafe.address), 0n, 'the Safe holds 0 shares after both members are fully active — it never deposited');
    assert.equal(chain.sharesOf(fork.rpcUrl, vault1, ballast.address), chain.sharesOf(fork.rpcUrl, vault1, momentum.address), 'equal deposits at unchanged NAV mint equal shares');
  });
});

let rebalancePayload, chosenSlipBps, realSwapReason = '', derivedSlipBpsForBallast = null, momentumTrendUp = false;

test('Vault 1: Momentum proposes a Rebalance (derived slippage, card 209; empty orders — see console log for why)', () => {
  // Snapshot must be strictly before propose (VO-9); a small margin avoids racing the same-second edge.
  chain.fastForward(fork.rpcUrl, 2);

  // ── attempt a REAL swap leg first: read-only pool probe, no orders committed to yet ──
  let derivation = null;
  try {
    const adapter = dep.adapter;
    const router = chain.callOne(fork.rpcUrl, adapter, 'router()(address)');
    const factory = chain.callOne(fork.rpcUrl, router, 'factory()(address)');
    const amountIn = 10_000_000n; // 10 USDC of the 200 USDC idle — a rounding error against real pool depth if one exists
    for (const feeTier of [500n, 3000n, 10000n, 100n]) {
      const pool = chain.callOne(fork.rpcUrl, factory, 'getPool(address,address,uint24)(address)', usdc, WETH, feeTier);
      if (/^0x0{40}$/i.test(pool)) continue;
      const liquidity = BigInt(chain.callOne(fork.rpcUrl, pool, 'liquidity()(uint128)'));
      if (liquidity === 0n) continue;

      const slot0 = chain.callMany(fork.rpcUrl, pool, 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)');
      const sqrtP = BigInt(slot0[0]);
      const token0 = chain.callOne(fork.rpcUrl, pool, 'token0()(address)');
      const poolFeeRawPpm = BigInt(chain.callOne(fork.rpcUrl, pool, 'fee()(uint24)'));
      const usdcIsToken0 = token0.toLowerCase() === usdc.toLowerCase();
      const Q192 = 1n << 192n;
      const num = sqrtP * sqrtP;
      const grossOut = usdcIsToken0 ? (amountIn * num) / Q192 : (amountIn * Q192) / num;
      const priceOutWad = chain.oraclePriceWad(fork.rpcUrl, dep.aggregator, WETH);
      const usdcScalar = BigInt(chain.callOne(fork.rpcUrl, vault1, 'usdcScalar()(uint256)'));
      const valueInWad = amountIn * usdcScalar;
      const unitOut = BigInt(chain.callOne(fork.rpcUrl, vault1, 'assetUnit(address)(uint256)', WETH));

      const d = deriveMaxSlippageBps({ poolFeeRawPpm, valueInWad, unitOut, priceOutWad, grossOut });
      console.log(`[persona-round-sim] Vault 1 pool probe: fee tier ${feeTier} pool ${pool} liquidity ${liquidity} -> ${d.ok ? `derived ${d.chosenSlipBps} bps` : `refused (${d.reason})`}`);
      // Ballast's own vote is decided with `ordersEmpty: true` regardless of this value (see the
      // commit/reveal test below and ballastVoteDecide's own doc comment), so no cap is applied
      // here — a derivation landing at or above 100 bps is still a genuine, usable derivation.
      if (d.ok) { derivation = { ...d, pool, feeTier, poolFeeRawPpm, grossOut, priceOutWad, usdcScalar, unitOut, adapter }; break; }
    }
    if (!derivation) console.log('[persona-round-sim] Vault 1 pool probe: no fee tier produced a usable pool + derivation.');
  } catch (e) {
    realSwapReason = `pool probe threw: ${/** @type {Error} */ (e).message}`;
  }

  if (derivation) {
    // A real, liquid Base Sepolia WETH/USDC pool exists at this fee tier, and the derivation is
    // genuine (real pool + real oracle reads, card 209's exact pure function). The order still
    // stays EMPTY here — no swap is actually attempted — for a reason that is a FORK ARTIFACT, not
    // a claim about live Arc: this suite fast-forwards chain time via `evm_increaseTime` to
    // collapse ARC's own commit+reveal windows (86400+86400=172800s, read from ARC_SMOKE.gov), but
    // the forked WETH feed's own `updatedAt` stays FROZEN at the fork block — nothing here ever
    // publishes a new round the way the real feed continuously does. By execute() time on THIS
    // fork, the feed's own heartbeat (read fresh below) has necessarily been exceeded by the warp
    // alone, so any order touching the oracle at execute time would revert StaleOracle for a
    // reason that says nothing about live Arc, where the feed keeps publishing and a real
    // execute() call reads a genuinely fresh price. Attempting the real swap here would therefore
    // prove nothing (a fork-clock artifact, not a real liquidity or timing finding), so it is
    // skipped and stated as such rather than attempted and left to fail unexplained.
    const heartbeat = chain.readOracleHeartbeat(fork.rpcUrl, dep.aggregator, WETH);
    chosenSlipBps = derivation.chosenSlipBps;
    derivedSlipBpsForBallast = derivation.derivedSlipBps;
    realSwapReason = `real pool found (fee tier ${derivation.feeTier}, pool ${derivation.pool}) and deriveMaxSlippageBps succeeded (chosen ${chosenSlipBps} bps) — `
      + `not executed as a real swap because this fork's static WETH feed (heartbeat ${heartbeat}s) cannot outlive ARC's own `
      + `commit+reveal windows (${ARC_SMOKE.gov.commitDuration}+${ARC_SMOKE.gov.revealDuration}=${ARC_SMOKE.gov.commitDuration + ARC_SMOKE.gov.revealDuration}s) fast-forwarded via evm_increaseTime — `
      + 'a FORK-CLOCK artifact (the feed never re-publishes on a static fork), not evidence about live Arc, where the feed keeps publishing.';
  } else {
    // A fixed, valid, clearly-safe default (1..MAX_REBALANCE_SLIPPAGE_BPS=200, and well under
    // Ballast's own 100 bps refusal line) — ui-smoke-chain.mjs's own no-op rebalance uses 100 bps
    // for the same purpose; this suite picks a smaller value on purpose.
    chosenSlipBps = 30n;
    realSwapReason = `no probed fee tier produced BOTH a real pool with nonzero liquidity AND a derivation deriveMaxSlippageBps accepted — see the per-tier "pool probe" lines just above for the specific reason at each tier${realSwapReason ? ` (also: ${realSwapReason})` : ''}; using the fixed no-op maxSlippageBps default.`;
  }
  console.log(`[persona-round-sim] Vault 1 rebalance: EMPTY ORDERS. ${realSwapReason}`);

  // `momentumProposeDecide`'s return is a DIRECTIONAL readout (buy the basket asset, sell it, or
  // 'hold' when too little feed history was available to call a trend) — it does not gate WHETHER
  // Momentum proposes this round. The scripted round (spec step 2) has Momentum propose
  // unconditionally; direction only matters for what the order WOULD contain, and this round's
  // order stays empty regardless of direction (see the pool-probe result below), so a 'hold'
  // readout changes nothing about what gets proposed here — it is recorded (and used for
  // Momentum's OWN vote direction next) rather than silently discarded.
  const roundDeltas = readRecentFeedDeltas(dep.aggregator, WETH);
  const proposeDecision = policy.momentumProposeDecide({ roundDeltas });
  assert.ok(['proposeIntoAsset', 'proposeIntoUsdc', 'hold'].includes(proposeDecision.action));
  momentumTrendUp = proposeDecision.trendUp;
  console.log(`[persona-round-sim] Vault 1 momentumProposeDecide: action=${proposeDecision.action} trendUp=${momentumTrendUp} (from ${roundDeltas.length} measured feed-round deltas)`);

  rebalancePayload = cast([
    'abi-encode', 'f(address,uint256,(address,address,uint256,uint256,uint256,bytes)[])',
    dep.adapter, String(chosenSlipBps), '[]',
  ]);
  const actionHash = cast(['keccak', rebalancePayload]).trim();
  chain.propose(fork.rpcUrl, momentum.privateKey, dep.governance, vault1, REBALANCE_PTYPE, actionHash);
  pid1 = chain.activeProposalOf(fork.rpcUrl, dep.governance, vault1);
  assert.notEqual(pid1, '0', 'propose must have created an active proposal');
});

test('Vault 1: both commit and reveal, per persona policy', () => {
  const p = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  const ballastSalt = chain.randomSalt();
  const momentumSalt = chain.randomSalt();

  // ordersEmpty: true — Vault 1's proposal carries zero SwapOrders. A liquid Base Sepolia
  // WETH/USDC pool WAS found (fee tier 3000, 55 bps derived — see the propose test's own console
  // log and comment) but the swap was not executed: this fork's frozen feed cannot outlive the
  // fast-forwarded commit+reveal windows, a fork-clock artifact rather than a real liquidity or
  // timing finding. See ballastVoteDecide's own doc comment for why a no-op is judged on that
  // fact first, ahead of the (here, unused) derived-bound/cap branches.
  const ballastVote = policy.ballastVoteDecide({ maxSlippageBps: chosenSlipBps, derivedSlipBps: derivedSlipBpsForBallast, reducesExposure: false, ordersEmpty: true });
  const momentumVote = policy.momentumVoteDecide({ trendUp: momentumTrendUp, orderDirection: 'noOp' });
  // Both directions must actually be FOR here: with only 2 members (sub-five regime), the round
  // only passes if the self-directed FOR stake majority clears >50% of snapshot (Governance.sol's
  // forStakeMajority branch) — see Vault 2 below for the DEFEATED counterexample at 1-of-2.
  assert.equal(momentumVote.action, 'commitFor', 'a no-op order carries no directional risk for Momentum, independent of the measured trend');

  const ballastSupport = ballastVote.action === 'commitFor';
  const momentumSupport = momentumVote.action === 'commitFor';
  assert.equal(ballastSupport, true, `Ballast must vote FOR a no-op order (${ballastVote.reason})`);

  const ballastCommitment = chain.computeCommitment({ pid: pid1, voter: ballast.address, support: ballastSupport, salt: ballastSalt });
  const momentumCommitment = chain.computeCommitment({ pid: pid1, voter: momentum.address, support: momentumSupport, salt: momentumSalt });
  chain.commitVote(fork.rpcUrl, ballast.privateKey, dep.governance, pid1, ballastCommitment);
  chain.commitVote(fork.rpcUrl, momentum.privateKey, dep.governance, pid1, momentumCommitment);

  // Contrarian publishes its case against DURING the commit window (spec step 3). It holds no
  // wallet at launch (the spec's funded-count table), so its decision is always publish-only —
  // called here for real, not merely covered by the pure test, so the sim's own record shows it
  // ran for this round.
  const contrarianDecision = policy.contrarianDecide({ funded: false, prevailingSupport: null, caseStrength: 0, ownBar: 0 });
  assert.equal(contrarianDecision.action, 'publishDissent', 'unfunded at launch — Contrarian only ever publishes, never votes');
  console.log(`[persona-round-sim] Vault 1 Contrarian (${policy.CONTRARIAN_MODEL_TIER}): ${contrarianDecision.reason}`);

  const now = chain.chainNow(fork.rpcUrl);
  if (p.commitDeadline > now) chain.fastForward(fork.rpcUrl, p.commitDeadline - now);

  chain.revealVote(fork.rpcUrl, ballast.privateKey, dep.governance, pid1, ballastSupport, ballastSalt);
  chain.revealVote(fork.rpcUrl, momentum.privateKey, dep.governance, pid1, momentumSupport, momentumSalt);

  const after = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  assert.equal(after.revealedVoterCount, 2);
  assert.equal(after.forWeight, after.revealedWeight, 'both revealed FOR: forWeight must equal the full revealed weight');

  // Auditor publishes the readout AFTER the reveal (spec step 3): NAV, idle share, queued exits,
  // oracle age, fee accrued, who voted — read from the chain, not asserted, and it holds no
  // opinion (auditorDecide is a pure passthrough — see its own doc comment).
  const navUsdc = BigInt(chain.callOne(fork.rpcUrl, vault1, 'navWad()(uint256)')) / BigInt(chain.callOne(fork.rpcUrl, vault1, 'usdcScalar()(uint256)'));
  const idleUsdcNow = BigInt(chain.callOne(fork.rpcUrl, vault1, 'idleUsdc()(uint256)'));
  const totalQueued = BigInt(chain.callOne(fork.rpcUrl, vault1, 'totalQueuedShares()(uint256)'));
  const oracleAgeSeconds = chain.oracleFeedAgeSeconds(fork.rpcUrl, dep.aggregator, WETH);
  const auditorReadout = policy.auditorDecide({
    navUsdc, idleUsdc: idleUsdcNow, queuedExitShares: totalQueued, oracleAgeSeconds, feeAccruedUsdc: 0n,
    voters: [{ member: ballast.address, support: ballastSupport }, { member: momentum.address, support: momentumSupport }],
  });
  assert.equal(auditorReadout.action, 'publishReadout');
  console.log(`[persona-round-sim] Vault 1 Auditor (${policy.AUDITOR_MODEL_TIER}) readout: navUsdc=${navUsdc} idleUsdc=${idleUsdcNow} queuedExitShares=${totalQueued} oracleAgeSeconds=${oracleAgeSeconds} voters=${auditorReadout.readout.voters.length}`);
});

test('Vault 1: finalize (Passed) then execute the empty-orders rebalance', () => {
  const p = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  const now = chain.chainNow(fork.rpcUrl);
  if (p.revealDeadline > now) chain.fastForward(fork.rpcUrl, p.revealDeadline - now);

  chain.finalize(fork.rpcUrl, broadcaster.privateKey, dep.governance, pid1);
  const finalized = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  assert.equal(finalized.status, 'Passed', 'both members revealed FOR with equal stake — forStakeMajority must pass this at 2 members');

  const now2 = chain.chainNow(fork.rpcUrl);
  if (finalized.executableAt > now2) chain.fastForward(fork.rpcUrl, finalized.executableAt - now2);
  chain.execute(fork.rpcUrl, broadcaster.privateKey, dep.governance, pid1, rebalancePayload);

  const executed = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  assert.equal(executed.status, 'Executed');
  assert.equal(chain.hasPendingExecution(fork.rpcUrl, dep.governance, vault1), false, 'execution clears the pending flag — the exit below must take Mode I, not Mode F');
});

test('Vault 1: Momentum requests its exit — Mode I, the USDC settlement leg read back from chain and cross-checked', () => {
  // NON-VACUITY: this test's own Mode-I/exact-formula assertions below hold trivially if the
  // round never actually happened (no pending execution either way settles Mode I) — pin that the
  // round DID run and DID execute before reading anything else.
  assert.ok(pid1 && pid1 !== '0', 'pid1 must be set by the propose test that ran before this one');
  const priorProposal = chain.readProposal(fork.rpcUrl, dep.governance, pid1);
  assert.equal(priorProposal.status, 'Executed', 'the round must have actually finalized Passed and executed before this exit is a meaningful Mode-I proof');

  const momentumExitDecision = policy.momentumExitDecide({ outvotedCount: 0, roundComplete: true });
  assert.equal(momentumExitDecision.action, 'requestExit', "the scripted round is done — Momentum's own thesis exits regardless of outvote count");

  const idleUsdcBefore = BigInt(chain.callOne(fork.rpcUrl, vault1, 'idleUsdc()(uint256)'));
  const totalSharesBefore = BigInt(chain.callOne(fork.rpcUrl, vault1, 'totalShares()(uint256)'));
  const usdcScalar = BigInt(chain.callOne(fork.rpcUrl, vault1, 'usdcScalar()(uint256)'));
  const burnShares = chain.sharesOf(fork.rpcUrl, vault1, momentum.address);
  assert.ok(burnShares > 0n);

  const receipt = chain.requestExit(fork.rpcUrl, momentum.privateKey, vault1, burnShares);
  momentumExitedAtGlobal = chain.chainNow(fork.rpcUrl);
  const decoded = chain.decodeExitSettled(receipt);
  assert.ok(decoded, 'Mode I settles instantly — ExitSettled must be in this same receipt');
  assert.equal(decoded.member.toLowerCase(), momentum.address.toLowerCase());
  assert.equal(decoded.sharesBurned, burnShares);

  const tenure = momentumExitedAtGlobal - momentumActivatedAt;
  const expectedFeeBps = chain.expectedExitFeeBps({ maxBps: BigInt(ARC_SMOKE.exitFeeMaxBps), period: BigInt(ARC_SMOKE.exitFeeDecayPeriod), tenure: BigInt(tenure) });
  assert.equal(decoded.exitFeeBps, expectedFeeBps, `exit fee must equal ARC config's decay formula at the measured tenure (${tenure}s of a ${ARC_SMOKE.exitFeeDecayPeriod}s period)`);
  assert.ok(decoded.exitFeeBps > 0n && decoded.exitFeeBps <= BigInt(ARC_SMOKE.exitFeeMaxBps), 'fee must be a positive fraction of the configured max — not the sole-holder waiver (Ballast still holds shares) and not the unfaded max');

  const expectedUsdcPaid = chain.computeNoOpExitUsdcPaid({ idleUsdcBefore, totalSharesBefore, burnShares, feeBps: decoded.exitFeeBps, usdcScalar });
  assert.equal(decoded.usdcPaid, expectedUsdcPaid, 'in-kind settlement (cash leg): usdcPaid must equal the pro-rata NAV formula reproduced from chain-read idleUsdc/totalShares/feeBps — this is the deposit-100-USDC, no-swap, guaranteed-loss case (fee > 0, no gain), so perfFeeUsdc must be 0');
  assert.equal(decoded.perfFeeUsdc, 0n, 'a fee-only loss (no price gain — no swap occurred) must carry zero performance fee');
  assert.equal(chain.sharesOf(fork.rpcUrl, vault1, momentum.address), 0n, 'full exit must burn every share');

  console.log(`[persona-round-sim] Vault 1 exit: sharesBurned=${decoded.sharesBurned} usdcPaid=${decoded.usdcPaid} exitFeeBps=${decoded.exitFeeBps} perfFeeUsdc=${decoded.perfFeeUsdc}`);
});

// ═══════════════ Vault 2: defeated/under-quorum proposal + a queued Mode-F exit while it is pending ═══════════════

let ballast2, momentum2, pid2;

test('Vault 2 setup: a second vault through the same Safe, Ballast and Momentum deposit and activate', () => {
  // vault2 was already created + registered in before() alongside vault1 — see that comment.

  ballast2 = generateThrowawayAccount();
  momentum2 = generateThrowawayAccount();
  for (const acct of [ballast2, momentum2]) setEthBalance(fork.rpcUrl, acct.address, `0x${(10n * ONE_ETH).toString(16)}`);
  dealErc20(fork.rpcUrl, usdc, ballast2.address, DEPOSIT_USDC);
  dealErc20(fork.rpcUrl, usdc, momentum2.address, DEPOSIT_USDC);

  chain.approveAndDeposit(fork.rpcUrl, ballast2.privateKey, usdc, vault2, DEPOSIT_USDC);
  chain.approveAndDeposit(fork.rpcUrl, momentum2.privateKey, usdc, vault2, DEPOSIT_USDC);

  const bPending = chain.readPendingDeposit(fork.rpcUrl, vault2, ballast2.address);
  chain.fastForward(fork.rpcUrl, Math.max(1, bPending.availableAt - chain.chainNow(fork.rpcUrl)));
  chain.activate(fork.rpcUrl, broadcaster.privateKey, vault2, ballast2.address);
  const mPending = chain.readPendingDeposit(fork.rpcUrl, vault2, momentum2.address);
  const now = chain.chainNow(fork.rpcUrl);
  if (mPending.availableAt > now) chain.fastForward(fork.rpcUrl, mPending.availableAt - now);
  chain.activate(fork.rpcUrl, broadcaster.privateKey, vault2, momentum2.address);

  assert.ok(chain.sharesOf(fork.rpcUrl, vault2, ballast2.address) > 0n);
  assert.ok(chain.sharesOf(fork.rpcUrl, vault2, momentum2.address) > 0n);
});

test('Vault 2: a proposal goes up, Ballast queues a Mode-F exit WHILE it is pending, only Momentum reveals', () => {
  chain.fastForward(fork.rpcUrl, 2);
  const payload = cast(['abi-encode', 'f(address,uint256,(address,address,uint256,uint256,uint256,bytes)[])', dep.adapter, '100', '[]']);
  const actionHash = cast(['keccak', payload]).trim();
  chain.propose(fork.rpcUrl, momentum2.privateKey, dep.governance, vault2, REBALANCE_PTYPE, actionHash);
  pid2 = chain.activeProposalOf(fork.rpcUrl, dep.governance, vault2);

  const p = chain.readProposal(fork.rpcUrl, dep.governance, pid2);
  assert.equal(p.memberCount, 2, 'sub-five regime: exactly 2 members at proposal creation');

  // Only Momentum commits, WHILE still in the commit phase (commitVote requires
  // block.timestamp < commitDeadline — Governance.sol:385). Ballast deliberately never commits;
  // its non-participation, plus Momentum's lone 50%-of-snapshot reveal below, is what leaves this
  // proposal under quorum at finalize.
  // Vault 2's proposal is the same fixed-bps no-op shape as Vault 1's — decided the same way,
  // through the policy function, not hardcoded.
  const momentumVote2 = policy.momentumVoteDecide({ trendUp: momentumTrendUp, orderDirection: 'noOp' });
  assert.equal(momentumVote2.action, 'commitFor', 'a no-op order carries no directional risk for Momentum');
  const momentum2Support = momentumVote2.action === 'commitFor';

  const salt = chain.randomSalt();
  const commitment = chain.computeCommitment({ pid: pid2, voter: momentum2.address, support: momentum2Support, salt });
  chain.commitVote(fork.rpcUrl, momentum2.privateKey, dep.governance, pid2, commitment);

  // NOW move to the reveal phase: hasPendingExecution turns true at reveal start
  // (Governance.sol:736-741), which is what makes Ballast's exit below Mode-F.
  const now = chain.chainNow(fork.rpcUrl);
  if (p.commitDeadline > now) chain.fastForward(fork.rpcUrl, p.commitDeadline - now);
  assert.equal(chain.hasPendingExecution(fork.rpcUrl, dep.governance, vault2), true, 'reveal phase has opened — a pending execution must now be visible');

  const ballastShares = chain.sharesOf(fork.rpcUrl, vault2, ballast2.address);
  const receipt = chain.requestExit(fork.rpcUrl, ballast2.privateKey, vault2, ballastShares);
  const queued = chain.decodeExitQueued(receipt);
  assert.ok(queued, 'a pending execution must route requestExit through the Mode-F QUEUE path, not settle it instantly');
  assert.equal(queued.member.toLowerCase(), ballast2.address.toLowerCase());
  assert.equal(queued.shares, ballastShares);
  assert.equal(chain.queuedExitShares(fork.rpcUrl, vault2, ballast2.address), ballastShares);
  assert.equal(chain.sharesOf(fork.rpcUrl, vault2, ballast2.address), ballastShares, 'Mode-F queuing does not burn shares yet — only settleQueuedExit does, after the queue clears');

  // Only Momentum reveals (self-directed FOR, 50% of snapshot stake) — at 2 members this clears
  // NEITHER sub-five branch: headMajorityWithStake needs revealedVoterCount*2 > memberCount
  // (1*2 > 2 is false), forStakeMajority needs strictly > 50% (50%*2 == snapshotTotal, not >).
  chain.revealVote(fork.rpcUrl, momentum2.privateKey, dep.governance, pid2, momentum2Support, salt);
});

test('Vault 2: finalize is Defeated (under quorum, sub-five regime), then the queued Mode-F exit settles', () => {
  assert.ok(pid2 && pid2 !== '0', 'pid2 must be set by the propose test that ran before this one');
  const p = chain.readProposal(fork.rpcUrl, dep.governance, pid2);
  const now = chain.chainNow(fork.rpcUrl);
  if (p.revealDeadline > now) chain.fastForward(fork.rpcUrl, p.revealDeadline - now);

  chain.finalize(fork.rpcUrl, broadcaster.privateKey, dep.governance, pid2);
  const finalized = chain.readProposal(fork.rpcUrl, dep.governance, pid2);
  assert.equal(finalized.status, 'Defeated', 'one of two members revealing exactly 50% FOR stake clears neither sub-five branch (needs a strict majority)');

  assert.equal(chain.hasPendingExecution(fork.rpcUrl, dep.governance, vault2), false, 'Defeated clears the pending flag — the queued exit must now be settleable');

  const before = chain.sharesOf(fork.rpcUrl, vault2, ballast2.address);
  const receipt = chain.settleQueuedExit(fork.rpcUrl, broadcaster.privateKey, vault2, ballast2.address);
  const decoded = chain.decodeExitSettled(receipt);
  assert.ok(decoded, 'settleQueuedExit must settle instantly once nothing is pending');
  assert.equal(decoded.sharesBurned, before);
  assert.equal(chain.queuedExitShares(fork.rpcUrl, vault2, ballast2.address), 0n);
  assert.equal(chain.sharesOf(fork.rpcUrl, vault2, ballast2.address), 0n);
  console.log(`[persona-round-sim] Vault 2: Defeated (under quorum) then queued exit settled — usdcPaid=${decoded.usdcPaid} exitFeeBps=${decoded.exitFeeBps}`);
});

// Pure-function unit + mutation coverage for the persona policies and the two settlement formulas
// used above now lives in scripts/test/persona-policies.test.mjs — deliberately separate from this
// file, which needs a real anvil/forge fork; see that file's own header for why.

/**
 * Reads the WETH/USD feed's own recent `getRoundData` history directly off the deployed
 * ChainlinkOracle's configured feed (real chain data, read-only) and returns signed WAD deltas,
 * oldest first — what `policy.momentumProposeDecide` consumes. Walks back up to 5 rounds from the
 * latest; a feed with fewer available rounds returns fewer deltas (never fabricated).
 */
function readRecentFeedDeltas(oracleAddr, asset) {
  const feed = chain.callMany(fork.rpcUrl, oracleAddr, 'feedOf(address)(address,uint32,uint64,uint128,uint128)', asset)[0];
  const deltas = [];
  try {
    const latest = chain.callMany(fork.rpcUrl, feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
    let roundId = BigInt(latest[0]);
    let prevAnswer = BigInt(latest[1]);
    for (let i = 0; i < 5 && roundId > 1n; i++) {
      roundId -= 1n;
      const r = chain.callMany(fork.rpcUrl, feed, 'getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)', roundId);
      const answer = BigInt(r[1]);
      deltas.unshift(answer - prevAnswer);
      prevAnswer = answer;
    }
  } catch {
    // A feed that does not serve older rounds (phase boundary, etc.) legitimately yields fewer
    // deltas — momentumProposeDecide handles an empty list explicitly ('hold'), never guesses.
  }
  return deltas;
}
