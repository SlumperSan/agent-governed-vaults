/**
 * Pure decision: can a resumed smoke run still finish this proposal, and if not, what settles it?
 *
 * Extracted from smoke-test.mjs so it can be tested without executing the runner (which drives
 * `cast` and sends transactions on import).
 *
 * Governance facts this encodes — see contracts/src/Governance.sol:
 *  - `markExpired(pid)` requires `status == Passed && now > expiresAt`. It rejects anything else.
 *  - `finalize(pid)` requires `status == Active && now >= revealDeadline`. With
 *    `revealedVoterCount == 0` quorum fails under every regime, so it settles Defeated.
 *  - `_refreshStatus()` only auto-expires *Passed* proposals, so an Active-but-shut proposal
 *    never settles on its own, and `propose()` keeps reverting `ProposalActive()` until it does.
 */

/** @typedef {{stranded: boolean, action: 'markExpired'|'finalize'|null, reason: string}} Recovery */

/**
 * @param {Object} p
 * @param {string} p.status              one of None|Active|Passed|Defeated|Executed|Expired
 * @param {number} p.now                 chain time, seconds
 * @param {number} p.expiresAt           execution-window end, seconds
 * @param {number} p.revealDeadline      reveal-window end, seconds
 * @param {number} p.revealedVoterCount  reveals landed so far
 * @returns {Recovery}
 */
export function classifyProposal({ status, now, expiresAt, revealDeadline, revealedVoterCount }) {
  if (status === 'Passed' && now > expiresAt) {
    return { stranded: true, action: 'markExpired', reason: 'passed but execution window lapsed' };
  }
  if (status === 'Active' && now >= revealDeadline && revealedVoterCount === 0) {
    return {
      stranded: true,
      action: 'finalize',
      reason: 'reveal window shut with nothing revealed — can never pass, and blocks the next propose()',
    };
  }
  if (status === 'Expired' || status === 'Defeated') {
    return { stranded: true, action: null, reason: `already settled (${status})` };
  }
  return { stranded: false, action: null, reason: `still workable (${status})` };
}
