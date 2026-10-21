#!/usr/bin/env node
// @ts-check
/**
 * Deploy preflight for RWAllyAgentRegistry. Exits 1 while any chain's import ceiling snapshot is
 * missing, a placeholder or malformed. Run it before the registry's CREATE2 deploy is announced and
 * before `initialize` is queued for signing.
 *
 *     node scripts/registry-deploy-preflight.mjs
 *     node scripts/registry-deploy-preflight.mjs --config <path to a registry create2 json>
 *     node scripts/registry-deploy-preflight.mjs --chain arc-mainnet   # also prints the ceiling
 *
 * Before initialize is signed (no chain call): the exact arguments it must carry.
 *
 *     node scripts/registry-deploy-preflight.mjs --expected <values.json>
 *
 * After initialize, before any vault pins the registry: read the deployed registry back and refuse
 * on any mismatch with the expected values (every `--rpc` is judged on its own; give two providers).
 *
 *     node scripts/registry-deploy-preflight.mjs --expected <values.json> --rpc <url> [--rpc <url>] [--registry <address>]
 *
 * The expected values file is JSON: { chain, owner, feeToken, treasury, fee, outsideRegistry,
 * importIdCeiling }, `chain` a key of importCeilings.chains. `initialize` takes the import ceiling
 * once and has no setter, so the value is permanent for the chain: it must equal the recorded
 * snapshot `nextId`, and a placeholder or a zero owner, token or treasury is refused. It reads and
 * prints; it signs nothing and sends no transaction (calls are eth_chainId, eth_getCode, eth_call).
 *
 * Getters relied on (contracts/src/RWAllyAgentRegistry.sol at origin/feat/registry-final-454):
 * initialized(), owner(), treasury(), fee(), feeToken(), outsideRegistry(), importIdCeiling(),
 * MAX_FEE(). `subVaultRegistry()` does not exist on the registry at that head; it is probed anyway
 * and must be zero if a later head adds it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, getAddress, isAddress, toFunctionSelector } from 'viem';
import { checkImportCeilings } from './lib/registry-import-ceilings.mjs';
import { ethCall, ethChainId, ethGetCode } from './lib/chain-rpc.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = /^0x0{40}$/i;
const MAX_FEE = 100_000_000n; // RWAllyAgentRegistry.MAX_FEE, a constant in the bytecode

const INITIALIZE_ABI = [
  {
    type: 'function',
    name: 'initialize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner_', type: 'address' },
      { name: 'feeToken_', type: 'address' },
      { name: 'treasury_', type: 'address' },
      { name: 'initialFee', type: 'uint256' },
      { name: 'outsideRegistry_', type: 'address' },
      { name: 'importIdCeiling_', type: 'uint256' },
    ],
    outputs: [],
  },
];
const sel = (/** @type {string} */ sig) => toFunctionSelector(sig);

/** @param {unknown} v @returns {boolean} a value that is still a stand-in, not a decision */
const isPlaceholder = (v) => typeof v === 'string' && /placeholder|^<.*>$|^todo$|^tbd$/i.test(v.trim());

