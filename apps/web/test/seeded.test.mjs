// @ts-check
/**
 * Seeded-address awareness (Decisions/Seed agent personas 2026-09-23.md, card 210). The scenario
 * this file exists to pin: a vault with 5 on-chain holders, 2 of them owner-held seeded wallets,
 * must never render an "organically stake-weighted" claim — that would launder team-funded
 * activity into a community-demand signal, the exact failure the decision doc names.
 *
 * SECOND FINDING, caught in PR #391's security review before merge: `holderCount` is "addresses
 * with shares > 0, creator included" (VaultCore.sol:128) — the vault's creator is the RWAlly
 * team's own Safe, a DIFFERENT address from the two seeded personas, and it is never on
 * `docs/seeded-addresses.json`. `organicMemberBound`/`organicStakeWeightedClaim` now take
 * `nonCreatorHolderCount` (VaultCore's own `nonCreatorMemberCount`, creator already excluded) as
 * their first argument — never `holderCount` — so the team's Safe can no longer read as an
 * organic member just because it happens not to be on the seeded list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededEntryFor, isSeeded, organicMemberBound, organicStakeWeightedClaim,
} from '../src/seeded.mjs';
import { SIGNER_REGIME_BELOW } from '../src/governance.mjs';

const BALLAST = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const MOMENTUM = '0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48';
const ORGANIC = '0x000000000000000000000000000000000000aa';

const ENTRIES = Object.freeze([
  { address: BALLAST, persona: 'Ballast', model: 'Sonnet', fundedBy: 'RWAlly team (owner-held key)', addedAt: '2026-09-23', note: 'x' },
  { address: MOMENTUM, persona: 'Momentum', model: 'Haiku', fundedBy: 'RWAlly team (owner-held key)', addedAt: '2026-09-23', note: 'x' },
]);

test('seededEntryFor / isSeeded match case-insensitively, and only entries on the list', () => {
  assert.equal(seededEntryFor(BALLAST, ENTRIES)?.persona, 'Ballast');
  assert.equal(seededEntryFor(BALLAST.toLowerCase(), ENTRIES)?.persona, 'Ballast');
  assert.equal(seededEntryFor(BALLAST.toUpperCase().replace('0X', '0x'), ENTRIES)?.persona, 'Ballast');
  assert.equal(seededEntryFor(ORGANIC, ENTRIES), null);
  assert.equal(isSeeded(BALLAST, ENTRIES), true);
  assert.equal(isSeeded(ORGANIC, ENTRIES), false);
  // Unusable inputs are "not seeded", not a thrown error.
  assert.equal(isSeeded(null, ENTRIES), false);
  assert.equal(isSeeded(BALLAST, null), false);
  assert.equal(isSeeded(BALLAST, undefined), false);
});

test('organicMemberBound subtracts the disclosure list size from the raw count, floored at 0', () => {
  assert.equal(organicMemberBound(5, 2), 3);
  assert.equal(organicMemberBound(2, 5), 0, 'more seeded entries than holders never goes negative');
  assert.equal(organicMemberBound(0, 0), 0);
});

test('organicMemberBound is null — never a number — on an unreadable input', () => {
  assert.equal(organicMemberBound(null, 2), null);
  assert.equal(organicMemberBound(5, undefined), null);
  assert.equal(organicMemberBound(NaN, 2), null);
  assert.equal(organicMemberBound(-1, 2), null);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SCENARIO THE TASK NAMES: 5 holders, 2 of them seeded.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('5 holders, 2 seeded: the organic bound is 3, under SIGNER_REGIME_BELOW — the stake-weighted claim does not render', () => {
  const bound = organicMemberBound(5, ENTRIES.length);
  assert.equal(bound, 3);
  assert.ok(bound < SIGNER_REGIME_BELOW);
  assert.equal(organicStakeWeightedClaim(5, ENTRIES.length), false, 'a caller must not render the claim here');
});

test('positive control: 5 holders, 0 seeded — the claim DOES render', () => {
  assert.equal(organicStakeWeightedClaim(5, 0), true);
});

test('5 holders, 5 seeded (the whole vault is seeded): the claim never renders', () => {
  assert.equal(organicStakeWeightedClaim(5, 5), false);
});

test('an unread holder count never renders the claim — unknown is not "not seeded enough", it is unknown', () => {
  assert.equal(organicStakeWeightedClaim(null, 0), null);
  assert.equal(organicStakeWeightedClaim(5, null), null);
  assert.notEqual(organicStakeWeightedClaim(null, 0), true, 'an unknown count must never satisfy the claim');
});

test('boundary: exactly SIGNER_REGIME_BELOW non-seeded members is enough; one fewer is not', () => {
  const seeded = 1;
  assert.equal(organicStakeWeightedClaim(SIGNER_REGIME_BELOW + seeded, seeded), true);
  assert.equal(organicStakeWeightedClaim(SIGNER_REGIME_BELOW + seeded - 1, seeded), false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SECURITY-REVIEW SCENARIO: 5 holders = the creator + 4 others, 0 seeded. `holderCount` (raw,
// creator included) is 5, but `nonCreatorMemberCount` (creator excluded) is 4 — one short of
// SIGNER_REGIME_BELOW. The claim must NOT render, even though the seeded list is empty.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('5 holders = the creator + 4 others, 0 seeded: nonCreatorHolderCount is 4, under SIGNER_REGIME_BELOW — the claim does not render', () => {
  const holderCountRaw = 5; // creator included — never passed to organicMemberBound directly
  const nonCreatorHolderCount = holderCountRaw - 1; // creator excluded — VaultCore.nonCreatorMemberCount
  assert.equal(nonCreatorHolderCount, 4);
  assert.equal(organicMemberBound(nonCreatorHolderCount, 0), 4);
  assert.ok(4 < SIGNER_REGIME_BELOW);
  assert.equal(organicStakeWeightedClaim(nonCreatorHolderCount, 0), false, 'the creator must not read as organic');
});

test('NON-VACUITY: passing the raw, creator-inclusive holderCount for the same vault would have wrongly rendered the claim', () => {
  // This is the exact defect the security review caught: with an empty seeded list, nothing
  // excluded the creator, so the raw count of 5 cleared SIGNER_REGIME_BELOW on its own.
  assert.equal(organicStakeWeightedClaim(5, 0), true);
});
