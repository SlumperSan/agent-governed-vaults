// @ts-check
/**
 * Seeded-address awareness — Decisions/Seed agent personas 2026-09-23.md, Tasks/
 * seeded-persona-activity.md (card 210). The public disclosure list itself lives at
 * `docs/seeded-addresses.json`, outside this zero-dependency directory; every function here takes
 * the list (or its size) as an argument rather than reading the file, so `apps/web/index.html`
 * (fetch) and `apps/vaults-ui` (a bundled static import, see `src/lib/atlas.ts`) can each supply it
 * their own way without this module caring which, or whether the read even succeeded.
 *
 * THE HARD RULE THIS FILE EXISTS TO ENFORCE (decision doc, constraint 3): a seeded address is a
 * real on-chain holder — the contract does not know or care that the owner holds its key — so it
 * is never subtracted out of a governance-math count (`governance.mjs`'s `quorumReadout` reads the
 * real, unmodified on-chain `memberCount`; do not touch that). What this file gates is a
 * DIFFERENT, narrower claim: whether a count is safe to present as evidence of organic
 * participation. Those are not the same number, and conflating them either breaks quorum math or
 * launders seeded activity into a community signal — the two failure modes the decision doc names.
 */
import { SIGNER_REGIME_BELOW } from './governance.mjs';

/** @typedef {{address:string, persona:string, model:string, fundedBy:string, addedAt:string, note:string}} SeededAddressEntry */

/** @param {unknown} a */
function lc(a) {
  return typeof a === 'string' && a.length > 0 ? a.toLowerCase() : null;
}

/**
 * The disclosure-list entry for `address`, or `null` when it is not on the list (or either input
 * is unusable). Case-insensitive, same as the schema guard's uniqueness check.
 * @param {unknown} address
 * @param {readonly SeededAddressEntry[] | null | undefined} entries
 * @returns {SeededAddressEntry | null}
 */
export function seededEntryFor(address, entries) {
  const target = lc(address);
  if (target === null) return null;
  for (const e of entries ?? []) {
    if (lc(e?.address) === target) return e;
  }
  return null;
}

/**
 * @param {unknown} address
 * @param {readonly SeededAddressEntry[] | null | undefined} entries
 */
export function isSeeded(address, entries) {
  return seededEntryFor(address, entries) !== null;
}

/**
 * A LOWER BOUND on non-seeded ("organic") members. `holderCount` is the raw on-chain figure;
 * `seededCount` is the disclosure list's size. No live read in this repo enumerates individual
 * holder addresses per vault (`chain-reader.mjs` has no such call — see its own header), so this
 * cannot subtract the actual overlap; it assumes the WORST case, that every seeded address counts
 * toward `holderCount`, rather than the best case that none does. Understating organic
 * participation is the safe direction here; overstating it is the one the decision doc forbids.
 *
 * `null` — never a number — when either input cannot be read, matching the "unknown is not zero"
 * convention this repo already uses elsewhere (`vault-view.mjs`'s `oracleHealth`,
 * `vault-state.mjs`'s `freezeUnknown`).
 * @param {unknown} holderCount
 * @param {unknown} seededCount
 * @returns {number | null}
 */
export function organicMemberBound(holderCount, seededCount) {
  // `Number(null) === 0` and `Number(undefined) === NaN` — two different "absent" spellings that
  // coerce to two different things. Reject both explicitly rather than letting `null` silently
  // coerce into a real zero, which would turn "not read yet" into "read as zero seeded/zero
  // holders" — the exact unknown-renders-as-known shape this module exists to refuse.
  if (holderCount === null || holderCount === undefined || seededCount === null || seededCount === undefined) {
    return null;
  }
  const raw = Number(holderCount);
  const seeded = Number(seededCount);
  if (!Number.isFinite(raw) || !Number.isFinite(seeded) || raw < 0 || seeded < 0) return null;
  return Math.max(0, raw - seeded);
}

/**
 * Whether an "organically stake-weighted governance" claim may be rendered anywhere in the UI —
 * i.e. whether the non-seeded member BOUND alone already reaches `SIGNER_REGIME_BELOW`, the same
 * threshold `Governance.sol` uses to leave the signer-majority regime. `null` (never `true`) when
 * the bound itself is unknown: an unread count is not evidence FOR the claim, so a caller must
 * render nothing — never a claim — on `null`.
 * @param {unknown} holderCount
 * @param {unknown} seededCount
 * @returns {boolean | null}
 */
export function organicStakeWeightedClaim(holderCount, seededCount) {
  const bound = organicMemberBound(holderCount, seededCount);
  return bound === null ? null : bound >= SIGNER_REGIME_BELOW;
}
