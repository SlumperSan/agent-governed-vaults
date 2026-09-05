/**
 * HOW IT WORKS. The seven-step rail, then the three steps a member takes.
 *
 * `#how` IS THE ANCHOR TWO OTHER THINGS POINT AT: the header nav's "How it
 * works" entry and the hero's second button. Both used to be links to
 * `how-it-works.html`, which was retired into this section on 2026-09-05. The
 * label survived the move and only the destination changed, from a document to
 * a heading, which is why `CTA.howItWorks` is still the corpus string it always
 * was.
 *
 * THE ROWS ARE AN ORDERED LIST IN THE MARKUP, and the numerals a reader sees are
 * `aria-hidden`. An `<ol>` already tells assistive technology that these are
 * three items in an order and which one is which; rendering "01" as announced
 * text on top of that is the same information twice. The visible numerals are
 * therefore presentation, and the semantics come from the element.
 */
import type { JSX } from 'react';
import { EYEBROW, HEADING, RAIL, STEPS } from './copy';
import styles from './IndexHow.module.css';

export default function IndexHow(): JSX.Element {
  return (
    <section className={styles.how} id="how" aria-labelledby="how-h">
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>{EYEBROW}</p>
            <h2 className={styles.heading} id="how-h">
              {HEADING}
            </h2>
          </div>
          <p className={styles.rail}>{RAIL}</p>
        </div>

        <ol className={styles.steps}>
          {STEPS.map((step) => (
            <li className={styles.step} key={step.n}>
              <span className={styles.numeral} aria-hidden="true">
                {step.n}
              </span>
              <span className={styles.verb}>{step.verb}</span>
              <span className={styles.line}>{step.line}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
