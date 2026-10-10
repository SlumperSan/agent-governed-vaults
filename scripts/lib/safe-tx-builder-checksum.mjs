// @ts-check
/**
 * Safe{Wallet} Transaction Builder's own batch-file checksum algorithm, ported EXACTLY from
 * safe-global/safe-react-apps, commit `118f25df89f781631386e6b279d812dfc837204a`:
 *
 *   apps/tx-builder/src/lib/checksum.ts            -- serializeJSONObject / calculateChecksum /
 *                                                       addChecksum / validateChecksum (ported below)
 *   apps/tx-builder/src/typings/models.ts           -- BatchFile / BatchTransaction / ContractMethod
 *   apps/tx-builder/src/store/transactionLibraryContext.tsx -- `initializeBatch`: confirms the
 *                                                       checksum is OPTIONAL on import (see note below)
 *
 * `serializeJSONObject` is transcribed line-for-line from `checksum.ts` (object keys sorted, then
 * `JSON.stringify` of the sorted key array prefixed to a recursively-serialized value list) —
 * anything else here would be exactly the untested-reimplementation shape this repository has
 * already paid for once (`scripts/lib/safe-exec.mjs`'s own header). The ONE substitution is the
 * hash primitive: the original calls `web3.utils.sha3` (plain Keccak-256 over the UTF-8 bytes of a
 * string that does not itself look like `0x`-prefixed hex, which every string this module ever
 * hashes satisfies — see below); `keccak` is injected here rather than importing a `web3` dependency
 * scripts/ does not otherwise carry (smoke-test.mjs's own header: "Zero npm dependencies"), and the
 * production caller passes `(s) => execFileSync('cast', ['keccak', s]).trim()` — Foundry's `cast
 * keccak` on a non-hex-looking input computes the identical primitive. Verified against
 * checksum.test.js's OWN known vector in scripts/test/safe-tx-builder-checksum.test.mjs, both via a
 * real `cast keccak` subprocess and via a stubbed `keccak` for speed.
 *
 * WHY `0x`-LOOKING NEVER HAPPENS HERE. `web3.utils.sha3` (and `cast keccak`, matching it) special-case
 * a string that itself parses as `0x`-prefixed hex, hashing the DECODED BYTES instead of the UTF-8
 * string. `serializeJSONObject`'s own recursion always opens an object with `{["k1","k2",...]`, so
 * the top-level string handed to the hash primitive always starts with `{[` and can never be mistaken
 * for hex — confirmed empirically against the real vector below, not merely argued.
 *
 * THE CHECKSUM IS CONFIRMED OPTIONAL ON IMPORT. `transactionLibraryContext.tsx`'s `initializeBatch`
 * calls `validateChecksum(batchFile)`; on a mismatch (including an ABSENT `meta.checksum`, which
 * `validateChecksum` never special-cases) it only sets `hasChecksumWarning` — a transient 5-second UI
 * banner, cleared by its own `useEffect` timeout — and still calls `resetTransactions(...)`
 * unconditionally, loading and displaying the transactions either way. This script computes and
 * includes the checksum anyway, since doing so is free and removes the warning banner entirely for a
 * correctly-generated file.
 */

/** The SAME `undefined`-to-`null` substitution `checksum.ts` applies before `JSON.stringify`, so a
 *  round-trip through `JSON.parse(JSON.stringify(x))` (which drops `undefined` keys outright) cannot
 *  silently change what gets hashed. */
export const stringifyReplacer = (_key, value) => (value === undefined ? null : value);

/**
 * Recreates `checksum.ts`'s `serializeJSONObject` byte-for-byte: arrays serialize element-wise,
 * plain objects serialize their SORTED key list (so key order in the source object never changes the
 * checksum) followed by each value in that sorted order, and everything else falls through to
 * `JSON.stringify` with the same `undefined`->`null` substitution.
 *
 * @param {unknown} json
 * @returns {string}
 */
