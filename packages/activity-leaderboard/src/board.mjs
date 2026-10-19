// @ts-check
import { FORMULA_VERSION, SCHEMA, SECONDS_PER_DAY, USDC_DAYS_DECIMALS } from './constants.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';

/**
 * Render cost-basis USDC-seconds (raw USDC units x seconds) as USDC-days with six exact decimals,
 * floored. `usdcSeconds / 86400` is the count of 10^-6 USDC-days, so no precision is invented.
 * @param {bigint} usdcSeconds
 */
export function usdcDaysString(usdcSeconds) {
  const micro = usdcSeconds / SECONDS_PER_DAY;
  const s = micro.toString(10).padStart(USDC_DAYS_DECIMALS + 1, '0');
  return `${s.slice(0, -USDC_DAYS_DECIMALS)}.${s.slice(-USDC_DAYS_DECIMALS)}`;
}

/**
 * Rank non-team rows by USDC-seconds descending, ties by address ascending. Team-operated rows get
 * rank null. Returns rows sorted by address (the file order), each carrying its rank.
 * @param {Array<{address:string, usdcSeconds:bigint, teamOperated:boolean, teamReasons:string[], extra?: object}>} rows
 */
function rankRows(rows) {
  const ranked = rows.filter((r) => !r.teamOperated)
    .sort((a, b) => (a.usdcSeconds === b.usdcSeconds ? (a.address < b.address ? -1 : 1) : a.usdcSeconds > b.usdcSeconds ? -1 : 1));
  const rankOf = new Map(ranked.map((r, i) => [r.address, i + 1]));
  return [...rows]
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .map((r) => ({
      ...(r.extra ?? {}),
      address: r.address,
      rank: rankOf.get(r.address) ?? null,
      teamOperated: r.teamOperated,
      teamReasons: r.teamReasons,
      usdcDays: usdcDaysString(r.usdcSeconds),
      usdcSeconds: r.usdcSeconds,
    }));
}

/** Two totals, never one: team-operated, and everyone else. */
function totalsOf(rows) {
  const t = { teamOperated: { addresses: 0, usdcSeconds: 0n }, others: { addresses: 0, usdcSeconds: 0n } };
  for (const r of rows) {
    const side = r.teamOperated ? t.teamOperated : t.others;
    side.addresses += 1;
    side.usdcSeconds += r.usdcSeconds;
  }
  return {
    teamOperated: { addresses: t.teamOperated.addresses, usdcDays: usdcDaysString(t.teamOperated.usdcSeconds), usdcSeconds: t.teamOperated.usdcSeconds },
    others: { addresses: t.others.addresses, usdcDays: usdcDaysString(t.others.usdcSeconds), usdcSeconds: t.others.usdcSeconds },
  };
}

/**
 * Global row rule: an address's chains are summed only where its deployed-code hash equals the hash
 * on its largest-position chain (ties: lowest chain id). The same address on two chains can be two
 * different parties when it is a counterfactual wallet. A chain where the address has a position but
 * no code hash was supplied THROWS, so the rule cannot be skipped by omission.
 * @param {Array<{chainId:number, usdcSeconds: Map<string,bigint>, codeHashes: Map<string,string>}>} chains
 * @param {Map<string,string[]>} team
 */
function globalRows(chains, team) {
  /** @type {Map<string, Array<{chainId:number, usdcSeconds:bigint, codeHash:string}>>} */
  const byAddr = new Map();
  for (const c of chains) {
    for (const [addr, secs] of c.usdcSeconds) {
      const codeHash = c.codeHashes.get(addr);
      if (codeHash === undefined) throw new Error(`board: no code hash for ${addr} on chain ${c.chainId}; the global row cannot be formed`);
      if (!byAddr.has(addr)) byAddr.set(addr, []);
      byAddr.get(addr)?.push({ chainId: c.chainId, usdcSeconds: secs, codeHash });
    }
  }
  const rows = [];
  for (const [address, parts] of byAddr) {
    const ref = [...parts].sort((a, b) => (a.usdcSeconds === b.usdcSeconds ? a.chainId - b.chainId : a.usdcSeconds > b.usdcSeconds ? -1 : 1))[0];
    const counted = parts.filter((p) => p.codeHash === ref.codeHash);
    const excluded = parts.filter((p) => p.codeHash !== ref.codeHash);
    rows.push({
      address,
      usdcSeconds: counted.reduce((s, p) => s + p.usdcSeconds, 0n),
      teamOperated: team.has(address),
      teamReasons: team.get(address) ?? [],
      extra: {
        chainsCounted: counted.map((p) => p.chainId).sort((a, b) => a - b),
        chainsExcluded: excluded.map((p) => p.chainId).sort((a, b) => a - b),
      },
    });
  }
  return rows;
}

/**
 * @param {object} input
 * @param {{number:number, start:number, end:number, status:'closed'|'provisional'}} input.epoch
 * @param {string} input.codeCommit  commit of the code that produced the board (an input, not discovered)
 * @param {string} input.seededAddressesSha256 SHA-256 of docs/seeded-addresses.json as read
 * @param {Map<string,string[]>} input.team
 * @param {Array<{chainId:number, name:string, vaults:string[], fromBlock:number, toBlock:number, toBlockHash:string, integratedUntil:number,
 *   usdcSeconds: Map<string,bigint>, codeHashes: Map<string,string>}>} input.chains
 */
export function buildBoard({ epoch, codeCommit, seededAddressesSha256, team, chains }) {
  const orderedChains = [...chains].sort((a, b) => a.chainId - b.chainId);
  const perChain = orderedChains.map((c) => {
    const rows = rankRows([...c.usdcSeconds].map(([address, usdcSeconds]) => ({
      address, usdcSeconds, teamOperated: team.has(address), teamReasons: team.get(address) ?? [],
    })));
    return {
      chainId: c.chainId,
      name: c.name,
      vaults: [...c.vaults].map((v) => v.toLowerCase()).sort(),
      fromBlock: c.fromBlock,
      toBlock: c.toBlock,
      toBlockHash: c.toBlockHash,
      integratedUntil: c.integratedUntil,
      rows,
      totals: totalsOf(rows),
    };
  });
  const gRows = rankRows(globalRows(orderedChains, team));
  const body = {
    schema: SCHEMA,
    formulaVersion: FORMULA_VERSION,
    epoch,
    codeCommit,
    seededAddressesSha256,
    chains: perChain,
    global: { rows: gRows, totals: totalsOf(gRows) },
  };
  return { ...body, contentSha256: sha256Hex(canonicalJson(body)) };
}

/** Recompute a board's hash from its body; true only if it matches the recorded one. */
export function verifyBoard(board) {
  const { contentSha256, ...body } = board;
  return typeof contentSha256 === 'string' && sha256Hex(canonicalJson(body)) === contentSha256;
}

/** The exact bytes written to a file: canonical JSON plus a newline. */
export const boardFileText = (board) => `${canonicalJson(board)}\n`;
