// @ts-check
/**
 * Team-operated addresses: the owner-funded persona wallets in `docs/seeded-addresses.json`, each
 * vault's creator, and each chain's deployer. They are measured like everyone else and labelled
 * `teamOperated`; they are left out of ranks and shown in a separate total.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param {object} inputs
 * @param {{addresses?: Array<{address: string}>}} inputs.seededDoc  parsed docs/seeded-addresses.json
 * @param {readonly string[]} [inputs.creators]   vault creator addresses
 * @param {readonly string[]} [inputs.deployers]  deployer addresses
 * @returns {Map<string, string[]>} lowercase address -> sorted reasons ('seeded' | 'creator' | 'deployer')
 */
export function buildTeamSet({ seededDoc, creators = [], deployers = [] }) {
  if (!seededDoc || !Array.isArray(seededDoc.addresses)) throw new Error('team: seeded-addresses document has no addresses array');
  /** @type {Map<string, Set<string>>} */
  const m = new Map();
  const add = (a, reason) => {
    if (typeof a !== 'string' || !ADDRESS_RE.test(a)) throw new Error(`team: ${reason} entry is not an address: ${String(a)}`);
    const k = a.toLowerCase();
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)?.add(reason);
  };
  for (const e of seededDoc.addresses) add(e?.address, 'seeded');
  for (const a of creators) add(a, 'creator');
  for (const a of deployers) add(a, 'deployer');
  return new Map([...m].map(([k, v]) => [k, [...v].sort()]));
}
