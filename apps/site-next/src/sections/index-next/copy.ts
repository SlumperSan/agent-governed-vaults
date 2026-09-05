/**
 * The last beat: what is designed and not built, and where the warnings live.
 *
 * THE HEADING IS THE PAGE'S OWN PUNCHLINE. Everything above it is loud: a
 * headline at 100px, a strip of solid accent, a block number the size of a
 * poster. It ends on "There is nothing to claim here.", which is corpus-verbatim
 * from `apps/site/index.html` and is the sentence that makes the loudness
 * legitimate. A page that shouts and then offers an allocation is a presale
 * page; a page that shouts and then says there is nothing to take is a
 * different kind of thing.
 *
 * THE RWLY SENTENCE IS CARRIED WORD FOR WORD FROM THE CORPUS AND MUST NOT BE
 * REPHRASED. `apps/site/index.html` renders it, it has been through the claim
 * guards in that form, and `scripts/test/claims-lede-truth.test.mjs` bans a
 * whole family of near-misses around it. Specifically it bans saying that the
 * protocol, the contracts, the vault, Governance or FeeEngine routes, pays,
 * distributes, accrues, credits, sends or allocates anything TO RWLY, and it
 * bans RWLY as a governance or entitlement subject. The permitted form makes
 * RWLY or the treasury the actor and the verb a design intention, which is what
 * this sentence does: RWLY is designed to accrue fees, and the second sentence
 * says the thing does not exist. Both halves are load-bearing. Dropping the
 * second one turns a design note into a promise.
 *
 * `grep -ci rwly` RETURNS 0 IN Governance.sol, FeeEngine.sol AND VaultCore.sol.
 * That is the fact behind the rule, and it is why the sentence says "designed"
 * rather than "does".
 */

/** Corpus: apps/site/index.html, the "Next" section heading. */
export const HEADING = 'There is nothing to claim here.';

/**
 * Corpus: apps/site/index.html, the hero's RWLY paragraph, both sentences.
 * See the header note. Do not rephrase either one.
 */
export const DESIGN_INTENT =
  'The next iteration, RWLY, is designed to accrue the protocol’s fees into official Robinhood Stock Tokens. RWLY does not exist yet.';
