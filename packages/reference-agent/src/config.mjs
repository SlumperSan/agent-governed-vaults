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
 * Policy knobs are plain data so they can be diffed, committed, and reasoned about without
 * reading code. See docs/REFERENCE-AGENT.md for what each one means in protocol terms.
 */

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
    rpcUrl: null,
    chainId: 84532,
    chainName: 'base-sepolia',
    governance: null,
    /** SubVaultRegistry — source of the STACKED fee figures (sub-vault fees compound). */
    subvaultRegistry: null,
    /** USDC address — the EIP-712 verifyingContract for x402 authorizations. */
    usdc: null,
    usdcName: 'USD Coin',
    usdcVersion: '2',
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

/** @param {object} [overrides] @returns {any} */
export function loadConfig(overrides = {}) {
  const cfg = merge(DEFAULT_CONFIG, overrides);
  if (cfg.mode !== 'dry-run' && cfg.mode !== 'execute')
    throw new ConfigError(`mode must be 'dry-run' or 'execute', got ${JSON.stringify(cfg.mode)}`);
  // Validate the money knobs eagerly so a typo fails at startup, not at the first paid read.
  toBaseUnits(cfg.api.payments.maxSessionSpendUsdc);
  toBaseUnits(cfg.api.payments.maxSingleReadUsdc);
  toBaseUnits(cfg.policy.join.depositUsdc);
  toBaseUnits(cfg.policy.join.minFreeCapacityUsdc);
  toBaseUnits(cfg.policy.join.minOperatorNetRealizedUsdc);
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

const KEYISH = /^(privateKey|privkey|secret|mnemonic|seed|key|pk|signature)$/i;

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
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? '[redacted:32-byte-hex]' : value;
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
