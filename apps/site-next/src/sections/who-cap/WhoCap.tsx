/**
 * who-cap — "A planned 50,000 USDC is a blast radius, not a queue."
 * on who-its-for.html.
 *
 * WHAT THIS SECTION IS FOR. A reader who has just been told the first vault
 * holds 50,000 USDC will read that number one of two ways: as scarcity, or as
 * a limit. The passage exists to close off the first reading, so the design
 * has to close it off too — a block that treats the figure as a headline
 * number sells the reading the copy is refusing. Hence: no oversized numeral,
 * no counter, no chip, no progress bar and no chroma. One heading, one
 * paragraph, one flat note, all at the page's ordinary weight.
 *
 * WHAT IS PRERENDERED. Everything. The eyebrow, the heading, the paragraph,
 * the note label and the note body are all in the markup before any module
 * runs. The enter animation is added afterwards by <Reveal>, which starts from
 * the resting state rather than from an `opacity: 0` class, so a reader with
 * motion reduced — or with JavaScript unavailable — gets the finished section,
 * and the bytes the claims suite reads are in `dist/who-its-for.html` whether
 * or not anything ever scrolls.
 *
 * REDUCED MOTION. Handled entirely inside <Reveal>, which early-returns on
 * `prefersReducedMotion()` and leaves the resting markup alone. Nothing in
 * this file reads `matchMedia`, and nothing branches the render tree on it:
 * that is the hydration-parity trap the sections README names, and the fix is
 * to have no branch rather than a careful one.
 *
 * MOTION SPEC: fade in, 0.4s. `rise={0}` is the whole of it — opacity only, no
 * travel, no stagger. The section is a correction to an assumption, like
 * hiw-corrections is, and it gets the same restraint for the same reason.
 *
 * WHY THE SECTION ELEMENT IS OUTSIDE <Reveal>. The landmark carries
 * `aria-labelledby` pointing at its own heading, so it is named by copy that
 * already exists rather than by a new string. <Reveal> takes no arbitrary
 * attributes, so it wraps the reading column instead — which is also the right
 * thing to animate, since a landmark that fades is a landmark briefly missing
 * from the visible content of the accessibility tree.
 *
 * OWNERSHIP. This file owns `src/sections/who-cap/` and nothing else. `wrap` is
 * the shell's shared reading column and is used as-is; every other class here
 * is module-scoped. The flat note is styled locally rather than added to
 * `index.css`, which belongs to Shell.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { BODY, EYEBROW, HEADING, NOTE_BODY, NOTE_LABEL } from './copy';
import s from './WhoCap.module.css';

/**
 * Seconds. The brief pins this section to a plain fade at 0.4s — the floor of
 * the design system's 0.4-0.8s band for UI motion. A literal rather than a
 * `DUR` member because the shared scale is the shared scale, and this section
 * is deliberately below its slowest step.
 */
const FADE_SECONDS = 0.4;

/** The heading's id, so the landmark is named by the heading rather than by new prose. */
const HEADING_ID = 'the-cap';

export default function WhoCap(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* rise={0} is the motion spec in full: opacity, once, nothing else. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>{EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />
        <Pinned as="p" className={s.body} html={BODY} />

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" className={s.noteBody} html={NOTE_BODY} />
        </div>
      </Reveal>
    </section>
  );
}
