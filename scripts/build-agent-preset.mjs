#!/usr/bin/env node
// @ts-check
/**
 * Generates `packages/reference-agent/presets/arc-mainnet.json` from the deployment record.
 *
 *     node scripts/build-agent-preset.mjs            write the preset
 *     node scripts/build-agent-preset.mjs --check    exit 1 if the file on disk differs
 *
 * Why a generated file inside the package and not an import of the record: `Dockerfile` copies
 * `packages` and `apps` and the agent is copied out of the tree by integrators, so a
 * `../../../contracts/...` import resolves on a checkout and throws inside the container. The
 * preset is therefore a file in the package, and `scripts/test/agent-preset-drift.test.mjs`
 * asserts it equals what this script builds from the record, so the two cannot drift.
 *
 * Sources, and nothing else:
 *   - `contracts/config/deployments/arc-mainnet.json`  every address, the chain id and name
 *   - `contracts/config/arc-mainnet.json`              `smoke.minDepositUsdc` (base units)
 *   - the existing preset's `usdcDomain` block         written by `scripts/verify-arc-usdc-domain.mjs`
 *                                                      from the token itself, never typed by hand
 *
 * The USDC EIP-712 domain is not in either JSON file. This script refuses to invent it: with no
 * `usdcDomain` block already in the preset it stops and names the script that records one.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
export const RECORD_PATH = path.join(REPO, 'contracts/config/deployments/arc-mainnet.json');
export const CONFIG_PATH = path.join(REPO, 'contracts/config/arc-mainnet.json');
export const PRESET_PATH = path.join(REPO, 'packages/reference-agent/presets/arc-mainnet.json');

/** Arc's native gas asset is USDC, shown as an 18-decimal native view over the 6-decimal token. */
export const ARC_NATIVE_CURRENCY = Object.freeze({ name: 'USDC', symbol: 'USDC', decimals: 18 });

/** The least a member deposits into the Arc vaults, in whole USDC. */
const toWholeUsdc = (baseUnits) => {
  const s = String(baseUnits);
  if (!/^\d+$/.test(s) || BigInt(s) % 1_000_000n !== 0n) throw new Error(`minDepositUsdc ${s} is not a whole number of USDC`);
  return (BigInt(s) / 1_000_000n).toString();
};

/**
 * PURE. Build the preset from the parsed record, the parsed config and a USDC domain.
 * @param {any} record @param {any} config
 * @param {{name:string, version:string, chainId:number, verifyingContract:string, separator:string}} usdcDomain
 */
export function buildPreset(record, config, usdcDomain) {
  const need = (v, what) => {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`deployment record has no address for ${what}`);
    return v;
  };
  if (record.chainId !== 5042 || config.chainId !== 5042) throw new Error('record and config must both be chain 5042');
  const rpcs = [record.rpc, record.crossCheckedOn];
  for (const r of rpcs) if (typeof r !== 'string' || !r.startsWith('https://')) throw new Error('deployment record has no https RPC pair');
  const usdc = need(record.infrastructure?.usdc, 'infrastructure.usdc');
  if (usdc.toLowerCase() !== String(config.usdc).toLowerCase()) throw new Error('record and config disagree on the USDC address');
  const minDepositUsdc = toWholeUsdc(config.smoke?.minDepositUsdc);
  const factory = need(record.singletons?.VaultFactory, 'singletons.VaultFactory');
  return {
    preset: 'arc-mainnet',
    generatedBy: 'scripts/build-agent-preset.mjs',
    source: 'contracts/config/deployments/arc-mainnet.json',
    chainId: record.chainId,
    chainName: record.chainName,
    nativeCurrency: { ...ARC_NATIVE_CURRENCY },
    rpcUrls: rpcs,
    contracts: {
      governance: need(record.singletons?.Governance, 'singletons.Governance'),
      factory,
      operatorRegistry: need(record.singletons?.OperatorRegistry, 'singletons.OperatorRegistry'),
      subvaultRegistry: need(record.singletons?.SubVaultRegistry, 'singletons.SubVaultRegistry'),
      usdc,
    },
    usdcDomain,
    vaultList: { contract: factory, countFunction: 'vaultCount()', itemFunction: 'allVaults(uint256)' },
    minDepositUsdc,
    depositUsdc: minDepositUsdc,
  };
}

/** @returns {string} the file's exact bytes for `preset` */
export const serialize = (preset) => JSON.stringify(preset, null, 2) + '\n';

/** @returns {any} the domain already recorded in the preset on disk, or a thrown instruction */
function existingDomain() {
  if (!existsSync(PRESET_PATH)) throw new Error('no preset on disk yet: run `node scripts/verify-arc-usdc-domain.mjs --write` first');
  const d = JSON.parse(readFileSync(PRESET_PATH, 'utf8')).usdcDomain;
  if (!d) throw new Error('the preset has no usdcDomain block: run `node scripts/verify-arc-usdc-domain.mjs --write`');
  return d;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const text = serialize(buildPreset(record, config, existingDomain()));
  if (process.argv.includes('--check')) {
    if (!existsSync(PRESET_PATH) || readFileSync(PRESET_PATH, 'utf8') !== text) {
      console.error('packages/reference-agent/presets/arc-mainnet.json differs from the deployment record: run `node scripts/build-agent-preset.mjs`');
      process.exit(1);
    }
    console.log('preset matches the deployment record');
  } else {
    writeFileSync(PRESET_PATH, text);
    console.log(`wrote ${path.relative(REPO, PRESET_PATH)}`);
  }
}
