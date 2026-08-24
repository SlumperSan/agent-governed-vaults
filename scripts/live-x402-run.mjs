#!/usr/bin/env node
// @ts-check
/**
 * Live x402 settlement run — the whole loop, on a real chain, in one command.
 *
 *     FACILITATOR_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes \
 *     SETTLER_KEYSTORE=~/.foundry/keystores/deployer \
 *     SETTLER_KEYSTORE_PASSWORD=… \
 *     node scripts/live-x402-run.mjs --out=docs/evidence/x402-live-run.json
 *
 * ## What it proves
 *
 *   1. An unpaid GET /vaults returns 402 with a PAYMENT-REQUIRED challenge.
 *   2. The agent SDK signs an EIP-3009 authorization over USDC with the payer account.
 *   3. The API (keyless, FACILITATOR=http) forwards it to the facilitator-server.
 *   4. The facilitator recovers the payer, checks authorizationState, simulates, and broadcasts
 *      transferWithAuthorization. USDC actually moves.
 *   5. The API serves the data with the settlement tx hash as the receipt id.
 *   6. Replaying the same envelope is rejected — at the facilitator by the on-chain nonce
 *      (`authorization-used`), and at the API by its local seen-nonce guard (`replayed-nonce`).
 *      These are different defenses at different layers and the run records both separately.
 *
 * Everything it observes goes into a JSON transcript (`--out`) so every claim can be re-verified
 * afterwards with `cast`, independently of this script's own reporting.
 *
 * ## Roles
 *
 *   SETTLER  the operator's funded account, from a keystore. Pays gas. Also the payTo recipient,
 *            so the test USDC returns to the operator instead of being stranded.
 *   PAYER    a throwaway keypair generated in this process, funded with a small USDC float from
 *            the settler. Never written to disk. Testnet chain ids only.
 *
 * ## Safety
 *
 *   - Testnet chain ids only; any other id is a hard refusal.
 *   - Consent env var required (the facilitator-server's own gate; this script does not bypass it).
 *   - No raw key is ever accepted from the environment, printed, or written to the transcript.
 *   - Spend is bounded: the funding float and the price are both capped and asserted before any
 *     transaction is sent.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccountFromKeystore } from './lib/keystore.mjs';
import { startFacilitatorServer, CONSENT_ENV_VAR } from '../apps/api/src/facilitator-server.mjs';
import { readUsdcDomain } from '../apps/api/src/facilitator.mjs';
import { buildApiServer, resolveApiConfig } from '../apps/api/src/serve.mjs';
import { createProtocolClient } from '../packages/agent-sdk/src/index.mjs';
import { seed } from '../packages/reference-agent/fixtures/seed-snapshot.mjs';

const TESTNET_CHAIN_IDS = new Set([84532, 11155111, 31337, 1337]);
const DEFAULT_RPC = 'https://base-sepolia-rpc.publicnode.com';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Hard ceilings. This script exists to move a few cents; anything larger is a mistake. */
const MAX_FUND_USDC = 1_000_000n;  // 1.00 USDC
const MAX_PRICE_USDC = 100_000n;   // 0.10 USDC

const ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

const usdc = (base) => `${Number(base) / 1e6} USDC`;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

/**
 * Validate the run's parameters before anything is signed or sent. Pure, so the caps are testable.
 * @param {{env:Record<string,string|undefined>, args:Record<string,any>}} p
 */
