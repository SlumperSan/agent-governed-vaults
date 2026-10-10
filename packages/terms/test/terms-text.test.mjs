// @ts-check
/**
 * `packages/terms/src/terms-text.mjs` is the ONE source `apps/site` and `apps/vaults-ui` both
 * import (card #214) — this file tests the module directly, independent of either app, so a
 * defect here is caught once rather than twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTermsSections, TERMS_SUBTITLE, TERMS_TEXT, TERMS_VERSION, termsTextSha256 } from '../src/terms-text.mjs';

test('TERMS_VERSION and TERMS_SUBTITLE are non-empty', () => {
  assert.equal(TERMS_VERSION, '0.1');
  assert.ok(TERMS_SUBTITLE.length > 0);
});

test('TERMS_TEXT opens with the "## Terms of Use" heading and closes with section 13', () => {
  assert.match(TERMS_TEXT, /^## Terms of Use\n/);
  assert.match(TERMS_TEXT, /### 13\. Whole agreement[\s\S]*rest still applies\.$/);
});

test('TERMS_TEXT carries none of the "## Held for counsel" text — card #214 publishes only the part under "## Terms of Use"', () => {
  assert.doesNotMatch(TERMS_TEXT, /Held for counsel/);
  // The held-back paragraphs' own subjects must not leak in either — a partial edit that kept one
  // sentence of that section would not be caught by the heading check alone.
  assert.doesNotMatch(TERMS_TEXT, /Governing law/);
  assert.doesNotMatch(TERMS_TEXT, /class-action waiver/);
});

test('parseTermsSections returns exactly 13 sections, numbered 1 through 13 in order', () => {
  const sections = parseTermsSections(TERMS_TEXT);
  assert.equal(sections.length, 13);
  assert.deepEqual(sections.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('MUTATION: a TERMS_TEXT missing one heading is caught (parseTermsSections throws rather than silently returning 12)', () => {
  const mutated = TERMS_TEXT.replace('### 7. Things you must not do\n\n', '');
  assert.notEqual(mutated, TERMS_TEXT, 'mutation target text not found -- update this test if section 7 moved');
  assert.throws(() => parseTermsSections(mutated), /expected 13/);
});

test('every "- " list block parses into items, joining wrapped continuation lines', () => {
  const sections = parseTermsSections(TERMS_TEXT);
  const s2 = sections.find((s) => s.number === 2);
  assert.ok(s2);
  const list = s2.body.find((b) => b.type === 'ul');
  assert.ok(list && list.type === 'ul');
  assert.equal(list.items.length, 4);
  // The second item wraps across two source lines ("...subject to\n  comprehensive U.S. sanctions;")
  // — this asserts the wrap was joined into one item, not split into two or left with the line break.
  assert.match(list.items[1], /^you are not located in.*comprehensive U\.S\. sanctions;$/);
  assert.doesNotMatch(list.items[1], /\n/);
});

test('**bold** becomes <strong>, without changing the words themselves', () => {
  const sections = parseTermsSections(TERMS_TEXT);
  const s1 = sections.find((s) => s.number === 1);
  assert.ok(s1);
  const bodyText = s1.body.map((b) => (b.type === 'p' ? b.html : b.items.join(' '))).join(' ');
  assert.match(bodyText, /<strong>We never hold your funds\.<\/strong>/);
  assert.doesNotMatch(bodyText, /\*\*/, 'no raw markdown asterisks should survive into the parsed output');
});

test('termsTextSha256() equals sha256(TERMS_TEXT), independently derived with node:crypto', async () => {
  const expected = createHash('sha256').update(TERMS_TEXT, 'utf8').digest('hex');
  const actual = await termsTextSha256();
  assert.equal(actual, expected);
});

test('termsTextSha256() is memoized: repeated calls return the identical resolved string', async () => {
  const a = await termsTextSha256();
  const b = await termsTextSha256();
  assert.equal(a, b);
});

test('MUTATION: changing TERMS_TEXT by one character changes the hash', async () => {
  const bytes = new TextEncoder().encode(`${TERMS_TEXT} `);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const mutatedHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const realHash = await termsTextSha256();
  assert.notEqual(mutatedHash, realHash, 'RED: a text one character longer must hash differently');
});
