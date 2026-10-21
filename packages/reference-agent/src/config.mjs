// @ts-check
/**
 * Configuration, the dry-run/execute gate, and secret-safe serialization.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **Dry-run is the default.** `execute` mode requires BOTH an operator-injected viem account
 *     AND `AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS=yes`. Missing either one is a hard refusal at
 *     startup, not a downgrade — a silent fall back to dry-run would teach an operator that the
 *     env var is optional, and the one time it mattered they would be wrong.
 *  2. **No key ever enters this process's data.** The agent takes an *account object* (viem's
 *     `privateKeyToAccount(...)` or any `{ address, signMessage, … }`), never a hex key, never a
 *     path to one. `redact()` is what every log line and config dump goes through, and it reduces
 *     an account to `{ address }` — a test asserts a key-shaped value cannot survive it.
 *
 * Chains: the default is Base Sepolia. `chain.preset: 'arc-mainnet'` fills the whole chain block
 * (chain id, native currency, RPC list, contract addresses, USDC domain) and the default deposit
 * from `presets/arc-mainnet.json`, a file generated from the deployment record by
 * `scripts/build-agent-preset.mjs`. Anything you set beside the preset wins over it, except a
 * `chainId` that disagrees with the preset, which is refused.
 *
 * With a preset and no `api.baseUrl`, the vault list and the operator track record come from the
 * chain alone (`discovery` below); setting `api.baseUrl` beside the preset keeps the API source.
 *
 * Policy knobs are plain data so they can be diffed, committed, and reasoned about without
 * reading code. See docs/REFERENCE-AGENT.md for what each one means in protocol terms.
 */

// A static JSON import, not `node:fs`: apps/vaults-ui bundles this module for the browser, where a
// file read does not exist. Each preset is listed here by name so the bundle carries exactly the
// presets that ship.
import arcMainnet from '../presets/arc-mainnet.json' with { type: 'json' };

/** Values `policy.crank.scope` takes. */
export const CRANK_SCOPES = Object.freeze(['held', 'all', 'off']);

/** USDC has 6 decimals; policy numbers are written in whole USDC and scaled here. */
export const USDC_DECIMALS = 6n;
export const USDC_UNIT = 10n ** USDC_DECIMALS;

