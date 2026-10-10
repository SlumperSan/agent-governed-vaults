#!/usr/bin/env node
// @ts-check
/**
 * Build a Safe{Wallet} Transaction Builder batch JSON file for the owner to import at
 * app.safe.global ("Drag and drop a JSON file", CreateTransactions.tsx) — the card: owner signs the
 * first vault through app.safe.global on Arc 5042 with MetaMask.
 *
 * TWO SEPARATE INVOCATIONS, TWO SEPARATE FILES, TWO SEPARATE SAFE TRANSACTIONS:
 *
 *   node scripts/build-safe-tx-builder.mjs createVault
 *   node scripts/build-safe-tx-builder.mjs registerVault --vault 0x...   (run AFTER createVault mines)
 *
 * WHY NOT ONE BATCHED FILE. Transaction Builder proposes a batch of 2+ transactions through Safe's
 * MultiSend (`sdk.txs.send({txs})`, safe-global/safe-apps-sdk commit
 * `139fa4fc222e068f32f7627a99a057ea6c51f8a4`, `packages/safe-apps-sdk/src/txs/index.ts` — it forwards
 * the raw `txs` array unchanged; the MultiSend-vs-direct-call decision is the HOST's, made in
 * safe-wallet-web, not in this SDK or in this script). `VaultFactory.createVault` is PERMISSIONLESS
 * (contracts/src/VaultFactory.sol:187) and assigns no CREATE2 salt tied to the Safe, so a
 * `registerVault` step encoded ahead of time against a PREDICTED vault address could be raced by
 * anyone else's `createVault` call landing first — the predicted address the batch was built for
 * might never be the one that actually gets created, or might belong to a different creator by the
 * time `registerVault` runs. The safe, unbeatable sequence this script enforces by construction:
 *
 *   1. Import and sign the `createVault` file alone. Wait for it to mine.
 *   2. Read the REAL emitted vault address back from the chain (VaultCreated's `vault` topic, or
 *      `cast logs`/a block explorer).
 *   3. Run this script AGAIN with `registerVault --vault <that address>`. It VERIFIES on-chain,
 *      before emitting anything, that `vault.creator()` really is the declared Safe and that the
 *      vault is present in the factory's `allVaults` — never a predicted or hand-typed address.
 *
 * CALLDATA IS BYTE-IDENTICAL TO scripts/smoke-test.mjs's OWN SAFE-ROUTED PATH
 * (`routeThroughSafe` / `stepCreateVaultRouted` / `stepRegisterGovRouted`, card 208 / PR #374). Both
 * the parameter-tuple construction (`createVaultParamsTuple` / `registerVaultConfigTuple`,
 * scripts/smoke-preflight.mjs, factored out of smoke-test.mjs's own four previously-duplicated inline
 * copies in this same change) and the `cast calldata` encoding
 * (scripts/lib/safe-tx-builder.mjs) are the exact same code path smoke-test.mjs uses — this script
 * does not re-derive either. scripts/test/safe-route-fork.test.mjs's fork proof compares the REAL
 * inner calldata a live Safe-routed smoke-test.mjs run sends (read back with `cast tx <hash> input`
 * and decoded) against what this script emits for the same inputs.
 *
 * SCHEMA AND CHECKSUM: read from safe-global/safe-react-apps, commit
 * `118f25df89f781631386e6b279d812dfc837204a` — see scripts/lib/safe-tx-builder-checksum.mjs's header
 * for the exact files and for why `meta.checksum` is confirmed OPTIONAL on import (a mismatch or
 * absence is a 5-second UI warning, never a load failure). scripts/lib/safe-tx-builder.mjs's header
 * states plainly what `contractMethod`/`contractInputsValues` do and do NOT buy in the Safe UI given
 * `data` is also present (required for byte-identity) — read it before assuming "decoded inputs".
 *
 * Environment — the SAME variables and defaults scripts/smoke-test.mjs reads, so every parameter
 * comes from the config/manifest sources smoke-test reads and is never hand-typed:
 *   BASE_SEPOLIA_RPC   RPC url            (default: https://sepolia.base.org)
 *   SMOKE_CONFIG       chain config       (default: contracts/config/base-sepolia.json)
 *   SMOKE_DEPLOYMENT   deployment record  (default: contracts/config/deployments/base-sepolia.json)
 *   DEPLOY_JSON        forge broadcast output
 *                      (default: contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json)
 *   CAST               cast binary        (default: "cast" on PATH)
 *
 * `--out <path>` overrides where the file is written; the default is a path under `os.tmpdir()` —
 * NEVER under the repository tree, because scripts/test/claims-lede-truth.test.mjs and
 * scripts/test/config-doc-truth.test.mjs walk every `.md`/`.html`/`.txt`/`.json` file in the repo and
 * an emitted batch's `meta.description` is prose that guard would then have to parse.
 *
 * Never broadcasts, never touches a key. Every chain interaction below is a read (`chain-id`, `code`,
 * `call`) used to VERIFY what this script is about to emit; `cast calldata`/`cast keccak` are local,
 * offline computations.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDeploymentRecord, normAddr, addressShapeRefusal, requireCreatorCode,
  requireSafeRoutingPlan,
} from './smoke-preflight.mjs';
import { createVaultBatchTransaction, registerVaultBatchTransaction, buildBatchFile } from './lib/safe-tx-builder.mjs';
import { addChecksum, transactionsInBatchAreImportable } from './lib/safe-tx-builder-checksum.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org';
const CAST = process.env.CAST ?? 'cast';
const DEPLOY_JSON = process.env.DEPLOY_JSON
  ?? path.join(ROOT, 'contracts', 'broadcast', 'DeployTestnet.s.sol', '84532', 'run-latest.json');
const CONFIG_PATH = process.env.SMOKE_CONFIG ?? path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
const DEPLOYMENT_PATH = process.env.SMOKE_DEPLOYMENT
  ?? path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json');

function fail(msg) {
  console.error(`\nREFUSING TO EMIT A SAFE BATCH: ${msg}\n`);
  process.exit(1);
}

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8' }).trim();
}
const clean = (line) => line.replace(/\s+\[[^\]]*\]$/, '').trim();
function call(to, sig, ...args) {
  return cast(['call', to, sig, ...args.map(String), '--rpc-url', RPC]).split('\n').map(clean);
}
const calldata = (sig, ...args) => cast(['calldata', sig, ...args]);
const keccak = (s) => cast(['keccak', s]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** `createVault`/`registerVault`'s own `inputs`, read off the COMPILED ABI rather than typed out by
 *  hand — see scripts/lib/safe-tx-builder.mjs's header for why. */
