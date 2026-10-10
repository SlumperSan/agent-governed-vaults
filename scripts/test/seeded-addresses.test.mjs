// @ts-check
/**
 * `docs/seeded-addresses.json` — the public disclosure list for owner-funded persona wallets
 * (Decisions/Seed agent personas 2026-09-23.md, Tasks/seeded-persona-activity.md card 210).
 *
 * The shipped file has an EMPTY `addresses` array (no wallet exists yet), so a test that only
 * reads the real file would pass vacuously and prove nothing about the schema. This file therefore
 * splits in two: fixture-driven tests that exercise every branch of
 * `scripts/lib/seeded-addresses.mjs`'s validator, and one test asserting the real, currently-empty
 * file still satisfies it (it will keep being run once entries are appended).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';

import { validateSeededAddressesDoc } from '../lib/seeded-addresses.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DOC_PATH = join(REPO, 'docs', 'seeded-addresses.json');

// Both have hex-letter digits, so lowercasing them actually changes the string — a numeral-only
// address (e.g. every digit 0-9) would make the "not checksummed" test vacuous, since lowercasing
// it is a no-op.
const VALID_1 = getAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
const VALID_2 = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

const entry = (address, overrides = {}) => ({
  address,
  persona: 'Ballast',
  model: 'Sonnet',
  fundedBy: 'RWAlly team (owner-held key)',
  addedAt: '2026-09-23',
  note: 'Capital-preservation persona, funded at launch.',
  ...overrides,
});

test('the real docs/seeded-addresses.json parses and validates (empty list today)', () => {
  const doc = JSON.parse(readFileSync(DOC_PATH, 'utf8'));
  assert.equal(typeof doc.readme, 'string');
  assert.ok(doc.readme.trim().length > 0, 'the README-style header field is empty');
  assert.deepEqual(doc.addresses, [], 'the shipped list must ship empty — entries are added only once a wallet is actually funded');
  const result = validateSeededAddressesDoc(doc);
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
});

test('a well-formed, checksummed, unique entry validates', () => {
  const result = validateSeededAddressesDoc({
    readme: 'x',
    addresses: [entry(VALID_1), entry(VALID_2, { persona: 'Momentum', model: 'Haiku' })],
  });
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
});

test('rejects a document with no readme header', () => {
  const result = validateSeededAddressesDoc({ addresses: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /readme/.test(e)));
});

test('rejects an address that is not checksummed', () => {
  const badChecksum = VALID_1.toLowerCase();
  assert.notEqual(badChecksum, VALID_1); // sanity: lowercasing actually changed it
  const result = validateSeededAddressesDoc({ readme: 'x', addresses: [entry(badChecksum)] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not checksummed/.test(e)), result.ok ? '' : result.errors.join('; '));
});

test('rejects an address that is not a valid address at all', () => {
  const result = validateSeededAddressesDoc({ readme: 'x', addresses: [entry('0xnotanaddress')] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not a valid address/.test(e)));
});

test('rejects a case-variant duplicate address', () => {
  const result = validateSeededAddressesDoc({
    readme: 'x',
    addresses: [entry(VALID_1), entry(VALID_1.toLowerCase(), { persona: 'Momentum' })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicates/.test(e)), result.ok ? '' : result.errors.join('; '));
});

test('rejects an entry missing a required field', () => {
  const bad = entry(VALID_1);
  delete bad.note;
  const result = validateSeededAddressesDoc({ readme: 'x', addresses: [bad] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /\.note/.test(e)));
});

test('rejects a non-array "addresses" field', () => {
  const result = validateSeededAddressesDoc({ readme: 'x', addresses: 'not-an-array' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not an array/.test(e)));
});
