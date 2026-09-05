/**
 * agents-before-you-point — "Then read the Disclaimers.", the closing section
 * of agents.html.
 *
 * WHAT IT IS FOR. agents.html is the one page on this site written for a
 * machine, and everything above this block is an interface: the chain id, the
 * address ledger, the ABIs, and what an agent may and may not do on-chain.
 * This section is the paragraph that says the reader most likely to skip the
 * Disclaimers is precisely the one now holding the integration guide, and
 * then gives five ways to go and read them. It asks for nothing, collects
 * nothing, and has no control that submits.
 *
 * IT DOES NOT MOVE. The brief pins this section to no motion, and this file
 * imports nothing from `src/motion/` as a result — no `<Reveal>`, no observer,
 * no transition on entry. That is not an omission to be filled in later. Every
 * other closing block on the site fades; the one that tells an autonomous
 * reader it is about to skip something important should not first perform its
 * own arrival. Three things follow for free from having no motion at all: the
 * reduced-motion state and the ordinary state are the same tree, there is
 * nothing to keep in step with the scroll loop, and the section costs the page
 * no JavaScript beyond what the shell already ships.
 *
 * WHAT THE PRERENDER MUST CARRY, AND WHY EVERY WORD BELOW IS UNCONDITIONAL.
 * The build renders this tree to a string and splices it into
 * `dist/agents.html`; the guards then read that file. So nothing here is
 * behind scroll state, an IntersectionObserver, a React-state toggle or a
 * client-only branch, and nothing here reads `matchMedia` or a viewport width
 * during render. The resting state IS the finished state — what the server
 * writes, what the client renders while hydrating, and what a reader whose
 * JavaScript never arrives keeps.
 *
 * THE EXEMPTION SENTENCE THIS SECTION USED TO CARRY IS GONE. The paragraph
 * used to close on `there is no guarantee of any outcome`, one of exactly two
 * fragments that lifted the claims suite's ban on that word. The rewrite
 * shortens this paragraph to a single sentence that does not include it. That
 * exemption fragment is presumably carried by disclaimers.html now; flagged in
 * the sync report as an item for the suite (or that page's owner) to confirm,
 * since an unused exemption reds the suite on the exemption list rather than
 * on this page.
 *
 * WHY `<Pinned>` FOR PROSE WITH NO ENTITIES IN IT. `renderToString` escapes
 * text children. None of these sentences needs an entity today, but the day
 * one gains an apostrophe it would reach `dist/agents.html` as `&#x27;` and a
 * guard doing `html.includes(SENTENCE)` would fail on a page that looks
 * perfect in a browser — the worst class of failure to trace, because nothing
 * on screen is wrong. Rendering the stored bytes closes that path before it
 * opens. See src/shell/PinnedText.tsx.
 *
 * THE FIVE LINKS ARE ALSO NAVIGATION PINS. Every page must literally contain
 * each of the eight `*.html` hrefs; the masthead carries six and the footer
 * carries all eight, and these five repeat exactly the hrefs the current page
 * repeats, `.html` suffix included — the first now `disclaimers.html` rather
 * than the retired `risks.html`. Do not switch them to the extension-less
 * form: the site suite matches on the suffix, and Pages already redirects the
 * other way.
 *
 * WHAT THIS FILE MAY NOT DO, restated because it is easy to drift into: it
 * owns `src/sections/agents-before-you-point/` and nothing else. `wrap` is the
 * shell's shared reading column, used as-is; every other class is
 * module-scoped. It composes itself into no page — `src/pages/AgentsPage.tsx`
 * belongs to Integrate.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { ACTIONS, BODY, EYEBROW, HEADING } from './copy';
import s from './AgentsBeforeYouPoint.module.css';

/**
 * The heading's id, used to name the section landmark. A `<section>` with no
 * accessible name is a generic container rather than a landmark, and naming it
 * from the heading already on the page means the landmark carries no invented
 * sentence — the aria-label is not published prose, but a landmark named from
 * existing copy needs no exemption for it either.
 */
const HEADING_ID = 'before-you-point';

export function AgentsBeforeYouPoint(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />
        <Pinned as="p" className={s.body} html={BODY} />

        <div className={s.actions}>
          {ACTIONS.map((a) => (
            <a
              key={a.href}
              className={a.primary ? `${s.action} ${s.actionPrimary}` : s.action}
              href={a.href}
            >
              {a.label}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

export default AgentsBeforeYouPoint;
