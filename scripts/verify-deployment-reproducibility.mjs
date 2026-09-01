#!/usr/bin/env node
// @ts-check
/**
 * Verify that every recorded on-chain deployment can still be SOURCE-VERIFIED: the
 * `sourceCommit` pinned in each `contracts/config/deployments/*.json` must still resolve in
 * this repo's git history, and must be reachable from the shared mainline
 * (`origin/protocol/main`) rather than only from a local or ephemeral ref that a `git gc`,
 * a rebase, or a force-push could make unreachable.
 *
 * WHY THIS EXISTS. `contracts/foundry.toml` sets no `bytecode_hash`, so solc's default `ipfs`
 * metadata mode applies, and the CBOR metadata trailer embeds an IPFS hash of the compiled
 * `sources` map, which is keyed by SOURCE PATH. Moving or renaming any file in a contract's
 * compiled dependency graph changes that trailer without changing a single opcode. Measured
 * 2026-09-01: on `protocol/main`, `ChainlinkOracle`'s compiled runtime bytecode diverges from
 * the deployed Base Sepolia bytecode (`0x6371E14C0682882e75E8382caf0216545B1f43C6`) in exactly
 * the 32-byte CBOR metadata hash — every other byte, including all four immutable-address
 * slots once masked, is identical. Building at the commit recorded as `sourceCommit` in the
 * deployment record (`5934ef22`) reproduces the deployed bytecode byte-for-byte, trailer
 * included. So HEAD reproducing a historical deployment is NOT guaranteed and must not be
 * assumed — only the exact pinned commit is guaranteed to. See docs/DEPLOYMENT.md's "Source
 * verification" section for the full reproduction procedure this script exists to protect.
 *
 * WHAT THIS SCRIPT DOES NOT DO. It does not rebuild anything and it does not touch an RPC. It
 * cannot and does not detect metadata drift itself — that is EXPECTED any time `contracts/`
 * changes under `ipfs` mode, and is not a defect. All it checks is whether the documented
 * reproduction recipe ("check out `sourceCommit`, build, verify") still has a commit to check
 * out. That is cheap, offline, and the one thing that actually rots silently: a `sourceCommit`
 * can be lost to a rebase or a pruned branch long after the deployment it describes is still
 * live and needs re-verifying.
 *
 * Exit 0 = every deployment record's `sourceCommit` resolves locally AND is an ancestor of
 *          `origin/protocol/main` (or ancestry could not be checked because no such ref is
 *          configured here — reported as an advisory NOTE, never a failure, since a shallow
 *          clone or a sandboxed CI checkout may not carry it).
 * Exit 1 = a `sourceCommit` does not resolve in local git history at all (unrecoverable), or it
 *          resolves but is NOT an ancestor of `origin/protocol/main` (recoverable only by
 *          re-recording a commit that IS on the shared mainline).
 *
 * Env: DEPLOYMENT_MAINLINE_REF (default origin/protocol/main)
 * Run: node scripts/verify-deployment-reproducibility.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentRecord, anyHardFail, formatResultLine } from './lib/deployment-reproducibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENTS_DIR = path.join(ROOT, 'contracts', 'config', 'deployments');
const MAINLINE_REF = process.env.DEPLOYMENT_MAINLINE_REF ?? 'origin/protocol/main';
const JSON_OUT = process.argv.includes('--json');

/** @param {string[]} args */
function gitOk(args) {
  try {
    execFileSync('git', args, {cwd: ROOT, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function findDeploymentFiles() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) return [];
  return fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(DEPLOYMENTS_DIR, f))
    .sort();
}

const files = findDeploymentFiles();
const haveMainline = gitOk(['rev-parse', '--verify', '--quiet', `${MAINLINE_REF}^{commit}`]);

const results = files.map((file) => {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return checkDeploymentRecord(cfg, {
    gitResolves: (commit) => gitOk(['cat-file', '-e', `${commit}^{commit}`]),
    gitIsAncestor: (commit) => gitOk(['merge-base', '--is-ancestor', commit, MAINLINE_REF]),
    haveMainline,
    fallbackChainName: path.basename(file, '.json'),
  });
});

const hardFail = anyHardFail(results);

if (JSON_OUT) {
  console.log(JSON.stringify({mainlineRef: MAINLINE_REF, haveMainline, results}, null, 2));
} else {
  console.log(`verify-deployment-reproducibility: checking ${files.length} deployment record(s)`);
  if (!haveMainline) {
    console.log(
      `  NOTE: ${MAINLINE_REF} is not resolvable here (no remote configured / not fetched). ` +
        `Ancestry cannot be checked -- resolution-in-local-history is still enforced.`
    );
  }
  for (const r of results) console.log(formatResultLine(r));
}

process.exit(hardFail ? 1 : 0);
