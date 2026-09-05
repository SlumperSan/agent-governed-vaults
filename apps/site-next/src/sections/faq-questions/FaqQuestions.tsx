/**
 * faq-questions — the fourteen answers on faq.html.
 *
 * 2026-09-05 CORPUS SYNC. The corpus faq.html no longer quotes either footer
 * standing-fact sentence verbatim inside an answer — the no-token answer and
 * the licence answer both now point a reader at the Disclaimers page instead
 * of repeating the sentence. So this section no longer owes the page a second,
 * counted copy of either sentence: faq.html now carries `FOOTER_TOKEN` and
 * `FOOTER_LICENCE` exactly ONCE each (in the footer), the same as every other
 * page, rather than twice. See src/sections/faq-questions/copy.ts for the full
 * provenance note and the corresponding change to the fourteen questions this
 * section renders (down from seventeen — three questions with no corpus
 * counterpart were dropped).
 *
 * NO HEADING OF ITS OWN. The fourteen questions are the headings, and the page
 * already has its `<h1>` in faq-hero. The landmark is named with an aria-label
 * instead — not published prose, and the one kind of new string the brief
 * permits.
 *
 * MOTION. One fade per article on enter, and nothing else. Nothing here pins,
 * scrubs or parallaxes; nothing re-animates on the way back up. The page is a
 * reference a reader arrives at with a question, so the resting state is the
 * finished state and the animation is the only thing added to it.
 */
import type { JSX } from 'react';
import { ENTRIES } from './copy';
import s from './FaqQuestions.module.css';
import { QA } from './QA';

export default function FaqQuestions(): JSX.Element {
  return (
    <section className={s.section} aria-label="Questions and answers">
      <div className="wrap">
        <div className={s.list}>
          {ENTRIES.map((entry) => (
            <QA key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </section>
  );
}
