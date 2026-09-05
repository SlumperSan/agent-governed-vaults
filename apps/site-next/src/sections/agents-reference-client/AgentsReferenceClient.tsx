/**
 * agents-reference-client — "There is a working agent in the repository."
 *
 * Source passage: the rewritten agents.html, the section whose eyebrow is
 * "Reference client". The eyebrow, the heading, both paragraphs and both links
 * are carried over byte-for-byte; see ./copy.ts for the provenance record.
 *
 * WHAT THE SECTION IS FOR. It is the page's admission that the software it has
 * just described how to talk to is a worked example rather than production
 * code, and it now points at the Disclaimers page for the review scope and
 * the two launch-class bugs running it live exposed, rather than naming them
 * inline. The two links go to the document and to the repository, so a reader
 * who wants to check the code itself can.
 *
 * That wording is this passage's own. operators.html carries a separate
 * reference-agent section with its own reviewed sentences, and the two were
 * reviewed apart; a future editor who notices they cover related ground should
 * leave both alone rather than align one to the other.
 *
 * WHY IT MOVES AS LITTLE AS IT DOES. A 0.4s fade on the block as a whole: no
 * rise, no stagger, nothing per-item. The brief pins this section to a plain
 * fade, and it is the right restraint for the copy — a staggered flourish
 * under a paragraph naming two defects would be the design arguing with the
 * sentence. `<Reveal rise={0}>` is a pure opacity transition; nothing here
 * travels.
 *
 * THREE CONSTRAINTS THIS FILE IS BUILT AROUND, each of which fails silently:
 *
 *   1. NOTHING IS CONDITIONALLY RENDERED. The build prerenders and the guards
 *      read the prerendered file. Every word and every href below is in
 *      `dist/agents.html` before a module runs, so copy behind a scroll state,
 *      an observer or a React-state toggle is copy the guard cannot see.
 *   2. THE RESTING STATE IS THE FINISHED STATE. The tree below is what the
 *      server renders, what the client renders while hydrating, and what a
 *      reader with motion reduced or with JavaScript unavailable keeps.
 *      `<Reveal>` adds the enter afterwards, in a layout effect, and leaves
 *      anything already on screen exactly where it is — so this section is
 *      never blanked while a chunk is in flight. Nothing here branches on
 *      `matchMedia` or on viewport width.
 *   3. THE COPY IS BYTES, NOT TEXT CHILDREN, wherever a guard could read it.
 *      `renderToString` escapes text children; a guard matching the raw file
 *      does not match an escaped entity. See ./copy.ts and
 *      src/shell/PinnedText.tsx.
 *
 * WHY THE `<section>` SITS OUTSIDE `<Reveal>`. The landmark is named by
 * `aria-labelledby` pointing at its own heading, so it carries no invented
 * prose; `<Reveal>` takes no arbitrary attributes, so it wraps the reading
 * column instead. That is also the right thing to animate — a landmark that
 * fades is a landmark briefly missing from what a screen reader can see.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it
 * owns `src/sections/agents-reference-client/` and nothing else. `wrap` is the
 * shell's shared reading column, used as-is; every other class is
 * module-scoped. It composes itself into no page — `src/pages/AgentsPage.tsx`
 * belongs to Integrate.
 */
import type { JSX } from 'react';
import { Reveal } from '../../motion/Reveal';
import { Pinned } from '../../shell/PinnedText';
import { ACTIONS, BODY_DETAIL, BODY_WHAT_IT_DOES, EYEBROW, HEADING } from './copy';
import s from './AgentsReferenceClient.module.css';

/**
 * Seconds. At the floor of the design system's band for UI motion, matching
 * the other blocks the brief pins to a plain fade at this speed. It is a
 * literal rather than a `DUR` member for the simple reason that the shared
 * scale has no 0.4 and a section may not add one — `src/motion/easings.ts`
 * belongs to Shell. The scale stays the scale.
 */
const FADE_SECONDS = 0.4;

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading already on the page means the landmark carries no new
 * sentence.
 */
const HEADING_ID = 'reference-client';

export function AgentsReferenceClient(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      {/* One target, one fade. `rise={0}` is the whole motion spec: opacity
          only, so neither paragraph slides up under the heading. */}
      <Reveal as="div" className="wrap" duration={FADE_SECONDS} rise={0}>
        <p className={s.eyebrow}>{EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />

        <Pinned as="p" className={s.lede} html={BODY_WHAT_IT_DOES} />
        <Pinned as="p" className={s.body} html={BODY_DETAIL} />

        <div className={s.actions}>
          {ACTIONS.map((a) => (
            <a key={a.href} className={s.action} href={a.href}>
              {a.label}
            </a>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

export default AgentsReferenceClient;
