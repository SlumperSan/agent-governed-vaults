/**
 * The four phrases on the strip. Each one is checkable against the contracts.
 *
 *   THE HIVE DECIDES
 *     `Governance.finalize` is what moves a vault, and it counts member votes.
 *     `Governance.sol` contains zero occurrences of "operator". The corpus
 *     sentence behind it is `apps/site/index.html`: "Nothing executes without a
 *     member vote."
 *
 *   SEVEN IMMUTABLE CONTRACTS
 *     Seven singletons, as `contracts/config/deployments/robinhood-mainnet.json`
 *     records them, and immutable in the sense the next phrase spells out: the
 *     corpus sentence is "The contracts carry no proxy, no upgrade path, no
 *     pause function and no admin key."
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
  'Seven immutable contracts.',
  'No admin key.',
  'Every position put to a vote.',
];
