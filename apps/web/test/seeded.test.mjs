// @ts-check
/**
 * Seeded-address awareness (Decisions/Seed agent personas 2026-09-23.md, card 210). The scenario
 * this file exists to pin: a vault with 5 on-chain holders, 2 of them owner-held seeded wallets,
 * must never render an "organically stake-weighted" claim — that would launder team-funded
 * activity into a community-demand signal, the exact failure the decision doc names.
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
