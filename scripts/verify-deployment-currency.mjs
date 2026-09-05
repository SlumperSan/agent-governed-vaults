#!/usr/bin/env node
// @ts-check
/**
 * Verify that every recorded on-chain deployment is still CURRENT with the mainline: that
 * `contracts/src` has not moved since the `sourceCommit` pinned in each
 * `contracts/config/deployments/*.json`.
 *
 * WHY THIS EXISTS. Launch gates 2 (testnet lifecycle), 3 (soak drills) and 6 (canary) in
 * `docs/LAUNCH-READINESS.md` are earned by exercising a LIVE deployment. Every `contracts/src`
 * merge silently invalidates them, and nothing in the repo noticed — `verify-deployment-
 * reproducibility.mjs` deliberately asks a different question (can the deployment still be
 * source-verified), and its own header says it does not answer this one.
 *
 * THE TRAP THIS EXISTS TO CLOSE. Comparing the SINGLETON contracts' codesizes gives a false
 * all-clear. `VaultFactory`, `Governance`, `FeeEngine` and the rest do not change when
 * `VaultCore` does, because the vault's code is not inside any of them: `VaultDeployer` pins it
 * as two SSTORE2 chunks (`codeChunkA`/`codeChunkB`, `contracts/src/VaultDeployer.sol:28-39`) and
 * stamps each new vault from those bytes. The singletons can be byte-identical while every vault
 * the factory creates is a stale `VaultCore`. So this script measures the chunks, not the
 * singletons.
 *
 * TWO INDEPENDENT CHECKS.
 *   1. git (default, offline, deterministic) -- `contracts/src` diff between each record's
 *      `sourceCommit` and the mainline. Any changed path = BEHIND.
 *   2. on-chain (`--onchain`, opt-in) -- read `VaultDeployer.codeChunkA/B` over a read-only RPC,
 *      measure the pinned `VaultCore` creation code, and compare against the locally built
 *      artifact. Read-only `eth_call`/`eth_getCode` only; this script never sends a transaction,
 *      never needs a key, and never broadcasts. Requires `forge build` to have run.
 *      A size MATCH is reported as "consistent", never "verified" -- two builds can coincide in
 *      length. A MISMATCH is conclusive.
 *
 * Exit 0 = every deployment record's `contracts/src` is unchanged since its `sourceCommit`, or
 *          currency could not be checked (no pinned commit, unresolvable commit, or no mainline
 *          ref -- each reported as a NOTE, never a failure; those are
 *          `verify-deployment-reproducibility`'s failures, not this script's).
 * Exit 1 = at least one deployment is BEHIND the mainline. Gates resting on it are stale.
 *
 * Env: DEPLOYMENT_MAINLINE_REF (default origin/protocol/main), DEPLOYMENT_RPC_URL (overrides the
 *      record's own `rpc` field for --onchain)
 * Run: node scripts/verify-deployment-currency.mjs [--json] [--onchain]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDeploymentCurrency,
  compareVaultCoreChunks,
  anyHardFail,
  formatResultLine,
} from './lib/deployment-currency.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENTS_DIR = path.join(ROOT, 'contracts', 'config', 'deployments');
const VAULTCORE_ARTIFACT = path.join(ROOT, 'contracts', 'out', 'VaultCore.sol', 'VaultCore.json');
const MAINLINE_REF = process.env.DEPLOYMENT_MAINLINE_REF ?? 'origin/protocol/main';
const JSON_OUT = process.argv.includes('--json');
const ONCHAIN = process.argv.includes('--onchain');

/**
 * `codeChunkA()` / `codeChunkB()` selectors. Both take no arguments, so the call data is the bare
 * selector and no ABI encoder is needed. Hard-coded rather than hashed at runtime to keep this
 * script dependency-free; `scripts/test/deployment-currency.test.mjs` pins them against `cast sig`
 * when foundry is available, so a rename of either getter fails the test rather than silently
 * turning every on-chain read into a revert.
 */
const CHUNK_SELECTORS = {codeChunkA: '0x95521d34', codeChunkB: '0x83944efa'};

