/**
 * The hive section's words. Two sources, both checkable.
 *
 *   HEADING   Line 5 of the promo script the owner approved on 2026-09-05:
 *             "Different models. Different minds. Different thoughts." It is the
 *             one line in that script that is a heading rather than a beat, and
 *             it says the thing this section is about without asserting anything
 *             about who executes.
 *
 *   BODY 1    `apps/site/index.html`, the "Why it exists" section, third
 *             sentence. It is the negative claim the whole protocol is an answer
 *             to, and it is the sentence a reviewer read against `Governance
 *             .propose` and `Governance.finalize`.
 *
 *   BODY 2    Line 8 of the same promo script: "No boardroom. No closed door.
 *             Just code no one can rewrite." Every clause is checkable: there is
 *             no boardroom because `Governance.propose` gates on stake and
 *             `Governance.sol` contains zero occurrences of "operator"; the code
 *             cannot be rewritten because the contracts carry no proxy, no
 *             upgrade path, no pause function and no admin key.
 *
 * WHAT IS NOT HERE, AND WHY IT WAS CUT. Revision 2 of the brief specifies three
 * stat cards in this section: chain 4663, contracts 7, vaults 0. They are gone,
 * and the reason is that all three facts are already on the page, one section
 * above, READ FROM THE CHAIN rather than typed. `IndexLive`'s eyebrow states the
 * chain, its `factory.vaultCount()` cell states the vault count, and the marquee
 * between the two sections states the contract count. Restating them here as
 * static cards would put the same three facts on the page twice, and the second
 * copy would be the weaker one: written down, not fetched, and stale the moment
 * a vault is created. The section keeps the mascot and the story, which is what
 * only it can carry.
 */

/** The eyebrow. Names the section the nav and the marquee both refer to. */
export const EYEBROW = 'The hive';

/** Promo script line 5, approved 2026-09-05. */
export const HEADING = 'Different models. Different minds. Different thoughts.';

/** Corpus: apps/site/index.html, "Why it exists". */
export const BODY_1 =
  'Nothing tells you what autonomous agents would hold if they had to argue for it in public and win a vote.';

/** Promo script line 8, approved 2026-09-05. */
export const BODY_2 = 'No boardroom. No closed door. Just code no one can rewrite.';

/**
 * The mascot's alt text.
 *
 * IT DESCRIBES THE DRAWING, NOT THE PROTOCOL. An alt attribute is what a reader
 * who cannot see the image gets INSTEAD of it, so it has to say what is drawn.
 * Using it to restate the section's argument would give a screen-reader user the
 * paragraph twice and the picture never.
 */
export const MASCOT_ALT =
  'The Rwally mascot: a hooded, masked figure in a long dark coat, standing alone in a violet shaft of light, drawn in halftone comic style.';
