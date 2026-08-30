// @ts-check
/**
 * Policy — the pure decision layer.
 *
 * Every function here is a total function of its arguments: no clock, no network, no I/O. `nowSec`
 * is always injected (the SDK's convention). That is what makes the whole decision surface
 * testable over fixture states, and it is why a policy change can be reviewed as a diff of
 * predicates rather than as a diff of behaviour.
 *
 * Each decision returns its full CHECK LIST, not just a verdict — every predicate with its inputs
 * and whether it passed. The narrative log prints those checks, so "did not join" is always
 * accompanied by which gate it failed on. A decision an operator cannot audit is a decision they
 * cannot correct.
 *
 * Three decisions, matching the sprint brief:
 *   decideJoin  — attested operator, positive leaderboard net, capacity available, fees in bounds
 *   decideVote  — commit / reveal / abstain, via a pluggable evaluator
 *   decideExit  — drawdown threshold, oracle-freeze warning, operator net turning negative
 */

import { toBaseUnits, fromBaseUnits } from './config.mjs';
import { resolveEvaluator } from './evaluators.mjs';

const BPS = 10000n;
const WAD = 10n ** 18n;

/** @param {string} name @param {boolean} ok @param {string} detail */
const check = (name, ok, detail) => ({ name, ok, detail });

/**
 * `netRealizedUsdc` arrives from the API bigint-serialized as a DECIMAL STRING. Comparing it as a
 * Number silently loses precision above 2^53 and, worse, `"−500" > 0` is a string comparison
 * waiting to happen. Always go through BigInt.
 * @param {any} v @returns {bigint|null}
 */
