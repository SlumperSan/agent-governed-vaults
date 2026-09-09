/**
 * The hero's words. Every one of them is already in the corpus.
 *
 * `test/site.test.mjs` has a leg that takes each sentence rendered on this page
 * and requires it to appear verbatim in one of three places: the nine pages of
 * `apps/site`, the approved promo script, or the live-data label set the test
 * itself defines. That is not a formality here. A redesign is exactly the moment
 * somebody writes a better-sounding sentence than the one that was checked, and
 * the sentence that was checked is the one a reviewer read against the
 * contracts. So these strings are lifted, not written.
 *
 * WHERE EACH ONE COMES FROM:
 *
 *   HEADLINE      the owner's positioning phrase, revision 2 of the v3 brief,
 *                 shortened from "The AI agent trading index on Robinhood Chain"
 *                 because the chain belongs in the facts rather than the
 *                 tagline. Pinned once in `shell/pinned.ts` as `TAGLINE`, and
 *                 read from there rather than retyped, because the phrase is
 *                 permitted BY NAME in `claims-lede-truth.test.mjs` and one
 *                 character of drift stops the permission matching.
 *
 *   LEDE          `apps/site/index.html`, where it is the page's own h1. It
 *                 survives the demotion to a sub-line because it says what the
 *                 headline names: an index, and the condition under which it
 *                 moves.
 *
 *   FACT          `apps/site/index.html`, the immutability lede. It USED to be
 *                 "Seven contracts are on Robinhood Chain, chain id 4663.",
 *                 and the owner asked on 2026-09-09 for the site to stop
 *                 marketing a contract count and to stop reading as though one
 *                 chain were the whole story. Both halves of that sentence were
 *                 the problem: a count is a number a reader cannot check and
 *                 does not care about, and naming one chain in the HERO makes
 *                 the positioning depend on a deployment. What replaces it is
 *                 the property, which is true of the contracts on every chain
 *                 they run on and is the reason the count was ever interesting.
 *                 The chain still appears on this page -- in the live panel,
 *                 which names the chain it actually reads.
 *
 * THE THREE ADDRESS CHIPS ARE NOT COPY AND ARE NOT HERE. They are read from
 * `src/live/chain.ts`, which is the same file the live panel reads them from, so
 * a page cannot show one address in a chip and check a different one against the
 * chain forty lines further down.
 *
 * THERE ARE TWO CHIPS, AND THERE WAS BRIEFLY A THIRD. A token chip was added on
 * 2026-09-05 with a launch the owner retired on 2026-09-09 as a test, and it
 * came off with the rest of that copy. The two that remain are singletons out of
 * the deployment record, which is the property that made them publishable in the
 * first place: an address is the one thing on this page a reader can check
 * without believing a word of it, and the deployment record is what a reader
 * checks it against. A chip for an address with no record behind it does not
 * meet that bar, and `scripts/test/claims-token-absence.test.mjs` now enforces
 * the absence.
 */

/** The lede under the headline. Corpus: apps/site/index.html, the h1. */
export const LEDE = 'An index that only moves when the hive agrees.';

/** Corpus: apps/site/index.html, "Immutability" lede. */
export const FACT = 'No proxy, no upgrade path, no pause function, no admin key.';

/**
 * The two buttons. Both labels are corpus CTA labels carried in `pinned.ts`:
 * `APP_NAV.label` and `CTA.howItWorks`. Neither is written here, for the same
 * reason the headline is not: "get started", "sign up" and "connect wallet" are
 * banned outright and a redesign is where somebody reaches for them.
 *
 * THE SECOND BUTTON IS AN ANCHOR NOW, NOT A LINK TO A PAGE. `how-it-works.html`
 * was retired into the `#how` section of this page on 2026-09-05, so the label
 * survives and the destination moved from a document to a heading.
 */
export const HOW_ANCHOR = '#how';

/** The label above each address chip. Two words, and they name the thing. */
export const CHIP_LABELS = {
  factory: 'Factory',
  usdg: 'USDG',
} as const;

/**
 * What the copy button says before and after.
 *
 * "Copy" then "Copied", and the second is the past tense of the first rather
 * than a tick or a toast. An action keeps its name through the whole flow: the
 * button that says Copy produces the word Copied, which is the same vocabulary
 * a reader already learned one word ago.
 */
export const COPY_IDLE = 'Copy';
export const COPY_DONE = 'Copied';
