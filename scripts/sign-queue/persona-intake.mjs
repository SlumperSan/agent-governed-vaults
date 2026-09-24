#!/usr/bin/env node
// @ts-check
/**
 * Adds the two FUNDED persona wallets (card 210: Ballast and Momentum, owner-funded, disclosed as
 * seeded) to `docs/seeded-addresses.json`, each with the `intendedDeposit` that
 * `personaIntentRefusal` (#415) checks every persona Sign-queue item against. This is the step
 * that makes a persona deposit signable at all, so it refuses rather than guesses:
 *
 * - each address must be a valid, distinct EOA not already listed;
 * - each must hold at least `MIN_FUNDING_RAW` USDC on Arc RIGHT NOW (100 USDC deposit + 1 USDC
 *   gas headroom, card 210). The file's own readme promises entries only once a wallet is actually
 *   funded, and an unfunded entry would unlock a deposit item that then fails on chain;
 * - the declared vault is the deployment record's `firstVault.address`, never a literal;
 * - the result must pass `validateSeededAddressesDoc`.
 *
 * Read-only against the chain (one `balanceOf` per address). Writes only the JSON file; the PR,
 * Security's review and the Sign-queue build (`persona-deposit.mjs`, Ballast first) follow it.
 *
 * Usage: node scripts/sign-queue/persona-intake.mjs --ballast 0x... --momentum 0x...
 * Env:   ARC_RPC (default https://rpc.mainnet.arc.io)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { validateSeededAddressesDoc } from '../lib/seeded-addresses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.ARC_RPC ?? 'https://rpc.mainnet.arc.io';
/** Card 210: 100 USDC deposit (the vault's immutable minDepositUsdc) plus 1 USDC for gas. */
export const MIN_FUNDING_RAW = 101_000_000n;
export const DEPOSIT_RAW = '100000000';
/** Decisions/Seed agent personas 2026-09-23.md: the two funded personas and their model tiers. */
export const PERSONAS = /** @type {const} */ ([
  { persona: 'Ballast', model: 'Sonnet', order: 'first' },
  { persona: 'Momentum', model: 'Haiku', order: 'second' },
]);

/** @param {string} addr @returns {Promise<bigint>} */
async function liveUsdcBalance(addr) {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'config', 'arc-mainnet.json'), 'utf8'));
  const data = `0x70a08231${addr.slice(2).toLowerCase().padStart(64, '0')}`;
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: cfg.usdc, data }, 'latest'] }),
  });
  const j = await r.json();
  if (typeof j?.result !== 'string') throw new Error(`USDC.balanceOf(${addr}) failed: ${JSON.stringify(j?.error ?? j)}`);
  return BigInt(j.result);
}

/**
 * @param {object} p
 * @param {string} p.ballast @param {string} p.momentum
 * @param {(addr: string) => Promise<bigint>} [p.readBalance] injectable; defaults to a live read
 * @param {string} [p.root] injectable repo root (tests only)
 * @param {string} [p.today] injectable YYYY-MM-DD (tests only)
 * @returns {Promise<object>} the new document (not yet written)
 */
export async function buildIntake({ ballast, momentum, readBalance = liveUsdcBalance, root = ROOT, today = new Date().toISOString().slice(0, 10) }) {
  const addrs = [ballast, momentum].map((a, i) => {
    try { return getAddress(String(a).trim()); } catch { throw new Error(`--${i ? 'momentum' : 'ballast'} ${JSON.stringify(a)} is not a valid address`); }
  });
  if (addrs[0] === addrs[1]) throw new Error('Ballast and Momentum must be two different wallets');

  const dep = JSON.parse(readFileSync(path.join(root, 'contracts', 'config', 'deployments', 'arc-mainnet.json'), 'utf8'));
  const vault = getAddress(dep?.firstVault?.address ?? '');
  const docPath = path.join(root, 'docs', 'seeded-addresses.json');
  const doc = JSON.parse(readFileSync(docPath, 'utf8'));
  if (!Array.isArray(doc.addresses)) throw new Error('docs/seeded-addresses.json has no addresses array');

  const added = [];
  for (const [i, { persona, model, order }] of PERSONAS.entries()) {
    const address = addrs[i];
    if (doc.addresses.some((e) => String(e.address).toLowerCase() === address.toLowerCase())) {
      throw new Error(`${address} is already listed in docs/seeded-addresses.json`);
    }
    if (doc.addresses.some((e) => e.persona === persona)) throw new Error(`persona ${persona} is already listed`);
    const balance = await readBalance(address);
    if (typeof balance !== 'bigint' || balance < MIN_FUNDING_RAW) {
      throw new Error(`${persona} ${address} holds ${balance} raw USDC, below ${MIN_FUNDING_RAW} (100 deposit + 1 gas) — fund it first; not adding it`);
    }
    added.push({
      address, persona, model,
      fundedBy: 'RWAlly owner (operator funds, owner-held key)',
      addedAt: today,
      note: `Seeded persona wallet holding RWAlly operator funds; deposits ${order} into the first Arc vault. Not an outside member.`,
      intendedDeposit: { vault, amountUsdcRaw: DEPOSIT_RAW },
    });
  }
  const next = { ...doc, addresses: [...doc.addresses, ...added] };
  const v = validateSeededAddressesDoc(next);
  if (!v.ok) throw new Error(`the result fails validateSeededAddressesDoc: ${v.errors.join('; ')}`);
  return next;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing required --${name}`);
  return process.argv[i + 1];
}

async function main() {
  const next = await buildIntake({ ballast: arg('ballast'), momentum: arg('momentum') });
  writeFileSync(path.join(ROOT, 'docs', 'seeded-addresses.json'), `${JSON.stringify(next, null, 2)}\n`);
  for (const e of next.addresses.slice(-2)) console.log(`added ${e.persona} ${e.address} (intendedDeposit ${e.intendedDeposit.amountUsdcRaw} raw to ${e.intendedDeposit.vault})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`persona-intake: ${e.message}`); process.exit(1); });
}
