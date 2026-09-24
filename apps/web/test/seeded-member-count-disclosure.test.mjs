// @ts-check
/**
 * Card 210, security-review finding 2 on PR #391: when `docs/seeded-addresses.json` fails to load
 * (this app is served with no build step, so a 404 is a real, common outcome — see
 * `fetchSeededCount`'s own header in index.html), the member count must render "seeded status
 * unknown", never the raw figure with no caveat at all — a caveat-free raw count reads as "nothing
 * here is seeded", which is not something an unread list can support.
 *
 * SOURCE ASSERTIONS, NOT A RENDER. `node --test` has no DOM and this app has no build step to
 * produce one from — same constraint `apps/vaults-ui/test/quorum-unknown.test.mjs` documents for
 * itself. `state.seededCount === null` is the "unread" state (`fetchSeededCount`'s own default and
 * failure path); this file pins that `memberCountLabel()` branches on it BEFORE checking for zero,
 * so the two can never be conflated by an accidental `!state.seededCount` (which is true for both
 * `null` and `0`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));

/** The `memberCountLabel` function body, isolated so a match elsewhere cannot pass this. */
function memberCountLabelSrc(src) {
  const start = src.indexOf('function memberCountLabel(v) {');
  assert.ok(start >= 0, 'memberCountLabel() is gone from apps/web/index.html — did this move?');
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, 'could not find the end of memberCountLabel()');
  return src.slice(start, end);
}

test('memberCountLabel renders "seeded status unknown" when the list has not been read, checked BEFORE the zero case', () => {
  const src = readFileSync(INDEX, 'utf8');
  const fn = memberCountLabelSrc(src);
  assert.match(fn, /state\.seededCount\s*===\s*null/, 'no explicit null (unread) check — this is the exact caveat the review asked for');
  assert.match(fn, /seeded status unknown/);
  // Order matters: `null === null` is true and `0 === null` is false, so testing `=== null` first
  // is what stops the unread state from ever falling into the "confirmed zero" branch below it.
  const nullIdx = fn.search(/state\.seededCount\s*===\s*null/);
  const zeroIdx = fn.search(/state\.seededCount\s*===\s*0/);
  assert.ok(zeroIdx > nullIdx, 'the null (unread) check must come before the confirmed-zero check');
});

test('memberCountLabel never uses a truthiness check that conflates "unread" (null) with "confirmed zero"', () => {
  const src = readFileSync(INDEX, 'utf8');
  const fn = memberCountLabelSrc(src);
  // `!state.seededCount` and `state.seededCount &&` are both true/false-alike for null AND 0 —
  // exactly the shape that shipped in this file before the review caught it (a bare `&&` guard
  // rendered nothing at all for an unread list, identical to a confirmed-empty one).
  assert.doesNotMatch(fn, /!state\.seededCount\b/);
  assert.doesNotMatch(fn, /state\.seededCount\s*&&/);
});

test('NON-VACUITY: the pre-fix guard (a bare `&&` on state.seededCount) would fail the assertions above', () => {
  const preFix = `function memberCountLabel(v) {
  const raw = Number(v.holderCount ?? 0);
  const bound = organicMemberBound(v.holderCount, state.seededCount);
  const note = state.seededCount && bound !== null
    ? \` (raw on-chain; at least \${bound} non-seeded)\`
    : '';
  return \`\${raw} member\${raw === 1 ? '' : 's'}\${esc(note)}\`;
}`;
  assert.doesNotMatch(preFix, /state\.seededCount\s*===\s*null/);
  assert.doesNotMatch(preFix, /seeded status unknown/);
  assert.match(preFix, /state\.seededCount\s*&&/);
});

test('index.html no longer feeds organicMemberBound/organicStakeWeightedClaim the raw, creator-inclusive holderCount (security review finding 1)', () => {
  const src = readFileSync(INDEX, 'utf8');
  // This app's live data source (the indexer/metered API) has no non-creator holder count, unlike
  // apps/vaults-ui's direct chain read — so the only safe fix here is to stop calling either
  // function at all, not to feed them a wrong base. See memberCountLabel's own header.
  assert.doesNotMatch(src, /organicMemberBound\(/);
  assert.doesNotMatch(src, /organicStakeWeightedClaim\(/);
});
