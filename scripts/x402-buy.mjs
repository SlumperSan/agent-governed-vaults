#!/usr/bin/env node
// @ts-check
/**
 * x402 buyer CLI — make one real purchase from the command line.
 *
 *     BUYER_KEYSTORE=~/.foundry/keystores/buyer \
 *     BUYER_KEYSTORE_PASSWORD=… \
 *     node scripts/x402-buy.mjs \
 *       --url=https://rwally.com/api/vaults \
 *       --network=base \
 *       --asset=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
 *       --pay-to=<the payee address named in the challenge you expect> \
 *       --max=0.10 \
 *       --rpc-url=https://mainnet.base.org
 *
 * This is `docs/REVENUE.md` §5.5's "make the first purchase" step, runnable rather than manual.
 * `scripts/lib/x402-buyer.mjs` does the actual handshake and its own header explains why signing
 * happens only after the challenge is checked against what YOU pass on the command line, never
 * against anything the server sends. Everything below exists to feed that check honestly.
 *
 * ## Key handling
 *
 * No flag here accepts a key or a raw private key — argv is one `ps`/shell-history/crash-dump away
 * from leaking, which is exactly the failure mode `scripts/live-x402-run.mjs` refuses for its own
 * SETTLER role. The only accepted path is a Foundry-style V3 keystore, decrypted in-process by
 * `scripts/lib/keystore.mjs` (`loadAccountFromKeystore`) and never retained, printed, or written —
 * `BUYER_PRIVATE_KEY` / `PRIVATE_KEY` in the environment are refused outright with a pointer to the
 * keystore path, not silently accepted as a shortcut.
 *
 * ## What this does NOT do
 *
 * It never defaults to a network or a chain — `--network` and `--rpc-url` are both required, so
 * pointing this at mainnet is something you must type, not something that happens if you forget a
 * flag. It never signs more than `--max`, checked before `--rpc-url` is even used to confirm the
 * USDC domain. It never broadcasts anything: this process only signs an EIP-3009 authorization and
 * hands it to the SERVER, whose facilitator settles on-chain (see `apps/api/src/facilitator.mjs`).
 * This process holds no gas and has no chain write path.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccountFromKeystore } from './lib/keystore.mjs';
import { buyResource, signerFromAccount, parseUsdcAmount, isAddress } from './lib/x402-buyer.mjs';
import { readUsdcDomain } from '../apps/api/src/facilitator.mjs';

/**
 * Hard ceiling on `--max`, independent of whatever the caller passes. This tool exists to make a
 * few-cents purchase (`docs/REVENUE.md` prices the one route it targets at $0.10); a `--max` above
 * this is almost certainly a decimal-point mistake, and the cost of being wrong about that is real
 * USDC leaving a real wallet.
 */
const HARD_MAX_USDC_BASE_UNITS = 5_000_000n; // $5.00

function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

function isLocalUrl(u) {
  try {
    const { hostname } = new URL(u);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * A signed payment authorization is bearer-secret-shaped for the few minutes it is valid: whoever
 * holds it can present it to the server. It must not cross plain http except to a local test
 * fixture, mirroring `apps/site-next/functions/api/_price.js`'s https-only rule for `FACILITATOR_URL`.
 * @param {string} u @param {string} flagName
 */
function requireSecureUrl(u, flagName) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`${flagName} is not a URL: ${u}`);
  }
  if (parsed.protocol !== 'https:' && !isLocalUrl(u)) {
    throw new Error(`${flagName} must be https (or a local test fixture), got: ${parsed.protocol}`);
  }
  return parsed.toString();
}

/**
 * Validate and normalize every CLI input before anything is signed. Pure given `{env, args}`, so
 * every refusal here is unit-testable without a keystore, a network, or a signature.
 * @param {{env:Record<string,string|undefined>, args:Record<string,any>}} p
 */
