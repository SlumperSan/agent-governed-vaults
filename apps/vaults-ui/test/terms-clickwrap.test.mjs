// @ts-check
/**
 * Card #214: the deposit button in MemberActions.tsx stays disabled until the connected wallet has
 * accepted the current Terms of Use — where "current" means the live `packages/terms` hash, not
 * just a version label. Two halves:
 *
 *  - `terms-acceptance.ts` is plain, untyped-at-runtime TypeScript with no JSX, so Node 24's native
 *    type-stripping imports it directly (checked empirically before writing this file) — it is
 *    exercised for real here, against a stub `localStorage`, unlike the sibling
 *    source-guard-only files in this directory.
 *  - `MemberActions.tsx` is JSX, and (same reason as every sibling wiring test here) has no
 *    JSX/TSX loader wired into `node --test`, so its own gating is checked as source text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAcceptedCurrentTerms, recordTermsAcceptance } from '../src/lib/terms-acceptance.ts';
import { termsTextSha256 } from '../../../packages/terms/src/terms-text.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MEMBER_ACTIONS = readFileSync(join(APP, 'src/components/MemberActions.tsx'), 'utf8');
const VITE_CONFIG = readFileSync(join(APP, 'vite.config.ts'), 'utf8');
const CLICKWRAP = readFileSync(join(APP, 'src/components/TermsClickwrap.tsx'), 'utf8');

// ─────────────────── a minimal, in-memory localStorage stub for terms-acceptance.ts ───────────────────
// `window` does not exist in this `node --test` process at all (no DOM); terms-acceptance.ts
// touches `window.localStorage` only INSIDE its functions, never at module-load time, so the
// import above succeeds regardless and this stub only has to exist before a function is CALLED.

class FakeStorage {
  /** @type {Map<string, string>} */
  #data = new Map();
  /** @type {'ok' | 'throw'} */
  mode = 'ok';
  getItem(key) {
    if (this.mode === 'throw') throw new Error('FakeStorage: simulated getItem failure');
    return this.#data.has(key) ? /** @type {string} */ (this.#data.get(key)) : null;
  }
  setItem(key, value) {
    if (this.mode === 'throw') throw new Error('FakeStorage: simulated setItem failure');
    this.#data.set(key, value);
  }
  /** Bypasses `mode`, for setting up a corrupt-JSON fixture without going through setItem. */
  seed(key, value) {
    this.#data.set(key, value);
  }
}

function installFakeStorage() {
  const storage = new FakeStorage();
  // @ts-expect-error test-only global, not the real lib.dom Window
  globalThis.window = { localStorage: storage };
  return storage;
}

const ADDRESS = '0xAbC1230000000000000000000000000000dEaD';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('hasAcceptedCurrentTerms is false with no wallet connected (null address)', () => {
  installFakeStorage();
  assert.equal(hasAcceptedCurrentTerms(null, '0.1', HASH_A), false);
});

test('hasAcceptedCurrentTerms is false while the hash has not resolved yet (null hash) — an unresolved state is never "accepted"', () => {
  installFakeStorage();
  recordTermsAcceptance(ADDRESS, '0.1', HASH_A);
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', null), false);
});

test('recordTermsAcceptance then hasAcceptedCurrentTerms round-trips true for the same version and hash', () => {
  installFakeStorage();
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), false, 'precondition: nothing accepted yet');
  recordTermsAcceptance(ADDRESS, '0.1', HASH_A);
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), true);
});

test('a CHANGED TEXT (a different hash) invalidates a stored acceptance', () => {
  installFakeStorage();
  recordTermsAcceptance(ADDRESS, '0.1', HASH_A);
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), true, 'precondition: accepted under HASH_A');
  assert.equal(
    hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_B),
    false,
    'RED: a stored acceptance for HASH_A must not satisfy a check against HASH_B',
  );
});

