// @ts-check
/**
 * Head-state consistency check. Before anything is published, every position the reducer holds is
 * compared with the contract's own `sharesOf(member)` and `costBasisUsdc(member)` read at the same
 * block. A mismatch means the logs were misread or incomplete (a wrong event field, a missed
 * window), and the run aborts with nothing written. It reads head state only, so it needs no
 * archive node.
 */

export class ConsistencyError extends Error {
  /** @param {string[]} mismatches */
  constructor(mismatches) {
    super(`head-state check failed for ${mismatches.length} position(s):\n  ${mismatches.slice(0, 20).join('\n  ')}`);
    this.name = 'ConsistencyError';
    this.mismatches = mismatches;
  }
}

/**
 * @param {object} p
 * @param {Map<string, {vault:string, member:string, shares:bigint, basis:bigint}>} p.positions
 * @param {(vault:string, member:string, blockNumber:number) => Promise<{shares:bigint, basis:bigint}>} p.readPosition
 * @param {number} p.blockNumber
 * @returns {Promise<{checked:number}>}
 */
export async function assertHeadState({ positions, readPosition, blockNumber }) {
  const mismatches = [];
  let checked = 0;
  for (const key of [...positions.keys()].sort()) {
    const pos = /** @type {NonNullable<ReturnType<typeof positions.get>>} */ (positions.get(key));
    const onChain = await readPosition(pos.vault, pos.member, blockNumber);
    checked += 1;
    if (onChain.shares !== pos.shares || onChain.basis !== pos.basis) {
      mismatches.push(`${pos.vault} member ${pos.member}: ledger shares ${pos.shares} basis ${pos.basis}, chain shares ${onChain.shares} basis ${onChain.basis}`);
    }
  }
  if (mismatches.length > 0) throw new ConsistencyError(mismatches);
  return { checked };
}