/** @param {unknown} v @returns {bigint | null} a non-negative integer given as a number or decimal string */
function toUint(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/**
 * The expected values against the recorded config, before any network call. Returns the exact
 * `initialize` arguments when there is no problem.
 * @param {any} cfg parsed agent-registry-create2.json
 * @param {any} exp parsed expected values file
 * @param {string} [chainFlag] overrides exp.chain
 * @returns {{ problems: string[], chain: string, args: [string, string, string, bigint, string, bigint] | null }}
 */
export function expectedArgs(cfg, exp, chainFlag) {
  /** @type {string[]} */
  const problems = [];
  const chain = chainFlag ?? (exp && exp.chain);
  const snap = typeof chain === 'string' ? cfg?.importCeilings?.chains?.[chain] : undefined;
  if (!exp || typeof exp !== 'object') return { problems: ['expected values file is not an object'], chain: String(chain), args: null };
  if (!snap) problems.push(`no importCeilings entry for chain ${String(chain)}`);
  for (const k of ['owner', 'feeToken', 'treasury']) {
    const v = exp[k];
    if (isPlaceholder(v)) problems.push(`${k} is still a placeholder`);
    else if (typeof v !== 'string' || !isAddress(v, { strict: false })) problems.push(`${k} must be an address`);
    else if (ZERO.test(v)) problems.push(`${k} must not be the zero address`);
  }
  const fee = toUint(exp.fee);
  if (isPlaceholder(exp.fee)) problems.push('fee is still a placeholder');
  else if (fee === null) problems.push('fee must be a non-negative integer in raw units');
  else if (fee > MAX_FEE) problems.push(`fee ${fee} exceeds MAX_FEE ${MAX_FEE}`);
  const outside = exp.outsideRegistry;
  const ceiling = toUint(exp.importIdCeiling);
  if (isPlaceholder(outside)) problems.push('outsideRegistry is still a placeholder');
  else if (typeof outside !== 'string' || !isAddress(outside, { strict: false })) problems.push('outsideRegistry must be an address (the zero address means no import window)');
  if (isPlaceholder(exp.importIdCeiling)) problems.push('importIdCeiling is still a placeholder: it has no setter, so a wrong value is permanent for the chain');
  else if (ceiling === null) problems.push('importIdCeiling must be a non-negative integer');
  if (problems.length === 0 && snap) {
    if (ZERO.test(/** @type {string} */ (outside))) {
      if (ceiling !== 0n) problems.push('importIdCeiling must be 0 when outsideRegistry is the zero address');
    } else {
      if (ceiling === 0n) problems.push('importIdCeiling is 0 with an outside registry: no id could ever be imported, and it cannot be changed');
      if (ceiling !== BigInt(snap.nextId)) {
        problems.push(`importIdCeiling ${ceiling} differs from the recorded snapshot nextId ${snap.nextId} for ${chain}`);
      }
      if (/** @type {string} */ (outside).toLowerCase() !== String(snap.outsideRegistry).toLowerCase()) {
        problems.push(`outsideRegistry differs from the recorded importCeilings.chains.${chain}.outsideRegistry`);
      }
    }
  }
  if (problems.length) return { problems, chain: String(chain), args: null };
  return {
    problems,
    chain,
    args: [
      getAddress(exp.owner),
      getAddress(exp.feeToken),
      getAddress(exp.treasury),
      /** @type {bigint} */ (fee),
      getAddress(outside),
      /** @type {bigint} */ (ceiling),
    ],
  };
}

/** @param {unknown} hex @returns {bigint | null} null when not a clean 32-byte word */
const word = (hex) => (typeof hex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hex) ? BigInt(hex) : null);

/**
 * Read the deployed registry on one endpoint and judge every value against the expected ones.
 * A read that fails or returns something unparseable is a failure, never a skip.
 * @param {{ fetchImpl: typeof fetch, rpcUrl: string, registry: string, chainId: number, args: NonNullable<ReturnType<typeof expectedArgs>['args']> }} a
 * @returns {Promise<string[]>}
 */