function abiInputsFor(artifactRelPath, fnName) {
  const artifactPath = path.join(ROOT, 'contracts', 'out', artifactRelPath);
  if (!fs.existsSync(artifactPath)) {
    fail(`compiled ABI not found at ${artifactPath} — run \`cd contracts && forge build\` first.`);
  }
  const abi = JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
  const fn = abi.find((e) => e.type === 'function' && e.name === fnName);
  if (!fn) fail(`${fnName} not found in the compiled ABI at ${artifactPath}`);
  return fn.inputs;
}

/** The SAME forge-broadcast address extraction smoke-test.mjs's own `loadDeployment()` performs
 *  (contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json), kept as its own small copy here
 *  rather than imported: smoke-test.mjs's version reports failures through its own `assert`/`fail`
 *  (`process.exit(1)` with a specific message format) and this script must not change that behaviour
 *  to share the loader — see the PR body for the tradeoff. */
function loadBroadcastDeployment() {
  if (!fs.existsSync(DEPLOY_JSON)) {
    fail(`deploy output not found at ${DEPLOY_JSON} — run the DeployTestnet forge script first (see docs/TESTNET-CHECKLIST.md).`);
  }
  const j = JSON.parse(fs.readFileSync(DEPLOY_JSON, 'utf8'));
  const byName = {};
  for (const tx of j.transactions ?? []) {
    if (tx.transactionType === 'CREATE' && tx.contractName) (byName[tx.contractName] ??= []).push(tx.contractAddress);
  }
  const one = (name) => {
    const a = byName[name] ?? [];
    if (a.length !== 1) fail(`expected exactly one ${name} in ${DEPLOY_JSON}, found ${a.length}`);
    return a[0];
  };
  return {
    factory: one('VaultFactory'),
    governance: one('Governance'),
    aggregator: one('ChainlinkOracle'),
    adapter: one('AggregationRouterAdapter'),
  };
}

