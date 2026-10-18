// @ts-check
/**
 * Payload bytes for `Governance.execute`.
 *
 * A proposal commits to `actionHash = keccak256(payload)` and the chain never stores the payload,
 * so a crank can execute only a payload it was handed. `policy.crank.knownPayloads` maps
 * `actionHash => payload`; this module is where that map is checked against the hash function, once
 * per tick, so the pure planner and the actor read only entries whose bytes really hash to their key.
 *
 * Async because viem is a lazy dependency in this package (see salt.mjs): nothing here may load it
 * at import time, and `policy.mjs` stays free of it.
 */

/** @type {any} */
let _viem = null;
async function viem() {
  if (_viem) return _viem;
  _viem = await import('viem').catch(() => {
    throw new Error('payloads: viem is not installed: run `npm install viem` at the repo root');
  });
  return _viem;
}

/** keccak256 of `0x` hex bytes, lowercase. @param {string} payload @returns {Promise<string>} */
export async function payloadHash(payload) {
  const { keccak256 } = await viem();
  return String(keccak256(payload)).toLowerCase();
}

/**
 * Keep only the entries whose payload hashes to their key. Keys come back lowercase. A mismatched
 * entry is reported, never repaired and never executed.
 *
 * @param {Record<string,string>|null|undefined} known  actionHash => payload hex
 * @returns {Promise<{verified: Record<string,string>, rejected: Array<{actionHash:string, reason:string}>}>}
 */
export async function verifyKnownPayloads(known) {
  /** @type {Record<string,string>} */
  const verified = {};
  const rejected = [];
  for (const [key, payload] of Object.entries(known ?? {})) {
    const actionHash = key.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(actionHash)) {
      rejected.push({ actionHash: key, reason: 'key is not a 32-byte 0x hash' });
      continue;
    }
    if (typeof payload !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payload)) {
      rejected.push({ actionHash, reason: 'payload is not 0x hex bytes' });
      continue;
    }
    const actual = await payloadHash(payload);
    if (actual !== actionHash) {
      rejected.push({ actionHash, reason: `payload hashes to ${actual}, not to its key` });
      continue;
    }
    verified[actionHash] = payload;
  }
  return { verified, rejected };
}