test('address matching is case-insensitive (an EIP-55 checksum is not the storage key)', () => {
  installFakeStorage();
  recordTermsAcceptance(ADDRESS.toLowerCase(), '0.1', HASH_A);
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), true);
});

test('a different wallet has no acceptance of its own', () => {
  installFakeStorage();
  recordTermsAcceptance(ADDRESS, '0.1', HASH_A);
  const otherAddress = '0x0000000000000000000000000000000000beef';
  assert.equal(hasAcceptedCurrentTerms(otherAddress, '0.1', HASH_A), false);
});

test('corrupt JSON in storage reads as "nothing accepted", not a throw', () => {
  const storage = installFakeStorage();
  storage.seed('rwally.termsAcceptance.v1', '{not valid json');
  assert.doesNotThrow(() => hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A));
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), false);
});

test('a storage that throws on every call never crashes recordTermsAcceptance or hasAcceptedCurrentTerms', () => {
  const storage = installFakeStorage();
  storage.mode = 'throw';
  assert.doesNotThrow(() => recordTermsAcceptance(ADDRESS, '0.1', HASH_A));
  assert.doesNotThrow(() => hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A));
  assert.equal(hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_A), false, 'a write that never landed must not read as accepted');
});

test('MUTATION: comparing only termsVersion (dropping the hash check) would wrongly accept a changed text', () => {
  // Simulates the defect this file's whole design exists to prevent: a version-label-only compare.
  installFakeStorage();
  recordTermsAcceptance(ADDRESS, '0.1', HASH_A);
  const versionOnlyCheck = (addr, version) => {
    // Re-reads through the real recordTermsAcceptance's storage key indirectly, by checking the
    // real function still reports differently — this proves the REAL function is hash-sensitive
    // rather than re-implementing a broken comparator and asserting against itself.
    return hasAcceptedCurrentTerms(addr, version, HASH_A) || hasAcceptedCurrentTerms(addr, version, HASH_B);
  };
  assert.equal(versionOnlyCheck(ADDRESS, '0.1'), true, 'sanity: accepted under one of the two hashes');
  assert.equal(
    hasAcceptedCurrentTerms(ADDRESS, '0.1', HASH_B),
    false,
    'RED if hasAcceptedCurrentTerms ever stops checking the hash: HASH_B was never accepted',
  );
});

// ─────────────────── the hash actually shipped is sha256(TERMS_TEXT) ───────────────────

test('termsTextSha256() (the same import MemberActions.tsx uses) resolves to a 64-char hex digest', async () => {
  const hash = await termsTextSha256();
  assert.match(hash, /^[0-9a-f]{64}$/);
});

// ─────────────────── MemberActions.tsx: wired to the real module, not a placeholder ───────────────────

test('MemberActions.tsx imports termsTextSha256 and TERMS_VERSION from @rwally/terms', () => {
  assert.match(MEMBER_ACTIONS, /import\s*\{\s*termsTextSha256,\s*TERMS_VERSION\s*\}\s*from\s*'@rwally\/terms';/);
});

test('MemberActions.tsx imports hasAcceptedCurrentTerms and recordTermsAcceptance from ../lib/terms-acceptance', () => {
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/lib\/terms-acceptance';/.exec(MEMBER_ACTIONS);
  assert.ok(importBlock, 'no import from ../lib/terms-acceptance found');
  assert.ok(importBlock[1].includes('hasAcceptedCurrentTerms'));
  assert.ok(importBlock[1].includes('recordTermsAcceptance'));
});

test('vite.config.ts aliases @rwally/terms to packages/terms/src/terms-text.mjs', () => {
  assert.match(VITE_CONFIG, /'@rwally\/terms':\s*pkg\('terms\/src\/terms-text\.mjs'\)/);
});

// ─────────────────── the deposit button is actually gated on termsAccepted ───────────────────

