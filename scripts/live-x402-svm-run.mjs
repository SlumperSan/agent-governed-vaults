#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * x402 `exact-svm` END TO END on Solana devnet — the SVM sibling of `live-x402-run.mjs`.
 *
 * ## Why this file exists rather than a paragraph in a commit message
 *
 * The first devnet run of this scheme called `createSvmFacilitator().verifyAndSettle` DIRECTLY, and
 * its balances and signature were quoted as proof that the Solana payment path worked. They were not
 * that. `decodeSignatureHeader` rejected the envelope the shipped client builds, so no request could
 * reach the facilitator through `gate()` at all — the run exercised the same function the unit tests
 * already covered, and the claim was unfalsifiable from the repository because nothing here could
 * reproduce it.
 *
 * So: this starts at `createProtocolClient`, goes through a real HTTP server, a real 402, the real
 * gate, the real facilitator and a real devnet transaction, and asserts on SPL TOKEN BALANCE DELTAS
 * read back from chain. A stub can fake a receipt. It cannot fake a balance.
 *
 * ## Running it
 *
 *     SVM_LIVE=1 SVM_KEYPAIR_PATH=~/.svm-devnet.json node scripts/live-x402-svm-run.mjs
 *
 * It refuses to do anything without `SVM_LIVE=1`, and it refuses to sign anything if the RPC's
 * genesis hash is not devnet's. The keypair it is given becomes the FACILITATOR: it pays every
 * network fee, which is the whole trust shape of this scheme and the reason the EVM path's "the
 * server holds no key" does not carry over. It needs a little devnet SOL — `solana airdrop 2` — and
 * nothing else: the mint, the payer, and both token accounts are created here, so the run depends on
 * no faucet, no pre-existing state and no address anybody has to keep up to date.
 *
 * The payer is generated fresh every run and thrown away. It must not be the facilitator: the
 * facilitator refuses a transfer whose authority is itself (`authority-is-fee-payer`), because a
 * server that can pay itself has proved nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { resolveApiConfig, buildApiServer } from '../apps/api/src/serve.mjs';
import { createProtocolClient, createSvmPayer } from '../packages/agent-sdk/src/index.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC = process.env.SVM_RPC_URL || 'https://api.devnet.solana.com';
const PRICE = process.env.PRICE_AMOUNT || '10000'; // 0.01 at 6dp, the same price the EVM path uses
const DECIMALS = 6;

if (process.env.SVM_LIVE !== '1') {
  console.error('refusing to run: set SVM_LIVE=1. This signs and broadcasts real devnet transactions.');
  process.exit(2);
}

const keypairPath = (process.env.SVM_KEYPAIR_PATH || path.join(os.homedir(), '.svm-devnet.json'))
  .replace(/^~(?=$|\/)/, os.homedir());
const secret = fs.readFileSync(keypairPath, 'utf8').trim();
const facilitator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));

const conn = new Connection(RPC, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing to run: ${RPC} has genesis ${genesis}, which is not devnet (${DEVNET_GENESIS}).`);
  process.exit(2);
}
console.log(`devnet confirmed (genesis ${genesis})`);

const payer = Keypair.generate();
console.log(`facilitator / fee payer   ${facilitator.publicKey.toBase58()}`);
console.log(`payer / transfer authority ${payer.publicKey.toBase58()}  (generated, discarded after this run)`);

const sol = await conn.getBalance(facilitator.publicKey);
console.log(`facilitator SOL ${sol / LAMPORTS_PER_SOL}`);
if (sol < 0.2 * LAMPORTS_PER_SOL) {
  console.error('the facilitator needs at least 0.2 devnet SOL to run this. `solana airdrop 2`.');
  process.exit(2);
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
// The payer needs rent-exempt lamports for its own token account. It never pays a transaction fee:
// that is the point of the scheme.
console.log('\nfunding the payer:', await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: facilitator.publicKey, toPubkey: payer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
), [facilitator]));

const mint = await createMint(conn, facilitator, facilitator.publicKey, null, DECIMALS);
const payerAta = await getOrCreateAssociatedTokenAccount(conn, facilitator, mint, payer.publicKey);
const destAta = await getOrCreateAssociatedTokenAccount(conn, facilitator, mint, facilitator.publicKey);
console.log(`mint ${mint.toBase58()}`);
console.log(`payer token account ${payerAta.address.toBase58()}`);
console.log(`destination token account ${destAta.address.toBase58()}`);
console.log('minting 5.000000 to the payer:', await mintTo(conn, facilitator, mint, payerAta.address, facilitator, 5_000_000));

const balance = async (a) => (await getAccount(conn, new PublicKey(a))).amount;
const beforePayer = await balance(payerAta.address);
const beforeDest = await balance(destAta.address);
console.log(`\nbefore: payer ${beforePayer}  destination ${beforeDest}`);

// ── the API, configured exactly as an operator would ───────────────────────────────────────────
// An empty snapshot: this run is about the payment, and `/vaults` is metered whether or not it has
// rows to return.
const statePath = path.join(os.tmpdir(), `x402-svm-live-${process.pid}.json`);
fs.writeFileSync(statePath, JSON.stringify({
  version: 1, lastBlock: 0, lastLogIndex: -1,
  vaults: [], operators: [], shares: [], proposals: [], activeProposal: [],
  eventStats: [], adapters: [], queuedExits: [],
}));

const cfg = resolveApiConfig({
  FACILITATOR: 'svm',
  NETWORK: 'solana-devnet',
  PRICE_NETWORK: 'solana-devnet',
  PRICE_ASSET: mint.toBase58(),
  PRICE_PAYTO: destAta.address.toBase58(),
  PRICE_AMOUNT: PRICE,
  SVM_RPC_URL: RPC,
  SVM_KEYPAIR: secret,
  SVM_DESTINATION_TOKEN_ACCOUNT: destAta.address.toBase58(),
  SVM_DECIMALS: String(DECIMALS),
  STATE_PATH: statePath,
});

const built = await buildApiServer(cfg, { log: { info() {}, warn() {}, error: console.error } });
const server = built.api.server;
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
const { port } = server.address();
console.log(`\napi on 127.0.0.1:${port}, FACILITATOR=svm, challenge fee payer ${cfg.price.svm.feePayer}`);
if (cfg.price.svm.feePayer !== facilitator.publicKey.toBase58()) {
  throw new Error('the challenge names a fee payer that is not this facilitator');
}

// The observer is INJECTED rather than patched onto the global: the client captures `fetch` at
// construction, so reassigning `globalThis.fetch` afterwards is not seen by it.
let challenge = null;
const plainFetch = globalThis.fetch;
const observing = async (u, i) => {
  const r = await plainFetch(u, i);
  if (r.status === 402) challenge = JSON.parse(r.headers.get('payment-required'));
  return r;
};

const client = createProtocolClient({
  baseUrl: `http://127.0.0.1:${port}`,
  fetchImpl: observing,
  // Present and deliberately explosive: the challenge names exact-svm, so the SVM payer must take
  // it and the EIP-3009 signer must never be reached.
  wallet: { address: `0x${'1'.repeat(40)}`, sign: async () => { throw new Error('the EVM signer was reached on an SVM challenge'); } },
  domain: {},
  payer: createSvmPayer({ keypair: payer, sourceTokenAccount: payerAta.address.toBase58(), connection: conn }),
});

