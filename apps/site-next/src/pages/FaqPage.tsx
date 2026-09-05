/**
 * faq.html — the direct-answer page, in document order.
 *
 * 2026-09-05 CORPUS SYNC. faq.html used to be the page where the prerender
 * constraint bit hardest: it had to carry each counted footer sentence
 * exactly TWICE, with the second copy of each living inside a FaqQuestions
 * answer body. The corpus no longer quotes either footer sentence verbatim
 * inside an answer — both answers now point at the Disclaimers page instead —
 * so faq.html carries each footer sentence exactly ONCE, the same as every
 * other page. See src/sections/faq-questions/copy.ts for the full note.
 */
import FaqHero from '../sections/faq-hero/FaqHero';
import FaqQuestions from '../sections/faq-questions/FaqQuestions';
import FaqNext from '../sections/faq-next/FaqNext';

export default function FaqPage() {
  return (
    <>
      <FaqHero />
      <FaqQuestions />
      <FaqNext />
    </>
  );
}
