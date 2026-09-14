// @ts-check
/**
 * The three overstatements `docs/MEMBER-VERIFY.md` is not allowed to make.
 *
 * ## Why these three and not a general prose check
 *
 * A member-facing page is not dangerous when it is vague. It is dangerous when it is CONFIDENT and
 * slightly wrong, in front of an action that cannot be undone. Each pin below is one sentence that
 * a draft of this page actually carried, each is defensible-sounding, and each would have cost a
 * reader either money or an irrevocable position:
 *
 *   1. `0x` read as a green light in front of an irrevocable exit queue.
 *   2. A refund described as a transfer when the contract has a second branch that is not one.
 *   3. `exitFeeBpsOf` labelled as the charge, in the one case where settlement waives it entirely,
 *      which is the case every first-time reader of this page is in.
 *
 * ## Each pin runs in BOTH directions, and that is the point
 *
 * The false phrasing must be ABSENT and the correction must be PRESENT. A one-directional ban is
 * satisfied by deleting the sentence and saying nothing, which leaves the reader with the same
 * wrong default they arrived with; a one-directional requirement is satisfied by adding the
 * correction BELOW the false sentence, so the page contradicts itself and the reader believes
 * whichever they read first. Neither is what this file is for.
 *
 * ## Why the corrections are pinned to a SECTION and not to the file
 *
 * `claimEscrowed` appears twice on the page, once under the refund recipe and once under the exit
 * recipe. A file-scoped check for it passes while the refund section says nothing, and a member
 * whose refund escrowed is exactly the member who never reaches the exit section. So the
 * section-scoped helper below is load-bearing rather than tidy: it asserts the reader is told the
 * thing where they are standing.
 *
 * ## What this file is NOT
 *
 * It is not a claims guard over the page's prose in general: `claims-lede-truth.test.mjs` and
 * `claims-robinhood-deployment.test.mjs` already walk every `.md` in the repository, this one
 * included. It is three pins, and it says so rather than implying wider coverage it does not have.
 *
 * Lifted from PR #116's diff to `apps/site/test/site.test.mjs`, with the assertions unchanged.
 * They live here instead because `apps/site` is retired, and because a pin on a `docs/` page
 * belongs beside the page rather than inside a site suite that no longer ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMBER_PAGE = 'docs/MEMBER-VERIFY.md';

const read = () => readFileSync(path.join(REPO, ...MEMBER_PAGE.split('/')), 'utf8');

/** Collapse hard wrapping, so a sentence broken across two lines still matches as one. */
const flatten = (/** @type {string} */ s) => s.replace(/\s+/g, ' ');

/**
 * The text from `heading` up to the next heading at the SAME OR SHALLOWER level.
 *
 * Depth-aware rather than "up to the next `#`": `## 5.` contains `### A.`, `### B.` and `### C.`,
 * and a naive next-hash split would end section 5 at its own first subsection, making every pin
 * scoped to it vacuous. A vacuous assertion passes, which is the failure mode this whole file
 * exists to prevent, so it would have been a quiet one.
 */