export function serializeJSONObject(json) {
  if (Array.isArray(json)) {
    return `[${json.map((el) => serializeJSONObject(el)).join(',')}]`;
  }
  if (typeof json === 'object' && json !== null) {
    let acc = '';
    const keys = Object.keys(json).sort();
    acc += `{${JSON.stringify(keys, stringifyReplacer)}`;
    for (let i = 0; i < keys.length; i++) {
      acc += `${serializeJSONObject(/** @type {Record<string, unknown>} */ (json)[keys[i]])},`;
    }
    return `${acc}}`;
  }
  return `${JSON.stringify(json, stringifyReplacer)}`;
}

/**
 * `checksum.ts`'s `calculateChecksum`: serializes the WHOLE batch file with `meta.name` forced to
 * `null` (the checksum is meant to survive a rename), then hashes the serialized string.
 *
 * @param {object} batchFile
 * @param {(s: string) => string} keccak `cast keccak <s>` in production; a stub in fast unit tests
 * @returns {string}
 */
export function calculateChecksum(batchFile, keccak) {
  const serialized = serializeJSONObject({
    ...batchFile,
    meta: { .../** @type {any} */ (batchFile).meta, name: null },
  });
  return keccak(serialized);
}

/**
 * `checksum.ts`'s `addChecksum`: returns a NEW batch file with `meta.checksum` set. Deliberately does
 * not mutate `meta.checksum` in place when computing (matching the original, which reads `batchFile`
 * — including whatever `meta.checksum` it already carries, e.g. `''` in the known test vector below —
 * rather than deleting it first; only `validateChecksum` deletes before recomputing).
 *
 * @param {object} batchFile
 * @param {(s: string) => string} keccak
 * @returns {object}
 */
export function addChecksum(batchFile, keccak) {
  return {
    ...batchFile,
    meta: { .../** @type {any} */ (batchFile).meta, checksum: calculateChecksum(batchFile, keccak) },
  };
}

/**
 * `checksum.ts`'s `validateChecksum`: DELETES `meta.checksum` before recomputing, so this is the
 * shape the real import path actually hashes against — not the `addChecksum` vector, which includes
 * whatever `meta.checksum` the caller passed in (see the file-level note above). A file this script
 * emits must satisfy THIS function, not merely reproduce the `addChecksum` vector.
 *
 * @param {object} batchFile
 * @param {(s: string) => string} keccak
 * @returns {boolean}
 */
export function validateChecksum(batchFile, keccak) {
  const target = { ...batchFile, meta: { .../** @type {any} */ (batchFile).meta } };
  const checksum = target.meta.checksum;
  delete target.meta.checksum;
  return calculateChecksum(target, keccak) === checksum;
}

/**
 * `transactionLibraryContext.tsx`'s `validateTransactionsInBatch` — the ONE import-time check that is
 * a hard error rather than a warning (a failure here means `setErrorMessage(...)` and the file never
 * loads at all, unlike a checksum mismatch). Ported so this generator can refuse to WRITE a file that
 * would fail to import, rather than merely hoping its own construction never violates it.
 *
 * Requires every transaction's `value` to be a string (not a JS number — Safe's own comment: the
 * Solidity range exceeds `Number.MAX_SAFE_INTEGER`) and every `contractInputsValues` entry to be a
 * string, never a number.
 *
 * @param {{transactions: {value: unknown, contractInputsValues?: Record<string, unknown> | null}[]}} batchFile
 * @returns {boolean}
 */
export function transactionsInBatchAreImportable(batchFile) {
  return batchFile.transactions.every((tx) => {
    const valueEncodedAsString = typeof tx.value === 'string';
    const contractInputsEncodingValid =
      tx.contractInputsValues === null || tx.contractInputsValues === undefined
      || Object.values(tx.contractInputsValues).every((input) => typeof input !== 'number');
    return valueEncodedAsString && contractInputsEncodingValid;
  });
}
