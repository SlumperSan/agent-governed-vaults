// @ts-check
/**
 * Chain plumbing for `scripts/test/persona-round-sim.test.mjs`, built ON TOP OF
 * `scripts/test/lib/safe-fork-chain.mjs` (fork bootstrap, real `DeployTestnet.s.sol`, real SafeL2
 * v1.4.1 deploy/read) and `scripts/lib/safe-exec.mjs` (Safe plan/sign/pack — the exact low-level
 * bypass path `scripts/test/safe-route-fork.test.mjs`'s own layer-2 mutation tests use to route a
 * call through a real Safe without going through `scripts/smoke-test.mjs` as a child process).
 * This file adds the MEMBER-signed lifecycle safe-fork-chain.mjs does not need for card 208:
 * deposit, activate, commit/reveal, finalize/execute, exit — driven directly by `cast send` from
 * throwaway member keys, never through a Safe (only vault creation/registration is Safe-routed,
 * per the persona spec's hard constraint 1: "the owner funds and holds every wallet... on the
 * fork, scripts sign with throwaway keys").
 *
 * WHY BASE SEPOLIA, NOT ARC. See `Obsidian Vault/Agent-Governed Vaults/Findings/
 * 2026-09-23-arc-fork-persona-sim.md`: Arc's USDC is backed by a native precompile
 * (`0x1800...0000/0001`) anvil cannot execute, so a transfer/transferFrom of Arc's own USDC
 * reverts on any plain anvil fork of Arc. This file forks Base Sepolia instead — the same real
 * `DeployTestnet.s.sol` / real SafeL2 1.4.1 pattern `safe-fork-chain.mjs` and
 * `safe-route-fork.test.mjs` already use — and layers Arc's OWN launch parameters
 * (`contracts/config/arc-mainnet.json`'s `smoke` block: gov timings, 100 USDC minimum deposit, the
 * exit fee) onto vault creation, so governance behaves as the live Arc vault will even though the
 * settlement token itself is Base Sepolia's test USDC, not Arc's native one. WHAT THIS DOES NOT
 * PROVE: Arc's native-USDC transfer path, or Arc's own router/pool liquidity for cirBTC — both are
 * Arc-specific and unreachable from any anvil fork today. See this file's own callers for how each
 * gap is stated at its point of use, not just here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cast, clean, topicToAddress } from './safe-fork-chain.mjs';
import {
  readSafeState, buildPlan, safeTransactionHash, signAsOwner, packSignatures,
  execTransactionArgs, SAFE_EXEC_TRANSACTION_SIG,
} from '../../lib/safe-exec.mjs';

export const T_VAULT_CREATED = cast(['keccak', 'VaultCreated(address,address,address,uint256)']);
export const T_EXIT_SETTLED = cast(['keccak', 'ExitSettled(address,uint256,uint256,uint256,uint256)']);
export const T_EXIT_QUEUED = cast(['keccak', 'ExitQueued(address,uint256)']);
export const T_DEPOSIT_ACTIVATED = cast(['keccak', 'DepositActivated(address,uint256,uint256)']);

// ─────────────────────────────────────── time ───────────────────────────────────────

export function fastForward(rpcUrl, seconds) {
  cast(['rpc', 'evm_increaseTime', String(Math.trunc(seconds)), '--rpc-url', rpcUrl]);
  cast(['rpc', 'evm_mine', '--rpc-url', rpcUrl]);
}

export function chainNow(rpcUrl) {
  return Number(cast(['block', 'latest', '-f', 'timestamp', '--rpc-url', rpcUrl]));
}

// ─────────────────────────────────────── generic reads/sends ───────────────────────────────────────

/** One decoded `cast call` value, scientific-notation-annotation stripped. */
export function callOne(rpcUrl, to, sig, ...args) {
  return clean(cast(['call', to, sig, ...args.map(String), '--rpc-url', rpcUrl]));
}

/** Every decoded `cast call` value, one per return field, in order. */
export function callMany(rpcUrl, to, sig, ...args) {
  return cast(['call', to, sig, ...args.map(String), '--rpc-url', rpcUrl])
    .split('\n').map(clean).filter((l) => l !== '');
}

export function balanceOf(rpcUrl, token, address) {
  return BigInt(callOne(rpcUrl, token, 'balanceOf(address)(uint256)', address));
}

/** `cast send ... --json`, parsed. Throws with the real revert text on failure — callers that
 *  expect a specific revert use `trySend` instead. */