export function resolveRunConfig({ env, args }) {
  const problems = [];
  if (env[CONSENT_ENV_VAR] !== 'yes') problems.push(`${CONSENT_ENV_VAR} is not set to "yes"`);
  if (!env.SETTLER_KEYSTORE) problems.push('SETTLER_KEYSTORE (path to a keystore file) is not set');
  if (!env.SETTLER_KEYSTORE_PASSWORD) problems.push('SETTLER_KEYSTORE_PASSWORD is not set');
  if (env.SETTLER_PRIVATE_KEY || env.PAYER_PRIVATE_KEY)
    problems.push('refusing to run with a raw private key in the environment — use a keystore');
  if (problems.length)
    throw new Error('cannot start the live run:\n  - ' + problems.join('\n  - '));

  const toBase = (v, name) => {
    const s = String(v);
    if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`--${name} must be a USDC amount with at most 6 decimals, got ${s}`);
    const [w, f = ''] = s.split('.');
    return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0') || '0');
  };

  const price = toBase(args.price ?? '0.01', 'price');
  const fund = toBase(args.fund ?? '0.05', 'fund');
  if (price <= 0n) throw new Error('--price must be positive');
  if (price > MAX_PRICE_USDC) throw new Error(`--price ${usdc(price)} exceeds the ${usdc(MAX_PRICE_USDC)} cap`);
  if (fund > MAX_FUND_USDC) throw new Error(`--fund ${usdc(fund)} exceeds the ${usdc(MAX_FUND_USDC)} cap`);
  if (fund < price) throw new Error(`--fund ${usdc(fund)} is less than --price ${usdc(price)}; the payer could not pay`);

  return {
    rpcUrl: env.RPC_URL || DEFAULT_RPC,
    usdcAddress: env.USDC_ADDRESS || BASE_SEPOLIA_USDC,
    keystore: env.SETTLER_KEYSTORE,
    password: env.SETTLER_KEYSTORE_PASSWORD,
    price,
    fund,
    network: env.PRICE_NETWORK || 'base-sepolia',
    statePath: args.state ?? './data/live-x402-snapshot.json',
    outPath: args.out ?? 'docs/evidence/x402-live-run.json',
    apiPort: Number(args.apiPort ?? 8402),
    facilitatorPort: Number(args['facilitator-port'] ?? 8403),
  };
}

/**
 * Refuse to write a transcript that contains anything capable of signing. The transcript is
 * assembled from primitives, so this should never fire — it exists because "should never" is not a
 * guarantee, and this file is about to be committed to a public repo.
 * @param {any} value
 */