export async function checkOnchain({ fetchImpl, rpcUrl, registry, chainId, args }) {
  /** @type {string[]} */
  const problems = [];
  const fail = (/** @type {string} */ m) => problems.push(`${rpcUrl}: ${m}`);
  const [owner, feeToken, treasury, fee, outside, ceiling] = args;

  const cid = await ethChainId(fetchImpl, rpcUrl);
  if (!cid.ok) return [`${rpcUrl}: could not read eth_chainId (${cid.reason}); nothing was verified`];
  if (word(`0x${String(cid.result).replace(/^0x/, '').padStart(64, '0')}`) !== BigInt(chainId)) {
    return [`${rpcUrl}: eth_chainId is ${String(cid.result)}, expected ${chainId}; this endpoint is a different chain`];
  }
  const code = await ethGetCode(fetchImpl, rpcUrl, registry);
  if (!code.ok) return [`${rpcUrl}: could not read code at ${registry} (${code.reason})`];
  if (typeof code.result !== 'string' || code.result === '0x') return [`${rpcUrl}: no code at ${registry}: the registry is not deployed on this chain`];

  /** @param {string} label @param {string} signature @param {bigint} want @param {(n: bigint) => string} show */
  const expectWord = async (label, signature, want, show) => {
    const r = await ethCall(fetchImpl, rpcUrl, registry, sel(signature));
    if (!r.ok) return fail(`${label}: call failed (${r.reason}); the read reached no verdict`);
    const w = word(r.result);
    if (w === null) return fail(`${label}: returned ${String(r.result)}, not a 32-byte word`);
    if (w !== want) fail(`${label} is ${show(w)}, expected ${show(want)}`);
  };
  const addr = (/** @type {string} */ a) => BigInt(a);
  const showAddr = (/** @type {bigint} */ n) => `0x${n.toString(16).padStart(40, '0')}`;
  const showNum = (/** @type {bigint} */ n) => n.toString();

  await expectWord('registry.initialized()', 'initialized()', 1n, (n) => (n === 1n ? 'true' : n === 0n ? 'false' : showNum(n)));
  await expectWord('registry.owner()', 'owner()', addr(owner), showAddr);
  await expectWord('registry.treasury()', 'treasury()', addr(treasury), showAddr);
  await expectWord('registry.feeToken()', 'feeToken()', addr(feeToken), showAddr);
  await expectWord('registry.fee()', 'fee()', fee, showNum);
  await expectWord('registry.outsideRegistry()', 'outsideRegistry()', addr(outside), showAddr);
  await expectWord('registry.importIdCeiling()', 'importIdCeiling()', ceiling, showNum);

  // shortcut: an execution revert is read as "the getter does not exist" (true at the frozen head);
  // any other failure is a failure. Drop the probe when the registry is final and has no such getter.
  const sub = await ethCall(fetchImpl, rpcUrl, registry, sel('subVaultRegistry()'));
  if (sub.ok) {
    const w = word(sub.result);
    if (w === null) fail(`registry.subVaultRegistry(): returned ${String(sub.result)}, not a 32-byte word`);
    else if (w !== 0n) fail(`registry.subVaultRegistry() is ${showAddr(w)}, expected the zero address`);
  } else if (!/revert/i.test(sub.reason)) {
    fail(`registry.subVaultRegistry(): call failed (${sub.reason}); the read reached no verdict`);
  }
  return problems;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rpcs = argv.flatMap((a, i) => (a === '--rpc' ? [argv[i + 1]] : []));

  const file = flag('--config') ?? path.join(REPO, 'contracts', 'config', 'agent-registry-create2.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const res = checkImportCeilings(cfg);
  if (!res.ok) {
    for (const p of res.problems) console.error(`PREFLIGHT FAIL: ${p}`);
    process.exit(1);
  }
  const want = flag('--chain');
  if (want !== undefined) {
    const e = cfg.importCeilings.chains[want];
    if (!e) {
      console.error(`PREFLIGHT FAIL: no importCeilings entry for ${want}`);
      process.exit(1);
    }
    console.log(`${want}: importIdCeiling ${e.nextId} (block ${e.block}, read ${e.readAt})`);
  }
  console.log(`preflight ok: ${res.chains.length} import ceiling snapshot(s) recorded: ${res.chains.join(', ')}`);

  const expectedFile = flag('--expected');
  if (expectedFile === undefined) {
    if (rpcs.length) {
      console.error('PREFLIGHT FAIL: --rpc needs --expected, the values to judge the readback against');
      process.exit(1);
    }
    return;
  }
  const exp = JSON.parse(readFileSync(expectedFile, 'utf8'));
  const r = expectedArgs(cfg, exp, want);
  if (!r.args) {
    for (const p of r.problems) console.error(`PREFLIGHT FAIL: ${p}`);
    process.exit(1);
  }
  console.log(`initialize arguments expected on ${r.chain} (the import ceiling is permanent):`);
  console.log(`  owner_           ${r.args[0]}`);
  console.log(`  feeToken_        ${r.args[1]}`);
  console.log(`  treasury_        ${r.args[2]}`);
  console.log(`  initialFee       ${r.args[3]}`);
  console.log(`  outsideRegistry_ ${r.args[4]}`);
  console.log(`  importIdCeiling_ ${r.args[5]}`);
  console.log(`  calldata         ${encodeFunctionData({ abi: INITIALIZE_ABI, functionName: 'initialize', args: r.args })}`);

  if (rpcs.length === 0) return;
  const registry = flag('--registry') ?? cfg.address;
  if (typeof registry !== 'string' || !isAddress(registry, { strict: false }) || ZERO.test(registry)) {
    console.error('PREFLIGHT FAIL: --registry must be an address');
    process.exit(1);
  }
  /** @type {string[]} */
  const problems = [];
  for (const rpcUrl of rpcs) {
    problems.push(...(await checkOnchain({ fetchImpl: fetch, rpcUrl, registry, chainId: cfg.importCeilings.chains[r.chain].chainId, args: r.args })));
  }
  if (problems.length) {
    for (const p of problems) console.error(`PREFLIGHT FAIL: ${p}`);
    process.exit(1);
  }
  console.log(`onchain ok: ${registry} on ${r.chain} matches the expected values on ${rpcs.length} endpoint(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
