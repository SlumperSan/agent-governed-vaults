// @ts-check
/**
 * Validation for `docs/seeded-addresses.json` — the public disclosure list of owner-funded persona
 * wallets (Decisions/Seed agent personas 2026-09-23.md). The file itself ships with an empty
 * `addresses` array, so a test that only reads the shipped file proves nothing about the shape this
 * module enforces; `scripts/test/seeded-addresses.test.mjs` feeds this function planted fixtures
 * (a valid entry, a bad checksum, a case-variant duplicate) for that reason.
 *
 * Kept out of `apps/web/src` deliberately: this validator needs `viem`'s `getAddress` for the
 * checksum check, and `apps/web/src` is zero-dependency by its own rule (see that directory's
 * README). `apps/web/src/seeded.mjs` is the pure, dependency-free counterpart the UIs use at
 * render time — it takes the list as already-validated data.
 */
import { getAddress } from 'viem';

/** @typedef {{address:string, persona:string, model:string, fundedBy:string, addedAt:string, note:string}} SeededAddressEntry */

const REQUIRED_KEYS = /** @type {const} */ (['address', 'persona', 'model', 'fundedBy', 'addedAt', 'note']);

/**
 * @param {unknown} doc  the parsed contents of docs/seeded-addresses.json
 * @returns {{ok:true}|{ok:false, errors:string[]}}
 */
export function validateSeededAddressesDoc(doc) {
  const errors = [];
  if (doc === null || typeof doc !== 'object') {
    return { ok: false, errors: ['document is not an object'] };
  }
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (typeof d.readme !== 'string' || d.readme.trim().length === 0) {
    errors.push('missing or empty "readme" header field');
  }
  if (!Array.isArray(d.addresses)) {
    errors.push('"addresses" is not an array');
    return { ok: false, errors };
  }

  const seenLower = new Map(); // lowercased address -> index of first occurrence
  d.addresses.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      errors.push(`addresses[${i}] is not an object`);
      return;
    }
    const e = /** @type {Record<string, unknown>} */ (entry);
    for (const key of REQUIRED_KEYS) {
      if (typeof e[key] !== 'string' || e[key].trim().length === 0) {
        errors.push(`addresses[${i}].${key} is missing or not a non-empty string`);
      }
    }
    if (typeof e.address !== 'string') return;

    let checksummed;
    try {
      checksummed = getAddress(e.address);
    } catch {
      errors.push(`addresses[${i}].address "${e.address}" is not a valid address`);
      return;
    }
    if (checksummed !== e.address) {
      errors.push(`addresses[${i}].address "${e.address}" is not checksummed (expected "${checksummed}")`);
    }

    const lower = e.address.toLowerCase();
    if (seenLower.has(lower)) {
      errors.push(`addresses[${i}].address duplicates addresses[${seenLower.get(lower)}] (case-insensitive)`);
    } else {
      seenLower.set(lower, i);
    }
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
