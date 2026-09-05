/**
 * One question and its answer.
 *
 * EVERYTHING IS RENDERED, ALWAYS. There is no accordion here, no
 * `<details>`, no scroll gate and no React state. The build prerenders and the
 * guards read `dist/faq.html` as text, so any copy that appears only after an
 * interaction is copy that is absent from the file being checked. A disclosure
 * widget is the one design idea this section may not have.
 *
 * WHY THE PARAGRAPHS GO THROUGH `<Pinned>`. `renderToString` escapes text
 * children, and nine of these paragraphs carry an apostrophe. See copy.ts.
 *
 * MOTION. One fade per article, 0.4s, no rise and no stagger. The
 * article renders at its resting state and the fade is added afterwards, so a
 * reader with motion reduced, a reader with JavaScript unavailable, and the
 * guards reading the built file all see the finished article.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import type { QaEntry } from './copy';
import s from './FaqQuestions.module.css';

/** The brief's figure. Inside the 0.24-0.8s band src/motion/easings.ts sets. */
const ENTER_SECONDS = 0.4;

export function QA({ entry }: { entry: QaEntry }): JSX.Element {
  return (
    <Reveal as="article" className={s.qa} duration={ENTER_SECONDS} rise={0}>
      <Pinned as="h2" id={entry.id} className={s.question} html={entry.question} />
      <div className={s.answer}>
        {entry.blocks.map((block, i) => (
          <Pinned
            key={`${entry.id}-${i}`}
            as="p"
            className={block.pin ? s.standingFact : undefined}
            html={block.html}
          />
        ))}
      </div>
    </Reveal>
  );
}
