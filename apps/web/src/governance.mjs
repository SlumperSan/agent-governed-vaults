// @ts-check
/**
 * Proposal phase, and the exit mode it forces.
 *
 * TWO PLACES THE PRODUCT BRIEF AND THE UX SPEC SIMPLIFY THE CONTRACT. Both are modelled here as
 * the contract behaves, because both cost money:
 *
 *  1. Mode F does NOT begin when a rebalance passes. `Governance.hasPendingExecution` is
 *
 *         (status == Active && now >= commitDeadline) || (status == Passed && now <= expiresAt)
 *
 *     — i.e. it flips at REVEAL START, before any vote is counted, because once reveals begin the
 *     outcome leaks on-chain (Governance.sol:27-30). A user who exits during reveal expecting an
 *     instant settlement gets an irrevocable queued one instead.
 *  2. It is not rebalance-specific. `activeProposalOf` holds ONE proposal of ANY type, so a
 *     RuleChange or ChildAllocation in its reveal phase forward-prices exits identically.
 *
 * THE HONEST UNKNOWN. `Governance.Proposed` emits (pid, vault, ptype, proposer, actionHash) and
 * carries NO deadlines, so `commitDeadline` is not in the indexer and not on any API route. Exit
 * mode is therefore NOT DERIVABLE from the metered API. `resolveExitMode` returns `'unknown'`
 * for that case instead of assuming Mode I, and the UI must show it as unresolved. Guessing
 * "instant" when the chain says "queued and irrevocable" is the single most expensive lie this
 * app could tell.
 */

/** Governance.ProposalType */
export const PROPOSAL_TYPES = ['Rebalance', 'RuleChange', 'ChildAllocation'];

/**
 * The sentinel for "we do not know whether this vault has an active proposal". `null` means
 * KNOWN-ABSENT and resolves to Mode I; a source that carries no proposal field at all (the
 * metered API's `/vaults`) must emit this instead, or the app asserts instant settlement on
 * every vault it has never read a proposal for.
 */
export const PROPOSAL_UNKNOWN = 'unknown';

/** Governance.QUORUM_FLOOR_BPS — the protocol floor a vault's `quorumBps` may not go below. */
export const QUORUM_FLOOR_BPS = 2500;
/** Governance.SIGNER_REGIME_BELOW — under this many members at creation, quorum is not a stake %. */
export const SIGNER_REGIME_BELOW = 5;

/** The phases in order, with what each one means for a holder. */
export const PHASES = [
  { key: 'commit', label: 'Commit', blurb: 'Encrypted votes are being cast. The tally is hidden and exits still settle instantly.' },
  { key: 'reveal', label: 'Reveal', blurb: 'Votes are being revealed. Exits queue from here — the outcome is already visible on-chain.' },
  { key: 'timelock', label: 'Timelock', blurb: 'Passed and waiting. Members can still queue an exit; it settles after execution.' },
  { key: 'execute', label: 'Executed', blurb: 'Swaps have settled. Queued exits settle at the post-rebalance NAV.' },
];

/**
 * Which phase a proposal is in, from chain-read fields. Every deadline is required; if any is
 * missing the phase is `unknown` rather than inferred.
 *
 * @param {{status?:string, commitDeadline?:number|null, revealDeadline?:number|null,
 *          executableAt?:number|null, expiresAt?:number|null}} p
 * @param {number} nowSec
 * @returns {{phase:'commit'|'reveal'|'tally'|'timelock'|'executable'|'executed'|'defeated'|'expired'|'unknown',
 *            index:number, deadline:number|null, deadlineLabel:string}}
 */
