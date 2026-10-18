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
 *
 * and, beside them, the entry, settle and crank decisions (decideEntry, decideSettle, decideCrank:
 * finalize, execute and mark-expired, the three Governance calls anyone may make).
 */

import { toBaseUnits, fromBaseUnits, UNPROVEN_OPERATOR_PROFILE } from './config.mjs';
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
 * What the `unproven-operator` profile accepts, in the words the dry-run banner and the join check
 * both print. The Governance facts behind it, read from contracts/src/Governance.sol:
 *
 *  - `finalize` takes the sub-five branch when `p.memberCount < SIGNER_REGIME_BELOW` (5): the proposal
 *    passes on a strict majority of members-at-creation revealing with the FOR stake clearing quorum
 *    (`headMajorityWithStake`), OR on FOR stake above half of the snapshot (`forStakeMajority`).
 *  - A holder who is alone holds all of the snapshot, so its FOR reveal alone clears `forStakeMajority`.
 *  - A RuleChange passes only when `revealedWeight == snapshotTotal && forWeight >= snapshotTotal`: every
 *    unit of eligible stake must self-reveal, and all of it in favour.
 */
export const UNPROVEN_OPERATOR_RISK = Object.freeze([
  'An operator with no recorded gain or loss has no track record to judge, and a vault created today starts there.',
  'Below five holders, the outcome of a Rebalance depends on stake and on how many addresses vote (Governance.finalize).',
  'While it is the only holder, a depositor holds more than half of eligible stake, so whoever joins first holds the deciding vote on Rebalance proposals.',
  'A RuleChange needs every unit of eligible stake to reveal in favour, so one holder who does not reveal blocks it.',
]);

/**
 * The operator's realizations by members who are NOT on the disclosed list, from the registry's
 * RealizationRecorded logs (chain.readRealizations). Pure.
 *
 * The registry's accumulators (`statsOf`) add up every member's realization, with no mark on the
 * disclosed addresses, so the leaderboard figure cannot say who made it. This figure can. Moving an
 * address onto the list only removes its realizations from `included`; nothing is ever added.
 *
 * `reconciles` compares the window's total (included plus excluded) with the registry's own
 * accumulators when the window is complete: a difference means the operator realized somewhere the
 * window did not read, most likely in a vault older than this one.
 *
 * @param {Object} p
 * @param {{complete:boolean, gap:string|null, creationBlock:number|null, scannedFrom:number|null, scannedTo:number|null, head:number|null, members:Array<{member:string,gain:bigint,loss:bigint}>}|null} p.record
 * @param {string[]} [p.disclosed]  addresses to leave out
 * @param {{lifetimeGainUsdc?:any, lifetimeLossUsdc?:any}|null} [p.registryRow]  the operator's leaderboard row
 */