/** @param {string|number} usdc @returns {bigint} base units */
export function toBaseUnits(usdc) {
  const s = String(usdc).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ConfigError(`not a positive decimal amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > Number(USDC_DECIMALS)) throw new ConfigError(`more than 6 decimals: ${s}`);
  return BigInt(whole) * USDC_UNIT + BigInt(frac.padEnd(Number(USDC_DECIMALS), '0') || '0');
}

/** @param {bigint} base @returns {string} human USDC, e.g. "1.5" */
export function fromBaseUnits(base) {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const frac = (v % USDC_UNIT).toString().padStart(Number(USDC_DECIMALS), '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (v / USDC_UNIT) + (frac ? '.' + frac : '');
}

/** Presets that ship in `presets/`. Base Sepolia is the default and needs none. */
const PRESET_FILES = Object.freeze({ 'arc-mainnet': arcMainnet });
export const CHAIN_PRESETS = Object.freeze(Object.keys(PRESET_FILES));

/**
 * Defaults are deliberately conservative: attested operators only, positive track record, tight
 * fee ceilings, a small deposit, and `allowSkipWindow: false`. An operator who wants the agent to
 * take more risk has to say so in config, in writing.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 'dry-run' logs intended transactions and signs none of them. 'execute' is gated (see gateMode). */
  mode: 'dry-run',

  api: {
    baseUrl: 'http://127.0.0.1:8402',
    /** x402: whether the agent may sign payment authorizations for metered reads at all. */
    payments: { enabled: true, maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' },
  },

  chain: {
    /** Name of a file in `presets/` that fills this block, or null for the Base Sepolia defaults. */
    preset: null,
    rpcUrl: null,
    /** Every RPC the preset names; `rpcUrl` is the first. null unless a preset set it. */
    rpcUrls: null,
    chainId: 84532,
    chainName: 'base-sepolia',
    /** The chain's gas asset, for the viem chain object. Base Sepolia pays gas in Ether. */
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    governance: null,
    /** VaultFactory, and the pointer a later vault-discovery step enumerates from. */
    factory: null,
    vaultList: null,
    operatorRegistry: null,
    /** SubVaultRegistry — source of the STACKED fee figures (sub-vault fees compound). */
    subvaultRegistry: null,
    /** USDC address — the EIP-712 verifyingContract for x402 authorizations. */
    usdc: null,
    /**
     * The USDC EIP-712 domain. These MUST match what the token reports on `chainId` above, and
     * FiatTokenV2 deployments disagree: Base Sepolia's `0x036CbD…F7e` reports `"USDC"`, while
     * mainnet USDC reports `"USD Coin"`. Since this config defaults to base-sepolia (84532), the
     * default here is `"USDC"` — pairing it with `"USD Coin"` produced a valid signature over the
     * wrong struct hash, recovering to a stranger and failing as an opaque `signer-mismatch`.
     *
     * Change `chainId` and you must change these too (or set `preset: 'arc-mainnet'`, which fills
     * them from the token's own reads). Read them from the token rather than
     * guessing: `cast call <usdc> 'name()(string)'` / `'version()(string)'`, and confirm the pair
     * reproduces `DOMAIN_SEPARATOR()`. See docs/X402-LIVE-REPORT.md §6.
     */
    usdcName: 'USDC',
    usdcVersion: '2',
  },

  /**
   * Chain-only discovery (no API). Used when `chain.preset` is set and `api.baseUrl` is not: the
   * vault list is read from the factory. The factory's array only grows, so the agent looks at a
   * window of the NEWEST `maxVaults` entries, `pageSize` reads at a time, and says when the window
   * is smaller than the list. Each vault costs well over a dozen reads a tick, so keep `maxVaults`
   * modest against `policy.timing.tickIntervalSec`. `include` names vaults that are always read, whether or
   * not they fall in the window: put every vault the agent holds there once the factory outgrows it.
   */
  discovery: {
    maxVaults: 25,
    pageSize: 10,
    include: [],
    /**
     * The outside-member track record is read from the OperatorRegistry's RealizationRecorded logs
     * (chain.mjs, readRealizations). Bounds, measured on both Arc RPCs 2026-10-18: `pageBlocks` is
     * the smaller provider limit (10,000); `maxPagesPerTick` caps the log requests one tick spends
     * across all vaults (the scan resumes where it stopped, so a vault created 4.2 million blocks ago
     * is read in a few ticks); `maxBlocks` is how far behind the head a scan will start, and anything
     * older is a named gap (about 117 days of Arc blocks at 0.51 s); `pacingMs` spaces requests,
     * because unspaced ones are rate limited, and 1,000 ms is the pause arc.io sustained.
     */
    logs: { pageBlocks: 10000, maxPagesPerTick: 120, maxBlocks: 20000000, pacingMs: 1000 },
  },

  policy: {
    join: {
      /** operatorId 0 = unattested = scam-quarantine signal (see the listVaults projection). */
      requireAttestedOperator: true,
      /** Operator leaderboard net realized (gain - loss) must be at least this, in USDC. */
      minOperatorNetRealizedUsdc: '0',
      /** Reject an operator with no realizations at all — "not yet negative" is not a record. */
      requireProvenOperator: true,
      /** Stacked performance-fee ceiling, bps. Protocol base is 1000 (10%); sub-vaults stack. */
      maxPerfFeeBps: 1000,
      /** Exit-fee ceiling for THIS agent, bps. Protocol caps at 100 (1%) and decays with tenure. */
      maxExitFeeBps: 100,
      /** How much to deposit on a join decision, USDC. */
      depositUsdc: '25',
      /** Refuse to join unless at least this much room remains under the capacity cap, USDC. */
      minFreeCapacityUsdc: '25',
      /** Sub-vault depth ceiling (protocol hard cap is 3); 0 = top-level vaults only. */
      maxDepth: 0,
      /** Never hold positions in more than this many vaults at once. */
      maxConcurrentVaults: 3,
      /**
       * A named override profile, or null. `'unproven-operator'` lets the agent join a vault whose
       * operator has no realized gain or loss yet (see JOIN_PROFILES below for exactly what it changes
       * and what it keeps). The default stays null: the agent refuses such a vault.
       */
      profile: null,
      /**
       * Addresses to leave out of the outside-member track record, lower-case or checksummed: the
       * `address` fields of docs/seeded-addresses.json, which run.mjs loads with --disclosed=<path>.
       * The list can only REMOVE realizations from the figure, never add trust, so an agent has
       * no need to trust whoever maintains it. When the list is not empty (or the profile is on) the
       * agent reads the operator's RealizationRecorded logs and applies a second check to that figure.
       */
      disclosedAddresses: [],
    },

    exit: {
      /** Exit if NAV/share falls this far below the agent's entry mark, bps. */
      maxDrawdownBps: 1000,
      /** Exit on an oracle-freeze warning. NOTE: a *frozen* oracle freezes exits too — this is a
       *  pre-emptive reaction to a staleness WARNING, and it is best-effort by construction. */
      onOracleFreezeWarning: true,
      /** Exit if the operator's leaderboard net realized turns negative. */
      onOperatorNetNegative: true,
    },

    vote: {
      /** Which pluggable evaluator judges Rebalance proposals. See evaluators.mjs. */
      evaluator: 'naive-drift-band',
      /** naive-drift-band: support a rebalance only when observed drift exceeds this band, bps. */
      driftBandBps: 500,
      /** naive-drift-band: reject above this — that is not a rebalance, that is a new mandate. */
      maxDriftBandBps: 5000,
      /** Vote against (rather than abstain) when the evaluator cannot form a view. The default is
       *  to abstain by NOT committing: an uninformed vote still moves the tally. */
      voteAgainstWhenUnknown: false,
      /** Only vote on Rebalance (ptype 0). RuleChange/ChildAllocation need a human. */
      proposalTypes: [0],
    },

    timing: {
      /** Reveal this long before the reveal deadline. Covers RPC latency, a reorg, and a restart. */
      revealSafetyMarginSec: 1800,
      /** Wait this long past `availableAt` before calling activate — clock-skew tolerance. */
      activateGraceSec: 60,
      /** Poll interval for the perceive→decide→act loop. */
      tickIntervalSec: 60,
    },

    /**
     * Finishing a round, which anyone may do: `finalize` (reveal window over), `execute` (passed,
     * inside its window) and `markExpired` (passed, window over). Each takes the proposal id
     * alone, except `execute`, which also takes the payload bytes the chain never stores, so it
     * runs only for an `actionHash` listed in `knownPayloads` whose keccak256 matches (checked each
     * tick, where viem is loaded; see payloads.mjs). Every send is simulated first.
     *
     * `scope`: 'held' cranks only vaults where this agent has shares or a pending deposit (the
     * gas is paid in the chain's gas asset, for other members' benefit as well); 'all' cranks
     * every vault the agent reads; 'off' cranks nothing. A held vault outside the discovery window
     * is not read, so name it in `discovery.include`.
     * `markExpired` is bookkeeping only (the status refreshes itself on the next proposal), so it
     * is off by default.
     */
    crank: {
      scope: 'held',
      finalize: true,
      execute: true,
      markExpired: false,
      /** actionHash (lowercase 0x, 32 bytes) => payload (0x hex) whose keccak256 is that hash. */
      knownPayloads: {},
    },
  },

  /** Everything here is irreversible, opt-in, and off. */
  danger: {
    /** skipWindow() is once-per-agent-per-vault and CANNOT be undone (ARCHITECTURE §5). The
     *  planner never emits it unless this is true — and even then it is a config decision an
     *  operator made deliberately, not an autonomous one. */
    allowSkipWindow: false,
  },
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Deep merge of plain objects; arrays and scalars replace wholesale. */
function merge(base, over) {
  if (over === undefined) return base;
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out;
}

/**
 * The preset file as a config fragment. Addresses are lower-cased the way `run.mjs` lower-cases
 * the same flags, so a comparison against a chain read never trips on checksum casing.
 * @param {string} name @returns {any}
 */
export function presetFragment(name) {
  if (!CHAIN_PRESETS.includes(name))
    throw new ConfigError(`unknown chain preset ${JSON.stringify(name)}; the presets are ${CHAIN_PRESETS.join(', ')}`);
  const p = PRESET_FILES[name];
  const lc = (a) => a.toLowerCase();
  return {
    chain: {
      preset: name,
      rpcUrl: p.rpcUrls[0],
      rpcUrls: p.rpcUrls,
      chainId: p.chainId,
      chainName: p.chainName,
      nativeCurrency: p.nativeCurrency,
      governance: lc(p.contracts.governance),
      factory: lc(p.contracts.factory),
      vaultList: { ...p.vaultList, contract: lc(p.vaultList.contract) },
      operatorRegistry: lc(p.contracts.operatorRegistry),
      subvaultRegistry: lc(p.contracts.subvaultRegistry),
      usdc: lc(p.contracts.usdc),
      usdcName: p.usdcDomain.name,
      usdcVersion: p.usdcDomain.version,
    },
    policy: { join: { depositUsdc: p.depositUsdc } },
  };
}

/** The one named join profile. Its name is the value of `policy.join.profile`. */
export const UNPROVEN_OPERATOR_PROFILE = 'unproven-operator';

/**
 * Named, opt-in overrides of the join policy. A profile is a config fragment merged BEFORE the
 * caller's own keys, the way a chain preset is, so a key set beside it wins.
 *
 *  - `unproven-operator` sets `requireProvenOperator: false`, so a vault whose operator has no
 *    realized gain or loss can be joined; that is the state of every new vault. It changes nothing
 *    else in the gates: the operator must still be attested at the registry, the net must still clear
 *    its floor, and the fee, capacity, depth and NAV gates all stand. Two more things are NOT in the
 *    fragment because they are enforced elsewhere: `decideJoin` deposits the vault's own minimum and
 *    refuses a vault whose minimum is above `depositUsdc` (the vault's creator sets that minimum, so
 *    `depositUsdc` stays the ceiling), and `loadConfig` refuses the profile with
 *    `policy.exit.onOperatorNetNegative` off (the exit trigger that is the agent's way out when an
 *    unproven operator turns out to lose money).
 */
export const JOIN_PROFILES = Object.freeze({
  [UNPROVEN_OPERATOR_PROFILE]: Object.freeze({ policy: { join: { requireProvenOperator: false } } }),
});

/** @param {object} [overrides] @returns {any} */
export function loadConfig(overrides = {}) {
  const presetName = /** @type {any} */ (overrides).chain?.preset;
  const profileName = /** @type {any} */ (overrides).policy?.join?.profile;
  let base = DEFAULT_CONFIG;
  if (presetName !== undefined && presetName !== null) {
    const fragment = presetFragment(presetName);
    const chosen = /** @type {any} */ (overrides).chain?.chainId;
    // The USDC domain and every address belong to the preset's chain; a different id beside it
    // would pair them with a chain they are not on.
    if (chosen !== undefined && Number(chosen) !== fragment.chain.chainId)
      throw new ConfigError(`chain.preset ${presetName} is chain ${fragment.chain.chainId}, but chain.chainId is ${chosen}; drop one of them`);
    const over = /** @type {any} */ (overrides).chain ?? {};
    // A null or empty rpcUrl is not a setting that wins over the preset, it is the stub-fixture
    // trigger in run.mjs; beside a preset it would silently serve fixture data as chain reads.
    if (over.rpcUrl === null || over.rpcUrl === '')
      throw new ConfigError(`chain.rpcUrl is ${JSON.stringify(over.rpcUrl)} beside chain.preset ${presetName}; drop it to use the preset's RPC, or give a URL`);
    // The EIP-712 name and version belong to the token at the preset's USDC address. A different
    // token keeps them only by accident, and a wrong pair signs over the wrong struct hash.
    if (over.usdc !== undefined && String(over.usdc).toLowerCase() !== fragment.chain.usdc && (over.usdcName === undefined || over.usdcVersion === undefined))
      throw new ConfigError(`chain.usdc differs from chain.preset ${presetName}'s USDC; set chain.usdcName and chain.usdcVersion beside it, read from that token`);
    base = merge(DEFAULT_CONFIG, fragment);
  }
  if (profileName !== undefined && profileName !== null) {
    if (!Object.hasOwn(JOIN_PROFILES, profileName))
      throw new ConfigError(`unknown policy.join.profile ${JSON.stringify(profileName)}; the profiles are ${Object.keys(JOIN_PROFILES).join(', ')}`);
    base = merge(base, JOIN_PROFILES[profileName]);
  }
  let cfg = merge(base, overrides);
  // A preset with no API URL of its own means chain-only discovery. The localhost default belongs
  // to the Base Sepolia demo; keeping it beside a preset would aim the agent at a port nobody opened.
  if (presetName !== undefined && presetName !== null && !(/** @type {any} */ (overrides).api?.baseUrl))
    cfg = { ...cfg, api: { ...cfg.api, baseUrl: null } };
  if (cfg.mode !== 'dry-run' && cfg.mode !== 'execute')
    throw new ConfigError(`mode must be 'dry-run' or 'execute', got ${JSON.stringify(cfg.mode)}`);
  // Validate the money knobs eagerly so a typo fails at startup, not at the first paid read.
  toBaseUnits(cfg.api.payments.maxSessionSpendUsdc);
  toBaseUnits(cfg.api.payments.maxSingleReadUsdc);
  toBaseUnits(cfg.policy.join.depositUsdc);
  toBaseUnits(cfg.policy.join.minFreeCapacityUsdc);
  toBaseUnits(cfg.policy.join.minOperatorNetRealizedUsdc);
  for (const k of /** @type {const} */ (['maxVaults', 'pageSize']))
    if (!Number.isInteger(cfg.discovery[k]) || cfg.discovery[k] < 1)
      throw new ConfigError(`discovery.${k} must be a positive integer, got ${JSON.stringify(cfg.discovery[k])}`);
  if (!Array.isArray(cfg.discovery.include) || !cfg.discovery.include.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)))
    throw new ConfigError('discovery.include must be an array of 0x vault addresses');
  const crank = cfg.policy.crank;
  if (!CRANK_SCOPES.includes(crank.scope))
    throw new ConfigError(`policy.crank.scope must be one of ${CRANK_SCOPES.join(', ')}, got ${JSON.stringify(crank.scope)}`);
  for (const k of /** @type {const} */ (['finalize', 'execute', 'markExpired']))
    if (typeof crank[k] !== 'boolean') throw new ConfigError(`policy.crank.${k} must be true or false, got ${JSON.stringify(crank[k])}`);
  if (!crank.knownPayloads || typeof crank.knownPayloads !== 'object' || Array.isArray(crank.knownPayloads))
    throw new ConfigError('policy.crank.knownPayloads must be an object of actionHash => payload');
  for (const [hash, payload] of Object.entries(crank.knownPayloads)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ConfigError(`policy.crank.knownPayloads key ${JSON.stringify(hash)} is not a 32-byte 0x hash`);
    if (typeof payload !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payload))
      throw new ConfigError(`policy.crank.knownPayloads[${hash}] is not 0x hex bytes`);
  }
  for (const k of /** @type {const} */ (['pageBlocks', 'maxPagesPerTick', 'maxBlocks']))
    if (!Number.isInteger(cfg.discovery.logs[k]) || cfg.discovery.logs[k] < 1)
      throw new ConfigError(`discovery.logs.${k} must be a positive integer, got ${JSON.stringify(cfg.discovery.logs[k])}`);
  if (!Number.isInteger(cfg.discovery.logs.pacingMs) || cfg.discovery.logs.pacingMs < 0)
    throw new ConfigError(`discovery.logs.pacingMs must be a non-negative integer, got ${JSON.stringify(cfg.discovery.logs.pacingMs)}`);
  const disclosed = cfg.policy.join.disclosedAddresses;
  if (!Array.isArray(disclosed) || !disclosed.every((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)))
    throw new ConfigError('policy.join.disclosedAddresses must be an array of 0x addresses');
  if (cfg.policy.join.profile === UNPROVEN_OPERATOR_PROFILE && cfg.policy.exit.onOperatorNetNegative !== true)
    throw new ConfigError(
      `policy.join.profile ${UNPROVEN_OPERATOR_PROFILE} keeps the exit on a negative operator net as the way out of an operator with no record; policy.exit.onOperatorNetNegative must stay true`,
    );
  return cfg;
}

