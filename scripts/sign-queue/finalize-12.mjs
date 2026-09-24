#!/usr/bin/env node
// @ts-check
/**
 * Builds the ONE Sign-queue item for `Governance.finalize(12)` on Base Sepolia — a single,
 * static, dependency-free transaction. Server-side preconditions (checked live, in
 * `scripts/dashboard.mjs`, never baked in here): the `to` address reads as the Governance
 * recorded in `contracts/config/deployments/base-sepolia.json`, and proposal 12 is `Active` and
 * past `revealDeadline` on the chain's OWN clock — `Governance.finalize`'s exact precondition
 * (`Governance.sol:577-579`), the same predicate `scripts/lib/launch-checks.mjs`'s
 * `checkStaleProposal` already reads for its dashboard row, and `scripts/lib/proposal-decode.mjs`
 * is reused here rather than re-deriving the tuple layout.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mergeBuiltItems, readQueue, writeQueueAtomic } from '../lib/sign-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAST = process.env.CAST ?? 'cast';
export const BUILDER_NAME = 'finalize-12';
const PROPOSAL_ID = 12;

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', windowsHide: true }).trim();
}

export function build() {
  const dep = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'), 'utf8'));
  const governance = dep.singletons.Governance;
  const from = dep.deployer; // Governance.finalize has no caller restriction, but the owner's own
  // EOA is who signs everything else in this queue and who this precondition panel is written for.
  const data = cast(['calldata', 'finalize(uint256)', String(PROPOSAL_ID)]);

  return [{
    id: 'base-sepolia-finalize-12', order: 1, chainId: dep.chainId, chainName: 'Base Sepolia',
    what: `Governance.finalize(${PROPOSAL_ID}) — settle the stale proposal blocking the soak`,
    from, to: governance, value: '0', data, dataTemplate: null, dependsOn: [],
    status: 'pending', txHash: null, receipt: null, predictedAddress: null, expectedNonce: null,
    sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(), sentAt: null, doneAt: null,
    verifyNote: null, proposalId: PROPOSAL_ID, governanceAddr: governance,
  }];
}

function main() {
  const items = build();
  const existing = readQueue();
  const merged = mergeBuiltItems(existing.items, items, BUILDER_NAME);
  writeQueueAtomic({ items: merged });
  console.log(`finalize-12: wrote/merged ${items.length} item(s) into the Sign queue`);
  for (const it of items) console.log(`  ${it.order}. ${it.id} — ${it.what}`);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