export function assertNoSecrets(value, path = 'transcript') {
  if (value == null || typeof value !== 'object') {
    if (typeof value === 'function') throw new Error(`refusing to write ${path}: contains a function`);
    return;
  }
  for (const k of ['signTypedData', 'signMessage', 'signTransaction', 'getHdKey']) {
    if (typeof value[k] === 'function')
      throw new Error(`refusing to write ${path}: looks like an account object (has ${k})`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (/priv|secret|password|mnemonic|seed/i.test(k))
      throw new Error(`refusing to write ${path}.${k}: secret-shaped field name`);
    assertNoSecrets(v, `${path}.${k}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveRunConfig({ env: process.env, args });

  const { createPublicClient, createWalletClient, http, formatEther } = await import('viem');
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const { baseSepolia } = await import('viem/chains');

  /** @type {any} */
  const t = { startedAt: new Date().toISOString(), steps: [], deviations: [] };
  const step = (name, data) => {
    const entry = { name, at: new Date().toISOString(), ...data };
    t.steps.push(entry);
    console.log(`▸ ${name}${data?.detail ? ` — ${data.detail}` : ''}`);
    return entry;
  };

  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });

  // ── 0. chain identity, then the safety gate ──
  const chainId = await publicClient.getChainId();
  if (!TESTNET_CHAIN_IDS.has(chainId))
    throw new Error(`refusing to run against chain ${chainId} — testnet only`);
  const headBlock = await publicClient.getBlock();
  const localSec = Math.floor(Date.now() / 1000);
  const skewSec = localSec - Number(headBlock.timestamp);
  t.chain = { chainId, rpcUrl: cfg.rpcUrl, headBlock: Number(headBlock.number), headTimestamp: Number(headBlock.timestamp), localTimestamp: localSec, clockSkewSec: skewSec };
  step('chain-identified', { detail: `chainId ${chainId}, head ${headBlock.number}, local-vs-chain clock skew ${skewSec}s` });

  // ── 1. accounts: settler from keystore, payer generated here ──
  const settler = await loadAccountFromKeystore(cfg.keystore, cfg.password);
  const payer = privateKeyToAccount(generatePrivateKey());
  const payTo = settler.address; // recipient ≠ payer, and the float returns to the operator
  t.accounts = { settler: settler.address, payer: payer.address, payTo, payerIsEphemeral: true };
  step('accounts-ready', { detail: `settler ${settler.address}, ephemeral payer ${payer.address}` });

  const walletClient = createWalletClient({ account: settler, chain: baseSepolia, transport: http(cfg.rpcUrl) });

  // ── 2. the USDC EIP-712 domain, read from the token itself ──
  const domain = await readUsdcDomain({ publicClient, usdcAddress: cfg.usdcAddress, chainId });
  t.usdcDomain = {
    address: cfg.usdcAddress, name: domain.name, version: domain.version, chainId,
    onChainSeparator: domain.onChainSeparator, computedSeparator: domain.computedSeparator, matches: domain.matches,
  };
  if (!domain.matches) throw new Error('USDC domain does not reproduce DOMAIN_SEPARATOR — aborting');
  if (domain.name !== 'USD Coin')
    t.deviations.push({
      what: 'EIP-712 domain name',
      expectedByDefault: 'USD Coin',
      actualOnChain: domain.name,
      impact: 'signing with the old hardcoded default produces a signature that recovers to a stranger (signer-mismatch); every settlement would fail',
    });
  step('usdc-domain-verified', { detail: `name=${JSON.stringify(domain.name)} version=${JSON.stringify(domain.version)} separator=${domain.onChainSeparator}` });

  const balUsdc = (a) => publicClient.readContract({ address: cfg.usdcAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] });
  const snapshotBalances = async (label) => {
    const [payerB, payToB, settlerEth] = await Promise.all([balUsdc(payer.address), balUsdc(payTo), publicClient.getBalance({ address: settler.address })]);
    const b = { label, payerUsdc: payerB.toString(), payToUsdc: payToB.toString(), settlerWei: settlerEth.toString() };
    t.balances = t.balances ?? [];
    t.balances.push(b);
    return b;
  };

  // ── 3. fund the ephemeral payer ──
  const settlerStart = await balUsdc(settler.address);
  if (settlerStart < cfg.fund) throw new Error(`settler holds ${usdc(settlerStart)}, needs ${usdc(cfg.fund)} to fund the payer`);
  const fundHash = await walletClient.writeContract({
    address: cfg.usdcAddress, abi: ERC20_ABI, functionName: 'transfer', args: [payer.address, cfg.fund],
  });
  const fundRcpt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
  t.funding = { txHash: fundHash, amount: cfg.fund.toString(), block: Number(fundRcpt.blockNumber), gasUsed: fundRcpt.gasUsed.toString(), status: fundRcpt.status };
  step('payer-funded', { detail: `${usdc(cfg.fund)} → ${payer.address} in ${fundHash}` });

  // ── 4. bring up the facilitator (the only process holding a key) ──
  const fac = await startFacilitatorServer({
    account: settler, publicClient, walletClient,
    usdcAddress: cfg.usdcAddress, chainId, port: cfg.facilitatorPort, env: process.env,
    log: (m) => console.log(`  ${m}`),
  });
  step('facilitator-up', { detail: fac.url });

  // ── 5. bring up the API, keyless, pointed at the facilitator over HTTP ──
  await seed(cfg.statePath);
  const apiCfg = resolveApiConfig({
    PRICE_ASSET: cfg.usdcAddress, PRICE_PAYTO: payTo, PRICE_AMOUNT: cfg.price.toString(),
    PRICE_NETWORK: cfg.network, FACILITATOR: 'http', FACILITATOR_URL: fac.url,
    STATE_PATH: cfg.statePath, PORT: String(cfg.apiPort),
  });
  const { api } = await buildApiServer(apiCfg);
  await new Promise((r) => api.server.listen(cfg.apiPort, '127.0.0.1', () => r(undefined)));
  const baseUrl = `http://127.0.0.1:${cfg.apiPort}`;
  t.wiring = { apiBaseUrl: baseUrl, facilitatorUrl: fac.url, facilitatorKind: 'http', apiHoldsKey: false, price: cfg.price.toString(), network: cfg.network };
  step('api-up', { detail: `${baseUrl} (FACILITATOR=http → ${fac.url}), price ${usdc(cfg.price)}` });

  // ── 6. the unpaid request must be a 402 with a challenge ──
  const unpaid = await fetch(`${baseUrl}/vaults`);
  const challengeHeader = unpaid.headers.get('payment-required');
  t.challenge = { status: unpaid.status, header: challengeHeader ? JSON.parse(challengeHeader) : null };
  if (unpaid.status !== 402 || !challengeHeader) throw new Error(`expected 402 + challenge, got ${unpaid.status}`);
  step('402-challenge', { detail: `nonce ${t.challenge.header.nonce}` });

  // ── 7. THE PAID READ ──
  let captured = null;
  const before = await snapshotBalances('before-paid-read');
  const client = createProtocolClient({
    baseUrl,
    wallet: {
      address: payer.address,
      sign: (td) => payer.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message }),
    },
    domain: { name: domain.name, version: domain.version, chainId, verifyingContract: cfg.usdcAddress },
    onPayment: (p) => { captured = p; },
  });

  const t0 = Date.now();
  const { data, receipt } = await client.listVaults();
  const loopMs = Date.now() - t0;
  if (!receipt?.receiptId) throw new Error('paid read returned no receipt id');

  // Balances are snapshotted only AFTER the settlement is mined. The facilitator returns the hash
  // as soon as it broadcasts — it does not wait for inclusion — so the API answers the paid read
  // while the transfer is still in the mempool. Reading balances at that moment shows a delta of
  // zero on any chain with a real block time. (A fork with instant mining hides this completely,
  // which is exactly how it was found.)
  const settleRcpt = await publicClient.waitForTransactionReceipt({ hash: receipt.receiptId });
  const confirmedMs = Date.now() - t0;
  const after = await snapshotBalances('after-settlement-mined');
  if (settleRcpt.status !== 'success') throw new Error(`settlement tx reverted: ${receipt.receiptId}`);
  const settleTx = await publicClient.getTransaction({ hash: receipt.receiptId });
  const settleBlock = await publicClient.getBlock({ blockNumber: settleRcpt.blockNumber });

  t.paidRead = {
    route: '/vaults',
    // loopMs: 402 → sign → settle-broadcast → data. confirmedMs additionally waits for inclusion.
    latencyMs: loopMs,
    settlementConfirmedMs: confirmedMs,
    receiptId: receipt.receiptId,
    vaultsReturned: Array.isArray(data?.vaults) ? data.vaults.length : null,
    envelope: captured?.envelope ?? null,
    challenge: captured?.challenge ?? null,
    settlement: {
      txHash: receipt.receiptId,
      status: settleRcpt.status,
      block: Number(settleRcpt.blockNumber),
      blockTimestamp: Number(settleBlock.timestamp),
      from: settleRcpt.from,
      to: settleRcpt.to,
      gasUsed: settleRcpt.gasUsed.toString(),
      effectiveGasPrice: settleRcpt.effectiveGasPrice?.toString() ?? null,
      feeWei: (settleRcpt.gasUsed * (settleRcpt.effectiveGasPrice ?? 0n)).toString(),
      feeEth: formatEther(settleRcpt.gasUsed * (settleRcpt.effectiveGasPrice ?? 0n)),
      nonce: settleTx.nonce,
      logCount: settleRcpt.logs.length,
      logs: settleRcpt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    },
    deltas: {
      payerUsdc: (BigInt(after.payerUsdc) - BigInt(before.payerUsdc)).toString(),
      payToUsdc: (BigInt(after.payToUsdc) - BigInt(before.payToUsdc)).toString(),
      settlerWei: (BigInt(after.settlerWei) - BigInt(before.settlerWei)).toString(),
    },
  };
  step('paid-read-settled', {
    detail: `${loopMs}ms, tx ${receipt.receiptId}, payer ${t.paidRead.deltas.payerUsdc} / payTo +${t.paidRead.deltas.payToUsdc} base units`,
  });

  // The authorization's validAfter must actually precede the block that mined it — the clock-skew
  // hazard, measured rather than assumed.
  t.paidRead.validAfterMarginSec = Number(settleBlock.timestamp) - Number(captured?.envelope?.authorization?.validAfter ?? 0);

  // ── 8. REPLAY at the facilitator: the on-chain nonce is burned ──
  const replayBody = { x402Version: 2, challenge: { price: apiCfg.price }, envelope: captured.envelope };
  const r0 = Date.now();
  const replayRes = await fetch(fac.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(replayBody) });
  const replayBodyOut = await replayRes.json();
  t.replayAtFacilitator = { status: replayRes.status, body: replayBodyOut, latencyMs: Date.now() - r0 };
  step('replay-at-facilitator', { detail: `${replayRes.status} ${JSON.stringify(replayBodyOut)}` });

  // ── 9. REPLAY through the API: a different, earlier defense (local seen-nonce guard) ──
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const apiReplay = await fetch(`${baseUrl}/vaults`, { headers: { 'payment-signature': b64(captured.envelope) } });
  const apiReplayBody = await apiReplay.json();
  t.replayAtApi = { status: apiReplay.status, error: apiReplayBody?.error ?? null };
  step('replay-at-api', { detail: `${apiReplay.status} ${apiReplayBody?.error ?? ''}` });

  // ── 10. final balances + verification recipe ──
  await snapshotBalances('final');
  t.finishedAt = new Date().toISOString();
  t.verifyWith = {
    settlementReceipt: `cast receipt ${t.paidRead.receiptId} --rpc-url ${cfg.rpcUrl}`,
    authorizationState: `cast call ${cfg.usdcAddress} 'authorizationState(address,bytes32)(bool)' ${payer.address} ${captured.envelope.authorization.nonce} --rpc-url ${cfg.rpcUrl}`,
    payerBalance: `cast call ${cfg.usdcAddress} 'balanceOf(address)(uint256)' ${payer.address} --rpc-url ${cfg.rpcUrl}`,
    domain: `cast call ${cfg.usdcAddress} 'DOMAIN_SEPARATOR()(bytes32)' --rpc-url ${cfg.rpcUrl}`,
  };

  // NOT run through redact(): a 32-byte hex string is key-shaped, and so are the tx hashes and the
  // authorization nonce — the very evidence this file exists to carry. The transcript is built
  // from explicit primitive fields instead, and assertNoSecrets checks that nothing carrying a
  // signing capability slipped in.
  assertNoSecrets(t);
  await mkdir(dirname(cfg.outPath), { recursive: true });
  await writeFile(cfg.outPath, JSON.stringify(t, null, 2), 'utf8');
  console.log(`\n✓ transcript written to ${cfg.outPath}`);
  console.log(`  settlement tx: ${t.paidRead.receiptId}`);
  console.log(`  replay at facilitator: ${JSON.stringify(t.replayAtFacilitator.body)}`);

  await fac.close();
  await new Promise((r) => api.server.close(() => r(undefined)));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`\n✗ ${err?.message ?? err}`);
    if (err?.stack && process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