/** The phrase an operator must set to unlock execute mode. Deliberately unmistakable. */
export const EXECUTE_ENV_VAR = 'AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS';
export const EXECUTE_ENV_VALUE = 'yes';

/**
 * The execute gate. Returns the resolved mode or throws — it never silently downgrades.
 *
 * @param {Object} p
 * @param {string} p.mode                        requested mode
 * @param {{address?:string}|null} [p.account]   operator-injected viem account (NOT a key)
 * @param {Record<string,string|undefined>} [p.env]
 * @returns {{mode:'dry-run'|'execute', signsTransactions:boolean}}
 */
export function gateMode({ mode, account = null, env = {} }) {
  if (mode === 'dry-run') return { mode: 'dry-run', signsTransactions: false };
  if (mode !== 'execute') throw new ConfigError(`unknown mode ${JSON.stringify(mode)}`);

  const problems = [];
  if (!account || typeof account.address !== 'string')
    problems.push('no viem account was injected (execute mode needs `account` — an account object, never a private key)');
  if (env[EXECUTE_ENV_VAR] !== EXECUTE_ENV_VALUE)
    problems.push(`${EXECUTE_ENV_VAR} is not set to "${EXECUTE_ENV_VALUE}"`);

  if (problems.length)
    throw new ConfigError(
      'refusing to start in execute mode:\n  - ' +
        problems.join('\n  - ') +
        '\nExecute mode signs real transactions that move real funds. Fix both conditions or run in dry-run.',
    );
  return { mode: 'execute', signsTransactions: true };
}

