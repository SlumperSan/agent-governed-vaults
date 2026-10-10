#!/usr/bin/env node
// @ts-check
/**
 * GOVERNANCE PREFLIGHT — refuse loudly, before any drill starts, if the soak's target vault
 * already carries a stalled proposal.
 *
 * Measured: track B failed at drill 2 with "the parent already has proposal 11 in status Active —
 * settle it first". Diagnosis from chain (Governance `0xD963f553e3eCd1872aF1622b3e4664f133A51805`,
 * `proposals(11)` on the smoke vault `0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98`): created
 * 2026-09-09 21:49:20Z, reveal deadline 23:49:20Z the same day — twelve days before this was
 * caught — status still Active, revealedVoterCount 0. A run proposed, aborted between propose and
 * reveal, and nothing ever called `finalize`. `activeProposalOf` never clears on settlement
 * (see the comment on `votableNow` in `lib.mjs`), and governance serializes per vault, so every
 * drill against that vault was blocked from then on. This is the same shape as `START_BLOCK`
 * defaulting to 0 and `-Stop` losing track of reused services: the script leaves state behind
 * that it does not know about, and the next run inherits it, silently, until something deep in a
 * drill reverts with a message that names the symptom rather than the fix.
 *
 * This script checks ONE vault: `soak-vaults.json`'s `smokeVault.address` — the only vault whose
 * address is known BEFORE any drill runs (vault B and the child vault are created at runtime by
 * drill 1 / drill 2, which already carry their own blocking checks for the address they just
 * created; there is nothing for a startup preflight to point at before that).
 *
 * Exit 0 = clear to proceed (nothing active, or the existing proposal is settled). Exit 1 = refuse,
 * after printing the diagnosis and, where one exists, the exact one-line remedy — `finalize` and
 * `markExpired` are both `external` and callable by ANY account, so the remedy needs no special
 * key, only gas. Nothing here ever sends a transaction: broadcasting on the operator's behalf,
 * even to clear the script's own mess, is exactly the thing this script must not silently do.
 *
 * Env: SOAK_RPC (or BASE_SEPOLIA_RPC), SOAK_DEPLOYMENT, SOAK_SIGNER_ARGS (optional — used only to
 *      print a remedy command that will actually run as-is; the check itself needs no key).
 * Run:  node scripts/soak/preflight-governance.mjs
 * Exit: 0 clear to proceed. Non-zero otherwise — either this refuses deliberately (a blocking
 *       proposal, printed above) or the check itself could not complete (bad RPC/config, an
 *       `assert()`/thrown Error from `lib.mjs` or `deployment.mjs`) — never a silent "assume
 *       clear" on the latter, the same reasoning as every `assert()` elsewhere in this suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, RPC, log, cast, callU, readProposal, chainNow, proposalPreflightVerdict } from './lib.mjs';
import { assertLiveChainId, deploymentPath, loadDeployment } from './deployment.mjs';

/**
 * Read `activeProposalOf(vault)` and score it. Separated from `main()` so a test can call it with
 * an injected `now`/`governance`/reader — see `scripts/test/soak-governance-preflight.test.mjs`.
 * @param {string} vault
 * @param {{governance: string, now: number, readActive?: (governance: string, vault: string) => bigint, read?: (governance: string, pid: string) => any}} ctx
 */
export function checkVault(vault, { governance, now, readActive = callU, read = readProposal }) {
  const pid = readActive(governance, 'activeProposalOf(address)(uint256)', vault);
  const p = pid === 0n ? null : read(governance, pid.toString());
  return { pid, verdict: proposalPreflightVerdict(p, { now, pid: pid.toString() }) };
}

function main() {
  const dep = loadDeployment(deploymentPath(ROOT));
  assertLiveChainId(dep, Number(cast(['chain-id', '--rpc-url', RPC])));

  const soak = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'soak', 'soak-vaults.json'), 'utf8'));
  const vault = soak.smokeVault.address;

  log(`governance preflight: vault=${vault} governance=${dep.governance} rpc=${RPC}`);

  const now = chainNow();
  const { pid, verdict } = checkVault(vault, { governance: dep.governance, now });

  if (!verdict.blocking) {
    log(`OK — ${verdict.message}`);
    process.exit(0);
  }

  console.error(`\n[soak] GOVERNANCE PREFLIGHT REFUSED — vault ${vault}\n`);
  console.error(verdict.message);
  if (verdict.remedyFn) {
    const signerArgs = process.env.SOAK_SIGNER_ARGS
      || '--account <your-account> --password-file <your-password-file>';
    console.error(`\nRemedy — this is "${verdict.remedyFn}", external and callable by ANY funded`
      + ` account, not just the deployer's:\n`);
    console.error(`  cast send ${dep.governance} "${verdict.remedyFn}" ${pid} --rpc-url ${RPC} ${signerArgs}\n`);
  } else {
    console.error('');
  }
  process.exit(1);
}

// fileURLToPath, not a raw string compare against import.meta.url: a checkout path containing a
// space (or, on Windows, backslashes vs. forward slashes) makes a literal string comparison fail
// even when this IS the entrypoint — the same reasoning lib.mjs's ROOT constant gives.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
