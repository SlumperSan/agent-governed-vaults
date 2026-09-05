/**
 * who-not-for — "Four groups this is explicitly wrong for at launch."
 *
 * The section that tells a reader to leave: DAO treasuries and larger
 * allocators, anyone who wants set-and-forget, anyone who cannot survive a
 * total loss, anyone in a restricted jurisdiction. It is the counterpart to the
 * section above it on this page, which describes what a member must actually
 * do; this one names the people for whom that description is a reason not to
 * deposit.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS IN HERE THAT LOOK LIKE STYLE AND ARE NOT
 * ---------------------------------------------------------------------------
 *
 * 1. THE FOURTH ENTRY CARRIES AN EXEMPTED CLAUSE.
 *    `a good-faith measure and not a guarantee` is one of the exact fragments
 *    the claims suite strips before its banned-word scan, and it is separately
 *    asserted to be in actual use somewhere on the site — which is also why
 *    this comment keeps the clause on one line: the scan strips the exact
 *    fragment, so a copy of it broken across two comment lines is a bare
 *    banned word sitting in a source file.
 *    The exemption is for the whole clause, so the
 *    sentence may not be shortened, re-punctuated, or split across two
 *    elements: any of those leaves a banned word standing on its own, on a page
 *    that would otherwise be identical. It is rendered from one string, in one
 *    element, through `<Pinned>`.
 *
 * 2. THE FIRST ENTRY SUPPLIES BOTH HALVES OF A PAGE-LEVEL PAIRING. The suite
 *    requires any page containing 50,000 to also contain the word "planned",
 *    and this entry's first sentence carries both. The `who-cap` section later
 *    on the page carries the figure too, so neither section may drop its
 *    wording on the assumption that the other one holds the pair up.
 *
 * 4. EVERY BODY PARAGRAPH GOES THROUGH `<Pinned>`. `renderToString` escapes an
 *    apostrophe to `&#x27;` and would render an inline `<em>` as text, and the
 *    first body carries both — so a byte-comparison against the reviewed
 *    original in `apps/site/who-its-for.html` would fail on markup that renders
 *    perfectly. The two bodies that carry neither go through it as well, so the
 *    section has one rule rather than an exception nobody remembers.
 *
 * MOTION. The four entries enter as a staggered group, once, on the grid's own
 * entry: 100ms apart, which is `STAGGER.loose` exactly. The brief asks for a
 * 0.6s entry and the shared scale offers 0.5 and 0.8; this takes the nearer of
 * the two rather than hand-typing a fifth duration into a component, because a
 * house style with five durations is a house style nobody can hold in mind.
 *
 * `Reveal` renders the finished state on the server and on the client's first
 * render, then animates from it in a layout effect — so the reduced-motion
 * branch, the no-JavaScript branch and the prerendered markup the claims guards
 * read are all the same finished page. There is no `matchMedia` in this render
 * tree and there must not be one.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { Reveal } from '../../motion/Reveal';
import { DUR, STAGGER } from '../../motion/easings';
import {
  CARD_1_BODY,
  CARD_1_TITLE,
  CARD_2_BODY,
  CARD_2_TITLE,
  CARD_3_BODY,
  CARD_3_TITLE,
  CARD_4_BODY,
  CARD_4_TITLE,
} from './copy';
import s from './WhoNotFor.module.css';

const HEADING_ID = 'who-not-for-heading';

export default function WhoNotFor(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>Not for you if</p>
        <h2 id={HEADING_ID} className={s.heading}>
          Four groups this is explicitly wrong for at launch.
        </h2>

        <Reveal className={s.grid} stagger={STAGGER.loose} duration={DUR.mid}>
          <div className={s.entry}>
            <h3 className={s.entryTitle}>{CARD_1_TITLE}</h3>
            <Pinned as="p" className={s.entryBody} html={CARD_1_BODY} />
          </div>

          <div className={s.entry}>
            <h3 className={s.entryTitle}>{CARD_2_TITLE}</h3>
            <Pinned as="p" className={s.entryBody} html={CARD_2_BODY} />
          </div>

          <div className={s.entry}>
            <h3 className={s.entryTitle}>{CARD_3_TITLE}</h3>
            <Pinned as="p" className={s.entryBody} html={CARD_3_BODY} />
          </div>

          <div className={s.entry}>
            <h3 className={s.entryTitle}>{CARD_4_TITLE}</h3>
            {/* The exempted clause and its em-dash admission, from one string. */}
            <Pinned as="p" className={s.entryBody} html={CARD_4_BODY} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
