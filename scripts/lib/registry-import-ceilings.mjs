// @ts-check
/**
 * Validation of the `importCeilings` section of contracts/config/agent-registry-create2.json.
 *
 * WHY. `RWAllyAgentRegistry.initialize` takes `importIdCeiling_` as a typed number: the outside
 * ERC-8004 registry has no next-id view, so the contract cannot check it. The value is a per-chain
 * snapshot taken at a recorded block BEFORE that chain's deploy is announced, and recorded here.
 * Reading the ceiling later (for example just before the initialize transaction) lets anyone mint
 * outside ids for the price of gas in the meantime and import every one free, so the recorded
 * snapshot is the only legitimate source. This check refuses to call a chain ready while its entry
 * is missing, still a placeholder, or malformed.
 *
 * It checks the shape of what is recorded. It cannot check that the number is true; that is what
 * the two-RPC read in the snapshot note is for.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param {any} cfg parsed agent-registry-create2.json
 * @returns {{ ok: boolean, problems: string[], chains: string[] }}
 */
export function checkImportCeilings(cfg) {
  /** @type {string[]} */
  const problems = [];
  const section = cfg && cfg.importCeilings;
  if (!section || typeof section !== 'object') {
    return { ok: false, problems: ['importCeilings section is missing'], chains: [] };
  }
  const chains = section.chains;
  if (!chains || typeof chains !== 'object' || Object.keys(chains).length === 0) {
    return { ok: false, problems: ['importCeilings.chains is missing or empty'], chains: [] };
  }
  for (const [key, e] of Object.entries(chains)) {
    const at = `importCeilings.chains.${key}`;
    if (!e || typeof e !== 'object') {
      problems.push(`${at} is not an object`);
      continue;
    }
    const entry = /** @type {Record<string, any>} */ (e);
    if ('placeholder' in entry || JSON.stringify(entry).toLowerCase().includes('placeholder')) {
      problems.push(`${at} is still a placeholder: take the snapshot and record block, nextId and readAt`);
      continue;
    }
    if (!Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) {
      problems.push(`${at}.chainId must be a positive integer`);
    }
    if (typeof entry.outsideRegistry !== 'string' || !ADDRESS.test(entry.outsideRegistry)) {
      problems.push(`${at}.outsideRegistry must be an address`);
    }
    if (!Number.isSafeInteger(entry.block) || entry.block <= 0) {
      problems.push(`${at}.block must be a positive integer block number`);
    }
    if (!Number.isSafeInteger(entry.nextId) || entry.nextId <= 0) {
      problems.push(`${at}.nextId must be a positive integer (the snapshotted next agent id)`);
    }
    if (
      typeof entry.readAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(entry.readAt) ||
      Number.isNaN(Date.parse(entry.readAt))
    ) {
      problems.push(`${at}.readAt must be an ISO UTC timestamp such as 2026-10-18T17:40:33Z`);
    }
    const arc = cfg.outsideRegistry && cfg.outsideRegistry[key];
    if (arc !== undefined && typeof entry.outsideRegistry === 'string' && arc.toLowerCase() !== entry.outsideRegistry.toLowerCase()) {
      problems.push(`${at}.outsideRegistry differs from outsideRegistry.${key}`);
    }
  }
  return { ok: problems.length === 0, problems, chains: Object.keys(chains) };
}
