#!/usr/bin/env node
// @ts-check
/**
 * The quickstart's worked example: an agent that pays for a metered read and prints vault state.
 *
 * This is the file `docs/AGENT-QUICKSTART.md` tells a newcomer to run, and it is executed
 * end-to-end by `scripts/test/docs-site.test.mjs`, so the quickstart cannot claim a command that
 * no longer works.
 *
 *   node docs/examples/read-vaults.mjs --api=http://127.0.0.1:8402 --chain-id=84532
 *   node docs/examples/read-vaults.mjs --api=… --chain-id=84532 --rpc=https://sepolia.base.org
 *
 * Flags:
 *   --api=<url>       metered API base URL            (default http://127.0.0.1:8402)
 *   --chain-id=<n>    chain the USDC lives on         (default 84532, Base Sepolia)
 *   --rpc=<url>       read the USDC EIP-712 domain from the token instead of assuming it
 *   --vault=<addr>    also fetch one vault's detail view
 *   --json            one JSON object instead of prose
 *
 * WALLET. It generates a throwaway key in memory, on every run, and refuses any chain id that is
 * not a known testnet. It signs x402 payment authorizations and nothing else. Under EIP-3009 a
 * signature IS the spend, so a real key belongs here only when you meant to spend real USDC — and
 * against a `FACILITATOR=stub` server (what the quickstart runs) nothing settles at all.
 */

import { createProtocolClient, ProtocolError } from '../../packages/agent-sdk/src/index.mjs';

/** Chain ids a throwaway in-memory key is allowed to sign for. Mirrors the reference agent. */
const TESTNET_CHAIN_IDS = new Set([84532, 11155111, 421614, 11155420, 80002]);

/**
 * USDC's EIP-712 domain differs per chain — Base mainnet reports "USD Coin", Base Sepolia reports
 * "USDC". Signing under the wrong one produces a valid signature over the WRONG struct hash, which
 * recovers to a stranger and surfaces as an opaque `signer-mismatch`. This table is the fallback;
 * `--rpc` reads the truth from the token, which is what production code should do.
 * See docs/X402-FLOW.md §4 and docs/X402-LIVE-REPORT.md §7.1.
 */
const KNOWN_USDC = {
  8453: { name: 'USD Coin', version: '2', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  84532: { name: 'USDC', version: '2', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
};

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);

const apiUrl = String(args.api ?? 'http://127.0.0.1:8402').replace(/\/$/, '');
const chainId = Number(args['chain-id'] ?? 84532);
const asJson = Boolean(args.json);
const out = [];
const say = (line) => { if (!asJson) console.log(line); };

// ── read the USDC EIP-712 domain from the token (zero dependencies) ─────────

/**
 * Call a no-argument, string-returning view (`name()`, `version()`) over plain JSON-RPC and decode
 * the ABI response by hand. No web3 library: this is here so it can be copy-pasted into any agent,
 * including one whose runtime has no dependencies at all.
 * @param {string} rpcUrl @param {string} address @param {string} selector 4-byte hex
 */
export async function callStringView(rpcUrl, address, selector) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: address, data: selector }, 'latest'],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`eth_call ${selector} failed: ${body.error.message}`);
  return decodeAbiString(body.result);
}

