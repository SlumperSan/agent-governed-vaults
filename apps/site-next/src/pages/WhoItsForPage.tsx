/**
 * who-its-for.html — the assumptions-and-exclusions page, in document order.
 *
 * FOUR SECTIONS, NOT FIVE, SINCE 2026-09-05 ROUND 8. `who-not-for`, the
 * "Not for you if" block and its four groups, is gone from this page and its
 * copy now renders inside `risks-scope-additions` on disclaimers.html, which
 * is where `apps/site` has carried it since PR #220 (`2faed164`). The rule
 * that commit applied, and that this page now follows: the body is positive
 * and factual, and every risk, caveat and legal sentence lives on the
 * Disclaimers page. What is left here is the factual half: what the design
 * assumes about a reader, what the deal is, and that nothing is capped
 * because nothing is created. It closes on `who-decide`, which is the pointer
 * to the page the caveats went to. See sections/risks-scope-additions/groups.ts.
 *
 * WhoCap supplies the "planned" that every page mentioning 50,000 must also
 * carry. WhoDecide no longer carries a guard-derived count phrase: the corpus
 * dropped the "seven ... nothing is done" sentence and now simply points the
 * reader at the Disclaimers page (disclaimers.html — risks.html no longer
 * exists as a file) instead of restating a number this page does not own.
 */
import WhoHero from '../sections/who-hero/WhoHero';
import WhoDeal from '../sections/who-deal/WhoDeal';
import WhoCap from '../sections/who-cap/WhoCap';
import WhoDecide from '../sections/who-decide/WhoDecide';

export default function WhoItsForPage() {
  return (
    <>
      <WhoHero />
      <WhoDeal />
      <WhoCap />
      <WhoDecide />
    </>
  );
}
