// @ts-check
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The five chains the leaderboard covers, and the registered-agent vaults on each.
 *
 * `vaults` is EMPTY on every chain because no registered-agent vault is deployed yet. The run
 * refuses a chain with no vaults, so nothing is measured until an address and its deploy block are
 * added here (or passed on the command line for a dry run). Nothing is invented: a chain whose RPC
 * endpoints are not recorded in this repository lists none.
 *
 * The deployer is read from the chain's deployment record when one exists, so it cannot drift.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @param {string} file deployment record name under contracts/config/deployments */
function deployerFrom(file) {
  const p = path.join(REPO, 'contracts', 'config', 'deployments', file);
  if (!existsSync(p)) return null;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  return typeof d.deployer === 'string' ? d.deployer.toLowerCase() : null;
}

/** @type {Record<string, {chainId:number, name:string, rpcs:string[], deployer:string|null, vaults:Array<{address:string, fromBlock:number}>}>} */
export const CHAINS = Object.freeze({
  arc: { chainId: 5042, name: 'arc', rpcs: ['https://rpc.mainnet.arc.io', 'https://arc.gateway.tenderly.co'], deployer: deployerFrom('arc-mainnet.json'), vaults: [] },
  base: { chainId: 8453, name: 'base', rpcs: [], deployer: null, vaults: [] },
  arbitrum: { chainId: 42161, name: 'arbitrum', rpcs: [], deployer: null, vaults: [] },
  ethereum: { chainId: 1, name: 'ethereum', rpcs: [], deployer: null, vaults: [] },
  polygon: { chainId: 137, name: 'polygon', rpcs: [], deployer: null, vaults: [] },
});

/** Unix seconds the epochs are counted from: the first registered-agent vault's deploy block. Unset until one exists. */
export const EPOCH_ANCHOR = null;
