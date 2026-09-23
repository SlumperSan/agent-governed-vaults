#!/usr/bin/env node
// @ts-check
/**
 * Builds the Sign-queue items for the FIRST Arc vault: `createVault` and `registerVault`, both
 * routed through the Arc creator Safe (`0x99e805294F1f1465C96f68e36264E99991Ef9E82`, SafeL2
 * v1.4.1, 1-of-1, sole owner the deployer EOA — `scripts/lib/launch-checks.mjs`'s `SAFE_ADDR`,
 * imported rather than re-typed, per that file's own "derived rather than copied" discipline) —
 * card 208, the exact routed-send shape `scripts/smoke-preflight.mjs`'s `requireIntendedCreator`/
 * `safeRoutingPlanRefusal` and `scripts/smoke-test.mjs`'s `routeThroughSafe` already implement for
 * the CLI smoke path. This builder produces the SAME inner calldata (via
 * `scripts/lib/vault-params.mjs`, shared with `smoke-test.mjs`) but signs with a PRE-VALIDATED
 * owner signature (`preValidatedSignature`, `scripts/lib/safe-exec.mjs`) instead of collecting a
 * real ECDSA signature — MetaMask itself, with `from` equal to the Safe owner, IS the
 * authorisation; see that function's own header for why this does not reopen MAJOR-1.
 *
 * `createVault`'s inner args are fully static (arc-deploy's CREATE addresses are deterministic
 * from nonce+deployer, independent of whether those deploys have been confirmed yet) and resolve
 * immediately. `registerVault`'s first argument is the vault address, which is NOT knowable until
 * `createVault` is actually mined — that item carries a `{{item:arc-first-vault-create.
 * log:VaultCreated.vault}}` template, resolved server-side by `scripts/lib/sign-queue-resolve.mjs`
 * once the dependency is `done`.
 *
 * Writes nothing to the chain — `cast` is used only for pure encoding (`calldata`) and one read
 * (the Safe's own `nonce()`, frozen the same way arc-deploy.mjs freezes the deployer nonce).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBuiltItems, readQueue, writeQueueAtomic } from '../lib/sign-queue.mjs';
import { CREATE_VAULT_SIG, REGISTER_VAULT_SIG } from '../smoke-preflight.mjs';
import { createVaultParamsTuple, registerVaultGovTuple } from '../lib/vault-params.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAST = process.env.CAST ?? 'cast';
const RPC = process.env.ARC_RPC ?? 'https://rpc.mainnet.arc.io';
const CHAIN_ID = 5042;
const CHAIN_NAME = 'Arc';
const OWNER = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
/** Not in any repo config — given by the owner, same source `scripts/lib/launch-checks.mjs`
 * documents at its own `SAFE_ADDR`. Duplicated as a literal (not imported) so this builder has no
 * import-time dependency on that module reading `contracts/config/deployments/base-sepolia.json`,
 * which is unrelated to Arc; `scripts/test/sign-queue.test.mjs` asserts the two literals agree. */
const SAFE_ADDR = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
export const BUILDER_NAME = 'first-vault';

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function readArcDeployItems() {
  const q = readQueue();
  const byId = Object.fromEntries(q.items.filter((it) => it.builder === 'arc-deploy').map((it) => [it.id, it]));
  for (const id of ['arc-oracle', 'arc-factory', 'arc-governance', 'arc-adapter']) {
    if (!byId[id]) throw new Error(`first-vault: arc-deploy item "${id}" not found in the queue — run arc-deploy.mjs first`);
  }
  // Prefer the CONFIRMED address once known; fall back to the frozen prediction, which is
  // deterministic (nonce+deployer) independent of confirmation.
  const addr = (it) => it.receipt?.contractAddress ?? it.predictedAddress;
  return {
    oracle: addr(byId['arc-oracle']), factory: addr(byId['arc-factory']),
    governance: addr(byId['arc-governance']), adapter: addr(byId['arc-adapter']),
  };
}