export function outsideTrackRecord({ record, disclosed = [], registryRow = null }) {
  if (!record) return null;
  const listed = new Set(disclosed.map((a) => String(a).toLowerCase()));
  const included = { gain: 0n, loss: 0n, net: 0n, members: 0 };
  const excluded = { gain: 0n, loss: 0n, members: 0 };
  for (const m of record.members) {
    const side = listed.has(String(m.member).toLowerCase()) ? excluded : included;
    side.gain += m.gain;
    side.loss += m.loss;
    side.members += 1;
  }
  included.net = included.gain - included.loss;
  const regGain = asBigInt(registryRow?.lifetimeGainUsdc);
  const regLoss = asBigInt(registryRow?.lifetimeLossUsdc);
  const reconciles =
    record.complete && regGain !== null && regLoss !== null ? included.gain + excluded.gain === regGain && included.loss + excluded.loss === regLoss : null;
  return {
    complete: record.complete,
    gap: record.gap,
    creationBlock: record.creationBlock,
    scannedFrom: record.scannedFrom,
    scannedTo: record.scannedTo,
    head: record.head,
    included,
    excluded,
    reconciles,
  };
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
 * @param {ReturnType<typeof outsideTrackRecord>} [p.trackRecordExcludingDisclosed]  the operator's realizations by members
 *   NOT on the disclosed list. null when none was requested; a figure that could not be read in full refuses.
 * @returns {{join:boolean, checks:Array<{name:string,ok:boolean,detail:string}>, depositUsdc:bigint, reason:string}}
 */
export function decideJoin({ vault, chain, operatorRow, registryOperatorId = null, fees = {}, heldVaultCount = 0, config, trackRecordExcludingDisclosed = null }) {
  const checks = [];
  // Under the unproven-operator profile the deposit is the vault's own minimum, whatever
  // `depositUsdc` says: the profile accepts an operator with no record, so it accepts it with the
  // least money the vault allows. An unreadable minimum is 0 here and `meets-min-deposit` refuses it.
  const pinned = config.profile === UNPROVEN_OPERATOR_PROFILE;
  const minDepositRead = chain?.minDepositUsdc;
  const deposit = pinned ? (minDepositRead === null || minDepositRead === undefined ? 0n : BigInt(minDepositRead)) : toBaseUnits(config.depositUsdc);
  if (pinned)
    checks.push(
      check(
        'profile-unproven-operator',
        true,
        `profile ${UNPROVEN_OPERATOR_PROFILE} is on; holders now ${vault?.memberCount ?? 'unknown'}. ${UNPROVEN_OPERATOR_RISK.join(' ')}`,
      ),
    );

  // ── attested operator ──────────────────────────────────────────────────────
  // Operator identity is the REGISTRY key, not the API's display metadata — a spoofed vault can
  // claim any branding it likes (AGENT-QUICKSTART §4). When a registry read is available it wins;
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

  // ── outside-member track record ────────────────────────────────────────────
  // The registry's net above counts every member's realization, disclosed addresses included. When a
  // figure that leaves the disclosed addresses out was asked for, it is applied on top: it can only
  // tighten the verdict. A figure that could not be read in full refuses, and names why, rather than
  // being read as an operator with no realizations.
  const outside = trackRecordExcludingDisclosed;
  if (outside) {
    if (!outside.complete)
      checks.push(
        check('outside-track-record', false, `the realizations by outside members were not read in full (${outside.gap}); refusing rather than reading an unread range as none`),
      );
    else {
      const hasRecord = outside.included.gain > 0n || outside.included.loss > 0n;
      const ok = outside.included.net >= minNet && (!config.requireProvenOperator || hasRecord);
      checks.push(
        check(
          'outside-track-record',
          ok,
          `outside members (not on the disclosed list): gain $${fromBaseUnits(outside.included.gain)} / loss $${fromBaseUnits(outside.included.loss)} / net $${fromBaseUnits(outside.included.net)} from ${outside.included.members} address(es); ` +
            `left out as disclosed: gain $${fromBaseUnits(outside.excluded.gain)} / loss $${fromBaseUnits(outside.excluded.loss)} from ${outside.excluded.members} address(es); ` +
            `blocks ${outside.scannedFrom} to ${outside.scannedTo}, floor $${fromBaseUnits(minNet)}${config.requireProvenOperator ? '; an outside realization is required' : ''}` +
            (outside.reconciles === false ? '; the window total differs from the registry accumulators, so this operator realized in blocks the window did not read' : ''),
        ),
      );
    }
  }

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
  // The stacked read wins; the discovery row's own depth is the fallback. When neither was
  // measured the depth is UNKNOWN, and an unknown depth is refused like an unreadable fee, never
  // taken as 0 (a child vault at depth 1 against maxDepth 0 must not pass on a failed read).
  const rawDepth = fees.depth ?? vault?.depth ?? null;
  const depth = rawDepth === null ? NaN : Number(rawDepth);
  if (!Number.isFinite(depth)) checks.push(check('depth-within-limit', false, 'vault depth unreadable (SubVaultRegistry.depthOf): refusing to join blind to depth'));
  else checks.push(check('depth-within-limit', depth <= config.maxDepth, `vault depth ${depth}, max ${config.maxDepth}`));
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
        : `depositing $${fromBaseUnits(deposit)}, vault minimum $${fromBaseUnits(BigInt(minDeposit))}${pinned ? `; pinned at the vault minimum by the ${UNPROVEN_OPERATOR_PROFILE} profile (depositUsdc is not used)` : ''}`,
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
  // Forward pricing: exiting while a pending execution exists (any active proposal past its reveal
  // start, of any type) settles at POST-execution NAV, and the shares lock until someone calls
  // settleQueuedExit (ARCHITECTURE §4.4). The agent still exits — but the plan must say so, because
  // the price it gets is not the price it sees.
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
 * Mode F settlement: shares queued behind a pending execution settle at post-execution NAV, and
 * stay locked until someone calls settleQueuedExit (ARCHITECTURE §4.4). Nobody is obliged to call
 * it for us, so the agent watches for its own.
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

/** The one proposal type the crank executes: Rebalance. RuleChange and ChildAllocation need a human. */
export const CRANK_EXECUTE_PTYPE = 0;

/**
 * Should the agent finish the latest proposal on this vault: `finalize`, `execute` or `markExpired`?
 *
 * All three are callable by anyone and gate on `block.timestamp` (Governance.sol `finalize`,
 * `execute`, `markExpired`), so the decision is taken on CHAIN time. `chainNowSec` is the latest
 * block's timestamp; when it is unreadable the local clock stands in with `timing.activateGraceSec`
 * taken OFF it, which puts the margin on the near side of every boundary: a `finalize` or
 * `markExpired` is never emitted early, and an `execute` is never emitted before the timelock. The
 * far side of the execution window is left to the simulation that precedes every send.
 *
 * Phase table, `now` being the chain time above:
 *
 *   Active,  now >= revealDeadline                      finalize      (boundary is >=)
 *   Passed,  executableAt <= now <= expiresAt           execute       (needs a verified payload, ptype 0)
 *   Passed,  now >  expiresAt                           mark-expired  (boundary is strict >)
 *   Passed,  now <  executableAt                        none: wait
 *   Defeated / Executed / Expired / None                none
 *   proposal unreadable                                 none, degraded
 *
 * `execute` needs the payload bytes, which the chain never stores, so it runs only for an
 * `actionHash` present in `knownPayloads`. `knownPayloads` must already be verified against keccak256
 * (payloads.verifyKnownPayloads): this function is pure and loads no hash library.
 *
 * @param {Object} p
 * @param {any} p.governance    readGovernance result (the latest proposal stays readable once settled)
 * @param {number|null} [p.chainNowSec]  latest block timestamp, null when unreadable
 * @param {number} p.nowSec     the local clock, used only when chainNowSec is null
 * @param {any} p.timing        resolved policy.timing config
 * @param {any} p.config        resolved policy.crank config
 * @param {Record<string,string>} [p.knownPayloads]  verified actionHash (lowercase) => payload
 * @param {boolean} p.held      the agent has shares or a pending deposit in this vault
 * @returns {{action:'finalize'|'execute'|'mark-expired'|'none', checks:Array<{name:string,ok:boolean,detail:string}>, reason:string, degraded?:boolean, urgent?:boolean, pid?:bigint, ptype?:number, actionHash?:string, payload?:string}}
 */
export function decideCrank({ governance, chainNowSec = null, nowSec, timing, config, knownPayloads = {}, held }) {
  /** @type {Array<{name:string,ok:boolean,detail:string}>} */
  const checks = [];
  const none = (reason, extra = {}) => ({ action: /** @type {const} */ ('none'), checks, reason, ...extra });

  // ── scope: cranking a vault the agent does not hold spends gas for other members ─────────────
  if (config.scope === 'off') {
    checks.push(check('scope', false, 'policy.crank.scope is off'));
    return none('cranking is switched off (policy.crank.scope = off)');
  }
  const inScope = config.scope === 'all' || held === true;
  checks.push(
    check(
      'scope',
      inScope,
      config.scope === 'all'
        ? 'scope is all: every vault read is cranked'
        : held
          ? 'scope is held and the agent holds a position here'
          : 'scope is held and the agent holds no position here',
    ),
  );
  if (!inScope) return none('the agent holds no position here and policy.crank.scope is held');

  // ── the proposal: an unreadable one is unknown, never "nothing to do" ────────────────────────
  const p = governance?.proposal;
  if (governance?.available === false) return none('no governance contract is configured');
  if (!p && BigInt(governance?.activePid ?? 0n) > 0n)
    return none(`proposal ${governance.activePid} exists but its state could NOT be read: unknown, not "nothing to do". Retrying next tick.`, { degraded: true });
  if (!p) return none('no proposal on this vault');

  // ── the clock ─────────────────────────────────────────────────────────────────────────────────
  const grace = Number(timing?.activateGraceSec ?? 0);
  const onChainTime = chainNowSec != null && Number.isFinite(Number(chainNowSec));
  const now = onChainTime ? Number(chainNowSec) : Number(nowSec) - grace;
  checks.push(
    check(
      'clock',
      true,
      onChainTime ? `chain time ${now}` : `chain time unreadable: local clock ${nowSec} less the ${grace}s margin = ${now}`,
    ),
  );

  const ids = { pid: p.pid, ptype: p.ptype, actionHash: p.actionHash };
  const allOk = () => checks.every((c) => c.ok);
  /** The verdict when every check passed, else `none` carrying the first failing check's detail. */
  const verdict = (action, why, extra = {}) =>
    allOk() ? { action, checks, reason: why, ...ids, ...extra } : none(checks.find((c) => !c.ok)?.detail ?? why, ids);

  if (p.statusName === 'Active') {
    checks.push(check('status-active', true, 'proposal is Active'));
    // Governance.finalize: `block.timestamp >= revealDeadline`.
    const over = now >= p.revealDeadline;
    checks.push(check('reveal-window-over', over, over ? `reveal window ended at ${p.revealDeadline}` : `reveal window ends at ${p.revealDeadline} (in ${p.revealDeadline - now}s)`));
    checks.push(check('finalize-enabled', config.finalize === true, config.finalize === true ? 'policy.crank.finalize is on' : 'policy.crank.finalize is off'));
    return verdict('finalize', `FINALIZE proposal ${p.pid}: the reveal window ended at ${p.revealDeadline}, and until it is finalized the vault stays in Mode F`);
  }

  if (p.statusName === 'Passed') {
    checks.push(check('status-passed', true, 'proposal has Passed'));
    // Governance.markExpired: `block.timestamp > expiresAt`, strict.
    if (now > p.expiresAt) {
      checks.push(check('window-over', true, `execution window ended at ${p.expiresAt}`));
      checks.push(check('mark-expired-enabled', config.markExpired === true, config.markExpired === true ? 'policy.crank.markExpired is on' : 'policy.crank.markExpired is off (bookkeeping only)'));
      return verdict('mark-expired', `MARK-EXPIRED proposal ${p.pid}: the execution window ended at ${p.expiresAt}`);
    }
    // Governance.execute: `executableAt <= block.timestamp <= expiresAt`.
    const elapsed = now >= p.executableAt;
    checks.push(check('timelock-elapsed', elapsed, elapsed ? `executable since ${p.executableAt}` : `executable at ${p.executableAt} (in ${p.executableAt - now}s)`));
    checks.push(check('window-open', true, `execution window open until ${p.expiresAt} (${p.expiresAt - now}s left)`));
    checks.push(check('execute-enabled', config.execute === true, config.execute === true ? 'policy.crank.execute is on' : 'policy.crank.execute is off'));
    const rebalance = p.ptype === CRANK_EXECUTE_PTYPE;
    checks.push(check('rebalance-only', rebalance, rebalance ? 'proposal type is Rebalance' : `proposal type ${p.ptypeName} is not executed by this agent; a human decides it`));
    const payload = knownPayloads[String(p.actionHash).toLowerCase()];
    const known = typeof payload === 'string';
    checks.push(
      check(
        'payload-known',
        known,
        known
          ? `a verified payload for ${p.actionHash} is held`
          : `no verified payload for actionHash ${p.actionHash}: the chain does not store it, so it cannot be executed from here (policy.crank.knownPayloads)`,
      ),
    );
    const margin = Number(timing?.revealSafetyMarginSec ?? 0);
    return verdict('execute', `EXECUTE proposal ${p.pid}: passed, inside its execution window until ${p.expiresAt}`, {
      payload,
      urgent: p.expiresAt - now <= margin,
    });
  }

  if (p.statusName === 'Unknown') return none(`proposal status ${p.status} is not one this agent knows`, { degraded: true, ...ids });
  return none(`proposal ${p.pid} is ${p.statusName}: nothing to finish`, ids);
}
