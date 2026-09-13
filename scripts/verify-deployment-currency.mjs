#!/usr/bin/env node
// @ts-check
/**
 * Verify that every recorded on-chain deployment is still CURRENT with the mainline: that
 * `contracts/src` has not moved since the `sourceCommit` pinned in each
 * `contracts/config/deployments/*.json`.
 *
 * WHY THIS EXISTS. Launch gates 2 (testnet lifecycle), 3 (soak drills) and 6 (canary) in
 * `docs/LAUNCH-READINESS.md` are earned by exercising a LIVE deployment. Every `contracts/src`
 * merge silently invalidates them, and nothing in the repo noticed —
 * `verify-deployment-reproducibility.mjs` deliberately asks a different question (can the
 * deployment still be source-verified), and its own header says it does not answer this one.
 *
 * THE TRAP THIS EXISTS TO CLOSE — twice over.
 *   1. Comparing the SINGLETON contracts' codesizes gives a false all-clear. `VaultFactory`,
 *      `Governance`, `FeeEngine` and the rest do not change when `VaultCore` does, because the
 *      vault's code is not inside any of them: `VaultDeployer` pins it as two SSTORE2 chunks
 *      (`codeChunkA`/`codeChunkB`) and stamps each new vault from those bytes. So this script
 *      measures the chunks, not the singletons.
 *   2. Comparing the CHUNKS' sizes gives a false all-clear too, and that one is live right now.
 *      solc's CBOR metadata trailer is fixed length, so a source change that alters nothing but a
 *      license string still changes the bytes while leaving the length alone. This script
 *      therefore compares BYTES; see `scripts/lib/deployment-currency.mjs` for the measurement.
 *
 * TWO INDEPENDENT CHECKS.
 *   1. git (default, offline, deterministic) -- `contracts/src` diff between each record's
 *      `sourceCommit` and the mainline. Any changed path = BEHIND, and that sets the exit code.
 *   2. on-chain (`--onchain`, opt-in) -- read `VaultDeployer.codeChunkA/B` over a read-only RPC,
 *      reassemble the pinned `VaultCore` creation code from the chunks' deployed code, and compare
 *      it byte for byte against the locally built artifact. Read-only `eth_call`/`eth_getCode`
 *      only; this script never sends a transaction, never needs a key, and never broadcasts.
 *      Requires `forge build` to have run. Reported, never exit-code-bearing: it depends on a
 *      network and on a local build tree, and a check that turns red when an RPC rate-limits is a
 *      check people learn to ignore.
 *
 * WHY THE GATE RUNS THIS ADVISORY. `scripts/gate.mjs` and `.github/workflows/ci.yml` run it
 * without letting it fail the build, and that is a deliberate, narrow decision: BOTH recorded
 * deployments are behind the mainline TODAY, by a BUSL-1.1 -> MIT relicense that touched all 19
 * `contracts/src` files. Hard-failing would turn `protocol/main` red for every contributor over a
 * fact no pull request can fix — the remedy is a redeploy, which is an owner action under
 * `docs/SWARM.md` section 10. The exit code below is still the script's contract, so the day the
 * records are refreshed this can be flipped to blocking by deleting one `advisory: true`. The
 * BLOCKING half of this issue lives in `scripts/test/deployment-currency.test.mjs`, which
 * `npm run test:backend` already globs.
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
  formatOnchainLine,
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
const CHUNK_SELECTORS = { codeChunkA: '0x95521d34', codeChunkB: '0x83944efa' };

/** @param {string[]} args */
function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** @param {string[]} args */
function gitOut(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function findDeploymentFiles() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
  return fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(DEPLOYMENTS_DIR, f))
    .sort();
}

/** @param {string} url @param {{method:string, params:unknown[]}} body */
async function rpc(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}

/**
 * Read-only: resolve VaultDeployer's two pinned chunks and return their DEPLOYED CODE, not their
 * length. The length is what a size comparison would have used, and the length is the thing that
 * agrees while the bytes disagree.
 * @param {string} url @param {string} vaultDeployer
 */
async function readPinnedChunks(url, vaultDeployer) {
  const chunks = [];
  for (const sel of [CHUNK_SELECTORS.codeChunkA, CHUNK_SELECTORS.codeChunkB]) {
    const word = await rpc(url, { method: 'eth_call', params: [{ to: vaultDeployer, data: sel }, 'latest'] });
    const address = '0x' + String(word).slice(-40);
    const code = await rpc(url, { method: 'eth_getCode', params: [address, 'latest'] });
    if (!code || code === '0x') throw new Error(`chunk ${address} has no code`);
    chunks.push({ address, code: String(code) });
  }
  return chunks;
}

function localVaultCoreCreationCode() {
  if (!fs.existsSync(VAULTCORE_ARTIFACT)) return null;
  const artifact = JSON.parse(fs.readFileSync(VAULTCORE_ARTIFACT, 'utf8'));
  const object = artifact?.bytecode?.object;
  return typeof object === 'string' ? object : null;
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

/** @type {Record<string, Record<string, unknown>>} */
const onchain = {};
if (ONCHAIN) {
  const localCode = localVaultCoreCreationCode();
  for (const file of files) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    // KEYED BY FILE, NOT BY `chainName`. Two records on `protocol/main` both declare
    // `"chainName": "robinhood-mainnet"` (the protocol deployment and the RWLY one), so keying this
    // map by chain name let the second record's SKIP overwrite the first record's completed
    // comparison -- the on-chain leg then reported SKIP for a deployment it had just read and found
    // mismatched. A result silently replaced by a SKIP is the same fail-open shape this script
    // exists to close, so the unique thing (the filename) is the key and the chain name is display.
    const name = `${path.basename(file, '.json')}${cfg.chainName ? ` (${cfg.chainName})` : ''}`;
    const url = process.env.DEPLOYMENT_RPC_URL ?? cfg.rpc;
    const vaultDeployer = cfg?.singletons?.VaultDeployer;
    if (!url || !vaultDeployer) {
      onchain[name] = { skipped: 'no rpc url or no VaultDeployer in record' };
      continue;
    }
    if (localCode === null) {
      onchain[name] = { skipped: 'contracts/out/VaultCore.sol/VaultCore.json missing — run `forge build`' };
      continue;
    }
    try {
      const chunks = await readPinnedChunks(url, vaultDeployer);
      onchain[name] = {
        vaultDeployer,
        chunks: chunks.map((c) => ({ address: c.address, bytes: (c.code.length - 2) / 2 })),
        ...compareVaultCoreChunks(
          chunks.map((c) => c.code),
          localCode,
        ),
      };
    } catch (err) {
      onchain[name] = { skipped: `rpc read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

const hardFail = anyHardFail(results);

if (JSON_OUT) {
  console.log(JSON.stringify({ mainlineRef: MAINLINE_REF, haveMainline, results, onchain }, null, 2));
} else {
  console.log(`verify-deployment-currency: checking ${files.length} deployment record(s) against ${MAINLINE_REF}`);
  if (!haveMainline) {
    console.log(
      `  NOTE: ${MAINLINE_REF} is not resolvable here (no remote configured / not fetched). ` +
        'Currency cannot be checked -- reported, not failed.',
    );
  }
  for (const r of results) {
    console.log(formatResultLine(r));
    for (const note of r.notes) console.log(`  NOTE: ${note}`);
  }
  for (const [name, o] of Object.entries(onchain)) {
    console.log(formatOnchainLine(name, /** @type {any} */ (o)));
  }
}

process.exit(hardFail ? 1 : 0);
