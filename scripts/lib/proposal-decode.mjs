// @ts-check
/**
 * Decode one `proposals(uint256)` result into a named object. Pure — no chain, no `cast`.
 *
 * WHY THIS IS A SEPARATE MODULE. scripts/smoke-test.mjs reads a proposal in three places, and it
 * cannot be imported by a test: it resolves a deployment file, builds `cast` argument lists and
 * runs the whole lifecycle at import. So the decode that lived inside it — `STATUS[Number(p[8])]`
 * and four bare index constants — was arithmetic no test in this repository could reach. Respell
 * an entry in `STATUS` and `stepFinalize`'s `status === 'Passed'` assertion rejects a proposal
 * that did pass; shift one index and `recoverStrandedProposal` hands `classifyProposal` a
 * timestamp belonging to a different field. Either way every suite stays green. Issue #196.
 *
 * The field names and the Number/BigInt split are deliberately identical to `readProposal` in
 * scripts/soak/lib.mjs:419-433, so that if the two decodes are later served by one module the
 * change is an import swap rather than a rewrite at every call site. They are separate today
 * because lib.mjs's decode is still fused to its own `call()` — the soak runner's `cast` wrapper —
 * and unfusing it is PR #193's change, not this one.
 */

/**
 * The `cast call` signature. `cast` prints one line per return value, so this signature's arity
 * is also the length of the array `decodeProposal` expects.
 *
 * Sixteen values, matching `Governance.proposals(uint256)`.
 */
export const PROPOSAL_SIG =
  'proposals(uint256)(address,uint8,address,uint64,uint64,uint64,uint64,uint64,uint8,bytes32,uint256,uint256,uint256,uint256,uint256,uint256)';

/** Tuple position of each field, in the order `PROPOSAL_SIG` returns them. */
export const P = {
  VAULT: 0, PTYPE: 1, PROPOSER: 2, CREATED_AT: 3, COMMIT_DEADLINE: 4, REVEAL_DEADLINE: 5,
  EXECUTABLE_AT: 6, EXPIRES_AT: 7, STATUS: 8, ACTION_HASH: 9, SNAPSHOT_TOTAL: 10,
  MEMBER_COUNT: 11, FOR_WEIGHT: 12, AGAINST_WEIGHT: 13, REVEALED_WEIGHT: 14,
  REVEALED_VOTER_COUNT: 15,
};

/**
 * `Governance.Status`, in declaration order (contracts/src/Governance.sol:95-102).
 *
 * There is NO out-of-range fallback here, and that is the pre-existing behaviour preserved
 * unchanged: a status byte outside 0..5 decodes to `undefined`, exactly as the inline lookup in
 * smoke-test.mjs did before this extraction. packages/reference-agent/src/chain.mjs:136 appends
 * `?? 'Unknown'` instead; that is a deliberate choice in that module, not a divergence introduced
 * here, and changing this one would alter the text of smoke-test's finalize assertion.
 */
export const STATUS = ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'];

/**
 * @param {string[]} p one decoded `cast call` output line per tuple member, in `P` order
 * @returns {object} the named proposal, with `raw` carrying the input lines unchanged
 */
export function decodeProposal(p) {
  return {
    raw: p,
    vault: p[P.VAULT], ptype: Number(p[P.PTYPE]), proposer: p[P.PROPOSER],
    createdAt: Number(p[P.CREATED_AT]),
    commitDeadline: Number(p[P.COMMIT_DEADLINE]), revealDeadline: Number(p[P.REVEAL_DEADLINE]),
    executableAt: Number(p[P.EXECUTABLE_AT]), expiresAt: Number(p[P.EXPIRES_AT]),
    status: STATUS[Number(p[P.STATUS])], actionHash: p[P.ACTION_HASH],
    snapshotTotal: BigInt(p[P.SNAPSHOT_TOTAL]), memberCount: Number(p[P.MEMBER_COUNT]),
    forWeight: BigInt(p[P.FOR_WEIGHT]), againstWeight: BigInt(p[P.AGAINST_WEIGHT]),
    revealedWeight: BigInt(p[P.REVEALED_WEIGHT]),
    revealedVoterCount: Number(p[P.REVEALED_VOTER_COUNT]),
  };
}
