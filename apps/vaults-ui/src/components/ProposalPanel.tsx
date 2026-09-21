import type { Vault } from '../lib/atlas';
import { proposalPhase, quorumReadout, wadExact } from '../lib/atlas';

/**
 * `quorumReadout.met` HAS THREE STATES AND THIS TAG SHOWS THREE. `null` is "not measurable from
 * what was read" — the sub-five regime returns it whenever `delegatedForWeight` is absent, and the
 * stake and RuleChange regimes whenever the snapshot or the vault's own quorum is not exposed.
 * `met ? 'met' : 'not met'` collapsed that onto the negative, printing a settled "not met" beside
 * a sentence saying the answer is unknown. Asserting a proposal is short of quorum when the chain
 * has not been asked is the same class of lie as asserting an exit settles instantly.
 */
function quorumTag(met: boolean | null): string {
  return met === true ? 'met' : met === false ? 'not met' : 'unknown';
}

interface Props {
  readonly vault: Vault;
  readonly nowSec: number;
}

/**
 * The proposal, its phase, and the votes.
 *
 * PHASE AND QUORUM ARE NOT COMPUTED HERE. `proposalPhase` and `quorumReadout`
 * come from `apps/web/src/governance.mjs`, which mirrors `Governance.sol` and
 * is tested against it. A component that re-derived "has it passed" would be a
 * second opinion on a consensus rule.
 *
 * Votes are shown as commit-reveal actually behaves: `revealedWeight` is the
 * quorum numerator and is the only weight that has been proven, while for and
 * against include applied standing defaults. Unrevealed commitments are not
 * votes and are not counted here.
 */
export function ProposalPanel({ vault, nowSec }: Props) {
  const p = vault.proposal;
  if (!p) {
    return (
      <section className="panel">
        <h2>Proposal</h2>
        <p className="note">No open proposal. Nothing rebalances until one passes.</p>
      </section>
    );
  }

  const phase = proposalPhase(p, nowSec);
  const readout = quorumReadout({
    ptype: p.ptype,
    revealedWeight: p.revealedWeight,
    forWeight: p.forWeight,
    snapshotTotal: p.snapshotTotal,
    memberCount: p.memberCount,
    quorumBps: (vault.governanceConfig?.['quorumBps'] as number | undefined) ?? undefined,
    revealedVoterCount: p.revealedVoterCount,
    // Sub-five vaults measure both stake terms on FOR weight MINUS cranked delegated weight
    // (VO-2b). Omitting this makes the readout `met: null` rather than wrong — but "unknown" on
    // every sub-five vault is what shipped before this line existed, so it is forwarded rather
    // than left implicit.
    delegatedForWeight: p.delegatedForWeight,
  });

  const forW = p.forWeight ?? 0n;
  const againstW = p.againstWeight ?? 0n;
  const cast = forW + againstW;
  const forPct = cast === 0n ? 0 : Number((forW * 10000n) / cast) / 100;

  return (
    <section className="panel">
      <h2>Proposal #{p.pid}</h2>
      {/* No on-chain title — `Governance.proposals` carries `actionHash`, not prose. Fall back to
          the proposal type rather than rendering a blank line where fixture data used to have one. */}
      <p className="proposal-title">{p.title ?? `${p.ptype} proposal`}</p>
      <dl className="kv">
        <dt>Type</dt>
        <dd>{p.ptype}</dd>
        <dt>Phase</dt>
        <dd>
          <span className="tag">{phase.phase}</span>{' '}
          <span className="dim">{phase.deadlineLabel}</span>
        </dd>
        <dt>Proposed by</dt>
        <dd className="mono">{p.proposer}</dd>
        <dt>Quorum</dt>
        <dd>
          <span className={readout.met === true ? 'tag' : 'tag tag-warn'}>{quorumTag(readout.met)}</span>{' '}
          <span className="dim">{readout.text}</span>
        </dd>
      </dl>

      <h3>Votes</h3>
      <div
        className="bar"
        role="img"
        aria-label={`${forPct.toFixed(1)} percent for, ${(100 - forPct).toFixed(1)} percent against, of revealed weight`}
      >
        <div className="bar-for" style={{ width: `${forPct}%` }} />
      </div>
      <table className="grid">
        <tbody>
          <tr>
            <th scope="row">For</th>
            <td className="num">{wadExact(forW, { maxFrac: 2 })}</td>
          </tr>
          <tr>
            <th scope="row">Against</th>
            <td className="num">{wadExact(againstW, { maxFrac: 2 })}</td>
          </tr>
          <tr>
            <th scope="row">Revealed</th>
            <td className="num">{wadExact(p.revealedWeight ?? 0n, { maxFrac: 2 })}</td>
          </tr>
          <tr>
            <th scope="row">Eligible at snapshot</th>
            <td className="num dim">{wadExact(p.snapshotTotal ?? 0n, { maxFrac: 2 })}</td>
          </tr>
        </tbody>
      </table>
      <p className="note">
        Revealed weight is the quorum numerator. A commitment that is never revealed is not a vote.
      </p>
    </section>
  );
}
