#!/usr/bin/env node
// @ts-check
/**
 * Entrypoint: `node packages/reference-agent/src/run.mjs`
 *
 * Dry-run by default. Execute mode is unreachable from this script alone by design — it needs BOTH
 * `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes` and an account, and this file will not build an
 * account from a private key found in the environment. That is deliberate: an agent that reads
 * `PRIVATE_KEY` from env is one leaked `.env` away from a drained wallet, and one `console.log`
 * away from a key in a logfile. To run in execute mode, import `createAgent` and inject an account
 * you constructed yourself:
 *
 *     import { privateKeyToAccount } from 'viem/accounts';
 *     import { createAgent } from './agent.mjs';
 *     const agent = createAgent({ config: {...config, mode:'execute'}, account: privateKeyToAccount(key), ... });
 *
 * Flags:
 *   --api=<url>        metered API base URL          (default http://127.0.0.1:8402)
 *   --rpc=<url>        JSON-RPC endpoint for chain reads. Omitted ⇒ the STUB reader, whose values
 *                      are marked [stub-chain] in the narrative. The protocol has no deployment
 *                      yet (issue #10), so the stub is the default for the demo run.
 *   --governance=<addr> --subvault-registry=<addr> --usdc=<addr> --chain-id=<n>
 *   --ticks=<n>        how many loop passes to run (default 1)
 *   --demo-wallet      generate a throwaway in-memory key, used as the x402 payer AND as the
 *                      agent's identity so the salt/reveal path is exercised for real. DEV ONLY:
 *                      the key exists for the life of the process, is never written down, and
 *                      funds nothing but the read budget. Refuses on any chain id but a testnet.
 *                      This does NOT enable execute mode — the run stays dry-run either way.
 *   --cap=<usdc>       per-session x402 spend cap    (default 0.25)
 *   --json             one JSON record per line instead of prose
 *   --config=<path>    JSON file merged over the defaults
 */

import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { createChainReader, createStubChainReader } from './chain.mjs';
import { createLogger } from './log.mjs';
import { createAgent } from './agent.mjs';
import { buildVote } from './salt.mjs';
import {
  DEMO_ENTRY_MARKS,
  DEMO_FIXTURE_CHAIN,
  DEMO_PID,
  DEMO_VAULTS,
  demoGovernance,
  withDemoCommitment,
} from '../fixtures/demo-chain.mjs';

const TESTNET_CHAIN_IDS = new Set([84532, 11155111, 31337, 1337]);

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger({ json: Boolean(args.json) });

  const fileConfig = args.config ? JSON.parse(readFileSync(String(args.config), 'utf8')) : {};
  const config = loadConfig({
    ...fileConfig,
    mode: 'dry-run', // this script never runs in execute mode — see the header
    api: {
      ...(fileConfig.api ?? {}),
      baseUrl: args.api ? String(args.api) : fileConfig.api?.baseUrl ?? undefined,
      payments: {
        ...(fileConfig.api?.payments ?? {}),
        ...(args.cap ? { maxSessionSpendUsdc: String(args.cap) } : {}),
      },
    },
    chain: {
      ...(fileConfig.chain ?? {}),
      ...(args.rpc ? { rpcUrl: String(args.rpc) } : {}),
      ...(args['chain-id'] ? { chainId: Number(args['chain-id']) } : {}),
      ...(args.governance ? { governance: String(args.governance).toLowerCase() } : {}),
      ...(args['subvault-registry'] ? { subvaultRegistry: String(args['subvault-registry']).toLowerCase() } : {}),
      ...(args.usdc ? { usdc: String(args.usdc).toLowerCase() } : {}),
    },
  });

  // ── demo wallet ────────────────────────────────────────────────────────────
  // Metered reads cost USDC, and the salt scheme needs a signer. --demo-wallet mints ONE throwaway
  // key in memory, used both as the x402 payer and as the agent's identity, so the demo exercises
  // the real 402 → authorize → retry loop against a real HTTP server AND the real salt/reveal
  // recovery path. The key lives only in this process, is never written down, and is refused
  // outright on anything but a known testnet. This stays a DRY RUN throughout: no transaction is
  // ever signed, whatever wallet is present.
  let payer = null;
  let account = null;
  if (args['demo-wallet'] || args['demo-payer']) {
    if (!TESTNET_CHAIN_IDS.has(Number(config.chain.chainId))) {
      log.error(`--demo-wallet refused: chain id ${config.chain.chainId} is not a known testnet. A throwaway key must never sign on mainnet.`);
      process.exitCode = 2;
      return;
    }
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const acct = privateKeyToAccount(generatePrivateKey());
    account = { address: acct.address, signMessage: (a) => acct.signMessage(a) };
    payer = {
      address: acct.address,
      signTypedData: (typedData) =>
        acct.signTypedData({
          domain: typedData.domain,
          types: { TransferWithAuthorization: typedData.types.TransferWithAuthorization },
          primaryType: 'TransferWithAuthorization',
          message: typedData.message,
        }),
    };
    log.info(`demo wallet: ${acct.address} (throwaway, in-memory, testnet only — never written to disk)`);
  }

  // ── chain reader ───────────────────────────────────────────────────────────
  // No RPC ⇒ the stub, loudly marked. The protocol is not deployed yet (docs/RUNTIME.md, #10), so
  // the demo run cannot read a real chain and does not pretend to.
  let chainReader;
  let entryMarks = {};
  if (config.chain.rpcUrl) {
    chainReader = createChainReader({
      rpcUrl: config.chain.rpcUrl,
      chainId: config.chain.chainId,
      chainName: config.chain.chainName,
      governance: config.chain.governance,
      onEvent: (e) => (e.level === 'warn' ? log.warn(e.msg, e.detail) : log.info(e.msg, e.detail)),
    });
  } else {
    log.warn('no --rpc given: chain reads come from a STUB fixture. Every value it produces is marked [stub-chain] and none of it is live data.');
    const nowSec = Math.floor(Date.now() / 1000);
    let gov = demoGovernance(nowSec);
    if (account) {
      // Make the demo's outstanding commit a REAL one: build the commitment this account would
      // have produced, then throw the salt away. Recovery then has to re-derive it, which is the
      // whole S-4 mitigation rather than a mock of it.
      config.chain.governance ??= '0x' + '9'.repeat(40);
      const vote = await buildVote({ account, chainId: config.chain.chainId, vault: DEMO_VAULTS.helios, pid: DEMO_PID, support: true });
      gov = withDemoCommitment(gov, vote.commitment);
      log.info(`demo: seeded an outstanding commit on ${DEMO_VAULTS.helios.slice(0, 10)}… pid ${DEMO_PID} — the salt is NOT retained, the agent must re-derive it`);
    }
    chainReader = createStubChainReader(DEMO_FIXTURE_CHAIN, gov);
    entryMarks = DEMO_ENTRY_MARKS;
  }

  const agent = createAgent({ config, account, payer, chainReader, log, env: process.env, fetchImpl: fetch, entryMarks });
  await agent.loop({ maxTicks: Number(args.ticks ?? 1) });
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
});