// `approval` is deliberately absent: the dry-run record has an `approval` field (act.mjs) and
// this pattern is anchored, so adding it would blank a field the operator needs to read.
const KEYISH = /^(privateKey|privkey|secret|mnemonic|seed|key|pk|signature|sessionKey|sessionPrivateKey|serializedSessionKey|serializedAccount)$/i;

// Any URL inside a string. An Alchemy-style RPC URL carries its API key in the path, and viem
// request errors embed the URL they called, so a URL is cut to scheme plus host wherever it
// appears in a line, and userinfo (`user:pass@`) is dropped with the rest.
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#'"`<>]+)([^\s'"`<>]*)/gi;

/** `https://x.g.alchemy.com/v2/KEY` → `https://x.g.alchemy.com`, anywhere in `text`. */
export function redactUrls(text) {
  return String(text).replace(URL_IN_TEXT, (_, scheme, authority) => scheme + authority.replace(/^.*@/, ''));
}

/**
 * Reduce anything log-bound to something safe to print. Accounts collapse to their public
 * address; key-shaped property names and bare 32-byte hex values collapse to a marker. Every log
 * line and config dump goes through this — see test/config.test.mjs for the adversarial cases.
 *
 * @param {any} value @param {number} [depth]
 */
export function redact(value, depth = 0) {
  if (depth > 8) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[fn]';
  if (typeof value === 'string') {
    // A raw 32-byte hex string in a log is either a key or indistinguishable from one at a glance.
    // Salts and commitments are shown via explicit helpers (see log.mjs), not through redact().
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? '[redacted:32-byte-hex]' : redactUrls(value);
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  // A viem account (or anything carrying a signer) is reduced to its public address.
  const isSigner =
    typeof value.address === 'string' &&
    (typeof value.signMessage === 'function' ||
      typeof value.sign === 'function' ||
      typeof value.signTypedData === 'function' ||
      typeof value.signTransaction === 'function');
  if (isSigner) return { address: value.address, _: '[account: signer withheld]' };

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = KEYISH.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}