const section = (/** @type {string} */ text, /** @type {string} */ heading) => {
  const at = text.indexOf(heading);
  assert.notEqual(at, -1, `${MEMBER_PAGE}: section "${heading}" is gone. A pin scoped to a heading that no longer exists asserts nothing, so this is a failure and not a skip.`);
  const depth = (heading.match(/^#+/) ?? ['#'])[0].length;
  const rest = text.slice(at + heading.length);
  const next = rest.search(new RegExp(`^#{1,${depth}} `, 'm'));
  return flatten(next === -1 ? rest : rest.slice(0, next));
};

test('the member page does not overstate the dry-run, the cancel refund or the exit fee', () => {
  const text = read();
  const flat = flatten(text);

  // ── 1. The dry-run. `0x` is the success return in both modes, in front of an irrevocable queue.
  assert.equal(
    flat.match(/`0x` means it would succeed/),
    null,
    `${MEMBER_PAGE}: "\`0x\` means it would succeed" reads a bare 0x as a green light. requestExit returns no data, so 0x is the successful simulation in Mode F too — where it means the contract will accept an irrevocable queue`,
  );

  const modes = section(text, '## 4. Read the exit mode before you exit');
  assert.ok(
    /`0x` tells you only that \*\*the call would not revert\*\*/.test(modes),
    `${MEMBER_PAGE} §4: the dry-run must say 0x means only that the call would not revert`,
  );
  assert.ok(
    /returns no data, so `0x` is what a successful simulation looks like in \*\*both\*\* modes/.test(modes),
    `${MEMBER_PAGE} §4: must say why 0x cannot distinguish the modes — requestExit returns no data`,
  );
  assert.ok(
    /Re-read `hasPendingExecution` in the same breath as you send/.test(modes),
    `${MEMBER_PAGE} §4: must send the reader back to hasPendingExecution immediately before the send`,
  );
  assert.ok(
    /A non-zero proposal id is not Mode F/.test(modes),
    `${MEMBER_PAGE} §4: activeProposalOf is assigned in Governance.propose and never zeroed, and is non-zero through the commit phase too — the page prints it beside the mode read and must say it is not the mode read`,
  );

  // ── 2. cancelPending. _payOrEscrow has a second branch that is not a transfer.
  assert.equal(
    flat.match(/transfers the USDC back to you, in full/),
    null,
    `${MEMBER_PAGE}: "transfers the USDC back to you, in full" states one of VaultCore._payOrEscrow's two branches as if it were the only one`,
  );

  const reclaim = section(text, '### B. Reclaim a pending deposit');
  assert.ok(
    /only one of them is a transfer/.test(reclaim),
    `${MEMBER_PAGE} §5-B: must say the refund has a second branch that is not a transfer`,
  );
  assert.ok(
    /`claimable`/.test(reclaim) && /claimEscrowed\(address\)/.test(reclaim),
    `${MEMBER_PAGE} §5-B: a member whose refund escrowed needs claimable/claimEscrowed HERE, not only in §5-C`,
  );

  // ── 3. The exit fee. exitFeeBpsOf is the rate; settlement waives it for a sole holder.
  assert.equal(
    flat.match(/The exit fee you would pay right now/),
    null,
    `${MEMBER_PAGE}: "the exit fee you would pay right now" labels exitFeeBpsOf as the charge. VaultCore._settleExit zeroes it when sharesOf[member] == totalShares, which is the state both vaults on chain 4663 are in`,
  );

  const position = section(text, '## 2. Read your position');
  assert.ok(
    /Settlement charges zero if you hold every share of the vault/.test(position),
    `${MEMBER_PAGE} §2: must state the sole-holder waiver beside the exitFeeBpsOf read`,
  );
  assert.ok(
    /`sharesOf\(YOU\)` against `totalShares\(\)`/.test(position),
    `${MEMBER_PAGE} §2: must give the reader the comparison that decides the waiver`,
  );
  assert.ok(
    /or zero if you hold every share/.test(modes),
    `${MEMBER_PAGE} §4: the Mode-I bullet says settlement is "less the exit fee" and carries the same claim — it must carry the same waiver`,
  );
});

test('the section helper is depth-aware, so a pin cannot be satisfied from the wrong subsection', () => {
  // Mutation-proofing for the helper itself. If `section` ever reverts to splitting on the next
  // `#` of any depth, `## Five` would end at `### A` and this assertion fails — which is the
  // failure the three pins above could not show, because a vacuous section is an EMPTY string and
  // an empty string fails their `assert.ok` for the right reason by accident rather than by check.
  const doc = '## Five\nintro\n\n### A\nalpha\n\n### B\nbravo\n\n## Six\nsix\n';
  const five = section(doc, '## Five');
  assert.ok(five.includes('alpha') && five.includes('bravo'), 'a `##` section must contain its `###` subsections');
  assert.ok(!five.includes('six'), 'a `##` section must stop at the next `##`');
  assert.equal(section(doc, '### A'), ' alpha ', 'a `###` section must stop at the next `###`');
});
