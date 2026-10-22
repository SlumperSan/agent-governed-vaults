#!/usr/bin/env node
// @ts-check
/**
 * Reads the EIP-712 domain of Arc's USDC from the chain, on BOTH Arc RPC endpoints, and proves it.
 *
 *     node scripts/verify-arc-usdc-domain.mjs            read, verify, compare with the preset
 *     node scripts/verify-arc-usdc-domain.mjs --write    also (re)write the preset's usdcDomain
 *
 * The x402 authorization an agent signs is an EIP-3009 `TransferWithAuthorization` over this
 * domain. A wrong name or version still produces a valid signature, over the wrong struct hash,
 * and it fails as an opaque signer mismatch. So the pair is never typed from memory: it is read
 * from the token's own `name()` and `version()`, and accepted only when
 *
 *   1. both endpoints answer for chain 5042 (the chain id is read, not assumed),
 *   2. both endpoints return the same name, version and `DOMAIN_SEPARATOR()`, and
 *   3. hashing {name, version, chainId 5042, verifyingContract = the USDC address} reproduces that
 *      separator exactly.
 *
 * If the token does not expose these, or step 3 does not reproduce, this exits 1 and writes
 * nothing. Read-only: `eth_chainId` and `eth_call`, no key, no transaction.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeAbiParameters, encodeFunctionData, hashDomain, parseAbi } from 'viem';
import { rpcCall, ethCall } from './lib/chain-rpc.mjs';
import { chainBindingVerdict } from './lib/chain-binding.mjs';
import { redactUrls } from '../packages/reference-agent/src/config.mjs';
import { buildPreset, serialize, RECORD_PATH, CONFIG_PATH, PRESET_PATH } from './build-agent-preset.mjs';

export const ARC_CHAIN_ID = 5042;
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const ARC_RPCS = Object.freeze(['https://rpc.mainnet.arc.io', 'https://arc.gateway.tenderly.co']);

const ABI = parseAbi(['function name() view returns (string)', 'function version() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)']);
const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/**
 * PURE. The separator the standard domain struct hashes to.
 * @param {{name:string, version:string, chainId:number, verifyingContract:string}} d
 */
export const separatorOf = (d) => hashDomain({ domain: d, types: { EIP712Domain: EIP712_DOMAIN } });

/**
 * One endpoint: its chain id, then the three reads. Never throws.
 * @returns {Promise<{ok:true, rpc:string, name:string, version:string, separator:string}|{ok:false, rpc:string, reason:string}>}
 */
async function readOne(fetchImpl, rpc, usdc, chainId) {
  const id = await rpcCall(fetchImpl, rpc, 'eth_chainId', []);
  const verdict = chainBindingVerdict({
    declaredChainId: chainId,
    rpcChainId: id.ok ? Number(id.result) : null,
    rpc,
    declaredBy: 'this script (Arc mainnet)',
  });
  if (!verdict.ok) return { ok: false, rpc, reason: verdict.message };
  /** @param {'name'|'version'|'DOMAIN_SEPARATOR'} functionName @param {'string'|'bytes32'} type */
  const call = async (functionName, type) => {
    const r = await ethCall(fetchImpl, rpc, usdc, encodeFunctionData({ abi: ABI, functionName }));
    if (!r.ok) throw new Error(r.reason);
    try {
      return /** @type {string} */ (decodeAbiParameters([{ type }], r.result)[0]);
    } catch {
      throw new Error(`${functionName}() did not decode as ${type}: ${String(r.result).slice(0, 80)}`);
    }
  };
  try {
    return { ok: true, rpc, name: await call('name', 'string'), version: await call('version', 'string'), separator: await call('DOMAIN_SEPARATOR', 'bytes32') };
  } catch (e) {
    return { ok: false, rpc, reason: redactUrls(`${rpc}: ${/** @type {Error} */ (e).message}`) };
  }
}

/**
 * Read and prove the domain. `ok` is true only when every endpoint answered, all agreed, and the
 * agreed pair reproduces the separator.
 * @param {{fetchImpl?:typeof fetch, rpcUrls?:readonly string[], usdc?:string, chainId?:number}} [o]
 * @returns {Promise<{ok:boolean, problems:string[], domain:null|{name:string, version:string, chainId:number, verifyingContract:string, separator:string}, reads:any[]}>}
 */
export async function verifyUsdcDomain({ fetchImpl = fetch, rpcUrls = ARC_RPCS, usdc = ARC_USDC, chainId = ARC_CHAIN_ID } = {}) {
  /** @type {string[]} */
  const problems = [];
  if (rpcUrls.length < 2) problems.push('fewer than two RPC endpoints: the two-provider rule needs both');
  const reads = await Promise.all(rpcUrls.map((r) => readOne(fetchImpl, r, usdc, chainId)));
  for (const r of reads) if (!r.ok) problems.push(r.reason);
  const good = /** @type {any[]} */ (reads.filter((r) => r.ok));
  if (good.length !== rpcUrls.length) return { ok: false, problems, domain: null, reads };
  const [first] = good;
  for (const g of good) {
    for (const k of ['name', 'version', 'separator']) {
      if (g[k] !== first[k]) problems.push(`${g.rpc} and ${first.rpc} disagree on ${k}: ${JSON.stringify(g[k])} vs ${JSON.stringify(first[k])}`);
    }
  }
  const domain = { name: first.name, version: first.version, chainId, verifyingContract: usdc, separator: first.separator };
  const rebuilt = separatorOf(domain);
  if (rebuilt.toLowerCase() !== first.separator.toLowerCase()) {
    problems.push(`{name ${JSON.stringify(first.name)}, version ${JSON.stringify(first.version)}, chainId ${chainId}, verifyingContract ${usdc}} hashes to ${rebuilt}, not the token's DOMAIN_SEPARATOR() ${first.separator}`);
  }
  return { ok: problems.length === 0, problems, domain: problems.length === 0 ? domain : null, reads };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyUsdcDomain();
  if (!result.ok || !result.domain) {
    console.error('Arc USDC domain NOT proven, nothing written:');
    for (const p of result.problems) console.error('  - ' + p);
    process.exit(1);
  }
  const { domain } = result;
  console.log(`name ${JSON.stringify(domain.name)}, version ${JSON.stringify(domain.version)}, chainId ${domain.chainId}`);
  console.log(`verifyingContract ${domain.verifyingContract}`);
  console.log(`DOMAIN_SEPARATOR ${domain.separator} (identical on ${ARC_RPCS.join(' and ')}, and reproduced from the pair)`);
  if (process.argv.includes('--write')) {
    const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    writeFileSync(PRESET_PATH, serialize(buildPreset(record, config, domain)));
    console.log(`wrote ${PRESET_PATH}`);
  } else if (existsSync(PRESET_PATH)) {
    const onDisk = JSON.parse(readFileSync(PRESET_PATH, 'utf8')).usdcDomain;
    const same = onDisk && JSON.stringify(onDisk) === JSON.stringify(domain);
    console.log(same ? 'the preset records exactly this domain' : 'the preset does NOT record this domain: rerun with --write');
    if (!same) process.exit(1);
  }
}