export function resolveBuyConfig({ env, args }) {
  const problems = [];

  if (args.key || args['private-key'] || args.privateKey)
    problems.push('a key must never be passed as a CLI argument — set BUYER_KEYSTORE / BUYER_KEYSTORE_PASSWORD instead');
  if (env.BUYER_PRIVATE_KEY || env.PRIVATE_KEY)
    problems.push('refusing to run with a raw private key in the environment — use BUYER_KEYSTORE instead');
  if (!env.BUYER_KEYSTORE) problems.push('BUYER_KEYSTORE (path to a keystore file) is not set');
  if (!env.BUYER_KEYSTORE_PASSWORD) problems.push('BUYER_KEYSTORE_PASSWORD is not set');

  if (!args.url) problems.push('--url is required');
  if (!args.network) problems.push('--network is required (never defaulted — e.g. "base", never assumed)');
  if (!args['rpc-url']) problems.push('--rpc-url is required (never defaulted — used to read the USDC EIP-712 domain and chain id)');
  if (!args.asset) problems.push('--asset is required (the USDC contract address you expect the challenge to name)');
  if (!args['pay-to']) problems.push('--pay-to is required (the recipient address you expect the challenge to name)');
  if (args.max === undefined) problems.push('--max is required (the most you are willing to pay, in USDC — never defaulted)');

  if (args.asset && !isAddress(args.asset)) problems.push(`--asset is not an address: ${args.asset}`);
  if (args['pay-to'] && !isAddress(args['pay-to'])) problems.push(`--pay-to is not an address: ${args['pay-to']}`);

  if (problems.length) throw new Error('cannot start x402-buy:\n  - ' + problems.join('\n  - '));

  const url = requireSecureUrl(String(args.url), '--url');
  const rpcUrl = requireSecureUrl(String(args['rpc-url']), '--rpc-url');

  const maxAmount = parseUsdcAmount(String(args.max), '--max');
  if (maxAmount <= 0n) throw new Error('--max must be positive');
  if (maxAmount > HARD_MAX_USDC_BASE_UNITS)
    throw new Error(`--max ${args.max} USDC exceeds this tool's ${Number(HARD_MAX_USDC_BASE_UNITS) / 1e6} USDC hard ceiling`);

  const maxTtlMs = args['max-ttl-ms'] !== undefined ? Number(args['max-ttl-ms']) : undefined;
  if (maxTtlMs !== undefined && !(Number.isFinite(maxTtlMs) && maxTtlMs > 0))
    throw new Error(`--max-ttl-ms must be a positive number, got ${args['max-ttl-ms']}`);

  const skewSec = args['skew-sec'] !== undefined ? Number(args['skew-sec']) : undefined;
  if (skewSec !== undefined && !(Number.isFinite(skewSec) && skewSec >= 0))
    throw new Error(`--skew-sec must be a non-negative number, got ${args['skew-sec']}`);

  return {
    url,
    rpcUrl,
    network: String(args.network),
    asset: String(args.asset),
    payTo: String(args['pay-to']),
    maxAmount,
    maxTtlMs,
    skewSec,
    outPath: args.out ? String(args.out) : undefined,
    keystore: /** @type {string} */ (env.BUYER_KEYSTORE),
    password: /** @type {string} */ (env.BUYER_KEYSTORE_PASSWORD),
  };
}

async function main() {
  const cfg = resolveBuyConfig({ env: process.env, args: parseArgs(process.argv.slice(2)) });

  const { createPublicClient, http } = await import('viem').catch(() => {
    throw new Error('viem is required — run `npm install` at the repo root');
  });

  console.log(`▸ decrypting keystore ${cfg.keystore}`);
  const account = await loadAccountFromKeystore(cfg.keystore, cfg.password);
  console.log(`▸ buyer address ${account.address}`);

  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const chainId = await publicClient.getChainId();
  console.log(`▸ chain id ${chainId} (via ${cfg.rpcUrl})`);

  const domain = await readUsdcDomain({ publicClient, usdcAddress: cfg.asset, chainId });
  if (!domain.matches) {
    throw new Error(
      `USDC domain for ${cfg.asset} on chain ${chainId} does not reproduce DOMAIN_SEPARATOR — ` +
        `refusing to sign against a domain that would not verify on-chain`,
    );
  }
  console.log(`▸ USDC domain verified: name=${JSON.stringify(domain.name)} version=${JSON.stringify(domain.version)}`);

  const result = await buyResource({
    url: cfg.url,
    expected: { asset: cfg.asset, payTo: cfg.payTo, network: cfg.network, maxAmount: cfg.maxAmount.toString(), maxTtlMs: cfg.maxTtlMs },
    walletAddress: account.address,
    domain: { name: domain.name, version: domain.version, chainId, verifyingContract: cfg.asset },
    sign: signerFromAccount(account),
    skewSec: cfg.skewSec,
  });

  if (result.paid) {
    console.log(`✓ paid — receipt ${JSON.stringify(result.receipt)}`);
  } else {
    console.log('✓ resource was free — nothing was signed');
  }
  console.log(JSON.stringify(result.data, null, 2));

  if (cfg.outPath) {
    // The envelope carries a signature and payment metadata (payer, payTo, amount, nonce) — all of
    // it evidence of a payment already made, none of it a secret. No key or password reaches this
    // object at any point above, so there is nothing here to redact.
    await mkdir(dirname(cfg.outPath), { recursive: true });
    await writeFile(cfg.outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  written to ${cfg.outPath}`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    if (err?.name === 'ChallengeMismatchError') {
      console.error(`\n✗ ABORTED before signing anything — ${err.message}`);
      console.error(`  ${JSON.stringify(err.detail)}`);
    } else {
      console.error(`\n✗ ${err?.message ?? err}`);
    }
    if (err?.stack && process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