/** @param {string[]} args */
function gitOk(args) {
  try {
    execFileSync('git', args, {cwd: ROOT, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

/** @param {string[]} args */
function gitOut(args) {
  return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'});
}

function findDeploymentFiles() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
  return fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(DEPLOYMENTS_DIR, f))
    .sort();
}

/** @param {string} url @param {object} body */
async function rpc(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, ...body}),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}

/** Read-only: resolve VaultDeployer's two pinned chunks and measure their deployed code. */
async function measurePinnedChunks(url, vaultDeployer) {
  const sizes = [];
  for (const sel of [CHUNK_SELECTORS.codeChunkA, CHUNK_SELECTORS.codeChunkB]) {
    const word = await rpc(url, {method: 'eth_call', params: [{to: vaultDeployer, data: sel}, 'latest']});
    const addr = '0x' + word.slice(-40);
    const code = await rpc(url, {method: 'eth_getCode', params: [addr, 'latest']});
    sizes.push({address: addr, bytes: (code.length - 2) / 2});
  }
  return sizes;
}

function localVaultCoreCreationBytes() {
  if (!fs.existsSync(VAULTCORE_ARTIFACT)) return null;
  const artifact = JSON.parse(fs.readFileSync(VAULTCORE_ARTIFACT, 'utf8'));
  const object = artifact?.bytecode?.object;
  if (typeof object !== 'string') return null;
  return object.replace(/^0x/, '').length / 2;
}

const files = findDeploymentFiles();
const haveMainline = gitOk(['rev-parse', '--verify', '--quiet', `${MAINLINE_REF}^{commit}`]);

const results = files.map((file) => {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return checkDeploymentCurrency(cfg, {
    gitResolves: (commit) => gitOk(['cat-file', '-e', `${commit}^{commit}`]),
    changedSourcePaths: (commit) =>
      gitOut(['diff', '--name-only', `${commit}..${MAINLINE_REF}`, '--', 'contracts/src'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    haveMainline,
    mainlineRef: MAINLINE_REF,
    fallbackChainName: path.basename(file, '.json'),
  });
});

/** @type {Record<string, unknown>} */
const onchain = {};
if (ONCHAIN) {
  const localBytes = localVaultCoreCreationBytes();
  for (const file of files) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = cfg.chainName ?? path.basename(file, '.json');
    const url = process.env.DEPLOYMENT_RPC_URL ?? cfg.rpc;
    const vaultDeployer = cfg?.singletons?.VaultDeployer;
    if (!url || !vaultDeployer) {
      onchain[name] = {skipped: 'no rpc url or no VaultDeployer in record'};
      continue;
    }
    if (localBytes === null) {
      onchain[name] = {skipped: 'contracts/out/VaultCore.sol/VaultCore.json missing — run `forge build`'};
      continue;
    }
    try {
      const chunks = await measurePinnedChunks(url, vaultDeployer);
      onchain[name] = {
        vaultDeployer,
        chunks,
        ...compareVaultCoreChunks(
          chunks.map((c) => c.bytes),
          localBytes,
        ),
      };
    } catch (err) {
      onchain[name] = {skipped: `rpc read failed: ${err.message}`};
    }
  }
}

const hardFail = anyHardFail(results);

if (JSON_OUT) {
  console.log(JSON.stringify({mainlineRef: MAINLINE_REF, haveMainline, results, onchain}, null, 2));
} else {
  console.log(`verify-deployment-currency: checking ${files.length} deployment record(s) against ${MAINLINE_REF}`);
  if (!haveMainline) {
    console.log(
      `  NOTE: ${MAINLINE_REF} is not resolvable here (no remote configured / not fetched). ` +
        `Currency cannot be checked -- reported, not failed.`,
    );
  }
  for (const r of results) {
    console.log(formatResultLine(r));
    for (const note of r.notes) console.log(`  NOTE: ${note}`);
  }
  for (const [name, o] of Object.entries(onchain)) {
    if (o.skipped) {
      console.log(`  onchain ${name}: SKIP (${o.skipped})`);
    } else {
      const verdict = o.match ? 'consistent (size match is not proof of equality)' : 'MISMATCH — deployed VaultCore is not this build';
      console.log(
        `  onchain ${name}: pinned VaultCore creation code ${o.pinnedBytes} B vs local ${o.localBytes} B ` +
          `(delta ${o.delta}) — ${verdict}`,
      );
    }
  }
}

process.exit(hardFail ? 1 : 0);
