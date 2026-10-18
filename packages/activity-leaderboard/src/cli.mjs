#!/usr/bin/env node
// @ts-check
/**
 * Compute one epoch's activity leaderboard from chain logs.
 *
 *   node packages/activity-leaderboard/src/cli.mjs --chain arc --epoch 0 \
 *        [--rpc <url>] [--vault <address>@<fromBlock>]... [--anchor <unixSeconds>] \
 *        [--epoch current] [--now <unixSeconds>] [--out <dir>] [--window <blocks>] [--confirmations <n>]
 *
 * It reads the chain and writes nothing unless `--out` is given. It hands the result to the
 * publisher, which prints a dry run unless LEADERBOARD_PUBLISH=yes (see publish.mjs). No keys, no
 * transactions: every call is a read.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS, EPOCH_ANCHOR } from './chains.mjs';
import { createChainReader } from './source.mjs';
import { runEpoch } from './run.mjs';
import { filesFor, publish } from './publish.mjs';
import { sha256Hex } from './canonical.mjs';
import { epochOf } from './epoch.mjs';
import { validateSeededAddressesDoc } from '../../../scripts/lib/seeded-addresses.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function parseArgs(argv) {
  const o = { chain: [], vault: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (k === 'chain' || k === 'vault') o[k].push(v); else o[k] = v;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const keys = o.chain.length ? o.chain : Object.keys(CHAINS);
  const nowSec = o.now !== undefined ? Number(o.now) : Math.floor(Date.now() / 1000);
  const anchor = o.anchor !== undefined ? Number(o.anchor) : EPOCH_ANCHOR;
  if (anchor === null || !Number.isSafeInteger(anchor)) {
    throw new Error('no epoch anchor: no registered-agent vault is configured yet. For a dry run pass --anchor <unix seconds of the vault deploy block> and --vault <address>@<fromBlock>.');
  }
  const epochNumber = o.epoch === 'current' ? epochOf(anchor, nowSec) : Number(o.epoch);
  if (o.epoch === undefined) throw new Error('--epoch <n|current> is required');

  const raw = readFileSync(path.join(REPO, 'docs', 'seeded-addresses.json'));
  const seededDoc = JSON.parse(raw.toString('utf8'));
  const valid = validateSeededAddressesDoc(seededDoc);
  if (!valid.ok) throw new Error(`docs/seeded-addresses.json is invalid: ${valid.errors.join('; ')}`);

  const chains = [];
  for (const key of keys) {
    const cfg = CHAINS[key];
    if (!cfg) throw new Error(`unknown chain ${key}`);
    const vaults = o.vault.length
      ? o.vault.map((s) => { const [address, fromBlock] = s.split('@'); return { address: address.toLowerCase(), fromBlock: Number(fromBlock) }; })
      : cfg.vaults;
    const rpcUrl = o.rpc ?? cfg.rpcs[0];
    if (!rpcUrl) throw new Error(`no RPC endpoint recorded for ${key}; pass --rpc`);
    const reader = createChainReader({
      rpcUrl,
      chainId: cfg.chainId,
      ...(o.window ? { windowBlocks: Number(o.window) } : {}),
      ...(o.confirmations ? { confirmations: Number(o.confirmations) } : {}),
    });
    await reader.assertBoundToDeclaredChain();
    chains.push({ chainId: cfg.chainId, name: cfg.name, vaults, deployers: cfg.deployer ? [cfg.deployer] : [], reader });
  }

  const codeCommit = o['code-commit'] ?? execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { board, diagnostics } = await runEpoch({
    chains, anchor, epochNumber, nowSec, seededDoc, seededSha256: sha256Hex(raw), codeCommit,
  });

  const files = filesFor(board);
  if (o.out) {
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(o.out, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  const result = publish({ repoDir: REPO, files, message: `leaderboard epoch ${epochNumber} ${board.contentSha256.slice(0, 12)}` });
  console.log(JSON.stringify({
    epoch: board.epoch,
    contentSha256: board.contentSha256,
    chains: board.chains.map((c) => ({ name: c.name, toBlock: c.toBlock, rows: c.rows.length })),
    globalRows: board.global.rows.length,
    diagnostics,
    publish: result,
  }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