export function send(rpcUrl, privateKey, to, sig, args) {
  const out = cast(['send', to, sig, ...args.map(String), '--rpc-url', rpcUrl, '--private-key', privateKey, '--json']);
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  if (receipt.status !== '0x1' && receipt.status !== 1) {
    throw new Error(`${sig}: transaction reverted (${receipt.transactionHash})`);
  }
  return receipt;
}

/** Like `send`, but catches a revert and returns `{ ok: false, error }` instead of throwing — for
 *  the frozen-oracle test, which needs to assert a SPECIFIC revert rather than merely "it threw". */
export function trySend(rpcUrl, privateKey, to, sig, args) {
  try {
    return { ok: true, receipt: send(rpcUrl, privateKey, to, sig, args) };
  } catch (e) {
    return { ok: false, error: /** @type {Error} */ (e).message };
  }
}

// ─────────────────────────────────────── vault creation, through the Safe ───────────────────────────────────────

/**
 * `factory.createVault(...)` routed through `safe`, via the exact low-level bypass path
 * `scripts/test/safe-route-fork.test.mjs`'s own layer-2 mutation tests use (buildPlan ->
 * safeTransactionHash -> signAsOwner -> packSignatures -> execTransaction) — real Safe bytecode,
 * real EIP-712 signing, no shortcut. `smoke` carries ARC's OWN launch parameters (read by the
 * caller from `contracts/config/arc-mainnet.json`), not Base Sepolia's testnet smoke values.
 * @returns {string} the created vault's address
 */
