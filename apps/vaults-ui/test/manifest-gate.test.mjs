// @ts-check
/**
 * Security review, PR #409 (card 211, A2). Nothing in the existing test suite reds if `App.tsx`'s
 * manifest gate is forced open — e.g. `vault.manifestVerified === 'verified'` weakened to `true`,
 * or to `vault.manifestVerified !== 'not-found'` (which would also let `'unknown'` through, the
 * exact fail-open direction A2 exists to prevent). `<MemberActions>` is the Sign surface; mounting
 * it unconditionally would offer a signature against a vault address this app never confirmed was
 * created by the real `VaultFactory`.
 *
 * SOURCE GUARD, same reason as every sibling wiring test in this app: no JSX/TSX loader in
 * `node --test`. The live-render check in this PR's body is the closest thing to an end-to-end
 * confirmation this repo's tooling allows for a JSX branch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(APP, 'src/App.tsx'), 'utf8');

/** The full `{vault.manifestVerified === 'verified' ? ( ... ) : ( ... )}` JSX expression,
 * brace-balanced, so the assertions below read the WHOLE gate rather than the first line of it. */
function manifestGateBlock() {
  const start = SRC.indexOf("{vault.manifestVerified === 'verified' ? (");
  assert.ok(start >= 0, "no `{vault.manifestVerified === 'verified' ? (` block found in App.tsx");
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('manifest gate block never closes its braces — regex/scan bug in this test');
}

test("MemberActions and EscrowClaims are mounted ONLY inside the manifestVerified === 'verified' branch", () => {
  const block = manifestGateBlock();
  assert.match(block, /<MemberActions vault=\{vault\} \/>/, 'MemberActions is not mounted inside the gate at all');
  assert.match(block, /<EscrowClaims vault=\{vault\} \/>/, 'EscrowClaims is not mounted inside the gate at all');
  // Neither component is USED (the actual self-closing JSX tag, not a doc-comment mention or the
  // import line) anywhere outside this one block — i.e. there is no second, ungated mount site
  // elsewhere in the file that would make the gate above decorative.
  const withoutBlock = SRC.replace(block, '');
  assert.doesNotMatch(
    withoutBlock,
    /<MemberActions vault=\{vault\} \/>/,
    'MemberActions is ALSO mounted outside the manifest gate',
  );
  assert.doesNotMatch(
    withoutBlock,
    /<EscrowClaims vault=\{vault\} \/>/,
    'EscrowClaims is ALSO mounted outside the manifest gate',
  );
});

test("the gate condition is an exact equality against the string literal 'verified' — no truthy/negated-not-found shortcut", () => {
  assert.match(
    SRC,
    /\{vault\.manifestVerified === 'verified' \? \(/,
    "the gate is no longer `=== 'verified'` — a weaker condition (truthy, or `!== 'not-found'`, " +
      "which would also admit 'unknown') would let Sign render for an unverified or unread manifest",
  );
});

test("MUTATION: forcing the gate open ('unknown' or 'not-found' also admitted) fails the equality assertion above", () => {
  // Each shape the gate could be weakened to, and confirmation none of them satisfies the strict
  // equality regex the previous test pins.
  const weakened = [
    "{vault.manifestVerified !== 'not-found' ? (",
    '{true ? (',
    '{vault.manifestVerified ? (',
    "{(vault.manifestVerified === 'verified' || vault.manifestVerified === 'unknown') ? (",
  ];
  const strict = /\{vault\.manifestVerified === 'verified' \? \(/;
  for (const w of weakened) {
    assert.doesNotMatch(w, strict, `weakened gate "${w}" must NOT satisfy the strict equality regex`);
  }
});

test('NON-VACUITY: the real App.tsx source contains at least one JSX conditional gate, so the scan above is not matching an absent file', () => {
  assert.ok(SRC.includes('manifestVerified'), 'manifestVerified does not appear in App.tsx at all — has it moved?');
});