export function asBigInt(v) {
  if (v === null || v === undefined || v === '') return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Should the agent join this vault?
 *
 * @param {Object} p
 * @param {any} p.vault        listVaults row: { vault, operatorId, memberCount, depth, parent, capacityCapUsdc, attested }
 * @param {any} p.chain        readVault result for this vault
 * @param {any} p.operatorRow  leaderboard row for this vault's operator (or null if absent)
 * @param {number|null} [p.registryOperatorId]  operatorOf(vault) read at the registry (trumps the API)
 * @param {{stackedPerfFeeBps:number|null, stackedExitFeeCapBps:number|null, depth:number|null}} [p.fees]
 * @param {number} p.heldVaultCount  how many vaults the agent already holds
 * @param {any} p.config       resolved policy.join config
 * @returns {{join:boolean, checks:Array<{name:string,ok:boolean,detail:string}>, depositUsdc:bigint, reason:string}}
 */
export function decideJoin({ vault, chain, operatorRow, registryOperatorId = null, fees = {}, heldVaultCount = 0, config }) {
  const checks = [];
  const deposit = toBaseUnits(config.depositUsdc);

  // ── attested operator ──────────────────────────────────────────────────────
  // Operator identity is the REGISTRY key, not the API's display metadata — a spoofed vault can
  // claim any branding it likes (AGENT-QUICKSTART § Protocol semantics). When a registry read is available it wins;
  // a disagreement between the two is itself disqualifying.
  const apiOpId = Number(vault?.operatorId ?? 0);
  const opId = registryOperatorId ?? apiOpId;
  if (registryOperatorId !== null && registryOperatorId !== apiOpId)
    checks.push(check('operator-attested', false, `registry says operatorId=${registryOperatorId} but the API says ${apiOpId} — refusing on the disagreement`));
  else if (config.requireAttestedOperator)
    checks.push(check('operator-attested', opId !== 0, opId !== 0 ? `attested, operatorId=${opId}` : 'operatorId=0 — unattested, treated as scam-quarantine'));
  else checks.push(check('operator-attested', true, `attestation not required by config (operatorId=${opId})`));

  // ── positive leaderboard net ───────────────────────────────────────────────
  const net = asBigInt(operatorRow?.netRealizedUsdc);
  const minNet = toBaseUnits(config.minOperatorNetRealizedUsdc);
  const gain = asBigInt(operatorRow?.lifetimeGainUsdc) ?? 0n;
  const loss = asBigInt(operatorRow?.lifetimeLossUsdc) ?? 0n;
  if (net === null)
    checks.push(check('operator-net-positive', false, 'no leaderboard row for this operator — no track record to judge'));
  else if (config.requireProvenOperator && gain === 0n && loss === 0n)
    checks.push(check('operator-net-positive', false, 'operator has no realizations at all — "not yet negative" is not a track record'));
  else
    checks.push(
      check(
        'operator-net-positive',
        // The floor does the work. The extra `net > 0n` that used to sit here made
        // `requireProvenOperator: false` INERT: the branch above already refuses an operator with
        // no realizations while that flag is on, so reaching here with it off is a caller
        // explicitly accepting a no-track-record operator — and `net > 0n` refused them anyway,
        // which is not what the flag documents ("Refuse an operator with no realizations at all").
        // Nothing is loosened for the default config: `minOperatorNetRealizedUsdc` defaults to 0,
        // so negatives are still excluded, and requireProvenOperator defaults to true.
        net >= minNet,
        `net realized $${fromBaseUnits(net)} (gain $${fromBaseUnits(gain)} / loss $${fromBaseUnits(loss)}), floor $${fromBaseUnits(minNet)}`,
      ),
    );

  // ── capacity available ─────────────────────────────────────────────────────
  // capacityCapUsdc == 0 means UNCAPPED (ARCHITECTURE §6, and isCapped() exists precisely so this
  // is not guessed). A naive `deposit <= cap` would refuse every uncapped vault.
  const cap = chain?.capacityCapUsdc;
  const minFree = toBaseUnits(config.minFreeCapacityUsdc);
  if (cap === null || cap === undefined) checks.push(check('capacity-available', false, 'capacity cap unreadable'));
  else if (BigInt(cap) === 0n) checks.push(check('capacity-available', true, 'vault is uncapped (capacityCapUsdc == 0)'));
  else {
    // Capacity is measured against NAV + escrowed pending, mirroring VaultCore.deposit.
    const used = (chain?.totalAssetsUsdc ?? 0n) + (chain?.totalPendingUsdc ?? 0n);
    const free = BigInt(cap) > used ? BigInt(cap) - used : 0n;
    checks.push(
      check(
        'capacity-available',
        free >= deposit && free >= minFree,
        `$${fromBaseUnits(free)} free of $${fromBaseUnits(BigInt(cap))} cap; need $${fromBaseUnits(deposit)} (floor $${fromBaseUnits(minFree)})`,
      ),
    );
  }

  // ── fees within bounds ─────────────────────────────────────────────────────
  // Sub-vault fees STACK up the parent chain, so the headline 10%/1% are floors, not the numbers
  // this agent pays. Prefer the stacked reads; fall back to the vault's own exitFeeBpsOf.
  const perf = fees.stackedPerfFeeBps;
  const exitCap = fees.stackedExitFeeCapBps ?? chain?.self?.exitFeeBps ?? null;
  if (perf === null || perf === undefined) checks.push(check('fees-in-bounds', false, 'stacked performance fee unreadable — refusing to join blind to fees'));
  else if (exitCap === null || exitCap === undefined) checks.push(check('fees-in-bounds', false, 'exit fee unreadable — refusing to join blind to fees'));
  else
    checks.push(
      check(
        'fees-in-bounds',
        perf <= config.maxPerfFeeBps && exitCap <= config.maxExitFeeBps,
        `stacked perf ${perf}bps (max ${config.maxPerfFeeBps}) / exit ${exitCap}bps (max ${config.maxExitFeeBps})`,
      ),
    );

  // ── the agent's own limits ─────────────────────────────────────────────────
  const depth = fees.depth ?? Number(vault?.depth ?? 0);
  checks.push(check('depth-within-limit', depth <= config.maxDepth, `vault depth ${depth}, max ${config.maxDepth}`));
  checks.push(
    check('concurrency-limit', heldVaultCount < config.maxConcurrentVaults, `holding ${heldVaultCount} of max ${config.maxConcurrentVaults} vaults`),
  );

  // A vault whose NAV cannot be read is a vault whose oracle may be stale — and a stale oracle
  // freezes EXITS as well as entries (ARCHITECTURE §11). Never deposit into one.
  checks.push(check('nav-readable', chain?.navReadable === true, chain?.navReadable ? 'NAV/share reads cleanly' : `NAV read failed: ${chain?.navError ?? 'unknown'} — a stale oracle freezes exits too`));

  const minDeposit = chain?.minDepositUsdc;
  checks.push(
    check(
      'meets-min-deposit',
      minDeposit === null || minDeposit === undefined ? false : deposit >= BigInt(minDeposit),
      minDeposit === null || minDeposit === undefined
        ? 'minDepositUsdc unreadable'
        : `depositing $${fromBaseUnits(deposit)}, vault minimum $${fromBaseUnits(BigInt(minDeposit))}`,
    ),
  );

  const failed = checks.filter((c) => !c.ok);
  return {
    join: failed.length === 0,
    checks,
    depositUsdc: deposit,
    reason: failed.length === 0 ? 'all join gates passed' : `blocked on: ${failed.map((c) => c.name).join(', ')}`,
  };
}

/**
 * Should the agent exit this vault?
 *
 * Any ONE trigger is sufficient — exits are the risk-off direction, so the predicates are OR'd,
 * not AND'd.
 *
 * @param {Object} p
 * @param {any} p.chain            readVault result
 * @param {bigint|null} p.entryNavPerShareWad  the agent's entry mark (null ⇒ drawdown unknowable)
 * @param {any} p.operatorRow      leaderboard row for the operator
 * @param {any} p.governance       readGovernance result (for the Mode I / Mode F warning)
 * @param {any} p.config           resolved policy.exit config
 * @returns {{exit:boolean, triggers:Array<{name:string,ok:boolean,detail:string}>, modeF:boolean, reason:string}}
 */
export function decideExit({ chain, entryNavPerShareWad, operatorRow, governance, config }) {
  const triggers = [];

  // ── drawdown ───────────────────────────────────────────────────────────────
  const nav = chain?.navPerShareWad;
  if (nav == null || entryNavPerShareWad == null)
    triggers.push(check('drawdown', false, 'no entry mark or no readable NAV — drawdown not computable'));
  else {
    const entry = BigInt(entryNavPerShareWad);
    const now = BigInt(nav);
    const dropBps = entry === 0n ? 0n : now >= entry ? 0n : ((entry - now) * BPS) / entry;
    triggers.push(
      check(
        'drawdown',
        dropBps >= BigInt(config.maxDrawdownBps),
        `NAV/share ${fmtWad(now)} vs entry ${fmtWad(entry)} = ${dropBps}bps down, threshold ${config.maxDrawdownBps}bps`,
      ),
    );
  }

  // ── oracle-freeze warning ──────────────────────────────────────────────────
  // See chain.mjs: a failed navPerShareWad IS the freeze, not a warning ahead of it. Acting on it
  // is best-effort — if the oracle is already stale, requestExit reverts too. It is still worth
  // trying: the breaker can clear, and an agent that queues its exit the moment it notices is
  // ahead of one that waits.
  const navFailures = Number(chain?.navConsecutiveFailures ?? 0);
  if (config.onOracleFreezeWarning)
    triggers.push(
      check(
        'oracle-freeze',
        chain?.navReadable === false,
        chain?.navReadable === false
          ? `NAV unreadable ${navFailures}x consecutively (${chain?.navError ?? 'unknown'}) — the oracle breaker may have tripped; NOTE a frozen oracle freezes exits too`
          : 'NAV reads cleanly, oracle appears live',
      ),
    );

  // ── operator net turning negative ──────────────────────────────────────────
  const net = asBigInt(operatorRow?.netRealizedUsdc);
  if (config.onOperatorNetNegative)
    triggers.push(
      check(
        'operator-net-negative',
        net !== null && net < 0n,
        net === null ? 'no leaderboard row — operator net unknown' : `operator net realized $${fromBaseUnits(net)}`,
      ),
    );

  const fired = triggers.filter((t) => t.ok);
  // Forward pricing: exiting while a passed-but-unexecuted rebalance exists settles at POST-
  // rebalance NAV, and the shares lock until settleQueuedExit (ARCHITECTURE §4.4). The agent still
  // exits — but the plan must say so, because the price it gets is not the price it sees.
  const modeF = governance?.hasPendingExecution === true;
  return {
    exit: fired.length > 0,
    triggers,
    modeF,
    reason: fired.length ? `exit triggered by: ${fired.map((t) => t.name).join(', ')}` : 'no exit trigger fired',
  };
}

/** Format a WAD as a short decimal for logs. */
export function fmtWad(v) {
  const b = BigInt(v);
  const whole = b / WAD;
  const frac = ((b % WAD) * 10000n / WAD).toString().padStart(4, '0');
  return `${whole}.${frac}`;
}

/** Phase of a proposal's commit-reveal lifecycle at `nowSec`. */
export function votePhase(proposal, nowSec) {
  if (!proposal) return 'none';
  if (nowSec < proposal.commitDeadline) return 'commit';
  if (nowSec < proposal.revealDeadline) return 'reveal';
  return 'closed';
}

/**
 * What should the agent do about the active proposal on this vault?
 *
 * Returns exactly one of:
 *   {action:'commit', support}   — commit phase, we have weight, the evaluator formed a view
 *   {action:'reveal', support}   — we have an outstanding commit and the reveal window is open
 *   {action:'none'}              — with a reason, always
 *
 * The reveal branch is checked FIRST and unconditionally: an outstanding commit is an obligation
 * the agent already incurred, and failing it forfeits the vote (S-4). It outranks every other
 * consideration, including a policy that would no longer commit that vote today.
 *
 * @param {Object} p
 * @param {any} p.governance   readGovernance result
 * @param {any} p.chain        readVault result
 * @param {bigint} p.votingWeight  the agent's voting-eligible shares
 * @param {number} p.nowSec
 * @param {any} p.config       resolved policy.vote config
 * @param {any} p.timing       resolved policy.timing config
 * @returns {{action:'commit'|'reveal'|'none', support:boolean|null, reason:string, urgent?:boolean, secondsToDeadline?:number, evaluation?:any}}
 */
export function decideVote({ governance, chain, votingWeight, nowSec, config, timing }) {
  const p = governance?.proposal;

  // A read that FAILED is not a read that said "nothing here". Reporting "no active proposal"
  // because `proposals(pid)` errored would be a reassuring lie on the one path where being wrong
  // forfeits a vote — so an unreadable proposal is surfaced as unknown and flagged degraded.
  if (!p && BigInt(governance?.activePid ?? 0n) > 0n)
    return {
      action: 'none',
      support: null,
      degraded: true,
      reason: `proposal ${governance.activePid} is active but its state could NOT be read — this is unknown, not "nothing to do". Retrying next tick.`,
    };
  if (!p) return { action: 'none', support: null, reason: 'no active proposal on this vault' };

  const phase = votePhase(p, nowSec);

  // ── reveal: an obligation already incurred, so it comes first ──────────────
  if (governance.hasOutstandingCommit) {
    if (phase === 'commit')
      return {
        action: 'none',
        support: null,
        reason: `committed; the reveal window opens at ${p.commitDeadline} (in ${p.commitDeadline - nowSec}s)`,
        secondsToDeadline: p.revealDeadline - nowSec,
      };
    if (phase === 'reveal') {
      const remaining = p.revealDeadline - nowSec;
      const margin = Number(timing.revealSafetyMarginSec);
      // The margin is a "reveal by then at the latest", not a "wait until then". Revealing early
      // is free and safe — the commitment already bound the direction, so a visible partial tally
      // cannot change our vote (VO-7). We reveal as soon as the window opens.
      return {
        action: 'reveal',
        support: null, // recovered from the chain commitment by the actor — see salt.recoverVote
        reason: `reveal window open, ${remaining}s until forfeiture (safety margin ${margin}s)`,
        urgent: remaining <= margin,
        secondsToDeadline: remaining,
      };
    }
    return {
      action: 'none',
      support: null,
      reason: `reveal window CLOSED at ${p.revealDeadline} — this vote is forfeit and counts as an abstain (S-4)`,
      secondsToDeadline: p.revealDeadline - nowSec,
    };
  }

  // Likewise: we could not read whether we hold a commit. Say so rather than concluding we don't.
  if (governance.commitUnknown)
    return {
      action: 'none',
      support: null,
      degraded: true,
      reason: `could not read commitOf for proposal ${governance.activePid} — whether a reveal is owed is UNKNOWN. Retrying next tick.`,
    };

  // ── commit ─────────────────────────────────────────────────────────────────
  if (phase !== 'commit')
    return { action: 'none', support: null, reason: `commit window closed (phase: ${phase}) and we hold no commit` };
  if (governance.revealed === true) return { action: 'none', support: null, reason: 'already revealed on this proposal' };
  if (!config.proposalTypes.includes(p.ptype))
    return { action: 'none', support: null, reason: `proposal type ${p.ptypeName} is not in the agent's mandate (${config.proposalTypes.join(',')}) — a human decides this one` };
  if (p.statusName !== 'Active')
    return { action: 'none', support: null, reason: `proposal status is ${p.statusName}, not Active` };
  if (BigInt(votingWeight ?? 0n) === 0n)
    return { action: 'none', support: null, reason: 'no voting-eligible stake (pending deposits and locked Mode-F shares do not vote)' };

  const evaluator = resolveEvaluator(config.evaluator);
  const evaluation = evaluator.evaluate({ proposal: p, chain, config, nowSec });
  if (evaluation.support === null) {
    if (!config.voteAgainstWhenUnknown)
      return { action: 'none', support: null, reason: `abstaining by not committing — ${evaluation.reason}`, evaluation };
    return { action: 'commit', support: false, reason: `no view, and voteAgainstWhenUnknown is set — ${evaluation.reason}`, evaluation };
  }
  return {
    action: 'commit',
    support: evaluation.support,
    reason: `${evaluator.name}: ${evaluation.reason}`,
    secondsToDeadline: p.commitDeadline - nowSec,
    evaluation,
  };
}

/**
 * Entry lifecycle: a first deposit is escrowed for the observation window with no shares and no
 * vote (ARCHITECTURE §5). This decides what the agent owes that position right now.
 *
 * `skipWindow` is NEVER returned unless `danger.allowSkipWindow` is explicitly true — it is
 * irreversible and once-per-agent-per-vault. Even then it is an operator's standing config
 * decision, not an autonomous one, and a test pins that the default config cannot produce it.
 *
 * @param {Object} p
 * @param {any} p.chain    readVault result (needs self.pendingAmount / self.pendingAvailableAt)
 * @param {number} p.nowSec
 * @param {any} p.timing
 * @param {any} p.danger
 * @returns {{action:'activate'|'wait'|'skip-window'|'none', reason:string, dueAtSec?:number}}
 */
export function decideEntry({ chain, nowSec, timing, danger }) {
  const pendingAmount = chain?.self?.pendingAmount;
  if (pendingAmount == null || BigInt(pendingAmount) === 0n)
    return { action: 'none', reason: 'no pending deposit awaiting activation' };

  const availableAt = Number(chain?.self?.pendingAvailableAt ?? 0);
  const grace = Number(timing.activateGraceSec ?? 0);
  const dueAt = availableAt + grace;

  if (nowSec >= dueAt)
    return { action: 'activate', reason: `observation window cleared at ${availableAt} (+${grace}s grace)`, dueAtSec: dueAt };

  if (danger?.allowSkipWindow === true)
    return {
      action: 'skip-window',
      reason:
        'danger.allowSkipWindow is explicitly enabled — skipWindow() is IRREVERSIBLE and once-per-agent-per-vault',
      dueAtSec: nowSec,
    };

  return {
    action: 'wait',
    reason: `observation window ends at ${availableAt}; activate scheduled for ${dueAt} (in ${dueAt - nowSec}s). Not skipping — skipWindow is irreversible and off by default.`,
    dueAtSec: dueAt,
  };
}

/**
 * Mode F settlement: shares queued behind a rebalance settle at post-rebalance NAV, and stay
 * locked until someone calls settleQueuedExit (ARCHITECTURE §4.4). Nobody is obliged to call it
 * for us, so the agent watches for its own.
 *
 * @param {Object} p @param {any} p.chain @param {any} p.governance
 * @returns {{action:'settle-queued-exit'|'none', reason:string}}
 */
export function decideSettle({ chain, governance }) {
  const queued = chain?.self?.queuedExitShares;
  if (queued == null || BigInt(queued) === 0n) return { action: 'none', reason: 'no queued exit shares' };
  if (governance?.hasPendingExecution === true)
    return { action: 'none', reason: `${queued} shares queued, but the rebalance has not executed yet — settling now is not possible` };
  return { action: 'settle-queued-exit', reason: `${queued} shares queued and no pending execution remains — settle at post-rebalance NAV` };
}
