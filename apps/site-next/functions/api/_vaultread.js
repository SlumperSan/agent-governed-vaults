/**
 * The live chain read itself, separated from `vaults.js` so it can be unit-tested with an
 * injected reader and no network — exactly the seam `packages/canary/src/reader.mjs` already
 * defines (`{headBlock, tryRead, ...}`), reused here rather than re-invented.
 *
 * THE PROPERTY THIS FILE EXISTS TO HOLD: a revert and a transport failure must never collapse
 * into one field (issues #266, PR #185 — this repo has shipped that bug twice). `tryRead` already
 * classifies every failed read as `kind: 'revert'` or `kind: 'transport'` via
 * `packages/canary/src/call-error.mjs`'s `classifyCallError`, and forces `revertData` to `null`
 * on a transport failure so a busy RPC can never be misread as on-chain evidence. This file adds
 * ONE more distinction on top of that: among reverts, only the ones whose returndata's first 4
 * bytes match a KNOWN freeze selector (`EXIT_FROZEN_SELECTORS`) are reported as `pricingFrozen`.
 * An unrecognised revert is not guessed at — it is filed as unreadable, the same as a transport
 * failure, because inventing a cause for it would itself be a fabricated chain fact.
 *
 * Per vault, every field is therefore one of exactly three states, and never a fourth:
 *   - present with a value       → the read succeeded
 *   - absent, vault.pricingFrozen: true  → oracle-frozen (navWad/navPerShareWad only)
 *   - absent, vault.unreadable[field]    → missing evidence (transport, an unrecognised revert, or
 *                                          a local decode defect — `kind: 'decode'`, see `readOneVault`)
 * A field is NEVER `null` or `0` for "could not read it" — that is indistinguishable from a real
 * zero balance, which is the exact catastrophic false claim this route must not make.
 */
import { VAULT_VIEWS, EXIT_FROZEN_SELECTORS } from '../../../../packages/canary/src/abis.mjs';
// Static, not the lazy `await import('viem')` `reader.mjs`/`facilitator.mjs` use elsewhere in
// this repo for an OPTIONAL dependency: this route already requires viem to build the chain
// reader it is handed (see `createChainReader` in `packages/canary/src/reader.mjs`), so there is
// no "viem absent" case left to guard against, and a static import avoids re-resolving the
// dynamic import on every vault.
import { getAddress } from 'viem';

/** Oracle-priced fields: the only two that can revert with a freeze selector, because both call
 * `navWad()` internally (VaultCore.sol:375 — `navPerShareWad` opens `navWad() * WAD / ts`). */
const PRICING_FIELDS = ['navWad', 'navPerShareWad'];

/** Plain storage getters. Can fail on transport; have no oracle dependency to freeze on. */
const PLAIN_UINT_FIELDS = [
  'totalShares', 'idleUsdc', 'totalPendingUsdc', 'capacityCapUsdc', 'minDepositUsdc',
  'usdcScalar', 'basketLength', 'childVaultCount',
];

/** Every field a fully-successful read could contribute, `pricingFrozen` included — it is a
 * real answer, not a gap, the same way `unreadable` fields are gaps and value fields are not. */
const DATA_FIELDS = [...PLAIN_UINT_FIELDS, 'locked', 'creator', ...PRICING_FIELDS, 'pricingFrozen'];

/**
 * Did this vault contribute NOTHING — no value, no recognised freeze, nothing but `label`,
 * `address` and a pile of `unreadable` entries? That is the case a reader whose `headBlock`
 * answers but whose every subsequent call fails produces, and it is meaningfully different from
 * "some fields came back": nothing here was actually read, so nothing here should be sold.
 * @param {object} vault a single entry of `readVaultsAtHead`'s `.vaults` array
 */
export function vaultYieldedNoData(vault) {
  return !DATA_FIELDS.some((f) => f in vault);
}

/** First 4 bytes of a `0x`-prefixed hex blob, lowercased — a selector, not a value. */
function selectorOf(hex) {
  return typeof hex === 'string' ? hex.slice(0, 10).toLowerCase() : null;
}

/**
 * Read every field of one vault at a pinned block. Never throws: every failure is recorded on
 * the returned object rather than propagated, so one bad field cannot take down the other vault
 * or the fields around it. "Never throws" is a claim this function is responsible for keeping
 * true, not just documenting — it did not hold for one call until the `creator` block below was
 * written: `getAddress` throws on a malformed value, and an uncaught throw here propagates all
 * the way to `vaults.js`'s `readVaultsAtHead` try/catch, which reports it as `chain read failed`
 * — mislabelling a LOCAL decode defect as a chain-level failure to a paying customer. Caught here
 * instead and filed under `unreadable` with `kind: 'decode'`, a label distinct from `'revert'`
 * and `'transport'` because it is neither: nothing about the chain failed, the bytes it returned
 * just did not decode as an address.
 * @param {{headBlock():Promise<number>, tryRead: Function}} reader
 * @param {{label:string, address:string}} vault
 * @param {number} blockNumber
 */
