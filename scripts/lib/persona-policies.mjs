// @ts-check
/**
 * Pure `decide(readout) => action` policies for the four seeded personas
 * (`Obsidian Vault/Agent-Governed Vaults/Decisions/Seed agent personas 2026-09-23.md`). No chain
 * call, no LLM call, no `process.exit` — every function here takes a plain-object "readout" the
 * caller assembles from real chain reads and returns a plain-object "action" the caller then
 * drives against the chain. This is what `scripts/test/persona-round-sim.test.mjs` calls for
 * every decision a persona makes, rather than hard-coding "Ballast votes yes" inline — the spec
 * names a THESIS per persona, and these functions are that thesis made testable and
 * mutation-coverable in isolation, independent of anvil/forge/cast.
 *
 * Model tiers are a DISCLOSURE property (the spec: "each persona's public line names its
 * model"), not a behavioural one — nothing here calls a model, so tier is carried only as a
 * label on each policy's exported constant, never branched on.
 */

export const BALLAST_MODEL_TIER = 'sonnet';
export const MOMENTUM_MODEL_TIER = 'haiku';
export const CONTRARIAN_MODEL_TIER = 'sonnet';
export const AUDITOR_MODEL_TIER = 'haiku';

/** Basis-point threshold the spec calls "the 1% cap" — Ballast refuses anything at or above it,
 *  independent of the derived-safe check below. Matches `VaultCore.EXIT_FEE_CAP_BPS` in spelling
 *  (100 bps == 1%) but is a persona-policy constant, not a contract read — the persona's OWN risk
 *  line, not a value it can source from the vault. */
export const BALLAST_NEAR_CAP_BPS = 100n;

/**
 * Ballast's deposit thesis: capital preservation, deposit exactly the vault's minimum ONLY when
 * the vault will actually accept it (never below `minDepositUsdc`, never above idle capacity).
 * @param {{ minDepositUsdc: bigint }} readout
 * @returns {{ action: 'deposit', amountUsdc: bigint } | { action: 'skip', reason: string }}
 */
export function ballastDepositDecide({ minDepositUsdc }) {
  if (minDepositUsdc <= 0n) return { action: 'skip', reason: 'minDepositUsdc is not positive; refusing to size a deposit against it.' };
  return { action: 'deposit', amountUsdc: minDepositUsdc };
}

/**
 * Ballast's vote thesis (spec): "YES only on rebalances that reduce cirBTC exposure or keep
 * slippage <= fee+gap+25 bps. NO on anything near the 1% cap." `derivedSlipBps` is card 209's
 * `poolFeeBps + measuredExecutionGapBps + 25` (the exact quantity `deriveMaxSlippageBps` in
 * `scripts/build-rebalance-order.mjs` computes) — Ballast never re-derives it, it only compares
 * the PROPOSED `maxSlippageBps` against that already-derived safe ceiling.
 *
 * `ordersEmpty` is a deliberate, stated extension of the spec's thesis, not a loophole: a
 * no-op rebalance (zero `SwapOrder`s) moves nothing, so it cannot increase cirBTC exposure and
 * carries no real slippage risk at all — capital preservation cannot be hurt by it, regardless of
 * whatever placeholder `maxSlippageBps` the contract's encoding still requires be nonzero. Checked
 * FIRST, ahead of the cap line: an empty order's placeholder bps value is not real risk
 * information, so the cap must not veto it.
 * @param {{ maxSlippageBps: bigint, derivedSlipBps: bigint | null, reducesExposure: boolean, ordersEmpty?: boolean }} readout
 *   `derivedSlipBps` is null when no real pool/oracle reading was available to derive it (an
 *   empty-orders proposal carries no swap to size a derivation against) — Ballast then judges
 *   purely on `reducesExposure` and the cap, never on a fabricated derivation.
 * @returns {{ action: 'commitFor' | 'commitAgainst', reason: string }}
 */
export function ballastVoteDecide({ maxSlippageBps, derivedSlipBps, reducesExposure, ordersEmpty = false }) {
  if (ordersEmpty) {
    return { action: 'commitFor', reason: 'the order carries zero SwapOrders — a no-op cannot increase cirBTC exposure or realize any slippage.' };
  }
  if (maxSlippageBps >= BALLAST_NEAR_CAP_BPS) {
    return { action: 'commitAgainst', reason: `maxSlippageBps ${maxSlippageBps} is at or above the ${BALLAST_NEAR_CAP_BPS} bps (1%) line Ballast refuses regardless of anything else.` };
  }
  if (reducesExposure) {
    return { action: 'commitFor', reason: 'the order reduces cirBTC (basket-asset) exposure, which Ballast wants regardless of the slippage bound.' };
  }
  if (derivedSlipBps !== null && maxSlippageBps <= derivedSlipBps) {
    return { action: 'commitFor', reason: `maxSlippageBps ${maxSlippageBps} is within the derived safe bound (fee+gap+25bps = ${derivedSlipBps}).` };
  }
  return { action: 'commitAgainst', reason: 'the order neither reduces exposure nor stays inside the derived fee+gap+25bps bound.' };
}

