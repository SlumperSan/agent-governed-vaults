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
 * Right before initialize is signed: the registry is deployed and not yet initialized, and the
 * outside ERC-8004 registry's proxy implementation and admin still equal the recorded ones.
 *
 *     node scripts/registry-deploy-preflight.mjs --expected <values.json> --rpc <url> [--rpc <url>] --before-initialize
 *
 * After initialize, before any vault pins the registry: read the deployed registry back and refuse
 * on any mismatch with the expected values (every `--rpc` is judged on its own; give two providers).
 * The outside registry's proxy is re-read here too.
 *
 *     node scripts/registry-deploy-preflight.mjs --expected <values.json> --rpc <url> [--rpc <url>] [--registry <address>]
 *
 * The expected values file is JSON: { chain, owner, feeToken, treasury, fee, outsideRegistry,
 * importIdCeiling, outsideImplementation, outsideAdmin }, `chain` a key of importCeilings.chains.
 * `initialize` takes the import ceiling once and has no setter, so the value is permanent for the
 * chain: it must equal the recorded snapshot `nextId`, and a placeholder or a zero owner, token or
 * treasury is refused. The treasury is FEE_TREASURY (checked against the FEE_TREASURY environment
 * variable when it is set) and never the initializer key; the outside registry is never the
 * registry itself. With an outside registry, `outsideImplementation` is its EIP-1967 implementation
 * and `outsideAdmin` its upgrade authority: the EIP-1967 admin slot when that is set, else its
 * `owner()` (a UUPS proxy keeps the admin slot empty). It reads and prints; it signs nothing and
 * sends no transaction (calls are eth_chainId, eth_getCode, eth_getStorageAt, eth_call).
 *
 * Getters relied on (contracts/src/RWAllyAgentRegistry.sol on protocol/main, after #468):
 * initialized(), owner(), treasury(), fee(), feeToken(), outsideRegistry(), importIdCeiling(),
 * and the constant MAX_FEE. `initialize` is the six-argument form (owner_, feeToken_, treasury_,
 * initialFee, outsideRegistry_, importIdCeiling_); the seven-argument form adds attestor_ last.
 * `subVaultRegistry()` does not exist on the registry; it is probed anyway and must be zero if a
 * later head adds it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, getAddress, isAddress, toFunctionSelector } from 'viem';
import { checkImportCeilings } from './lib/registry-import-ceilings.mjs';
import { ethCall, ethChainId, ethGetCode, rpcCall } from './lib/chain-rpc.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = /^0x0{40}$/i;
const MAX_FEE = 100_000_000n; // RWAllyAgentRegistry.MAX_FEE, a constant in the bytecode
// EIP-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1), and the same for admin.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

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
 * `initialize` arguments, and the recorded proxy of the outside registry, when there is no problem.
 * @param {any} cfg parsed agent-registry-create2.json
 * @param {any} exp parsed expected values file
 * @param {string} [chainFlag] overrides exp.chain
 * @param {{ registry?: string, feeTreasury?: string }} [opts] the registry address (default cfg.address)
 *   and FEE_TREASURY when it is known
 * @returns {{ problems: string[], chain: string, args: [string, string, string, bigint, string, bigint] | null, proxy: { implementation: string, admin: string } | null }}
 */