export function build() {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'config', 'arc-mainnet.json'), 'utf8'));
  const { oracle, factory, governance, adapter } = readArcDeployItems();
  const tokens = cfg.chainlinkOracle.assets.map((a) => a.asset); // basket: cirBTC alone on Arc
  const usdc = cfg.usdc;
  const smoke = cfg.smoke;

  const createParams = createVaultParamsTuple({
    usdc, tokens, oracle, capacityCapUsdc: smoke.capacityCapUsdc, minDepositUsdc: smoke.minDepositUsdc,
    exitFeeMaxBps: smoke.exitFeeMaxBps, exitFeeDecayPeriod: smoke.exitFeeDecayPeriod, adapters: [adapter],
  });
  const govTuple = registerVaultGovTuple(smoke.gov);

  const existing = readQueue();
  const existingCreate = existing.items.find((it) => it.builder === BUILDER_NAME && it.id === 'arc-first-vault-create');
  const baseSafeNonce = existingCreate
    ? existingCreate.dataTemplate?.safeNonce
    : Number(cast(['call', SAFE_ADDR, 'nonce()(uint256)', '--rpc-url', RPC]));
  if (!Number.isInteger(baseSafeNonce) || baseSafeNonce < 0) {
    throw new Error(`first-vault: unusable Safe nonce ${baseSafeNonce}`);
  }

  const createItem = {
    id: 'arc-first-vault-create', order: 101, chainId: CHAIN_ID, chainName: CHAIN_NAME,
    what: `Safe execTransaction: VaultFactory.createVault (basket ${tokens.join(', ')}, oracle ${oracle})`,
    from: OWNER, to: SAFE_ADDR, value: '0', data: null,
    dataTemplate: {
      kind: 'safe-exec', safe: SAFE_ADDR, to: factory, innerSig: CREATE_VAULT_SIG,
      innerArgsTemplate: [createParams], safeNonce: baseSafeNonce, safeOwner: OWNER,
    },
    dependsOn: ['arc-readback'], // arc-deploy's own non-signing read-back verification item
    status: 'pending', txHash: null, receipt: null, predictedAddress: null, expectedNonce: null,
    sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(), sentAt: null, doneAt: null,
    verifyNote: null, expectsSafeExecution: true,
    expectedLog: { event: 'VaultCreated', emitter: factory },
    // Cross-chain items (arc-deploy, base-sepolia finalize-12) do not depend on THIS builder's
    // own arc-deploy dependency check ever being satisfiable from a stale queue — recorded here so
    // the dashboard's precondition panel can show what this item assumes about the deploy.
    assumesArcDeploy: { oracle, factory, adapter },
  };

  const registerItem = {
    id: 'arc-first-vault-register', order: 102, chainId: CHAIN_ID, chainName: CHAIN_NAME,
    what: 'Safe execTransaction: Governance.registerVault(vault from the createVault log, gov config)',
    from: OWNER, to: SAFE_ADDR, value: '0', data: null,
    dataTemplate: {
      kind: 'safe-exec', safe: SAFE_ADDR, to: governance, innerSig: REGISTER_VAULT_SIG,
      innerArgsTemplate: ['{{item:arc-first-vault-create.log:VaultCreated.vault}}', govTuple],
      safeNonce: baseSafeNonce + 1, safeOwner: OWNER,
    },
    dependsOn: ['arc-first-vault-create'],
    status: 'pending', txHash: null, receipt: null, predictedAddress: null, expectedNonce: null,
    sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(), sentAt: null, doneAt: null,
    verifyNote: null, expectsSafeExecution: true,
    assumesArcDeploy: { governance },
  };

  return [createItem, registerItem];
}

function main() {
  const items = build();
  const existing = readQueue();
  const merged = mergeBuiltItems(existing.items, items, BUILDER_NAME);
  writeQueueAtomic({ items: merged });
  console.log(`first-vault: wrote/merged ${items.length} items into the Sign queue`);
  for (const it of items) console.log(`  ${it.order}. ${it.id} — ${it.what}`);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
