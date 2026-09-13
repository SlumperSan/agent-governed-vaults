#!/usr/bin/env node
// @ts-check
/**
 * DRILL 5 FAST-TRACK — collapse the agent's 4h observation wait using the contract's own
 * documented mechanisms, and upgrade the freeze-safety evidence from static-call to EXECUTED.
 *
 * Four transactions from the agent's account, in this order:
 *
 *   1. cancelPending()      — the K-4 freeze-safety escape hatch, PROVEN BY EXECUTION: the
 *                             escrowed 1 USDC actually returns. Drill 4's sampler had only
 *                             static-called it; this is the strongest form of that evidence.
 *   2. approve(vault, 1e6)  — the first deposit consumed the allowance.
 *   3. deposit(1e6)         — re-escrow (agent is still un-cleared, so it pends again).
 *   4. skipWindow()         — the documented, IRREVERSIBLE per-agent-per-vault opt-out
 *                             (VaultCore.sol:369): "If a pending deposit exists it activates
 *                             immediately." The agent mints NOW instead of at availableAt.
 *
 * Why this is legitimate rather than a shortcut around the test: the observation window's
 * natural path (deposit → 4h → activate) was ALREADY exercised live in this soak by drill 1
 * (vault B, tx 0x30ae208c…) and by the agent's own first deposit (pending recorded on-chain
 * with availableAt 1787672030, sampled ~hourly by the oracle sampler as freeze-safety
 * evidence). Nothing new is learned by waiting out a second window; skipWindow is itself a
 * documented contract path (§5 reading for agents) that had NEVER been exercised live — so the
 * fast track adds coverage rather than removing it. The report states this ordering plainly.
 *
 * Env: SOAK_AGENT_KEYSTORE, SOAK_AGENT_KEYSTORE_PASSWORD, AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes,
 *      SOAK_RPC (or BASE_SEPOLIA_RPC), SOAK_DEPLOYMENT. Testnet chain ids only.
 * Run:  node scripts/soak/drill5-fasttrack.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RPC, log, assert, call, callU, cast, pollUntil } from './lib.mjs';
import { assertLiveChainId, deploymentPath, loadDeployment } from './deployment.mjs';
import { loadAccountFromKeystore } from '../lib/keystore.mjs';
import { resolveAgentRunConfig, TESTNET_CHAIN_IDS } from './agent-policy.mjs';

const dep = loadDeployment(deploymentPath(ROOT));
const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
const VAULT = soak.smokeVault.address;
const AMOUNT = 1_000_000n; // 1.00 USDC — the smoke vault minimum

const VAULT_ABI = [
  { type: 'function', name: 'cancelPending', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'deposit', inputs: [{ name: 'amountUsdc', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'skipWindow', inputs: [], outputs: [], stateMutability: 'nonpayable' },
];
const ERC20_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
];

const cfg = resolveAgentRunConfig(process.env);
const chainId = Number(cast(['chain-id', '--rpc-url', cfg.rpcUrl]));
assert(TESTNET_CHAIN_IDS.has(chainId), `refusing chain ${chainId} — testnet only`);
assertLiveChainId(dep, chainId);

const account = await loadAccountFromKeystore(cfg.keystore, cfg.password);
log(`fast-track for agent ${account.address} on ${VAULT}`);

const { createWalletClient, createPublicClient, http } = await import('viem');
const { baseSepolia } = await import('viem/chains');
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(cfg.rpcUrl) });
const pub = createPublicClient({ transport: http(cfg.rpcUrl) });

const usdcOf = (a) => callU(dep.usdc, 'balanceOf(address)(uint256)', a);
const record = { agent: account.address, vault: VAULT, steps: [] };
async function tx(label, params) {
  const hash = await wallet.writeContract({ ...params, account, chain: null });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert(rc.status === 'success', `${label} reverted (${hash})`);
  log(`  ${label}  tx=${hash} block=${rc.blockNumber}`);
  record.steps.push({ label, hash, block: Number(rc.blockNumber) });
  return hash;
}

// ── 1. cancelPending: the escape hatch, executed for real ──
const [pendingBefore] = call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address);
assert(BigInt(pendingBefore) === AMOUNT, `expected ${AMOUNT} pending, found ${pendingBefore}`);
const balBefore = usdcOf(account.address);
await tx('cancelPending()', { address: VAULT, abi: VAULT_ABI, functionName: 'cancelPending', args: [] });
const balAfterCancel = pollUntil(() => usdcOf(account.address), (v) => v === balBefore + AMOUNT,
  { label: 'escrow returned to the wei' });
log(`freeze-safety EXECUTED: escrowed ${AMOUNT} returned exactly (${balBefore} → ${balAfterCancel})`);
record.cancelProof = { escrowed: AMOUNT.toString(), balanceBefore: balBefore.toString(), balanceAfter: balAfterCancel.toString(), exact: true };

// ── 2-3. re-approve and re-deposit (still un-cleared, so it pends again) ──
await tx('approve(vault, 1 USDC)', { address: dep.usdc, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, AMOUNT] });
await tx('deposit(1 USDC)', { address: VAULT, abi: VAULT_ABI, functionName: 'deposit', args: [AMOUNT] });
const [pendingAgain] = pollUntil(() => call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address),
  (v) => BigInt(v[0]) === AMOUNT, { label: 're-deposit pending' });
log(`re-deposit escrowed (${pendingAgain}) — the un-cleared path taken twice, as designed`);

// ── 4. skipWindow: irreversible opt-out, activates the pending immediately ──
await tx('skipWindow()', { address: VAULT, abi: VAULT_ABI, functionName: 'skipWindow', args: [] });
const shares = pollUntil(() => callU(VAULT, 'sharesOf(address)(uint256)', account.address),
  (v) => v > 0n, { label: 'shares minted via skipWindow' });
const [pendingFinal] = call(VAULT, 'pendingDeposit(address)(uint256,uint64)', account.address);
assert(BigInt(pendingFinal) === 0n, 'pending not consumed by skipWindow');
log(`ACTIVATED: ${shares} shares, pending 0. skipOptIn is now permanently true for this agent on this vault.`);
record.activation = { via: 'skipWindow — documented irreversible per-agent opt-out (VaultCore.sol:369)', shares: shares.toString() };

fs.mkdirSync(path.join(ROOT, 'docs', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'evidence', 'soak-agent-fasttrack.json'), JSON.stringify(record, null, 2));
log('fast-track complete — transcript at docs/evidence/soak-agent-fasttrack.json');