export function expectedArgs(cfg, exp, chainFlag, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  const chain = chainFlag ?? (exp && exp.chain);
  const snap = typeof chain === 'string' ? cfg?.importCeilings?.chains?.[chain] : undefined;
  if (!exp || typeof exp !== 'object') return { problems: ['expected values file is not an object'], chain: String(chain), args: null, proxy: null };
  if (!snap) problems.push(`no importCeilings entry for chain ${String(chain)}`);
  for (const k of ['owner', 'feeToken', 'treasury']) {
    const v = exp[k];
    if (isPlaceholder(v)) problems.push(`${k} is still a placeholder`);
    else if (typeof v !== 'string' || !isAddress(v, { strict: false })) problems.push(`${k} must be an address`);
    else if (ZERO.test(v)) problems.push(`${k} must not be the zero address`);
  }
  const lower = (/** @type {unknown} */ v) => String(v).toLowerCase();
  if (typeof cfg?.initializer === 'string' && lower(exp.treasury) === lower(cfg.initializer)) {
    problems.push('treasury is the initializer key (PROTOCOL_INITIALIZER); the registry treasury is FEE_TREASURY');
  }
  if (opts.feeTreasury !== undefined && lower(exp.treasury) !== lower(opts.feeTreasury)) {
    problems.push('treasury differs from FEE_TREASURY; the registry treasury is FEE_TREASURY');
  }
  const fee = toUint(exp.fee);
  if (isPlaceholder(exp.fee)) problems.push('fee is still a placeholder');
  else if (fee === null) problems.push('fee must be a non-negative integer in raw units');
  else if (fee > MAX_FEE) problems.push(`fee ${fee} exceeds MAX_FEE ${MAX_FEE}`);
  const outside = exp.outsideRegistry;
  const ceiling = toUint(exp.importIdCeiling);
  if (isPlaceholder(outside)) problems.push('outsideRegistry is still a placeholder');
  else if (typeof outside !== 'string' || !isAddress(outside, { strict: false })) problems.push('outsideRegistry must be an address (the zero address means no import window)');
  else if (lower(outside) === lower(opts.registry ?? cfg?.address)) problems.push('outsideRegistry is the registry itself');
  if (isPlaceholder(exp.importIdCeiling)) problems.push('importIdCeiling is still a placeholder: it has no setter, so a wrong value is permanent for the chain');
  else if (ceiling === null) problems.push('importIdCeiling must be a non-negative integer');
  const withOutside = typeof outside === 'string' && isAddress(outside, { strict: false }) && !ZERO.test(outside);
  if (withOutside) {
    for (const k of ['outsideImplementation', 'outsideAdmin']) {
      const v = exp[k];
      if (isPlaceholder(v)) problems.push(`${k} is still a placeholder`);
      else if (typeof v !== 'string' || !isAddress(v, { strict: false })) problems.push(`${k} must be recorded as an address when there is an outside registry`);
      else if (ZERO.test(v)) problems.push(`${k} must not be the zero address`);
    }
  }
  if (problems.length === 0 && snap) {
    if (!withOutside) {
      if (ceiling !== 0n) problems.push('importIdCeiling must be 0 when outsideRegistry is the zero address');
    } else {
      if (ceiling === 0n) problems.push('importIdCeiling is 0 with an outside registry: no id could ever be imported, and it cannot be changed');
      if (ceiling !== BigInt(snap.nextId)) {
        problems.push(`importIdCeiling ${ceiling} differs from the recorded snapshot nextId ${snap.nextId} for ${chain}`);
      }
      if (lower(outside) !== lower(snap.outsideRegistry)) {
        problems.push(`outsideRegistry differs from the recorded importCeilings.chains.${chain}.outsideRegistry`);
      }
    }
  }
  if (problems.length) return { problems, chain: String(chain), args: null, proxy: null };
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
    proxy: withOutside ? { implementation: getAddress(exp.outsideImplementation), admin: getAddress(exp.outsideAdmin) } : null,
  };
}

/** @param {unknown} hex @returns {bigint | null} null when not a clean 32-byte word */
const word = (hex) => (typeof hex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hex) ? BigInt(hex) : null);

/**
 * Read the deployed registry on one endpoint and judge every value against the expected ones.
 * A read that fails or returns something unparseable is a failure, never a skip.
 * `beforeInitialize` checks only that the registry is deployed and not yet initialized; the outside
 * registry's proxy is re-read in both phases.
 * @param {{ fetchImpl: typeof fetch, rpcUrl: string, registry: string, chainId: number, args: NonNullable<ReturnType<typeof expectedArgs>['args']>, proxy: ReturnType<typeof expectedArgs>['proxy'], beforeInitialize?: boolean }} a
 * @returns {Promise<string[]>}
 */
