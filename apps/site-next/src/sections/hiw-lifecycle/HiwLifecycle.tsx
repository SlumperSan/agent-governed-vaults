/**
 * hiw-lifecycle — "One rebalance, start to finish." on how-it-works.html.
 *
 * Seven ordered steps from a first deposit through execution and exit queueing,
 * then the delegation and standing-defaults note. It is the longest single
 * passage on the site and it carries three disclosures that exist because
 * somebody would otherwise be surprised by them at the worst moment: the
 * irrevocable observation-window opt-out in step 1, the opaque 32-byte
 * commitment in step 2, and the reference configuration's zero timelock in
 * step 6. None of the three may be compressed, moved below a fold, or put
 * behind an affordance.
 *
 * EVERY SENTENCE IS PRERENDERED AND UNCONDITIONAL. There is no accordion here,
 * no scroll-gated paragraph and no `<details>`: the guards read `dist/*.html`
 * as text, and copy that appears only after an interaction is copy that is not
 * in the file. The seven steps are a plain `<ol>` and the note is a plain
 * `<div>`, both fully rendered on the server.
 *
 * COPY. Carried verbatim from the `Lifecycle` section of
 * `apps/site/how-it-works.html`, held as HTML source bytes in `copy.ts` — read
 * the header of that file for why bytes rather than text, which numbers are
 * cited to which contract line, and the one place this passage's wording
 * legitimately differs from a shell constant.
 *
 * MOTION. One scrubbed rail, built entirely inside StepRail.tsx. Nothing in
 * this file animates, and nothing in this file branches on `matchMedia` or on
 * viewport width.
 */
import { useRef, type JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { StepRail } from './StepRail';
import {
  EYEBROW,
  HEADING,
  HEADING_ID,
  NOTE_BODY,
  NOTE_LABEL,
  STEPS,
} from './copy';
import { Backdrop } from '../../assets/Backdrop';
import s from './HiwLifecycle.module.css';

export default function HiwLifecycle(): JSX.Element {
  // Owned here rather than inside StepRail because the rail measures the block
  // that holds the steps, not itself.
  const lifecycleRef = useRef<HTMLDivElement | null>(null);

  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <Backdrop slot="lifecycle" />
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id={HEADING_ID} className={s.heading}>
          {HEADING}
        </h2>

        <div className={s.lifecycle} ref={lifecycleRef}>
          <StepRail containerRef={lifecycleRef} />
          <ol className={s.steps}>
            {STEPS.map((step) => (
              <li className={s.step} key={step.heading}>
                <h3 className={s.stepHeading}>{step.heading}</h3>
                {step.paragraphs.map((html) => (
                  <Pinned as="p" html={html} key={html.slice(0, 48)} />
                ))}
              </li>
            ))}
          </ol>
        </div>

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" html={NOTE_BODY} />
        </div>
      </div>
    </section>
  );
}
