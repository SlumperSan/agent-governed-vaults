#!/usr/bin/env node
// @ts-check
/**
 * Mutation-tests the Sign queue's most security-critical guards: for each, reintroduce the exact
 * defect the guard exists to catch, confirm the relevant test file goes RED, restore the source,
 * confirm it goes GREEN again. Prints a markdown table for the PR body.
 *
 * NOT part of `npm run gate` or `scripts/test/*.test.mjs` — it PATCHES source files on disk
 * (reverted before it exits, including on failure) and is meant to be run once, by hand, from a
 * worktree with no other uncommitted changes: `node scripts/mutation-sign-queue.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runTest(file) {
  try {
    execFileSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return 'green';
  } catch {
    return 'red';
  }
}

/** @type {{name: string, file: string, target: string, from: string, to: string}[]} */
const MUTATIONS = [
  {
    name: 'verifyReceipt: tx.from mismatch check disarmed (skip the comparison)',
    file: 'scripts/lib/sign-queue.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: "if (normAddr(tx.from) !== normAddr(item.from)) {\n    return `tx.from is ${tx.from}, item.from is ${item.from}`;\n  }",
    to: 'if (false) { return "unreachable"; }',
  },
  {
    name: 'verifyReceipt: input/sentData comparison disarmed',
    file: 'scripts/lib/sign-queue.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: "if (normAddr(tx.input) !== normAddr(item.sentData)) {\n    return 'tx.input does not match the data this server resolved and sent to the browser at send time';\n  }",
    to: '// disarmed',
  },
  {
    name: 'verifyReceipt: CREATE contractAddress-vs-predicted comparison disarmed',
    file: 'scripts/lib/sign-queue.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: 'if (item.predictedAddress && normAddr(receipt.contractAddress) !== normAddr(item.predictedAddress)) {',
    to: 'if (false) {',
  },
  {
    name: 'verifyReceipt: status!=1 (reverted) is treated as success',
    file: 'scripts/lib/sign-queue.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: "const statusOk = receipt.status === '0x1' || receipt.status === 1;",
    to: 'const statusOk = true;',
  },
  {
    name: 'mergeBuiltItems: the sent/done-item-refuses-a-changed-field guard removed (silently overwrites instead)',
    file: 'scripts/lib/sign-queue.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: "if (prev.status === 'pending') { out.push(next); continue; }",
    to: "out.push(next); continue;",
  },
  {
    name: 'preValidatedSignature: v byte changed from 0x01 (approved-hash) to 0x00 (contract-signature branch)',
    file: 'scripts/lib/safe-exec.mjs', target: 'scripts/test/sign-queue.test.mjs',
    from: "const v = '01';",
    to: "const v = '00';",
  },
  {
    name: 'arc-deploy.mjs: VaultFactory allowSubVaults flipped from false to true (DeployTestnet shape, not Deploy.s.sol)',
    file: 'scripts/sign-queue/arc-deploy.mjs', target: 'scripts/test/arc-deploy-order.test.mjs',
    from: "subRegItem.predictedAddress, vaultDeployerItem.predictedAddress, false, `[${oracleAddr}]`],",
    to: "subRegItem.predictedAddress, vaultDeployerItem.predictedAddress, true, `[${oracleAddr}]`],",
  },
  {
    // V-381-r1-8083f497 mutation S1: "advanceSentItems marks done WITHOUT calling verifyReceipt"
    // kept 38/38 of #381's original tests green. This is that exact mutation, now caught.
    name: 'advanceSentItems: verifyReceipt call removed — a matching from/to but WRONG input would confirm (V-381-r1 mutation S1)',
    file: 'scripts/lib/sign-queue-server.mjs', target: 'scripts/test/sign-queue-server.test.mjs',
    from: 'const reason = verifyReceipt({ item, tx: txR.result, receipt });',
    to: 'const reason = null;',
  },
  {
    name: 'originGateRefusal: the Origin/Host/Content-Type gate disarmed (always passes) — the CSRF fix from V-381-r1',
    file: 'scripts/lib/sign-queue-server.mjs', target: 'scripts/test/sign-queue-server.test.mjs',
    from: 'export function originGateRefusal(headers, port) {',
    to: 'export function originGateRefusal(headers, port) { return null;',
  },
];

const results = [];
for (const mut of MUTATIONS) {
  const filePath = path.join(ROOT, mut.file);
  const original = readFileSync(filePath, 'utf8');
  if (!original.includes(mut.from)) {
    results.push({ ...mut, error: `pattern not found in ${mut.file} — mutation script is stale` });
    continue;
  }
  const mutated = original.replace(mut.from, mut.to);
  writeFileSync(filePath, mutated, 'utf8');
  const redResult = runTest(path.join(ROOT, mut.target));
  writeFileSync(filePath, original, 'utf8'); // ALWAYS restore before checking the result
  const greenResult = runTest(path.join(ROOT, mut.target));
  results.push({ ...mut, redResult, greenResult });
}

console.log('\n| mutation | defect introduced | restored |');
console.log('|---|---|---|');
for (const r of results) {
  if (r.error) { console.log(`| ${r.name} | ERROR: ${r.error} | — |`); continue; }
  console.log(`| ${r.name} | ${r.redResult.toUpperCase()} | ${r.greenResult.toUpperCase()} |`);
}
const ok = results.every((r) => !r.error && r.redResult === 'red' && r.greenResult === 'green');
console.log(ok ? '\nALL MUTATIONS CONFIRMED (each went red, each restored to green).' : '\nSOME MUTATIONS DID NOT BEHAVE AS EXPECTED — see table above.');
process.exit(ok ? 0 : 1);