export async function checkOnchain({ fetchImpl, rpcUrl, registry, chainId, args, proxy, beforeInitialize = false }) {
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

  /** @param {string} label @param {string} target @param {string} signature @param {bigint} want @param {(n: bigint) => string} show */
  const expectWord = async (label, target, signature, want, show) => {
    const r = await ethCall(fetchImpl, rpcUrl, target, sel(signature));
    if (!r.ok) return fail(`${label}: call failed (${r.reason}); the read reached no verdict`);
    const w = word(r.result);
    if (w === null) return fail(`${label}: returned ${String(r.result)}, not a 32-byte word`);
    if (w !== want) fail(`${label} is ${show(w)}, expected ${show(want)}`);
  };
  const addr = (/** @type {string} */ a) => BigInt(a);
  const showAddr = (/** @type {bigint} */ n) => `0x${n.toString(16).padStart(40, '0')}`;
  const showNum = (/** @type {bigint} */ n) => n.toString();
  const showBool = (/** @type {bigint} */ n) => (n === 1n ? 'true' : n === 0n ? 'false' : showNum(n));

  if (beforeInitialize) {
    await expectWord('registry.initialized()', registry, 'initialized()', 0n, showBool);
  } else {
    await expectWord('registry.initialized()', registry, 'initialized()', 1n, showBool);
    await expectWord('registry.owner()', registry, 'owner()', addr(owner), showAddr);
    await expectWord('registry.treasury()', registry, 'treasury()', addr(treasury), showAddr);
    await expectWord('registry.feeToken()', registry, 'feeToken()', addr(feeToken), showAddr);
    await expectWord('registry.fee()', registry, 'fee()', fee, showNum);
    await expectWord('registry.outsideRegistry()', registry, 'outsideRegistry()', addr(outside), showAddr);
    await expectWord('registry.importIdCeiling()', registry, 'importIdCeiling()', ceiling, showNum);

    // shortcut: an execution revert is read as "the getter does not exist" (true on protocol/main);
    // any other failure is a failure. Drop the probe once no deploy can target a head with the getter.
    const sub = await ethCall(fetchImpl, rpcUrl, registry, sel('subVaultRegistry()'));
    if (sub.ok) {
      const w = word(sub.result);
      if (w === null) fail(`registry.subVaultRegistry(): returned ${String(sub.result)}, not a 32-byte word`);
      else if (w !== 0n) fail(`registry.subVaultRegistry() is ${showAddr(w)}, expected the zero address`);
    } else if (!/revert/i.test(sub.reason)) {
      fail(`registry.subVaultRegistry(): call failed (${sub.reason}); the read reached no verdict`);
    }
  }

  if (proxy) {
    const oc = await ethGetCode(fetchImpl, rpcUrl, outside);
    if (!oc.ok) fail(`outside registry ${outside}: could not read code (${oc.reason})`);
    else if (typeof oc.result !== 'string' || oc.result === '0x') fail(`outside registry ${outside}: no code`);
    /** @param {string} slot @returns {Promise<bigint | null>} */
    const slotWord = async (slot) => {
      const r = await rpcCall(fetchImpl, rpcUrl, 'eth_getStorageAt', [outside, slot, 'latest']);
      if (!r.ok) return (fail(`outside registry ${slot === IMPL_SLOT ? 'implementation' : 'admin'} slot: read failed (${r.reason}); the read reached no verdict`), null);
      const w = word(r.result);
      if (w === null) fail(`outside registry ${slot === IMPL_SLOT ? 'implementation' : 'admin'} slot: returned ${String(r.result)}, not a 32-byte word`);
      return w;
    };
    const impl = await slotWord(IMPL_SLOT);
    if (impl !== null && impl !== addr(proxy.implementation)) {
      fail(`outside registry implementation is ${showAddr(impl)}, expected the recorded ${proxy.implementation}`);
    }
    const admin = await slotWord(ADMIN_SLOT);
    if (admin !== null && admin !== 0n) {
      if (admin !== addr(proxy.admin)) fail(`outside registry admin slot is ${showAddr(admin)}, expected the recorded ${proxy.admin}`);
    } else if (admin === 0n) {
      await expectWord('outside registry owner() (UUPS upgrade authority)', outside, 'owner()', addr(proxy.admin), showAddr);
    }
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
  const beforeInitialize = argv.includes('--before-initialize');

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
  const registry = flag('--registry') ?? cfg.address;
  if (typeof registry !== 'string' || !isAddress(registry, { strict: false }) || ZERO.test(registry)) {
    console.error('PREFLIGHT FAIL: --registry must be an address');
    process.exit(1);
  }
  const exp = JSON.parse(readFileSync(expectedFile, 'utf8'));
  const feeTreasury = process.env.FEE_TREASURY || undefined;
  const r = expectedArgs(cfg, exp, want, { registry, feeTreasury });
  if (!r.args) {
    for (const p of r.problems) console.error(`PREFLIGHT FAIL: ${p}`);
    process.exit(1);
  }
  console.log(`initialize arguments expected on ${r.chain} (the import ceiling is permanent):`);
  console.log(`  owner_           ${r.args[0]}`);
  console.log(`  feeToken_        ${r.args[1]}`);
  console.log(`  treasury_        ${r.args[2]}${feeTreasury === undefined ? '   (FEE_TREASURY not set: not cross-checked)' : '   (= FEE_TREASURY)'}`);
  console.log(`  initialFee       ${r.args[3]}`);
  console.log(`  outsideRegistry_ ${r.args[4]}`);
  console.log(`  importIdCeiling_ ${r.args[5]}`);
  if (r.proxy) console.log(`  outside proxy    implementation ${r.proxy.implementation}, admin ${r.proxy.admin} (re-read on every --rpc)`);
  console.log(`  calldata         ${encodeFunctionData({ abi: INITIALIZE_ABI, functionName: 'initialize', args: r.args })}`);

  if (rpcs.length === 0) return;
  /** @type {string[]} */
  const problems = [];
  for (const rpcUrl of rpcs) {
    problems.push(...(await checkOnchain({ fetchImpl: fetch, rpcUrl, registry, chainId: cfg.importCeilings.chains[r.chain].chainId, args: r.args, proxy: r.proxy, beforeInitialize })));
  }
  if (problems.length) {
    for (const p of problems) console.error(`PREFLIGHT FAIL: ${p}`);
    process.exit(1);
  }
  console.log(
    beforeInitialize
      ? `onchain ok: ${registry} on ${r.chain} is deployed and not initialized, and the outside registry proxy matches the record, on ${rpcs.length} endpoint(s)`
      : `onchain ok: ${registry} on ${r.chain} matches the expected values on ${rpcs.length} endpoint(s)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
