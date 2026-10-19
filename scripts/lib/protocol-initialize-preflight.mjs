// @ts-check
/**
 * Read-back of a chain's `VaultFactory` initialisation, run BEFORE any vault is created, any
 * registry is wired to the factory, or any address is announced for that chain.
 *
 * WHY THIS EXISTS. Under the same-address CREATE2 deployment the factory's oracle allowlist is not
 * a constructor argument, it is set by the one-shot `VaultFactory.initialize(address[])`, which only
 * `PROTOCOL_INITIALIZER` may call (docs/DEPLOYMENT.md section 10). A factory that was initialised wrongly
 * (an empty list, which leaves the C-6 curation gate off for good, or a list that blesses an oracle
 * nobody chose, for example by a compromised initialiser key) can never be initialised again
 * (`AlreadyInitialized`), and a registry wired to it points there permanently. The contracts refuse
 * to create a vault until `initialize` has run, but they cannot judge what was passed to it. This
 * reads the chain and judges.
 *
 * WHAT IT CHECKS, per chain, on EVERY listed RPC endpoint (at least two, the project's own
 * two-provider rule for chain facts), each endpoint judged on its own so a disagreement reds:
 *   1. `eth_chainId` equals the declared chain id.
 *   2. The VaultFactory address from `contracts/config/create2-manifest.json` carries code.
 *   3. `initialized()` is true and `oracleAllowlistEnforced()` is true.
 *   4. For EVERY oracle in the plan: it carries code, and `isAllowedOracle(oracle)` is true.
 *   5. The factory's single `Initialized(address[])` event lists EXACTLY the plan's oracles. A
 *      `mapping` cannot be enumerated, so step 4 alone would pass a list that also blessed a fake
 *      oracle; the event is the only on-chain record of what was passed in.
 *
 * It signs nothing and sends nothing: every call is `eth_chainId`, `eth_getCode`, `eth_call` or
 * `eth_getLogs`. A read that fails, times out or returns something unparseable is a FAILURE, never
 * a skip: a guard that can skip is a guard that will. RECOVERY on a chain that fails step 3 or 5
 * is a new salt, not a repair: see docs/DEPLOYMENT.md section 10.
 *
 * `fetchImpl` is a parameter, never the bare global, so `scripts/test/protocol-initialize-preflight.test.mjs`
 * drives every branch against an in-memory fake chain.
 */
import { decodeAbiParameters, getAddress, isAddress, toEventSelector, toFunctionSelector } from 'viem';
import { ethCall, ethChainId, ethGetCode, rpcCall } from './chain-rpc.mjs';

export const SEL_INITIALIZED = toFunctionSelector('initialized()');
export const SEL_ENFORCED = toFunctionSelector('oracleAllowlistEnforced()');
export const SEL_IS_ALLOWED = toFunctionSelector('isAllowedOracle(address)');
export const TOPIC_INITIALIZED = toEventSelector('Initialized(address[])');

/** @typedef {{ chainId: number, rpcs: string[], oracles: string[], fromBlock?: string }} ChainPlan */

/** @param {unknown} hex @returns {boolean | null} null when it is not a clean ABI bool */
export function parseBool(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  if (/^0x0{64}$/.test(hex)) return false;
  if (/^0x0{63}1$/.test(hex)) return true;
  return null;
}

/** @param {string} a */
const pad32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/**
 * Plan shape problems, found before any network call. A plan that names no oracle is a refusal:
 * there is nothing to check against, which is the failure, not an excuse to pass.
 * @param {string} name @param {ChainPlan | undefined} plan @returns {string[]}
 */
export function planProblems(name, plan) {
  /** @type {string[]} */
  const p = [];
  if (!plan || typeof plan !== 'object') return [`${name}: no plan entry`];
  if (!Number.isInteger(plan.chainId) || plan.chainId <= 0) p.push(`${name}: chainId must be a positive integer`);
  if (!Array.isArray(plan.rpcs) || new Set(plan.rpcs).size < 2 || plan.rpcs.some((u) => typeof u !== 'string' || !u)) {
    p.push(`${name}: rpcs must list at least two distinct endpoints (the two-provider rule); a single read is not a cross-check`);
  }
  if (!Array.isArray(plan.oracles) || plan.oracles.length === 0) {
    p.push(`${name}: oracles is empty. An empty allowlist is the C-6-open state; the plan must name every oracle the chain is meant to bless`);
  } else {
    const norm = new Set();
    for (const o of plan.oracles) {
      if (typeof o !== 'string' || !isAddress(o, { strict: false })) p.push(`${name}: oracle ${String(o)} is not an address`);
      else if (/^0x0{40}$/i.test(o)) p.push(`${name}: the zero address is not an oracle`);
      else if (norm.has(o.toLowerCase())) p.push(`${name}: oracle ${o} is listed twice`);
      else norm.add(o.toLowerCase());
    }
  }
  return p;
}

/**
 * One endpoint, one chain. Every read must succeed and say the right thing.
 * @param {{ fetchImpl: typeof fetch, rpcUrl: string, name: string, plan: ChainPlan, factory: string }} a
 * @returns {Promise<string[]>}
 */