console.log('\ncalling the metered route through the client…');
const res = await client.listVaults();
console.log('challenge:', JSON.stringify(challenge));
console.log('receipt  :', res.receipt?.receiptId);
console.log('body     :', JSON.stringify(res.data));

if (challenge?.scheme !== 'exact-svm') throw new Error(`the challenge was not exact-svm: ${challenge?.scheme}`);
if (challenge.feePayer !== facilitator.publicKey.toBase58()) throw new Error('the challenge fee payer is wrong');
if (Number(challenge.decimals) !== DECIMALS) throw new Error('the challenge decimals are wrong');
if (!res.receipt?.receiptId) throw new Error('no receipt: the request was not settled');

// ── the assertion that cannot be stubbed ───────────────────────────────────────────────────────
const sig = res.receipt.receiptId;
const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
if (!tx) throw new Error(`the receipt id ${sig} is not a transaction on devnet`);
if (tx.meta?.err) throw new Error(`the settlement transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);
console.log(`\nsettled in slot ${tx.slot}`);
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

const afterPayer = await balance(payerAta.address);
const afterDest = await balance(destAta.address);
const want = BigInt(PRICE);
const out = beforePayer - afterPayer;
const inn = afterDest - beforeDest;
console.log(`after : payer ${afterPayer}  destination ${afterDest}`);
if (out !== want) throw new Error(`the payer lost ${out}, expected ${want}`);
if (inn !== want) throw new Error(`the destination gained ${inn}, expected ${want}`);
console.log(`\nBALANCE DELTA IS THE ASSERTION: payer -${out}, destination +${inn}, price ${want}. Exact.`);

// ── and the same payment must not work twice ───────────────────────────────────────────────────
// An SVM envelope has no `nonce` field, so the local replay guard keys on the transaction bytes.
// Solana refuses a duplicate signature within the blockhash's ~2-minute life on its own; this is
// the local half, and it was inert before it keyed on something that exists.
console.log('\nreplaying one identical envelope twice…');
const envelope = await createSvmPayer({ keypair: payer, sourceTokenAccount: payerAta.address.toBase58(), connection: conn })
  .buildEnvelope({ challenge });
const hdr = Buffer.from(JSON.stringify(envelope)).toString('base64');
const first = await plainFetch(`http://127.0.0.1:${port}/vaults`, { headers: { 'payment-signature': hdr } });
const second = await plainFetch(`http://127.0.0.1:${port}/vaults`, { headers: { 'payment-signature': hdr } });
const replayBody = await second.json().catch(() => ({}));
console.log(`first ${first.status}, replay ${second.status} — ${replayBody.error ?? ''}`);
if (first.status !== 200) throw new Error(`the first use of a fresh envelope must settle, got ${first.status}`);
if (second.status !== 402) throw new Error(`a replayed envelope must be refused, got ${second.status}`);

server.close();
server.closeIdleConnections?.();
fs.rmSync(statePath, { force: true });
console.log('\nEND TO END: client → 402 → envelope → gate → facilitator → devnet. Balances moved, replay refused.');