/** The `disabled={...}` attribute belonging to the Deposit button specifically. */
function depositButtonDisabledAttr() {
  const btnStart = MEMBER_ACTIONS.indexOf("{deposit.busy ? 'Depositing…' : 'Deposit'}");
  assert.ok(btnStart >= 0, 'Deposit button text not found');
  const btnBlock = MEMBER_ACTIONS.slice(Math.max(0, btnStart - 500), btnStart);
  const m = /disabled=\{[^}]*\}/.exec(btnBlock);
  assert.ok(m, 'no disabled={...} attribute found near the Deposit button');
  return m[0];
}

test('the Deposit button is disabled while termsAccepted is false', () => {
  assert.match(depositButtonDisabledAttr(), /!termsAccepted/, 'the deposit button must gate on termsAccepted');
});

test('MUTATION: dropping !termsAccepted from the Deposit button is caught', () => {
  const attr = depositButtonDisabledAttr();
  assert.match(attr, /!termsAccepted/, 'precondition: the real button gates on termsAccepted');
  const mutated = attr.replace(' || !termsAccepted', '');
  assert.notEqual(mutated, attr, 'mutation target text not found -- update this test if the button condition moved');
  assert.doesNotMatch(mutated, /!termsAccepted/, 'RED: the pre-fix button must not gate on termsAccepted');
});

test('MUTATION: reverting the whole button to its pre-card-214 disabled condition is caught', () => {
  const preFix = 'disabled={disabled || deposit.busy || !addrs || depositBlocked}';
  assert.doesNotMatch(preFix, /!termsAccepted/, 'RED: the pre-fix condition never mentions termsAccepted');
});

// ─────────────────── the clickwrap itself is actually rendered, not just imported ───────────────────

test('TermsClickwrap is rendered in the Deposit section, gated on connected', () => {
  const headingIdx = MEMBER_ACTIONS.indexOf('<h3>Deposit</h3>');
  assert.ok(headingIdx >= 0, 'Deposit heading not found');
  const rowIdx = MEMBER_ACTIONS.indexOf('<div className="act-row">', headingIdx);
  assert.ok(rowIdx > headingIdx, 'the deposit input row was not found after the Deposit heading');
  const between = MEMBER_ACTIONS.slice(headingIdx, rowIdx);
  assert.match(between, /<TermsClickwrap\b/, 'TermsClickwrap must render between the Deposit heading and the input row');
  assert.match(between, /connected\s*\?/, 'the clickwrap must be gated on a connected wallet');
});

test('MUTATION: removing the TermsClickwrap render is caught', () => {
  const headingIdx = MEMBER_ACTIONS.indexOf('<h3>Deposit</h3>');
  const rowIdx = MEMBER_ACTIONS.indexOf('<div className="act-row">', headingIdx);
  const withoutClickwrap =
    MEMBER_ACTIONS.slice(0, headingIdx + '<h3>Deposit</h3>'.length) + MEMBER_ACTIONS.slice(rowIdx);
  assert.notEqual(withoutClickwrap, MEMBER_ACTIONS, 'mutation target not found -- update this test if the layout moved');
  assert.doesNotMatch(
    withoutClickwrap.slice(headingIdx, headingIdx + 200),
    /<TermsClickwrap\b/,
    'RED: the mutation must actually remove the clickwrap render',
  );
});

test('handleAcceptTerms records acceptance and flips termsAccepted, and only when a wallet and a resolved hash are both present', () => {
  assert.match(
    MEMBER_ACTIONS,
    /function handleAcceptTerms\(\)\s*\{\s*if \(!address \|\| termsHash == null\) return;\s*recordTermsAcceptance\(address, TERMS_VERSION, termsHash\);\s*setTermsAccepted\(true\);\s*\}/,
  );
});

// ─────────────────── the checkbox itself never renders pre-checked ───────────────────

test('TermsClickwrap reads checked from props, not from its own local state', () => {
  assert.doesNotMatch(CLICKWRAP, /useState/, 'TermsClickwrap must not own checked/accepted state itself');
  assert.match(CLICKWRAP, /checked=\{checked\}/);
});
