// @ts-check
/**
 * Per-session x402 spend cap.
 *
 * The agent pays real USDC for every metered read. Without a cap, a loop bug, a retry storm, or a
 * hostile API that raises its price mid-session drains the wallet a cent at a time. AGENT-QUICKSTART
 * §1 recommends exactly this: wrap the signer with a per-task budget and a per-tx cap.
 *
 * Enforced at two layers, because one is not enough:
 *
 *  1. **Pre-call gate** (`canAfford`) — the perceive step asks before making a paid request, so an
 *     exhausted budget SKIPS the read cleanly and the loop still decides on what it already has.
 *     This is where the coherent log line comes from.
 *  2. **Signer backstop** (`guardSigner`) — the SDK runs 402 → sign → retry inside one call, so by
 *     the time `request()` returns, the authorization is already signed. The wrapped signer reads
 *     `typedData.message.value` and throws before producing a signature. A price the agent did not
 *     anticipate, or a code path that forgot the pre-call gate, dies here instead of paying.
 *
 * A signature IS the spend under EIP-3009: once signed, a facilitator can settle it. So the ledger
 * records at signature time, not at HTTP 200.
 */

import { fromBaseUnits, toBaseUnits } from './config.mjs';

export class BudgetExceededError extends Error {
  /** @param {string} message @param {{spent:bigint, cap:bigint, attempted:bigint}} detail */
  constructor(message, detail) {
    super(message);
    this.name = 'BudgetExceededError';
    this.detail = detail;
  }
}

/**
 * @param {Object} p
 * @param {string|number} p.maxSessionSpendUsdc
 * @param {string|number} p.maxSingleReadUsdc
 * @param {boolean} [p.enabled]  when false, no payment is ever authorized (free routes only)
 */
export function createBudget({ maxSessionSpendUsdc, maxSingleReadUsdc, enabled = true }) {
  const cap = toBaseUnits(maxSessionSpendUsdc);
  const perRead = toBaseUnits(maxSingleReadUsdc);
  let spent = 0n;
  /** @type {Array<{amount:bigint, label:string}>} */
  const ledger = [];

  /**
   * May the agent pay `amount` base units right now? Never throws — the caller degrades.
   * @param {bigint|string|number} amount
   * @returns {{ok:boolean, reason?:string}}
   */
  function canAfford(amount) {
    if (!enabled) return { ok: false, reason: 'x402 payments are disabled by config (free routes only)' };
    const a = BigInt(amount);
    if (a > perRead)
      return {
        ok: false,
        reason: `single read costs $${fromBaseUnits(a)} > per-read cap $${fromBaseUnits(perRead)}`,
      };
    if (spent + a > cap)
      return {
        ok: false,
        reason: `session spend cap reached: spent $${fromBaseUnits(spent)} of $${fromBaseUnits(cap)}, this read needs $${fromBaseUnits(a)}`,
      };
    return { ok: true };
  }

  /**
   * Record a spend, or throw if it breaches a cap. Called at SIGNATURE time.
   * @param {bigint|string|number} amount @param {string} [label]
   */
  function charge(amount, label = 'metered read') {
    const a = BigInt(amount);
    const verdict = canAfford(a);
    if (!verdict.ok) throw new BudgetExceededError(`x402 spend refused — ${verdict.reason}`, { spent, cap, attempted: a });
    spent += a;
    ledger.push({ amount: a, label });
    return { spent, remaining: cap - spent };
  }

  /**
   * Wrap an EIP-712 signer so no x402 authorization can be signed outside the budget. The value
   * comes from the typed data itself, so an inflated challenge cannot sneak past by lying to the
   * pre-call gate.
   *
   * @param {(typedData:object) => Promise<string>} sign
   * @param {string} [label]
   */
  function guardSigner(sign, label = 'metered read') {
    return async (typedData) => {
      const value = typedData?.message?.value;
      if (value === undefined || value === null)
        throw new BudgetExceededError('x402 spend refused — typed data carries no value to check', { spent, cap, attempted: 0n });
      charge(BigInt(value), label);
      return sign(typedData);
    };
  }

  return {
    canAfford,
    charge,
    guardSigner,
    get spent() {
      return spent;
    },
    get cap() {
      return cap;
    },
    get remaining() {
      return cap - spent;
    },
    get enabled() {
      return enabled;
    },
    /** Human summary for the session narrative. */
    summary() {
      return {
        enabled,
        spentUsdc: fromBaseUnits(spent),
        capUsdc: fromBaseUnits(cap),
        remainingUsdc: fromBaseUnits(cap - spent),
        paidReads: ledger.length,
      };
    },
    ledger: () => ledger.map((e) => ({ amountUsdc: fromBaseUnits(e.amount), label: e.label })),
  };
}
