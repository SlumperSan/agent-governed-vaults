/**
 * vision-body — the nine design-intent sections of vision.html, plus the
 * page's close.
 *
 * NEW, copy deck v2 (2026-09-05). See copy.ts for where every string comes
 * from and for the status-chip device this page uses in place of the
 * window-scoped RWLY qualifier the other eight pages carry.
 *
 * EACH SECTION IS ITS OWN <section> ELEMENT, and that is load-bearing rather
 * than a layout choice: `apps/site/test/site.test.mjs`'s RWLY guard reads
 * `dist/vision.html` for `<section\b[^>]*>[\s\S]*?<\/section>` blocks and
 * requires every one that mentions RWLY to contain the exact chip text
 * INSIDE that same element. A `<div>` wrapper, a fragment, or sections merged
 * into one element would put the chip and the mention in the wrong scope for
 * that check to see.
 *
 * THE CHIP RENDERS EVEN ON SECTIONS WITH NO RWLY MENTION (six, seven and
 * eight all name RWLY or a designed-intent claim near it; every section here
 * happens to be RWLY-adjacent, since the whole page is the RWLY design). It
 * is one visual device across the page rather than a conditional one, which
 * is also why the guard's positive half ("every RWLY-bearing section has the
 * chip") is satisfied unconditionally instead of by a per-section judgment
 * call about whether a given paragraph counts as "near" RWLY.
 *
 * NO MOTION. Matching risks-verify and risks-scope-additions: this is a page
 * of static disclosure-shaped prose, not a page that performs. No `Reveal`.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { CLOSE_ACTIONS, CLOSE_BODY, RWLY_CHIP, SECTIONS, type VisionSection } from './copy';
import s from './VisionBody.module.css';

function Chip(): JSX.Element {
  return <span className={s.chip}>{RWLY_CHIP}</span>;
}

function Section({ section }: { section: VisionSection }): JSX.Element {
  const headingId = `vision-${section.key}`;
  return (
    <section className={s.section} aria-labelledby={headingId}>
      <div className="wrap">
        <Chip />
        <h2 id={headingId} className={s.heading}>
          {section.heading}
        </h2>
        <Pinned as="p" className={s.lede} html={section.lede} />
        {section.paragraphs?.map((html) => (
          <Pinned as="p" className={s.body} html={html} key={html.slice(0, 48)} />
        ))}
        {section.dlGroups?.map((rows, i) => (
          <dl className={s.rows} key={i}>
            {rows.map((row) => (
              <div className={s.row} key={row.dt + row.dd.slice(0, 16)}>
                <Pinned as="dt" html={row.dt} />
                <Pinned as="dd" html={row.dd} />
              </div>
            ))}
          </dl>
        ))}
      </div>
    </section>
  );
}

export default function VisionBody(): JSX.Element {
  return (
    <>
      {SECTIONS.map((section) => (
        <Section section={section} key={section.key} />
      ))}

      <section className={s.close}>
        <div className="wrap">
          <p className={s.closeBody}>{CLOSE_BODY}</p>
          <div className={s.actions}>
            {CLOSE_ACTIONS.map((a) => (
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
    </>
  );
}