export async function checkEndpoint({ fetchImpl, rpcUrl, name, plan, factory }) {
  /** @type {string[]} */
  const problems = [];
  const at = `${name} @ ${rpcUrl}`;
  const fail = (/** @type {string} */ m) => problems.push(`${at}: ${m}`);

  const cid = await ethChainId(fetchImpl, rpcUrl);
  if (!cid.ok) {
    fail(`could not read eth_chainId (${cid.reason}); nothing was verified`);
    return problems;
  }
  if (typeof cid.result !== 'string' || Number(BigInt(cid.result)) !== plan.chainId) {
    fail(`eth_chainId is ${String(cid.result)}, the plan declares ${plan.chainId}; this endpoint is a different chain`);
    return problems;
  }

  const code = await ethGetCode(fetchImpl, rpcUrl, factory);
  if (!code.ok) {
    fail(`could not read code at the factory ${factory} (${code.reason})`);
    return problems;
  }
  if (typeof code.result !== 'string' || code.result === '0x' || code.result.length <= 2) {
    fail(`no code at the manifest's VaultFactory ${factory}: it is not deployed on this chain yet, so there is nothing to have initialised`);
    return problems;
  }

  /** @param {string} label @param {string} data @param {boolean} want */
  const expectBool = async (label, data, want) => {
    const r = await ethCall(fetchImpl, rpcUrl, factory, data);
    if (!r.ok) return fail(`${label}: call failed (${r.reason}); the read reached no verdict`);
    const b = parseBool(r.result);
    if (b === null) return fail(`${label}: returned ${String(r.result)}, not an ABI bool`);
    if (b !== want) fail(`${label} is ${b}, expected ${want}`);
  };

  await expectBool('factory.initialized()', SEL_INITIALIZED, true);
  await expectBool('factory.oracleAllowlistEnforced()', SEL_ENFORCED, true);

  for (const o of plan.oracles) {
    const oc = await ethGetCode(fetchImpl, rpcUrl, o);
    if (!oc.ok) fail(`oracle ${o}: could not read code (${oc.reason})`);
    else if (typeof oc.result !== 'string' || oc.result === '0x') fail(`oracle ${o} carries no code on this chain`);
    await expectBool(`factory.isAllowedOracle(${o})`, SEL_IS_ALLOWED + pad32(o), true);
  }

  const logs = await rpcCall(fetchImpl, rpcUrl, 'eth_getLogs', [
    { address: factory, topics: [TOPIC_INITIALIZED], fromBlock: plan.fromBlock ?? '0x0', toBlock: 'latest' },
  ]);
  if (!logs.ok) {
    fail(`could not read the Initialized event (${logs.reason}); the exact-set check reached no verdict. If the endpoint limits log ranges, set fromBlock to the factory's deploy block`);
    return problems;
  }
  if (!Array.isArray(logs.result) || logs.result.length !== 1) {
    fail(`expected exactly one Initialized event from the factory, found ${Array.isArray(logs.result) ? logs.result.length : 'a non-list'}. If it is zero the endpoint may not reach back to the initialisation block: set fromBlock`);
    return problems;
  }
  /** @type {string[]} */
  let blessed;
  try {
    const [list] = decodeAbiParameters([{ type: 'address[]' }], logs.result[0].data);
    blessed = /** @type {string[]} */ ([...list]);
  } catch (e) {
    fail(`the Initialized event did not decode as address[] (${/** @type {Error} */ (e).message})`);
    return problems;
  }
  const want = new Set(plan.oracles.map((o) => getAddress(o)));
  const got = new Set(blessed.map((o) => getAddress(o)));
  for (const g of got) if (!want.has(g)) fail(`the factory was initialised blessing ${g}, which is NOT in the plan`);
  for (const w of want) if (!got.has(w)) fail(`the plan's oracle ${w} is missing from the Initialized event`);
  return problems;
}

/**
 * One chain on every endpoint.
 * @param {{ fetchImpl: typeof fetch, name: string, plan: ChainPlan, factory: string }} a
 * @returns {Promise<string[]>}
 */
export async function checkChain({ fetchImpl, name, plan, factory }) {
  const shape = planProblems(name, plan);
  if (shape.length) return shape;
  /** @type {string[]} */
  const problems = [];
  for (const rpcUrl of plan.rpcs) problems.push(...(await checkEndpoint({ fetchImpl, rpcUrl, name, plan, factory })));
  return problems;
}

/**
 * The whole plan. `only` narrows to one chain and an unknown name is a failure.
 * @param {{ fetchImpl: typeof fetch, plan: { chains?: Record<string, ChainPlan> }, manifest: { contracts?: Record<string, { address?: string }> }, only?: string }} a
 * @returns {Promise<{ ok: boolean, problems: string[], checked: string[], factory: string }>}
 */
export async function checkPlan({ fetchImpl, plan, manifest, only }) {
  const factory = manifest?.contracts?.VaultFactory?.address;
  if (typeof factory !== 'string' || !isAddress(factory)) {
    return { ok: false, problems: ['the manifest has no VaultFactory address'], checked: [], factory: '' };
  }
  const chains = plan?.chains;
  if (!chains || typeof chains !== 'object' || Object.keys(chains).length === 0) {
    return { ok: false, problems: ['the plan names no chain'], checked: [], factory };
  }
  const names = only === undefined ? Object.keys(chains) : [only];
  /** @type {string[]} */
  const problems = [];
  for (const name of names) {
    problems.push(...(await checkChain({ fetchImpl, name, plan: chains[name], factory })));
  }
  return { ok: problems.length === 0, problems, checked: names, factory };
}
