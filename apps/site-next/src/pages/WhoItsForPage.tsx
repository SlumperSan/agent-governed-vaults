/**
 * who-its-for.html — the assumptions-and-exclusions page, in document order.
 *
 * WhoCap supplies the "planned" that every page mentioning 50,000 must also
 * carry. WhoDecide no longer carries a guard-derived count phrase: the corpus
 * dropped the "seven ... nothing is done" sentence and now simply points the
 * reader at the Disclaimers page (disclaimers.html — risks.html no longer
 * exists as a file) instead of restating a number this page does not own.
 */
import WhoHero from '../sections/who-hero/WhoHero';
import WhoDeal from '../sections/who-deal/WhoDeal';
import WhoNotFor from '../sections/who-not-for/WhoNotFor';
import WhoCap from '../sections/who-cap/WhoCap';
import WhoDecide from '../sections/who-decide/WhoDecide';

export default function WhoItsForPage() {
  return (
    <>
      <WhoHero />
      <WhoDeal />
      <WhoNotFor />
      <WhoCap />
      <WhoDecide />
    </>
  );
}
