// @ts-check
/**
 * Pluggable proposal evaluators.
 *
 * An evaluator answers one question — "should this agent support this Rebalance proposal?" — and
 * is the seam where a real strategy replaces the reference one. The contract is deliberately tiny
 * and pure:
 *
 *     evaluate({ proposal, vault, chain, config, nowSec }) => { support: true|false|null, reason, detail }
 *
 * `support: null` means "no view" — the agent then abstains by NOT committing, which is the
 * correct conservative behaviour: an uninformed vote is not neutral, it moves the tally.
 *
 * ── The honest limitation, stated once and repeated in the docs ──
 * A proposal commits to `actionHash`, the keccak of an execution payload (Governance.sol:465). The
 * payload itself is not on-chain until `execute`. So NO evaluator reading only chain state can
 * know *what* a rebalance does — it can only judge whether the vault currently *looks like* it
 * needs one. The shipped evaluator does exactly that and says so in every reason string. An
 * operator with an out-of-band payload source should supply `knownActions` (actionHash ⇒
 * description) and set `requireKnownAction: true`, which turns unknown payloads into abstentions.
 */

const BPS = 10000n;

/**
 * The reference evaluator: a naive drift band over observable capital placement.
 *
 * Signal: the fraction of NAV sitting idle in USDC rather than deployed into the basket. A vault
 * that has drifted out of its index into idle stables is a genuine rebalance candidate, and unlike
 * target weights (which live in a mandate the chain does not publish) that fraction is directly
 * readable — `idleUsdc` against `totalAssets`.
 *
 * Band logic:
 *   drift <  driftBandBps      → against: no meaningful drift, a rebalance is churn and fees
 *   drift within the band      → for:     the vault has drifted enough to be worth correcting
 *   drift >  maxDriftBandBps   → against: that is not a correction, that is a different mandate
 *
 * This is a demonstration of the plug point. It is not a strategy and it is not advice.
 */
export const naiveDriftBand = Object.freeze({
  name: 'naive-drift-band',

  /**
   * @param {Object} p
   * @param {any} p.proposal   decoded proposal (see chain.decodeProposal)
   * @param {any} p.chain      chain read for the vault (navPerShareWad, totalAssetsUsdc, idleUsdc…)
   * @param {any} p.config     resolved policy.vote config
   */
  evaluate({ proposal, chain, config }) {
    const known = config.knownActions ?? {};
    const action = proposal?.actionHash ? known[String(proposal.actionHash).toLowerCase()] : undefined;
    if (config.requireKnownAction && action === undefined)
      return {
        support: null,
        reason: 'abstain: the execution payload behind this actionHash is unknown and requireKnownAction is set',
        detail: { actionHash: proposal?.actionHash },
      };

    const total = chain?.totalAssetsUsdc;
    const idle = chain?.idleUsdc;
    if (total == null || idle == null || BigInt(total) === 0n)
      return {
        support: null,
        reason: 'abstain: cannot read the vault’s idle/total balance, so no drift signal exists',
        detail: { totalAssetsUsdc: total ?? null, idleUsdc: idle ?? null },
      };

    const driftBps = Number((BigInt(idle) * BPS) / BigInt(total));
    const band = Number(config.driftBandBps ?? 500);
    const maxBand = Number(config.maxDriftBandBps ?? 5000);
    const caveat = action === undefined ? ' (action payload NOT verified — actionHash is opaque)' : ` (action: ${action})`;

    if (driftBps > maxBand)
      return {
        support: false,
        reason: `against: idle drift ${driftBps}bps exceeds the max band ${maxBand}bps — this is a mandate change, not a rebalance${caveat}`,
        detail: { driftBps, band, maxBand },
      };
    if (driftBps < band)
      return {
        support: false,
        reason: `against: idle drift ${driftBps}bps is inside the band ${band}bps — rebalancing now is churn and fees${caveat}`,
        detail: { driftBps, band, maxBand },
      };
    return {
      support: true,
      reason: `for: idle drift ${driftBps}bps is above the band ${band}bps and below the max ${maxBand}bps${caveat}`,
      detail: { driftBps, band, maxBand },
    };
  },
});

/** An evaluator that never forms a view — the safe choice when no strategy is wired. */
export const alwaysAbstain = Object.freeze({
  name: 'always-abstain',
  evaluate() {
    return { support: null, reason: 'abstain: the always-abstain evaluator never forms a view', detail: {} };
  },
});

/** @type {Record<string, {name:string, evaluate:Function}>} */
export const EVALUATORS = Object.freeze({
  [naiveDriftBand.name]: naiveDriftBand,
  [alwaysAbstain.name]: alwaysAbstain,
});

/**
 * Resolve an evaluator by name, or accept an object implementing the contract directly (the
 * supported way to plug in a real strategy without editing this file).
 * @param {string|{name?:string, evaluate:Function}} nameOrImpl
 */
export function resolveEvaluator(nameOrImpl) {
  if (nameOrImpl && typeof nameOrImpl === 'object' && typeof nameOrImpl.evaluate === 'function')
    return { name: nameOrImpl.name ?? 'custom', evaluate: nameOrImpl.evaluate };
  const found = EVALUATORS[String(nameOrImpl)];
  if (!found) throw new Error(`unknown evaluator ${JSON.stringify(nameOrImpl)} — known: ${Object.keys(EVALUATORS).join(', ')}`);
  return found;
}
