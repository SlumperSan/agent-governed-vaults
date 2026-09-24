#!/usr/bin/env node
// @ts-check
/**
 * Builds the Sign-queue items for the Arc mainnet protocol deploy: `DeployChainlinkOracle.s.sol`
 * then `Deploy.s.sol`, mirrored EXACTLY — same order, same constructor args, same wiring calls —
 * plus the `AggregationRouterAdapter` deploy and a non-signing read-back verification item. This
 * writes NOTHING to the chain: it shells out to `cast` only for pure encoding
 * (`abi-encode`/`compute-address`) and one read (`cast nonce`), and appends/updates items in the
 * Sign-queue JSON file via `mergeBuiltItems` (idempotent — a rebuild after some items are already
 * `sent`/`done` refuses rather than silently redescribing them).
 *
 * Usage: `node scripts/sign-queue/arc-deploy.mjs`
 * Env:   ARC_RPC (default https://rpc.mainnet.arc.io), CAST (default "cast")
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBuiltItems, readQueue, writeQueueAtomic } from '../lib/sign-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAST = process.env.CAST ?? 'cast';
const RPC = process.env.ARC_RPC ?? 'https://rpc.mainnet.arc.io';
const CHAIN_ID = 5042;
const CHAIN_NAME = 'Arc';
const DEPLOYER = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
export const BUILDER_NAME = 'arc-deploy';

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', windowsHide: true }).trim();
}

/** Read the bytecode object for `contractName`, declared in `<fileBase>.sol`. Forge's `out/`
 * layout keys on the SOURCE FILE's basename regardless of its subdirectory under `contracts/src`. */
function artifactBytecode(fileBase, contractName = fileBase) {
  const p = path.join(ROOT, 'contracts', 'out', `${fileBase}.sol`, `${contractName}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const code = j.bytecode?.object;
  if (typeof code !== 'string' || !code.startsWith('0x') || code.length < 4) {
    throw new Error(`arc-deploy: no usable bytecode in ${p} — run \`forge build\` in contracts/ first`);
  }
  return code;
}

/** initcode = creation bytecode + ABI-encoded constructor args, concatenated as raw bytes. */
function initcode(fileBase, ctorSig, ctorArgs, contractName = fileBase) {
  const bytecode = artifactBytecode(fileBase, contractName);
  if (ctorSig === null) return bytecode; // no-arg constructor
  const encoded = cast(['abi-encode', ctorSig, ...ctorArgs.map(String)]);
  return bytecode + encoded.replace(/^0x/, '');
}

/**
 * @param {object} p
 * @param {string} p.id
 * @param {number} p.order
 * @param {string} p.what
 * @param {string} p.data
 * @param {number} p.expectedNonce
 * @param {string[]} p.dependsOn
 * @returns {import('../lib/sign-queue.mjs').QueueItem}
 */
function createItem({ id, order, what, data, expectedNonce, dependsOn }) {
  return {
    id, order, chainId: CHAIN_ID, chainName: CHAIN_NAME, what,
    from: DEPLOYER, to: null, value: '0', data, dataTemplate: null,
    dependsOn, status: 'pending', txHash: null, receipt: null,
    predictedAddress: cast(['compute-address', DEPLOYER, '--nonce', String(expectedNonce)])
      .replace(/^Computed Address:\s*/, '').trim(),
    expectedNonce, sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(),
    sentAt: null, doneAt: null, verifyNote: null,
  };
}

/** @param {object} p @returns {import('../lib/sign-queue.mjs').QueueItem} */
function callItem({ id, order, what, to, sig, args, expectedNonce, dependsOn }) {
  return {
    id, order, chainId: CHAIN_ID, chainName: CHAIN_NAME, what,
    from: DEPLOYER, to, value: '0', data: cast(['calldata', sig, ...args.map(String)]),
    dataTemplate: null, dependsOn, status: 'pending', txHash: null, receipt: null,
    predictedAddress: null, expectedNonce, sentData: null, builder: BUILDER_NAME,
    builtAt: new Date().toISOString(), sentAt: null, doneAt: null, verifyNote: null,
  };
}