/** ABI dynamic string: 32-byte offset, 32-byte length, then the UTF-8 bytes, right-padded. */
export function decodeAbiString(hex) {
  const data = String(hex).replace(/^0x/, '');
  if (data.length < 128) throw new Error('eth_call returned too little data to be a string');
  const offset = Number(BigInt('0x' + data.slice(0, 64))) * 2;
  const length = Number(BigInt('0x' + data.slice(offset, offset + 64)));
  const bytes = data.slice(offset + 64, offset + 64 + length * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

/**
 * Resolve the EIP-712 domain for USDC. With an RPC it is READ FROM THE TOKEN; without one it falls
 * back to the table above and says so, because an unverified domain is the most common cause of a
 * first integration failing.
 * @returns {Promise<{domain:object, source:string}>}
 */
export async function resolveUsdcDomain({ chainId, rpcUrl, address }) {
  const known = KNOWN_USDC[chainId];
  const verifyingContract = address ?? known?.address;
  if (!verifyingContract) throw new Error(`no USDC address known for chain ${chainId}; pass --usdc=<addr>`);
  if (!rpcUrl) {
    if (!known) throw new Error(`no USDC domain known for chain ${chainId}; pass --rpc to read it from the token`);
    return { domain: { ...knownDomain(known), chainId, verifyingContract }, source: 'table (NOT verified against the token)' };
  }
  const [name, version] = await Promise.all([
    callStringView(rpcUrl, verifyingContract, '0x06fdde03'), // name()
    callStringView(rpcUrl, verifyingContract, '0x54fd4d50'), // version()
  ]);
  return { domain: { name, version, chainId, verifyingContract }, source: `read from ${verifyingContract} via ${rpcUrl}` };
}

const knownDomain = (k) => ({ name: k.name, version: k.version });

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!TESTNET_CHAIN_IDS.has(chainId)) {
    console.error(`refused: chain id ${chainId} is not a known testnet. This example mints a throwaway key, which must never sign on mainnet.`);
    process.exitCode = 2;
    return;
  }

  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(generatePrivateKey());

  const { domain, source } = await resolveUsdcDomain({
    chainId,
    rpcUrl: args.rpc ? String(args.rpc) : undefined,
    address: args.usdc ? String(args.usdc) : undefined,
  });

  say(`agent wallet   ${account.address}  (throwaway, in memory, never written to disk)`);
  say(`usdc domain    name="${domain.name}" version="${domain.version}" chainId=${domain.chainId}`);
  say(`               ${source}`);
  if (!args.rpc) say('               ⚠  not read from the token. Pass --rpc=<url> before trusting this against a real facilitator.');
  say('');

  const paid = [];
  const client = createProtocolClient({
    baseUrl: apiUrl,
    wallet: {
      address: account.address,
      // The SDK hands over EIP-712 typed data; viem wants the domain/types/message split, and it
      // computes EIP712Domain itself, so only the payload type is passed through.
      sign: (td) => account.signTypedData({
        domain: td.domain,
        types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message: td.message,
      }),
    },
    domain,
    // Fires after the authorization is signed and BEFORE the paid retry. A receipt id cannot be
    // re-verified against the chain later; the envelope can. Record it.
    onPayment: ({ path, envelope }) => paid.push({ path, value: envelope.authorization.value, nonce: envelope.authorization.nonce }),
  });

  // 1. Free: what does this API charge, and for what?
  const disc = await client.discovery();
  say(`discovery      $${(Number(disc.price.amount) / 1e6).toFixed(2)} per metered read → ${disc.price.payTo}`);
  say(`               metered: ${disc.routes.metered.join(', ')}`);

  // 2. Free: is it alive, and how far has the indexer got?
  const health = await client.health();
  say(`health         ok=${health.ok} lastBlock=${health.lastBlock}`);
  say('');

  // 3. Paid: the whole 402 → authorize → retry loop happens inside this one call.
  const { data: vaults, receipt } = await client.listVaults();
  say(`GET /vaults    ${vaults.vaults.length} vault(s)   receipt ${receipt?.receiptId ?? '(none)'}`);
  for (const v of vaults.vaults) {
    say(`  ${v.vault}  operatorId=${v.operatorId}  members=${v.memberCount}  depth=${v.depth}` +
        `${v.attested ? '' : '   ⚠ UNATTESTED — treat as scam-quarantine'}`);
  }

  // 4. Paid: the operator leaderboard, losses included.
  const { data: board } = await client.leaderboard();
  say('');
  say(`GET /operators/leaderboard   ${board.leaderboard.length} operator(s)`);
  for (const r of board.leaderboard) {
    const net = (BigInt(r.netRealizedUsdc ?? '0') / 1_000_000n).toString();
    say(`  operatorId=${r.operatorId}  net realized $${net}  vaults=${r.vaultCount}`);
  }

  // 5. Paid: one vault in detail, if asked.
  if (args.vault) {
    const { data: vault } = await client.getVault(String(args.vault));
    say('');
    say(`GET /vaults/${args.vault}`);
    say(`  creator=${vault.creator} totalShares=${vault.totalShares} pending=${vault.pendingCount}`);
    out.push({ vault });
  }

  say('');
  say(`paid ${paid.length} time(s), ${paid.reduce((s, p) => s + Number(p.value), 0) / 1e6} USDC authorized in total.`);

  if (asJson) {
    console.log(JSON.stringify({
      wallet: account.address, domain, domainSource: source,
      discovery: disc, health, vaults: vaults.vaults, leaderboard: board.leaderboard,
      payments: paid, extra: out,
    }, null, 2));
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  main().catch((err) => {
    if (err instanceof ProtocolError) console.error(`API error ${err.status}: ${err.message}`);
    else console.error(String(err?.stack ?? err));
    process.exitCode = 1;
  });
}
