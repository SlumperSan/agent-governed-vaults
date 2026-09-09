/**
 * The four phrases on the strip. Each one is checkable against the contracts.
 *
 *   THE HIVE DECIDES
 *     `Governance.finalize` is what moves a vault, and it counts member votes.
 *     `Governance.sol` contains zero occurrences of "operator". The corpus
 *     sentence behind it is `apps/site/index.html`: "Nothing executes without a
 *     member vote."
 *
 *   NO UPGRADE PATH
 *     `apps/site/faq.html`: "...no proxy and no upgrade path."
 *
 *     THE FIRST DRAFT CITED THE WRONG SENTENCE. It said this phrase was a
 *     substring of "The contracts carry no proxy, no upgrade path, no pause
 *     function and no admin key." the way NO ADMIN KEY is. It is not -- that
 *     sentence has a COMMA after "path", not a period, so "No upgrade path."
 *     does not occur in it. NO ADMIN KEY genuinely does occur in it, which is
 *     exactly what made the wrong claim read as obviously true.
 *
 *     IT REPLACED "SEVEN IMMUTABLE CONTRACTS." ON 2026-09-09, on the owner's
 *     instruction to stop marketing a contract count. The count was also the one
 *     phrase on this strip sourced from the owner's brief rather than from the
 *     corpus, so replacing it removes an entry from OWNER_AND_LIVE_STRINGS in
 *     `test/site.test.mjs` -- every phrase on the strip now resolves against the
 *     corpus or the promo script, and that list is one string shorter.
 *
 *   NO ADMIN KEY
 *     The tail of that same corpus sentence, verbatim.
 *
 *   EVERY POSITION PUT TO A VOTE
 *     Line 7 of the promo script approved by the owner on 2026-09-05, verbatim
 *     apart from case: "Every trade argued in the open. Every position put to a
 *     vote."
 *
 * THEY ARE SET IN CAPITALS BY CSS, NOT BY THE STRING. `text-transform` in the
 * stylesheet, so what the sentence-source guard compares, what a screen reader
 * announces and what a reader copies out of the page are all normal sentence
 * case. A string typed in capitals is a string that reads as shouting in every
 * context that is not this strip, including the one that matters most here,
 * which is the guard that has to match it against the corpus.
 */
export const PHRASES: readonly string[] = [
  'The hive decides.',
  'No upgrade path.',
  'No admin key.',
  'Every position put to a vote.',
];
