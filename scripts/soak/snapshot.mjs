// @ts-check
/**
 * Reading the indexer's snapshot file.
 *
 * Extracted and unit-tested because getting it wrong is silent. The snapshot serializes its
 * `vaults` and `operators` Maps as ARRAYS OF [key, value] PAIRS, not as plain objects:
 *
 *   "vaults": [ ["0x9702…", { vault: "0x9702…", operatorId: 1, … }] ]
 *
 * so the obvious `Object.keys(snap.vaults)` yields `["0"]` — the array indices. That does not
 * throw. It quietly produces a vault list containing the string "0", which never matches a real
 * address, so drill 1 would have concluded "the indexer never discovered vault B" and reported
 * a false failure against working software. The block cursor is `lastBlock`; there is no
 * `cursor` field, and reading one gives `undefined` rather than an error.
 *
 * Both shapes are pinned by tests against the real snapshot the running indexer writes.
 */

/**
 * Vault addresses known to a snapshot, lowercased.
 * @param {any} snap parsed indexer-state.json
 * @returns {string[]}
 */
export function vaultsIn(snap) {
  const v = snap?.vaults;
  if (Array.isArray(v)) {
    // Serialized Map: [[key, value], …]. Prefer the entry's own `vault` field over the key,
    // so a future change to the map key does not silently break discovery detection.
    return v.map((entry) => {
      if (Array.isArray(entry)) return String(entry[1]?.vault ?? entry[0] ?? '').toLowerCase();
      return String(entry?.vault ?? '').toLowerCase();
    }).filter(Boolean);
  }
  if (v && typeof v === 'object') return Object.keys(v).map((k) => k.toLowerCase());
  return [];
}

/**
 * The snapshot's block cursor.
 * @param {any} snap
 * @returns {number|null}
 */
export function headBlockOf(snap) {
  const b = snap?.lastBlock;
  return typeof b === 'number' ? b : (b != null ? Number(b) : null);
}

/**
 * Look up one vault's projected row.
 * @param {any} snap
 * @param {string} address
 */
export function vaultRow(snap, address) {
  const want = String(address).toLowerCase();
  const v = snap?.vaults;
  if (Array.isArray(v)) {
    for (const entry of v) {
      const row = Array.isArray(entry) ? entry[1] : entry;
      if (String(row?.vault ?? '').toLowerCase() === want) return row;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const row of Object.values(v)) {
      if (String(/** @type {any} */ (row)?.vault ?? '').toLowerCase() === want) return row;
    }
  }
  return null;
}
