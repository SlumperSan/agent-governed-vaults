// @ts-check
/**
 * Seeded-address disclosure (Decisions/Seed agent personas 2026-09-23.md, card 210) —
 * `apps/web/test/seeded.test.mjs` already pins the pure math (5 holders, 2 seeded => the
 * organic bound is 3, under `SIGNER_REGIME_BELOW`, so `organicStakeWeightedClaim` is `false`).
 * This file pins the OTHER half: that `ProposalPanel.tsx` actually renders nothing unless that
 * function returns the literal `true`, and that the seeded list it reads is the real disclosure
 * list — not a hardcoded stand-in that would make the exclusion untestable from outside the
 * component.
 *
 * SOURCE ASSERTIONS, NOT A RENDER. Same constraint as `quorum-unknown.test.mjs`: `node --test`
 * has no TSX loader, so this reads the component's text rather than mounting it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PANEL = join(REPO, 'apps/vaults-ui/src/components/ProposalPanel.tsx');
const MEMBER_ACTIONS = join(REPO, 'apps/vaults-ui/src/components/MemberActions.tsx');
const VAULT_LIST = join(REPO, 'apps/vaults-ui/src/components/VaultList.tsx');
const APP = join(REPO, 'apps/vaults-ui/src/App.tsx');
const ATLAS = join(REPO, 'apps/vaults-ui/src/lib/atlas.ts');

test('ProposalPanel gates the stake-weighted claim on organicStakeWeightedClaim(...) === true, not truthiness', () => {
  const src = readFileSync(PANEL, 'utf8');
  assert.match(
    src,
    /organicStakeWeightedClaim\(vault\.nonCreatorMemberCount,\s*SEEDED_ADDRESSES\.length\)\s*===\s*true/,
    'the claim is no longer gated on an explicit `=== true` — a tri-state `null` (unknown) or a ' +
      'truthy-but-not-true value could then render a claim this app cannot back',
  );
  // The rendered sentence must exist and must carry the qualifier co-occurring with it (claims
  // guard 3, scripts/lib/claims-shapes.mjs) — belt and braces, since guard 3 does not walk .tsx.
  assert.match(src, /stake-weighted here: five or more non-seeded members/);
});

test('ProposalPanel never feeds the creator-inclusive vault.holderCount to the organic-claim gate (security review, PR #391)', () => {
  const src = readFileSync(PANEL, 'utf8');
  assert.doesNotMatch(
    src,
    /organicStakeWeightedClaim\(vault\.holderCount/,
    'vault.holderCount is "creator included" (VaultCore.sol:128) — the RWAlly team\'s own Safe, ' +
      'not a seeded persona — so it must never be the base this claim is computed from',
  );
});

test('NON-VACUITY: a truthiness-gated stake-weighted line would fail the assertion above', () => {
  const preFix = 'const stakeWeighted = organicStakeWeightedClaim(vault.nonCreatorMemberCount, SEEDED_ADDRESSES.length);';
  assert.doesNotMatch(preFix, /organicStakeWeightedClaim\([^)]*\)\s*===\s*true/);
});

test('NON-VACUITY: the pre-fix (creator-inclusive) line would fail the holderCount ban above', () => {
  const preFix = 'const stakeWeighted = organicStakeWeightedClaim(vault.holderCount, SEEDED_ADDRESSES.length) === true;';
  assert.match(preFix, /organicStakeWeightedClaim\(vault\.holderCount/);
});

test('ProposalPanel labels a seeded proposer, reading the real disclosure list (not a hardcoded stand-in)', () => {
  const src = readFileSync(PANEL, 'utf8');
  assert.match(src, /seededEntryFor\(p\.proposer,\s*SEEDED_ADDRESSES\)/);
  assert.match(src, /Seeded with RWAlly operator funds/);
  // Imported from the lib seam, never redeclared locally with a literal array — that would be a
  // second, driftable copy of the disclosure list inside the component.
  assert.match(src, /import\s*\{[^}]*SEEDED_ADDRESSES[^}]*\}\s*from\s*'\.\.\/lib\/atlas'/s);
  assert.doesNotMatch(src, /const\s+SEEDED_ADDRESSES\s*=/, 'SEEDED_ADDRESSES must come from atlas.ts, not a local literal');
});

test('VaultList feeds organicMemberBound the creator-excluded count, never the raw holderCount (security review, PR #391)', () => {
  const src = readFileSync(VAULT_LIST, 'utf8');
  assert.match(src, /organicMemberBound\(v\.nonCreatorMemberCount,\s*SEEDED_ADDRESSES\.length\)/);
  assert.doesNotMatch(src, /organicMemberBound\(v\.holderCount/);
  // The raw figure is still shown, unadjusted — this is a labelling fix, not a removal.
  assert.match(src, /\{v\.holderCount\}\s*holders/);
});

test('App.tsx feeds organicMemberBound the creator-excluded count, never the raw holderCount (security review, PR #391)', () => {
  const src = readFileSync(APP, 'utf8');
  assert.match(src, /organicMemberBound\(vault\.nonCreatorMemberCount,\s*SEEDED_ADDRESSES\.length\)/);
  assert.doesNotMatch(src, /organicMemberBound\(vault\.holderCount/);
});

test('MemberActions labels the connected wallet when it is a seeded address', () => {
  const src = readFileSync(MEMBER_ACTIONS, 'utf8');
  assert.match(src, /isSeeded\(address,\s*SEEDED_ADDRESSES\)/);
  assert.match(src, /seeded wallet, RWAlly operator funds/);
});

test('atlas.ts re-exports the seeded-address seam from the real module and the real disclosure file', () => {
  const src = readFileSync(ATLAS, 'utf8');
  assert.match(
    src,
    /export\s*\{\s*seededEntryFor,\s*isSeeded,\s*organicMemberBound,\s*organicStakeWeightedClaim\s*\}\s*from\s*'@atlas\/seeded'/,
  );
  assert.match(
    src,
    /import seededAddressesDoc from '\.\.\/\.\.\/\.\.\/\.\.\/docs\/seeded-addresses\.json'/,
    'SEEDED_ADDRESSES must be read from docs/seeded-addresses.json — the one repo location the ' +
      'decision doc names — not a copy kept inside this app',
  );
});
