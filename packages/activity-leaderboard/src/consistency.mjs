// @ts-check
/**
 * Head-state consistency checks. Both read state at one block and need no archive node.
 *
 * `assertHeadState`: before anything is published, (1) for every configured vault, the sum of the
 * ledger's shares must equal the contract's `totalShares()`, and (2) every position the reducer
 * holds must equal the contract's `sharesOf(member)` and `costBasisUsdc(member)`. Check (1) is the
 * one that sees a member who still holds shares and whose logs were all missed: that member is not
 * in the ledger, so check (2) never visits them, but their shares are in `totalShares()`, which only
 * mint and burn change (the same two places `sharesOf` changes). It cannot see an address that
 * entered and fully left inside missed logs, because that address leaves nothing at the head. A
 * mismatch aborts the run with nothing written.
 *
 * `assertSameChainView`: a second endpoint must report the same block hash at the head block and the
 * same `totalShares()` per vault. Together with the first check this ties the ledger to both.
 */

export class ConsistencyError extends Error {
  /** @param {string[]} mismatches */
  constructor(mismatches) {
    super(`head-state check failed for ${mismatches.length} item(s):\n  ${mismatches.slice(0, 20).join('\n  ')}`);
    this.name = 'ConsistencyError';
    this.mismatches = mismatches;
  }
}

/**
 * @param {object} p
 * @param {string[]} p.vaults  every configured vault address (a vault with no events is still checked)
 * @param {Map<string, {vault:string, member:string, shares:bigint, basis:bigint}>} p.positions
 * @param {(vault:string, member:string, blockNumber:number) => Promise<{shares:bigint, basis:bigint}>} p.readPosition
 * @param {(vault:string, blockNumber:number) => Promise<bigint>} p.readTotalShares
 * @param {number} p.blockNumber
 * @returns {Promise<{checked:number, vaultsChecked:number}>}
 */
export async function assertHeadState({ vaults, positions, readPosition, readTotalShares, blockNumber }) {
  if (vaults.length === 0) throw new Error('consistency: no vaults to check');
  const mismatches = [];

  /** @type {Map<string, bigint>} */
  const ledgerShares = new Map(vaults.map((v) => [v.toLowerCase(), 0n]));
  for (const pos of positions.values()) {
    if (!ledgerShares.has(pos.vault)) throw new Error(`consistency: position in unconfigured vault ${pos.vault}`);
    ledgerShares.set(pos.vault, /** @type {bigint} */ (ledgerShares.get(pos.vault)) + pos.shares);
  }
  for (const [vault, sum] of [...ledgerShares].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const total = await readTotalShares(vault, blockNumber);
    if (total !== sum) {
      mismatches.push(`${vault} totalShares: ledger sums to ${sum}, chain says ${total}; ${total > sum ? 'a member\'s logs were missed' : 'the ledger holds shares the chain does not'}`);
    }
  }

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
  return { checked, vaultsChecked: ledgerShares.size };
}

/**
 * @param {object} p
 * @param {{blockInfo:(n:number)=>Promise<{hash:string}>, readTotalShares:(v:string,n:number)=>Promise<bigint>}} p.primary
 * @param {{blockInfo:(n:number)=>Promise<{hash:string}>, readTotalShares:(v:string,n:number)=>Promise<bigint>}} p.secondary
 * @param {string[]} p.vaults
 * @param {number} p.blockNumber
 */
export async function assertSameChainView({ primary, secondary, vaults, blockNumber }) {
  const mismatches = [];
  const [a, b] = await Promise.all([primary.blockInfo(blockNumber), secondary.blockInfo(blockNumber)]);
  if (a.hash !== b.hash) mismatches.push(`block ${blockNumber} hash: first endpoint ${a.hash}, second endpoint ${b.hash}`);
  for (const v of vaults) {
    const [x, y] = await Promise.all([primary.readTotalShares(v, blockNumber), secondary.readTotalShares(v, blockNumber)]);
    if (x !== y) mismatches.push(`${v.toLowerCase()} totalShares at block ${blockNumber}: first endpoint ${x}, second endpoint ${y}`);
  }
  if (mismatches.length > 0) throw new ConsistencyError(mismatches);
}