export function proposalPhase(p, nowSec) {
  const st = p?.status;
  if (st === 'Executed') return { phase: 'executed', index: 3, deadline: null, deadlineLabel: '' };
  if (st === 'Defeated') return { phase: 'defeated', index: -1, deadline: null, deadlineLabel: '' };
  if (st === 'Expired') return { phase: 'expired', index: -1, deadline: null, deadlineLabel: '' };

  const cd = num(p?.commitDeadline);
  const rd = num(p?.revealDeadline);
  const ea = num(p?.executableAt);
  const ex = num(p?.expiresAt);

  if (st === 'Passed') {
    if (ea === null) return unknown();
    if (nowSec < ea) return { phase: 'timelock', index: 2, deadline: ea, deadlineLabel: 'Executable in' };
    if (ex !== null && nowSec > ex) return { phase: 'expired', index: -1, deadline: null, deadlineLabel: '' };
    return { phase: 'executable', index: 2, deadline: ex, deadlineLabel: 'Execution window closes in' };
  }

  if (st === 'Active') {
    if (cd === null || rd === null) return unknown();
    if (nowSec < cd) return { phase: 'commit', index: 0, deadline: cd, deadlineLabel: 'Commit closes in' };
    if (nowSec < rd) return { phase: 'reveal', index: 1, deadline: rd, deadlineLabel: 'Reveal closes in — unrevealed votes are forfeit' };
    return { phase: 'tally', index: 1, deadline: null, deadlineLabel: 'Awaiting finalisation' };
  }

  return unknown();

  function unknown() {
    return { phase: /** @type {const} */ ('unknown'), index: -1, deadline: null, deadlineLabel: '' };
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Mirror of `Governance.hasPendingExecution(vault)` — the ONLY thing that decides whether an exit
 * settles now or is queued irrevocably.
 *
 * @param {object|null|'unknown'} proposal  the vault's active proposal, `null` for KNOWN-ABSENT,
 *   or `PROPOSAL_UNKNOWN` when the source carries no proposal information at all
 * @param {number} nowSec
 * @returns {true|false|null}  null = not derivable from the data we have (see module header)
 */
export function hasPendingExecution(proposal, nowSec) {
  if (proposal === PROPOSAL_UNKNOWN) return null; // no proposal data ≠ no proposal
  if (!proposal) return false; // no active proposal is knowable from `activeProposal: null`
  const st = proposal.status;
  if (st === 'Defeated' || st === 'Executed' || st === 'Expired') return false;
  if (st === 'Passed') {
    const ex = num(proposal.expiresAt);
    if (ex === null) return null;
    return nowSec <= ex;
  }
  if (st === 'Active') {
    const cd = num(proposal.commitDeadline);
    if (cd === null) return null; // the API does not carry it — say so, do not assume
    return nowSec >= cd;
  }
  return null;
}

/**
 * Exit mode for a vault, as a value the UI can render without deciding anything itself.
 * @returns {{mode:'I'|'F'|'unknown', label:string, detail:string}}
 */
export function resolveExitMode(proposal, nowSec) {
  const pending = hasPendingExecution(proposal, nowSec);
  if (pending === true) {
    return {
      mode: 'F',
      label: 'Mode F — forward-priced',
      detail:
        'A proposal is past its commit deadline, so an exit now is QUEUED, irrevocable, and ' +
        'settles later at a price nobody can show you yet. Your shares lose their vote the ' +
        'moment you queue.',
    };
  }
  if (pending === false) {
    return {
      mode: 'I',
      label: 'Mode I — settles now',
      detail: 'No proposal is past its commit deadline, so an exit settles in the same transaction at current NAV.',
    };
  }
  return {
    mode: 'unknown',
    label: 'Exit mode unresolved',
    detail:
      proposal === PROPOSAL_UNKNOWN
        ? 'This data source carries no proposal information at all, so this app cannot tell you ' +
          'whether a proposal is active here, let alone whether it is past its commit deadline. ' +
          'Treat an exit as possibly irrevocable — your wallet resolves it on-chain at signing time.'
        : 'This vault has an active proposal, but the metered API does not carry proposal deadlines ' +
          '(Governance.Proposed emits no commitDeadline), and the deadline is what decides the mode. ' +
          'Your wallet will resolve it on-chain at signing time — it could be an irrevocable queued exit.',
  };
}

/**
 * Quorum readout, per `Governance.finalize` (Governance.sol:505-549). There are THREE regimes and
 * they do not share a threshold:
 *
 *  1. `RuleChange` — FULL CONSENSUS, no stake percentage at all:
 *     `revealedWeight == snapshotTotal && forWeight >= snapshotTotal`. Reporting a 25% floor
 *     against a proposal that needs 100% is not a rounding error, it is the wrong answer.
 *  2. `memberCount < SIGNER_REGIME_BELOW` — `headMajorityWithStake || forStakeMajority`, where
 *     `headMajorityWithStake` is a strict majority of members-at-creation revealed AND
 *     `forWeight * BPS >= quorumBps * snapshotTotal`, and `forStakeMajority` is
 *     `forWeight * 2 > snapshotTotal`. Both branches count FOR weight, never revealed weight,
 *     and it is not a bare signer count.
 *  3. Otherwise — `revealedWeight * BPS >= quorumBps * snapshotTotal`, measured against the
 *     VAULT's configured `quorumBps` (`configOf[vault].quorumBps`), which is bounded only as
 *     `>= 2500 && <= 10000`. The 2500 protocol FLOOR is not the operative threshold: a vault
 *     configured at 60% is not at quorum because it cleared 26%.
 *
 * In regime 3 the numerator is REVEALED weight only — standing defaults count toward the tally
 * but never toward quorum (ARCHITECTURE §6, K-3), which is why a proposal can read as passing
 * while still short of quorum.
 *
 * @param {{ptype?:string, revealedWeight?:any, forWeight?:any, snapshotTotal?:any,
 *          memberCount?:any, quorumBps?:any, revealedVoterCount?:any}} p
 *        `quorumBps` is the vault's configured quorum. Absent ⇒ the threshold is unknown and
 *        `met` is null; it is never defaulted to the floor.
 */
export function quorumReadout({ ptype, revealedWeight, forWeight, snapshotTotal, memberCount, quorumBps, revealedVoterCount }) {
  const total = big(snapshotTotal);
  const revealed = big(revealedWeight);
  const forW = big(forWeight);
  const members = Number(memberCount);
  const q = Number(quorumBps);
  const hasQuorum = Number.isFinite(q) && q > 0;
  const pct = (n, d) => `${(Number((n * 10_000n) / d) / 100).toFixed(2)}%`;

  if (ptype === 'RuleChange') {
    if (total === null || total === 0n || revealed === null || forW === null) {
      return {
        regime: /** @type {const} */ ('consensus'),
        met: null,
        text: 'RuleChange needs FULL CONSENSUS — every eligible share revealed and voting FOR. The stake snapshot is not exposed, so the shortfall cannot be measured.',
      };
    }
    return {
      regime: /** @type {const} */ ('consensus'),
      met: revealed === total && forW >= total,
      revealedBps: Number((revealed * 10_000n) / total),
      forBps: Number((forW * 10_000n) / total),
      text: `RuleChange — full consensus required, not a quorum percentage: ${pct(revealed, total)} of eligible stake revealed and ${pct(forW, total)} voting FOR, against 100% needed for both.`,
    };
  }

  if (Number.isFinite(members) && members > 0 && members < SIGNER_REGIME_BELOW) {
    if (total === null || total === 0n || forW === null) {
      return {
        regime: /** @type {const} */ ('signers'),
        met: null,
        text: `Under ${SIGNER_REGIME_BELOW} members, so quorum is a member majority carrying quorum stake, OR an outright FOR stake majority. The stake snapshot is not exposed, so neither can be measured.`,
      };
    }
    const headMajority = Number(revealedVoterCount) * 2 > members;
    const forStakeMajority = forW * 2n > total;
    // Branch 2 passes on its own. Branch 1 needs the head majority AND the vault's quorum stake,
    // so without a head majority it is settled false, and with one but no configured quorum the
    // answer is genuinely unknown rather than false.
    const met = forStakeMajority ? true
      : !headMajority ? false
        : hasQuorum ? forW * 10_000n >= BigInt(q) * total
          : null;
    return {
      regime: /** @type {const} */ ('signers'),
      met,
      forBps: Number((forW * 10_000n) / total),
      quorumBps: hasQuorum ? q : null,
      text:
        `${revealedVoterCount ?? '—'} of ${members} members revealed, ${pct(forW, total)} of eligible stake voting FOR. ` +
        `Under ${SIGNER_REGIME_BELOW} members this passes on a member majority carrying ` +
        `${hasQuorum ? `${(q / 100).toFixed(0)}% ` : 'the vault’s '}quorum stake, or on a FOR stake majority alone.`,
    };
  }

  if (total === null || revealed === null || total === 0n) {
    return { regime: /** @type {const} */ ('stake'), met: null, text: 'Quorum unknown — the API does not expose the proposal stake snapshot.' };
  }
  const bps = Number((revealed * 10_000n) / total);
  if (!hasQuorum) {
    return {
      regime: /** @type {const} */ ('stake'),
      met: null,
      bps,
      quorumBps: null,
      text: `${(bps / 100).toFixed(2)}% of eligible stake revealed. This vault’s configured quorum is not exposed, and it is anywhere from ${(QUORUM_FLOOR_BPS / 100).toFixed(0)}% to 100% — so whether that clears it is unknown.`,
    };
  }
  return {
    regime: /** @type {const} */ ('stake'),
    met: revealed * 10_000n >= BigInt(q) * total,
    bps,
    quorumBps: q,
    text: `${(bps / 100).toFixed(2)}% of eligible stake revealed · ${(q / 100).toFixed(2)}% required by this vault`,
  };
}

function big(v) {
  try {
    if (typeof v === 'bigint') return v;
    if (v === null || v === undefined || v === '') return null;
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * An operator diluted below the proposal threshold permanently loses the right to propose —
 * including the RuleChange that would lower the threshold (docs/NOW.md, Governance.sol M-6).
 * Dilution is passive: other members deposit, totalShares grows, nothing re-checks.
 *
 * `eligibleTotal` is `pastTotalVotingEligibleShares` (Governance.sol:288-291) — NOT `totalShares`.
 * It is net of queued-exit shares and of parent stake, so passing `totalShares` inflates the
 * denominator and under-reports an operator's standing against the threshold.
 *
 * @returns {{ok:boolean, bps:number, thresholdBps:number, headroomBps:number}|null}
 */
export function proposalRight({ stake, eligibleTotal, proposalThresholdBps }) {
  const s = big(stake);
  const t = big(eligibleTotal);
  const th = Number(proposalThresholdBps);
  if (s === null || t === null || t === 0n || !Number.isFinite(th)) return null;
  const bps = Number((s * 10_000n) / t);
  return { ok: bps >= th, bps, thresholdBps: th, headroomBps: bps - th };
}