export function createVaultViaSafe({ rpcUrl, safe, ownerPrivateKey, broadcasterPrivateKey, factory, usdc, tokens, aggregator, adapter, smoke, chainId }) {
  const { nonce } = readSafeState({ call: (...a) => callMany(rpcUrl, ...a), callU: (...a) => BigInt(callOne(rpcUrl, ...a)), safe });
  const params = `(${usdc},[${tokens.join(',')}],${aggregator},${smoke.capacityCapUsdc},${smoke.minDepositUsdc},${smoke.exitFeeMaxBps},${smoke.exitFeeDecayPeriod},[${adapter}])`;
  const data = cast(['calldata', 'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params]);
  const plan = buildPlan({ safe, to: factory, data, nonce });
  const call = (...a) => callMany(rpcUrl, ...a);
  safeTransactionHash({ call, cast: (a) => cast(a), plan, chainId }); // must not throw (MAJOR-1 cross-check)
  const sig = packSignatures([signAsOwner({ cast: (a) => cast(a), plan, chainId, signerArgs: ['--private-key', ownerPrivateKey] })]);
  const args = execTransactionArgs(plan, sig);
  const receipt = send(rpcUrl, broadcasterPrivateKey, safe, SAFE_EXEC_TRANSACTION_SIG, args);
  const created = receipt.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED);
  if (!created) throw new Error('createVaultViaSafe: VaultCreated event not found in receipt');
  return topicToAddress(created.topics[1]);
}

/** `governance.registerVault(vault, cfg)` routed through `safe`, same pattern as
 *  `createVaultViaSafe` above (`Governance.sol:223` gates it on `msg.sender == vault.creator()`,
 *  the same immutable-creator shape `createVault` itself is gated by). */
export function registerVaultViaSafe({ rpcUrl, safe, ownerPrivateKey, broadcasterPrivateKey, governance, vault, gov, chainId }) {
  const { nonce } = readSafeState({ call: (...a) => callMany(rpcUrl, ...a), callU: (...a) => BigInt(callOne(rpcUrl, ...a)), safe });
  const tuple = `(${gov.commitDuration},${gov.revealDuration},${gov.timelockDuration},${gov.executionWindow},${gov.quorumBps},${gov.proposalThresholdBps},${gov.concentrationCapBps},${gov.proposalCooldown})`;
  const data = cast(['calldata', 'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))', vault, tuple]);
  const plan = buildPlan({ safe, to: governance, data, nonce });
  const call = (...a) => callMany(rpcUrl, ...a);
  safeTransactionHash({ call, cast: (a) => cast(a), plan, chainId });
  const sig = packSignatures([signAsOwner({ cast: (a) => cast(a), plan, chainId, signerArgs: ['--private-key', ownerPrivateKey] })]);
  const args = execTransactionArgs(plan, sig);
  return send(rpcUrl, broadcasterPrivateKey, safe, SAFE_EXEC_TRANSACTION_SIG, args);
}

// ─────────────────────────────────────── member lifecycle (direct EOA sends) ───────────────────────────────────────

export function approveAndDeposit(rpcUrl, memberPrivateKey, usdc, vault, amountUsdc) {
  send(rpcUrl, memberPrivateKey, usdc, 'approve(address,uint256)', [vault, amountUsdc]);
  return send(rpcUrl, memberPrivateKey, vault, 'deposit(uint256)', [amountUsdc]);
}

/** Same as `approveAndDeposit`, but does not throw — for the frozen-oracle test, which expects
 *  this specific call to revert `StaleOracle`. */
export function tryApproveAndDeposit(rpcUrl, memberPrivateKey, usdc, vault, amountUsdc) {
  send(rpcUrl, memberPrivateKey, usdc, 'approve(address,uint256)', [vault, amountUsdc]); // approval itself never touches the oracle
  return trySend(rpcUrl, memberPrivateKey, vault, 'deposit(uint256)', [amountUsdc]);
}

export function activate(rpcUrl, callerPrivateKey, vault, member) {
  return send(rpcUrl, callerPrivateKey, vault, 'activate(address)', [member]);
}

export function skipWindow(rpcUrl, memberPrivateKey, vault) {
  return send(rpcUrl, memberPrivateKey, vault, 'skipWindow()', []);
}

export function readPendingDeposit(rpcUrl, vault, member) {
  const [amountUsdc, availableAt] = callMany(rpcUrl, vault, 'pendingDeposit(address)(uint256,uint64)', member);
  return { amountUsdc: BigInt(amountUsdc), availableAt: Number(availableAt) };
}

export function sharesOf(rpcUrl, vault, member) {
  return BigInt(callOne(rpcUrl, vault, 'sharesOf(address)(uint256)', member));
}

export function queuedExitShares(rpcUrl, vault, member) {
  return BigInt(callOne(rpcUrl, vault, 'queuedExitShares(address)(uint256)', member));
}

// ─────────────────────────────────────── governance: propose / commit / reveal ───────────────────────────────────────

/** `keccak256(abi.encode(pid, voter, support, salt))` — the exact commitment `Governance.
 *  revealVote` checks (Governance.sol:409), computed locally via `cast`, no RPC. */
export function computeCommitment({ pid, voter, support, salt }) {
  const encoded = cast(['abi-encode', 'f(uint256,address,bool,bytes32)', String(pid), voter, String(support), salt]);
  return cast(['keccak', encoded]).trim();
}

/** A fresh 32-byte salt from `cast wallet new`'s own CSPRNG (its private key, repurposed as
 *  arbitrary random bytes — never used as a real key here, only as commit-reveal salt). */
export function randomSalt() {
  const [kp] = JSON.parse(cast(['wallet', 'new', '--json']));
  return kp.private_key;
}

export function propose(rpcUrl, proposerPrivateKey, governance, vault, ptypeUint, actionHash) {
  return send(rpcUrl, proposerPrivateKey, governance, 'propose(address,uint8,bytes32)', [vault, ptypeUint, actionHash]);
}

export function activeProposalOf(rpcUrl, governance, vault) {
  return callOne(rpcUrl, governance, 'activeProposalOf(address)(uint256)', vault);
}

export function commitVote(rpcUrl, voterPrivateKey, governance, pid, commitment) {
  return send(rpcUrl, voterPrivateKey, governance, 'commitVote(uint256,bytes32)', [pid, commitment]);
}

export function revealVote(rpcUrl, voterPrivateKey, governance, pid, support, salt) {
  return send(rpcUrl, voterPrivateKey, governance, 'revealVote(uint256,bool,bytes32)', [pid, support, salt]);
}

export function finalize(rpcUrl, callerPrivateKey, governance, pid) {
  return send(rpcUrl, callerPrivateKey, governance, 'finalize(uint256)', [pid]);
}

export function execute(rpcUrl, callerPrivateKey, governance, pid, payload) {
  return send(rpcUrl, callerPrivateKey, governance, 'execute(uint256,bytes)', [pid, payload]);
}

export function hasPendingExecution(rpcUrl, governance, vault) {
  return callOne(rpcUrl, governance, 'hasPendingExecution(address)(bool)', vault) === 'true';
}

const GOV_CONFIG_SIG = 'configOf(address)(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32)';
export function readGovConfig(rpcUrl, governance, vault) {
  const [commitDuration, revealDuration, timelockDuration, executionWindow, quorumBps, proposalThresholdBps, concentrationCapBps, proposalCooldown]
    = callMany(rpcUrl, governance, GOV_CONFIG_SIG, vault).map(Number);
  return { commitDuration, revealDuration, timelockDuration, executionWindow, quorumBps, proposalThresholdBps, concentrationCapBps, proposalCooldown };
}

const PROPOSAL_SIG = 'proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)';
const STATUS = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'];
export function readProposal(rpcUrl, governance, pid) {
  const p = callMany(rpcUrl, governance, PROPOSAL_SIG, pid);
  return {
    vault: p[0], ptype: Number(p[1]), proposer: p[2],
    createdAt: Number(p[3]), commitDeadline: Number(p[4]), revealDeadline: Number(p[5]),
    executableAt: Number(p[6]), expiresAt: Number(p[7]),
    status: STATUS[Number(p[8])], actionHash: p[9],
    snapshotTotal: BigInt(p[10]), memberCount: Number(p[11]),
    forWeight: BigInt(p[12]), againstWeight: BigInt(p[13]),
    revealedWeight: BigInt(p[14]), revealedVoterCount: Number(p[15]),
  };
}

// ─────────────────────────────────────── exit ───────────────────────────────────────

export function requestExit(rpcUrl, memberPrivateKey, vault, shares) {
  return send(rpcUrl, memberPrivateKey, vault, 'requestExit(uint256)', [shares]);
}

export function settleQueuedExit(rpcUrl, callerPrivateKey, vault, member) {
  return send(rpcUrl, callerPrivateKey, vault, 'settleQueuedExit(address)', [member]);
}

/** Decodes an `ExitSettled(address indexed member, uint256 sharesBurned, uint256 usdcPaid,
 *  uint256 exitFeeBps, uint256 perfFeeUsdc)` log out of a receipt — read back exactly what the
 *  chain recorded, rather than inferring it from a balance diff. */
export function decodeExitSettled(receipt) {
  const log = receipt.logs.find((l) => l.topics?.[0] === T_EXIT_SETTLED);
  if (!log) return null;
  const member = topicToAddress(log.topics[1]);
  const [sharesBurned, usdcPaid, exitFeeBps, perfFeeUsdc] = cast([
    'abi-decode', '--input', 'f(uint256,uint256,uint256,uint256)', log.data,
  ]).split('\n').map(clean).map((v) => BigInt(v));
  return { member, sharesBurned, usdcPaid, exitFeeBps, perfFeeUsdc };
}

export function decodeExitQueued(receipt) {
  const log = receipt.logs.find((l) => l.topics?.[0] === T_EXIT_QUEUED);
  if (!log) return null;
  const member = topicToAddress(log.topics[1]);
  const shares = BigInt(clean(cast(['abi-decode', '--input', 'f(uint256)', log.data])));
  return { member, shares };
}

// ─────────────────────────────────────── pure settlement formulas (mutation-tested, no chain) ───────────────────────────────────────

/**
 * Mirrors `VaultCore._exitFeeBps` (VaultCore.sol) exactly: a linear decay from `maxBps` at
 * `tenure == 0` to `0` at `tenure >= period`, floor-divided — pure, no chain call, so it can be
 * mutation-tested directly against fixed fixtures (`scripts/test/persona-round-sim.test.mjs`'s own
 * "MUTATION-COVERED" tests) independent of anvil/forge.
 * @param {{ maxBps: bigint, period: bigint, tenure: bigint }} p
 * @returns {bigint}
 */
export function expectedExitFeeBps({ maxBps, period, tenure }) {
  if (maxBps === 0n) return 0n;
  if (tenure >= period) return 0n;
  return (maxBps * (period - tenure)) / period;
}

/**
 * Mirrors `VaultCore._settleExit`'s Pass-1 cash-target arithmetic for the NO-SWAP, NO-CHILDREN
 * case ONLY (`childValTotalWad == 0`, every `basketAssets[i]` slice `== 0`) — exactly the shape
 * every vault in this suite is in, since no rebalance in it ever moves USDC into a basket asset.
 * Divides ONCE by `totalSharesBefore * BPS`, matching the contract's own comment ("Both pro-rata
 * legs divide ONCE") bit for bit. Pure, no chain call.
 * @param {{ idleUsdcBefore: bigint, totalSharesBefore: bigint, burnShares: bigint, feeBps: bigint, usdcScalar: bigint }} p
 * @returns {bigint} usdcPay, before any performance fee — callers in this suite only use this in
 *   the guaranteed-loss case (fee > 0, no price gain), where the contract's own perfFee is 0 and
 *   this value is therefore also the FINAL usdcPaid the ExitSettled event carries.
 */
export function computeNoOpExitUsdcPaid({ idleUsdcBefore, totalSharesBefore, burnShares, feeBps, usdcScalar }) {
  const BPS = 10000n;
  const keepBps = BPS - feeBps;
  const tsBps = totalSharesBefore * BPS;
  const burnKeep = burnShares * keepBps;
  const cashTargetWad = (idleUsdcBefore * usdcScalar * burnKeep) / tsBps;
  let usdcPay = cashTargetWad / usdcScalar;
  if (usdcPay > idleUsdcBefore) usdcPay = idleUsdcBefore;
  return usdcPay;
}

// ─────────────────────────────────────── oracle ───────────────────────────────────────

export function oraclePriceWad(rpcUrl, oracle, asset) {
  return BigInt(callOne(rpcUrl, oracle, 'priceWad(address)(uint256)', asset));
}

/** `oracle.feedOf(asset)`'s own `heartbeat` field (VaultCore.sol's FeedConfig, `uint32`), read off
 *  the DEPLOYED oracle rather than assumed from a config file — the actual bound this fork's
 *  `priceWad` enforces. `feedOf` returns `(address feed, uint32 heartbeat, uint64 scale, uint128
 *  minPriceWad, uint128 maxPriceWad)`. */
export function readOracleHeartbeat(rpcUrl, oracle, asset) {
  const [, heartbeat] = callMany(rpcUrl, oracle, 'feedOf(address)(address,uint32,uint64,uint128,uint128)', asset);
  return Number(heartbeat);
}

/** `feed.latestRoundData()`'s `updatedAt`, and its age against the fork's current block timestamp
 *  — for logging real oracle freshness at a point in the test, rather than assuming it. */
export function oracleFeedAgeSeconds(rpcUrl, oracle, asset) {
  const [feed] = callMany(rpcUrl, oracle, 'feedOf(address)(address,uint32,uint64,uint128,uint128)', asset);
  const [, , , updatedAt] = callMany(rpcUrl, feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
  return chainNow(rpcUrl) - Number(updatedAt);
}

const toHex32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * Gives `vault`'s OWN internal `assetBalance[asset]` accounting a nonzero value by writing the
 * storage slot directly — the same brute-force technique `safe-fork-chain.mjs`'s `dealErc20` uses
 * for an ERC20's `balanceOf`, retargeted at `VaultCore.assetBalance` (a public mapping,
 * VaultCore.sol:99), read back through its own public getter rather than assumed. This is a
 * DELIBERATE FORK ADAPTATION, not a real rebalance: `navWad()` only calls `oracle.priceWad(asset)`
 * when `assetBalance[asset] != 0` (VaultCore.sol's own NAV walk), so the frozen-oracle test needs
 * a vault that genuinely HOLDS the basket asset internally before it can demonstrate the freeze
 * blocking anything — a real swap cannot establish that on this fork (no Base Sepolia WETH/USDC
 * pool was found with liquidity when this suite last probed for one; see Vault 1's own probe and
 * its logged reason). Real WETH tokens are ALSO transferred to the vault via `dealErc20` so the
 * vault's actual token custody is not left inconsistent with what this write claims it holds.
 */
export function seedAssetBalance(rpcUrl, vault, asset, amount) {
  const probe = 0x1234n;
  for (let slot = 0; slot < 64; slot++) {
    const key = cast(['index', 'address', asset, String(slot)]);
    const prev = cast(['storage', vault, key, '--rpc-url', rpcUrl]);
    cast(['rpc', 'anvil_setStorageAt', vault, key, toHex32(probe), '--rpc-url', rpcUrl]);
    const bal = BigInt(callOne(rpcUrl, vault, 'assetBalance(address)(uint256)', asset));
    if (bal === probe) {
      cast(['rpc', 'anvil_setStorageAt', vault, key, toHex32(amount), '--rpc-url', rpcUrl]);
      const finalBal = BigInt(callOne(rpcUrl, vault, 'assetBalance(address)(uint256)', asset));
      if (finalBal !== amount) throw new Error(`seedAssetBalance: slot ${slot} accepted the probe but not the real amount (got ${finalBal}, wanted ${amount})`);
      return slot;
    }
    cast(['rpc', 'anvil_setStorageAt', vault, key, prev, '--rpc-url', rpcUrl]); // not the slot: restore it
  }
  throw new Error(`seedAssetBalance: could not find the assetBalance storage slot for ${asset} on ${vault} after 64 candidates`);
}

/** `contracts/config/arc-mainnet.json`'s `.smoke` block — ARC's own launch parameters (gov
 *  timings, minDepositUsdc, exit fee), read fresh off disk rather than copied, so this suite
 *  cannot silently drift from whatever the file actually says. */
export function readArcSmokeParams(repoRoot) {
  const p = path.join(repoRoot, 'contracts', 'config', 'arc-mainnet.json');
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  return json.smoke;
}

export function readBaseSepoliaConfig(repoRoot) {
  const p = path.join(repoRoot, 'contracts', 'config', 'base-sepolia.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