export function build() {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'config', 'arc-mainnet.json'), 'utf8'));
  if (cfg.chainId !== CHAIN_ID) throw new Error(`arc-mainnet.json chainId is ${cfg.chainId}, expected ${CHAIN_ID}`);
  const oracleCfg = cfg.chainlinkOracle;
  const assets = oracleCfg.assets.map((a) => a.asset);
  const feeds = oracleCfg.assets.map((a) => a.feed);
  const heartbeats = oracleCfg.assets.map((a) => a.heartbeatSeconds);
  const minWad = oracleCfg.assets.map((a) => a.minPriceWad);
  const maxWad = oracleCfg.assets.map((a) => a.maxPriceWad);
  const usdc = cfg.usdc;
  // Arc is L1 with no L2 sequencer uptime feed — DeployChainlinkOracle.s.sol's ARC_CHAIN_ID
  // exemption, owner decision 2026-09-19 — so this is address(0), same as the script's default.
  const sequencer = '0x0000000000000000000000000000000000000000';
  if (oracleCfg.sequencerUptimeFeed !== '') {
    throw new Error('arc-mainnet.json chainlinkOracle.sequencerUptimeFeed is non-empty — this builder assumes the exempt/empty case DeployChainlinkOracle.s.sol allows for chain 5042; re-check before building');
  }
  const routerSigs = cfg.routerAllowedSignatures;
  if (!Array.isArray(routerSigs) || routerSigs.length === 0) {
    throw new Error('arc-mainnet.json routerAllowedSignatures is empty');
  }
  const selectors = routerSigs.map((sig) => cast(['sig', sig]));
  const router = cfg.router;

  // Freeze the base nonce ONCE. A rebuild after this builder's items have already been (partly)
  // sent must NOT re-read the live nonce — see scripts/lib/sign-queue.mjs's mergeBuiltItems doc.
  // Reuse the first item's own frozen expectedNonce if it already exists in the queue.
  const existing = readQueue();
  const existingFirst = existing.items.find((it) => it.builder === BUILDER_NAME && it.id === 'arc-oracle');
  const baseNonce = existingFirst
    ? existingFirst.expectedNonce
    : Number(cast(['nonce', DEPLOYER, '--rpc-url', RPC]));
  if (!Number.isInteger(baseNonce) || baseNonce < 0) {
    throw new Error(`arc-deploy: unusable base nonce ${baseNonce}`);
  }
  let n = baseNonce;
  const next = () => n++;

  const items = [];

  // 1. DeployChainlinkOracle.s.sol
  const oracleNonce = next();
  const oracleData = initcode(
    'ChainlinkOracle', 'constructor(address[],address[],uint32[],uint256[],uint256[],address,address)',
    [`[${assets.join(',')}]`, `[${feeds.join(',')}]`, `[${heartbeats.join(',')}]`, `[${minWad.join(',')}]`, `[${maxWad.join(',')}]`, usdc, sequencer],
  );
  const oracleItem = createItem({
    id: 'arc-oracle', order: 1, what: `Deploy ChainlinkOracle (${oracleCfg.assets.map((a) => a.symbol).join(', ')} feed(s), Arc mainnet, no L2 sequencer feed — exempt)`,
    data: oracleData, expectedNonce: oracleNonce, dependsOn: [],
  });
  items.push(oracleItem);
  const oracleAddr = oracleItem.predictedAddress;

  // 2. Deploy.s.sol, in its own stated order
  const registryItem = createItem({ id: 'arc-registry', order: 2, what: 'Deploy OperatorRegistry', data: initcode('OperatorRegistry', null, []), expectedNonce: next(), dependsOn: [] });
  items.push(registryItem);
  const subRegItem = createItem({ id: 'arc-subreg', order: 3, what: 'Deploy SubVaultRegistry', data: initcode('SubVaultRegistry', null, []), expectedNonce: next(), dependsOn: [] });
  items.push(subRegItem);
  const feeEngineItem = createItem({
    id: 'arc-feeengine', order: 4, what: 'Deploy FeeEngine(registry)',
    data: initcode('FeeEngine', 'constructor(address)', [registryItem.predictedAddress]),
    expectedNonce: next(), dependsOn: ['arc-registry'],
  });
  items.push(feeEngineItem);
  const governanceItem = createItem({ id: 'arc-governance', order: 5, what: 'Deploy Governance', data: initcode('Governance', null, []), expectedNonce: next(), dependsOn: [] });
  items.push(governanceItem);
  const vaultDeployerItem = createItem({ id: 'arc-vaultdeployer', order: 6, what: 'Deploy VaultDeployer', data: initcode('VaultDeployer', null, []), expectedNonce: next(), dependsOn: [] });
  items.push(vaultDeployerItem);
  const factoryItem = createItem({
    id: 'arc-factory', order: 7,
    what: 'Deploy VaultFactory (root vaults only, BLESSED_ORACLES = the deployed ChainlinkOracle)',
    data: initcode(
      'VaultFactory', 'constructor(address,address,address,address,address,bool,address[])',
      [registryItem.predictedAddress, governanceItem.predictedAddress, feeEngineItem.predictedAddress,
        subRegItem.predictedAddress, vaultDeployerItem.predictedAddress, false, `[${oracleAddr}]`],
    ),
    expectedNonce: next(),
    dependsOn: ['arc-registry', 'arc-governance', 'arc-feeengine', 'arc-subreg', 'arc-vaultdeployer', 'arc-oracle'],
  });
  items.push(factoryItem);

  // One-shot wiring — irreversible after broadcast, same three calls Deploy.s.sol makes.
  items.push(callItem({
    id: 'arc-wire-registry', order: 8, what: 'registry.wire(factory, feeEngine) — one-shot, irreversible',
    to: registryItem.predictedAddress, sig: 'wire(address,address)',
    args: [factoryItem.predictedAddress, feeEngineItem.predictedAddress],
    expectedNonce: next(), dependsOn: ['arc-registry', 'arc-factory', 'arc-feeengine'],
  }));
  items.push(callItem({
    id: 'arc-wire-subreg', order: 9, what: 'subReg.wire(factory) — one-shot, irreversible',
    to: subRegItem.predictedAddress, sig: 'wire(address)', args: [factoryItem.predictedAddress],
    expectedNonce: next(), dependsOn: ['arc-subreg', 'arc-factory'],
  }));
  items.push(callItem({
    id: 'arc-wire-gov', order: 10, what: 'governance.wireSubVaultRegistry(subReg) — one-shot, irreversible',
    to: governanceItem.predictedAddress, sig: 'wireSubVaultRegistry(address)', args: [subRegItem.predictedAddress],
    expectedNonce: next(), dependsOn: ['arc-governance', 'arc-subreg'],
  }));

  // AggregationRouterAdapter(router, [exactInputSingle, exactInput])
  const adapterItem = createItem({
    id: 'arc-adapter', order: 11,
    what: `Deploy AggregationRouterAdapter(router=${router}, selectors=${selectors.join(',')})`,
    data: initcode('AggregationRouterAdapter', 'constructor(address,bytes4[])', [router, `[${selectors.join(',')}]`]),
    expectedNonce: next(), dependsOn: [],
  });
  items.push(adapterItem);

  // Non-signing read-back verification — mirrors DeployTestnet.s.sol's post-deploy sanity block
  // (registry.factory()==factory, registry.feeEngine()==feeEngine, subReg.factory()==factory,
  // governance.subVaultRegistry()==subReg, adapter.router()==router, factory.isAllowedOracle(oracle),
  // per-asset oracle.feedOf(asset)==feed) plus Deploy.s.sol's own non-empty-BLESSED_ORACLES gate
  // (checked structurally: this builder never emits an empty blessedOracles list) and
  // adapter.allowedSelector(sig) for both configured router signatures. No `from`/no nonce: this
  // item never signs anything — the dashboard marks it done once every read agrees, and every
  // signing item after it in this file depends on it.
  items.push({
    id: 'arc-readback', order: 12,
    chainId: CHAIN_ID, chainName: CHAIN_NAME,
    what: 'Read-back: confirm the deploy wired correctly (registry/subReg/governance/adapter/oracle allowlist reads) — no signature, verified by reads alone',
    from: null, to: null, value: '0', data: null, dataTemplate: null,
    dependsOn: ['arc-registry', 'arc-subreg', 'arc-governance', 'arc-feeengine', 'arc-vaultdeployer', 'arc-factory', 'arc-wire-registry', 'arc-wire-subreg', 'arc-wire-gov', 'arc-adapter', 'arc-oracle'],
    status: 'pending', txHash: null, receipt: null, predictedAddress: null, expectedNonce: null,
    sentData: null, builder: BUILDER_NAME, builtAt: new Date().toISOString(), sentAt: null, doneAt: null,
    verifyNote: null,
    readback: {
      registry: registryItem.predictedAddress, subReg: subRegItem.predictedAddress,
      feeEngine: feeEngineItem.predictedAddress, governance: governanceItem.predictedAddress,
      factory: factoryItem.predictedAddress, oracle: oracleAddr, adapter: adapterItem.predictedAddress,
      router, selectors, assets, feeds,
    },
  });

  return items;
}

function main() {
  const items = build();
  const existing = readQueue();
  const merged = mergeBuiltItems(existing.items, items, BUILDER_NAME);
  writeQueueAtomic({ items: merged });
  console.log(`arc-deploy: wrote/merged ${items.length} items into the Sign queue`);
  for (const it of items) console.log(`  ${it.order}. ${it.id} (nonce ${it.expectedNonce ?? '—'}) — ${it.what}`);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main();
}
