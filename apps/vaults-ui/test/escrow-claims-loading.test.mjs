// @ts-check
/**
 * Security review, PR #409 (card 211, B2). `EscrowClaims.tsx` originally rendered "Nothing
 * claimable right now." whenever `claimable && claimable.length > 0` was false — which is true
 * BEFORE the claimable read has ever run (still loading), and STAYS true forever if
 * `readVaultAddresses` fails (the vault's own USDC address never resolves, so the claimable
 * multicall is never even planned). Both are "we do not know", not "you have nothing", and both
 * used to render as the confident negative — the exact "unread renders as a clean zero" collapse
 * this whole card (A2/B3 included) exists to close, one component over.
 *
 * SOURCE GUARDS, same reason as every sibling wiring test in this app: no JSX/TSX loader in
 * `node --test`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(APP, 'src/components/EscrowClaims.tsx'), 'utf8');

// ─────────────────── the "nothing claimable" claim requires a completed, empty, fully-read result ───

test('nothingClaimable requires claimable !== null (a completed read), not just a falsy/empty value', () => {
  assert.match(
    SRC,
    /const nothingClaimable = claimable !== null && claimable\.length === 0 && !anyUnread;/,
    'the nothingClaimable derivation no longer requires claimable !== null — a loading or failed ' +
      'read could render as "nothing claimable" again',
  );
});

test('the "Nothing claimable right now." text is gated on nothingClaimable, not rendered as an else-branch fallback', () => {
  assert.match(
    SRC,
    /\{nothingClaimable \? <p className="note dim">Nothing claimable right now\.<\/p> : null\}/,
    '"Nothing claimable right now." is no longer gated on the nothingClaimable flag',
  );
  // The pre-fix shape rendered it as the ELSE of the claimable-list ternary — no `null` between
  // the table's closing tag and the "nothing" branch, because they were one expression. Confirms
  // the two are now independent, sibling JSX expressions rather than one ternary.
  assert.match(
    SRC,
    /\) : null\}\s*\{nothingClaimable \?/,
    'the claimable table and the "nothing claimable" text are still one ternary rather than independent renders',
  );
});

test('MUTATION: the pre-fix condition (no completed-read requirement) would have rendered "nothing" while still loading', () => {
  // The exact defect this closes, reconstructed inline (not re-read from git history, which a
  // worktree checkout cannot assume is reachable): with `claimable` still `null` (load in
  // flight) and nothing unread or errored yet, the OLD gate reads true.
  function preFixShowsNothing(claimable, anyUnread, readError) {
    return !anyUnread && !readError; // the exact pre-fix else-branch condition
  }
  function fixedShowsNothing(claimable, anyUnread) {
    return claimable !== null && claimable.length === 0 && !anyUnread;
  }
  const stillLoading = { claimable: null, anyUnread: false, readError: null };
  assert.equal(
    preFixShowsNothing(stillLoading.claimable, stillLoading.anyUnread, stillLoading.readError),
    true,
    'sanity: the pre-fix condition really did read true while still loading — otherwise this is not reproducing the bug',
  );
  assert.equal(
    fixedShowsNothing(stillLoading.claimable, stillLoading.anyUnread),
    false,
    'the fixed condition must NOT show "nothing claimable" while still loading',
  );
});

// ─────────────────── a failed vault-USDC-address read is a distinct, rendered state ───────────────

test('a failed readVaultAddresses call sets a distinct usdcError state, not silently discarded', () => {
  assert.match(SRC, /const \[usdcError, setUsdcError\] = useState<string \| null>\(null\);/);
  const catchBlock = /readVaultAddresses\(publicClient, vaultAddr\)[\s\S]*?\.catch\(\(e: unknown\) => \{([\s\S]*?)\}\);/.exec(SRC);
  assert.ok(catchBlock, 'no .catch(...) block found on the readVaultAddresses(...) call');
  assert.match(
    catchBlock[1],
    /setUsdcError\(/,
    'the readVaultAddresses(...) failure path no longer sets usdcError — it is silently swallowed again',
  );
});

test('MUTATION: an empty catch handler (the pre-fix shape) is caught by the assertion above', () => {
  const buggyCatch = `.catch(() => { if (!cancelled) setUsdc(null); });`;
  assert.doesNotMatch(
    buggyCatch,
    /setUsdcError\(/,
    'the pre-fix catch handler now matches /setUsdcError\\(/ — the mutation fixture is stale',
  );
});

test('a usdcError renders the exact "could not read escrow" wording, not folded into the generic readError line', () => {
  assert.match(
    SRC,
    /Could not read escrow — claimable unknown \(\{usdcError\}\)/,
    'no distinct rendering for usdcError found',
  );
});

// ─────────────────── loading itself renders something, not an empty gap ───────────────────

test('a load in flight (address read or claimable read) renders a status line', () => {
  assert.match(
    SRC,
    /const loadingAddresses = !usdc && !usdcError;/,
    'loadingAddresses is no longer derived the same way',
  );
  assert.match(
    SRC,
    /const loadingClaimable = !!usdc && claimable === null && !readError;/,
    'loadingClaimable is no longer derived the same way',
  );
  assert.match(
    SRC,
    /\{loadingAddresses \|\| loadingClaimable \? \(/,
    'nothing renders while a read is genuinely in flight',
  );
});