/**
 * Momentum's propose thesis: full basket-asset exposure when the feed's recent rounds trend up,
 * idle USDC otherwise. `roundDeltas` is a list of signed round-over-round price deltas (WAD),
 * oldest first, read from the live feed's own recent `getRoundData` history — genuinely
 * chain-derived, never fabricated. Trend is "more up-rounds than down-rounds", a plain majority
 * vote over the sampled window, not a magnitude threshold (the spec names no magnitude).
 * @param {{ roundDeltas: bigint[] }} readout
 * @returns {{ action: 'proposeIntoAsset' | 'proposeIntoUsdc' | 'hold', trendUp: boolean }}
 */
export function momentumProposeDecide({ roundDeltas }) {
  if (roundDeltas.length === 0) return { action: 'hold', trendUp: false };
  let up = 0, down = 0;
  for (const d of roundDeltas) { if (d > 0n) up++; else if (d < 0n) down++; }
  const trendUp = up > down;
  return { action: trendUp ? 'proposeIntoAsset' : 'proposeIntoUsdc', trendUp };
}

/**
 * Momentum's vote thesis: YES on trend-aligned moves. `orderDirection` is the direction the
 * proposal ON THE FLOOR actually carries (which may not be Momentum's own proposal — the policy
 * is evaluated against whatever is up for a vote, per the "sim calls it for every decision" rule).
 * @param {{ trendUp: boolean, orderDirection: 'intoAsset' | 'intoUsdc' | 'noOp' }} readout
 * @returns {{ action: 'commitFor' | 'commitAgainst', reason: string }}
 */
export function momentumVoteDecide({ trendUp, orderDirection }) {
  if (orderDirection === 'noOp') {
    return { action: 'commitFor', reason: 'a no-op order carries no directional risk; Momentum has no reason to oppose its own round.' };
  }
  const aligned = (trendUp && orderDirection === 'intoAsset') || (!trendUp && orderDirection === 'intoUsdc');
  return aligned
    ? { action: 'commitFor', reason: 'the order direction matches the measured trend.' }
    : { action: 'commitAgainst', reason: 'the order direction runs against the measured trend.' };
}

/**
 * Momentum's exit thesis: "it is impatient: it exits if it is outvoted twice." The scripted round
 * (spec step 5) also has Momentum exit once its own round is done, regardless of outvote count —
 * modelled here as a second, independent trigger (`roundComplete`) rather than folding "done" into
 * "outvoted", which would misreport WHY Momentum exited in the mutation/assertion trail below.
 * @param {{ outvotedCount: number, roundComplete: boolean }} readout
 * @returns {{ action: 'requestExit' | 'hold', reason: string }}
 */
export function momentumExitDecide({ outvotedCount, roundComplete }) {
  if (outvotedCount >= 2) return { action: 'requestExit', reason: `outvoted ${outvotedCount} times (>= 2).` };
  if (roundComplete) return { action: 'requestExit', reason: 'the scripted round is done.' };
  return { action: 'hold', reason: 'neither outvoted twice nor round-complete yet.' };
}

/**
 * Contrarian's thesis: argue against the prevailing proposal on principle; no wallet at launch
 * (watch-only — see the spec's funded-count table). If funded later, it commits against the
 * majority whenever its written case clears its own bar. `caseStrength`/`ownBar` are both plain
 * numbers in the same units so the comparison is total and the function stays pure — the CALLER
 * is responsible for how a "case" is scored; this function only applies the decision rule.
 * @param {{ funded: boolean, prevailingSupport: boolean | null, caseStrength: number, ownBar: number }} readout
 *   `prevailingSupport` is null when there is no visible prevailing direction yet to argue against.
 * @returns {{ action: 'publishDissent' | 'commitAgainstPrevailing' | 'watch', reason: string }}
 */
export function contrarianDecide({ funded, prevailingSupport, caseStrength, ownBar }) {
  if (!funded) {
    return { action: 'publishDissent', reason: 'unfunded at launch — publishes the case against, casts no vote (spec: "It has no wallet at launch").' };
  }
  if (prevailingSupport !== null && caseStrength >= ownBar) {
    return { action: 'commitAgainstPrevailing', reason: `case strength ${caseStrength} clears its own bar ${ownBar}; commits opposite the prevailing direction (${prevailingSupport}).` };
  }
  return { action: 'watch', reason: 'no prevailing direction to argue against, or the case does not clear its own bar yet.' };
}

/**
 * Auditor's thesis: no opinion, no vote — publish the facts every round. Pure passthrough/shape
 * function: it never decides an action against the chain, only names which facts belong in the
 * readout it publishes, so a caller cannot accidentally wire it into a voting path.
 * @param {{ navUsdc: bigint, idleUsdc: bigint, queuedExitShares: bigint, oracleAgeSeconds: number, feeAccruedUsdc: bigint | null, voters: {member: string, support: boolean}[] }} readout
 *   `feeAccruedUsdc` is `null` when the caller did not query FeeEngine for this round (fee accrual
 *   lives in a separate contract this readout does not always read) — never fabricated as 0, which
 *   would misreport "queried and found zero" as indistinguishable from "not queried".
 * @returns {{ action: 'publishReadout', readout: object }}
 */
export function auditorDecide(readout) {
  return { action: 'publishReadout', readout };
}