async function readOneVault(reader, { label, address }, blockNumber) {
  const out = { label, address };
  const unreadable = {};
  const opts = { blockNumber };

  for (const fn of PLAIN_UINT_FIELDS) {
    const r = await reader.tryRead(address, VAULT_VIEWS, fn, [], opts);
    if (r.ok) out[fn] = r.value.toString();
    else unreadable[fn] = { reason: r.error, kind: r.kind };
  }

  const lockedRead = await reader.tryRead(address, VAULT_VIEWS, 'locked', [], opts);
  if (lockedRead.ok) out.locked = lockedRead.value;
  else unreadable.locked = { reason: lockedRead.error, kind: lockedRead.kind };

  const creatorRead = await reader.tryRead(address, VAULT_VIEWS, 'creator', [], opts);
  if (creatorRead.ok) {
    // Checksummed, never the raw lowercase ABI decode — a decimal or lowercase address is not
    // what this route promises to serve. Guarded: see the docstring above for why.
    try {
      out.creator = getAddress(creatorRead.value);
    } catch (err) {
      unreadable.creator = { reason: err?.message ?? String(err), kind: 'decode' };
    }
  } else {
    unreadable.creator = { reason: creatorRead.error, kind: creatorRead.kind };
  }

  for (const fn of PRICING_FIELDS) {
    const r = await reader.tryRead(address, VAULT_VIEWS, fn, [], opts);
    if (r.ok) {
      out[fn] = r.value.toString();
      continue;
    }
    const selector = r.kind === 'revert' ? selectorOf(r.revertData) : null;
    const frozenReason = selector ? EXIT_FROZEN_SELECTORS[selector] : undefined;
    if (frozenReason) {
      // A recognised freeze selector IS the product signal, not missing evidence. Report it once
      // per vault (both pricing fields revert for the same reason — they share the same oracle
      // call) rather than once per field.
      out.pricingFrozen = true;
      out.pricingFrozenReason = frozenReason;
      out.pricingFrozenSelector = selector;
    } else {
      // Anything else — a transport failure, or a revert this table does not recognise — is
      // unreadable. It is NOT filed as a freeze: inventing "StaleOracle" for a revert whose
      // returndata does not say so would be exactly the fabricated chain fact this file exists
      // to prevent.
      unreadable[fn] = { reason: r.error, kind: r.kind };
    }
  }

  // Capacity headroom (VaultCore.sol:408-410's own deposit-time gate: navUsdc + totalPendingUsdc
  // + amountUsdc <= capacityCapUsdc) — computed ONLY when every input to it was actually read
  // this request. A partial computation dressed as a real number would be a fabricated figure,
  // not an estimate.
  if (out.capacityCapUsdc !== undefined && out.navWad !== undefined &&
      out.usdcScalar !== undefined && out.totalPendingUsdc !== undefined) {
    const cap = BigInt(out.capacityCapUsdc);
    if (cap !== 0n) {
      // uncapped (capacityCapUsdc == 0) has no headroom to report — omitted, not zero.
      const navUsdc = BigInt(out.navWad) / BigInt(out.usdcScalar); // floor division, matching the contract exactly
      const committed = navUsdc + BigInt(out.totalPendingUsdc);
      out.capacityHeadroomUsdc = (cap - committed).toString();
    }
  }

  if (Object.keys(unreadable).length > 0) out.unreadable = unreadable;
  return out;
}

/**
 * Read every configured vault at ONE pinned block, so every field in the response is internally
 * consistent — no field straddles a block boundary another field was read at. `reader.headBlock()`
 * is the one call in this function that is allowed to throw: if the chain cannot even tell us
 * what block it is on, there is no coherent height to pin the rest of the reads to, and the
 * caller (`vaults.js`) turns that into a 503 that settles no payment. A `headBlock()` that
 * RESOLVES with something other than a real integer (`NaN`, a string, `undefined`) is the same
 * failure by another shape — a reader that answers with garbage instead of throwing must not
 * produce a response claiming `blockNumber: null` was a height anything was read at — so that
 * case is turned into a throw here too, reaching `vaults.js`'s catch the same way.
 * @param {{headBlock():Promise<number>, tryRead: Function}} reader
 * @param {Array<{label:string, address:string}>} vaults
 */
export async function readVaultsAtHead(reader, vaults) {
  const blockNumber = await reader.headBlock();
  if (!Number.isInteger(blockNumber)) {
    throw new Error(`reader.headBlock() resolved to a non-integer block number: ${blockNumber}`);
  }
  const results = [];
  for (const v of vaults) {
    results.push(await readOneVault(reader, v, blockNumber));
  }
  return { blockNumber, vaults: results };
}