function main() {
  const action = process.argv[2];
  if (action !== 'createVault' && action !== 'registerVault') {
    fail(
      `first argument must be "createVault" or "registerVault" (got ${JSON.stringify(action)}). Usage:\n`
      + '  node scripts/build-safe-tx-builder.mjs createVault\n'
      + '  node scripts/build-safe-tx-builder.mjs registerVault --vault 0x...',
    );
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(cfg.assets)) {
    fail(`chain config ${CONFIG_PATH} declares no usable \`assets\` array (createVault needs the basket) — got ${JSON.stringify(cfg.assets)}.`);
  }
  if (!cfg.smoke || typeof cfg.smoke !== 'object') {
    fail(`chain config ${CONFIG_PATH} declares no usable \`smoke\` block (capacityCapUsdc/minDepositUsdc/exitFee*/gov) — got ${JSON.stringify(cfg.smoke)}.`);
  }

  // Missing record, missing declaration, or a record for the wrong chain than CONFIG_PATH: throws.
  const deployment = loadDeploymentRecord({
    deploymentPath: DEPLOYMENT_PATH, configPath: CONFIG_PATH,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync,
  });

  // EXPLICIT AND FIRST, before any guard shared with the EOA path is reached. `requireIntendedCreator`
  // (smoke-test.mjs's own dispatcher) would refuse an eoa-kind record too, but with "the signer is
  // unknown" — this script never has a signer to compare, so that message would mislead. A Safe
  // Transaction Builder batch only makes sense for a contract-kind (Safe) creator in the first place.
  const kind = typeof deployment.intendedCreatorKind === 'string'
    ? deployment.intendedCreatorKind.trim().toLowerCase() : undefined;
  if (kind !== 'contract') {
    fail(
      `deployment record ${DEPLOYMENT_PATH} declares intendedCreatorKind ${JSON.stringify(deployment.intendedCreatorKind)}, `
      + 'not "contract". A Safe Transaction Builder batch only makes sense for a contract-kind (Safe) '
      + 'creator — an EOA creator signs createVault directly (SMOKE_SIGNER_ARGS via scripts/smoke-test.mjs); '
      + 'there is nothing for a Safe owner to import here.',
    );
  }
  const safe = deployment.intendedCreator;
  const badSafe = addressShapeRefusal('the declared intendedCreator', safe);
  if (badSafe) fail(badSafe);

  // Chain id (manifest vs the live RPC) AND "Safe has no code" — ONE reused guard
  // (smoke-preflight.requireCreatorCode, the same one stepCreateVault calls) rather than two.
  const observedChainId = Number(cast(['chain-id', '--rpc-url', RPC]));
  requireCreatorCode({
    address: safe,
    code: cast(['code', safe, '--rpc-url', RPC]),
    observedChainId,
    declaredChainId: deployment.chainId,
    kind: deployment.intendedCreatorKind,
  });

  const dep = loadBroadcastDeployment();
  const createdAt = arg('created-at') !== undefined ? Number(arg('created-at')) : Date.now();

  let transaction, name, description, outSuffix;
  if (action === 'createVault') {
    const abiInputs = abiInputsFor(path.join('VaultFactory.sol', 'VaultFactory.json'), 'createVault');
    transaction = createVaultBatchTransaction({
      calldata,
      usdc: cfg.usdc,
      tokens: cfg.assets.map((a) => a.token),
      aggregator: dep.aggregator,
      capacityCapUsdc: cfg.smoke.capacityCapUsdc,
      minDepositUsdc: cfg.smoke.minDepositUsdc,
      exitFeeMaxBps: cfg.smoke.exitFeeMaxBps,
      exitFeeDecayPeriod: cfg.smoke.exitFeeDecayPeriod,
      adapter: dep.adapter,
      factory: dep.factory,
      abiInputs,
    });
    // Reuses the SAME plan-checker smoke-test.mjs's routeThroughSafe applies before it ever collects
    // a signature (scripts/smoke-preflight.mjs's safeRoutingPlanRefusal): right Safe, right target,
    // CALL not DELEGATECALL, createVault's own selector, zero value/safeTxGas/baseGas/gasPrice. Any
    // future drift between this generator and the routed-send path throws here, not silently.
    requireSafeRoutingPlan({
      intended: safe, safe, to: transaction.to, action: 'createVault', expectedTo: dep.factory,
      data: transaction.data, operation: 0, value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    });
    name = 'createVault (Safe-routed first vault)';
    description = `Generated by scripts/build-safe-tx-builder.mjs. createVault on VaultFactory ${dep.factory}; `
      + 'inner calldata byte-identical to scripts/smoke-test.mjs stepCreateVaultRouted for this deployment.';
    outSuffix = `createVault-${observedChainId}-${Date.now()}`;
  } else {
    const vault = arg('vault');
    if (!vault) {
      fail('registerVault needs --vault <address> — the address createVault emitted, READ BACK FROM THE CHAIN, never predicted or hand-typed.');
    }
    const badVault = addressShapeRefusal('--vault', vault);
    if (badVault) fail(badVault);

    // VERIFIED ON-CHAIN before this script emits anything the owner might sign — both facts the card
    // asks for, and both refuse rather than warn.
    const onChainCreator = call(vault, 'creator()(address)')[0];
    if (normAddr(onChainCreator) !== normAddr(safe)) {
      fail(
        `vault ${vault}'s own creator() reads ${onChainCreator}, but the declared Safe is ${safe}. `
        + 'Governance.sol:223 would revert NotVaultCreator() on this registerVault anyway, but a wrong '
        + 'vault is worth catching before the owner ever signs it.',
      );
    }
    const vaultCount = Number(call(dep.factory, 'vaultCount()(uint256)')[0]);
    let inAllVaults = false;
    for (let i = 0; i < vaultCount; i++) {
      if (normAddr(call(dep.factory, 'allVaults(uint256)(address)', i)[0]) === normAddr(vault)) { inAllVaults = true; break; }
    }
    if (!inAllVaults) {
      fail(`vault ${vault} is not present in factory ${dep.factory}'s allVaults (scanned ${vaultCount} entries). Refusing to register a vault this factory never created.`);
    }

    const abiInputs = abiInputsFor(path.join('Governance.sol', 'Governance.json'), 'registerVault');
    transaction = registerVaultBatchTransaction({
      calldata, vault, gov: cfg.smoke.gov, governance: dep.governance, abiInputs,
    });
    requireSafeRoutingPlan({
      intended: safe, safe, to: transaction.to, action: 'registerVault', expectedTo: dep.governance,
      data: transaction.data, operation: 0, value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    });
    name = 'registerVault (Safe-routed first vault)';
    description = `Generated by scripts/build-safe-tx-builder.mjs. registerVault(${vault}, ...) on Governance ${dep.governance}; `
      + 'creator() and factory.allVaults were verified on-chain before this file was written.';
    outSuffix = `registerVault-${observedChainId}-${vault}-${Date.now()}`;
  }

  // meta.checksum is deliberately ABSENT until addChecksum runs — see buildBatchFile's own doc for
  // why an object that already carries a (wrong) checksum key hashes differently under Safe's real
  // validateChecksum than one built the way generateBatchFile actually builds one.
  const batchFile = buildBatchFile({ chainId: observedChainId, createdAt, safe, name, description, transaction });
  if (!transactionsInBatchAreImportable(batchFile)) {
    // Should be unreachable given the construction above (every value here is a string by
    // construction) — refusing rather than writing a file Safe's own import path would hard-reject.
    fail('the assembled batch file would fail Safe\'s own validateTransactionsInBatch (a value or contractInputsValues entry is not a string) — refusing to write it.');
  }
  const withChecksum = addChecksum(batchFile, keccak);

  const outPath = arg('out') ?? path.join(os.tmpdir(), `safe-tx-builder-${outSuffix}.json`);
  fs.writeFileSync(outPath, JSON.stringify(withChecksum, null, 2) + '\n');

  console.log(`wrote ${outPath}`);
  console.log(`  action    ${action}`);
  console.log(`  safe      ${safe}`);
  console.log(`  to        ${transaction.to}`);
  console.log(`  data      ${transaction.data}`);
  console.log(`  checksum  ${withChecksum.meta.checksum}`);
  console.log('\nImport at https://app.safe.global -> Transaction Builder -> "Drag and drop a JSON file".');
  console.log('The Safe UI will show raw calldata for this transaction (see this script\'s header: data');
  console.log('is present for byte-identity, so contractMethod/contractInputsValues are not decoded for');
  console.log('display) — verify `to` and `data` above against this printout before signing.');
}

main();
