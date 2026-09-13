/**
 * risks-register — the fifteen risk articles of risks.html.
 *
 * This is the most-linked destination on the site and the page the whole
 * claims contract exists to protect. It writes no sentence of its own: every
 * cell is carried byte-for-byte from `apps/site/risks.html` through
 * `entries.tsx`, and `__probe.mjs` renders this component and diffs the result
 * against that same source file.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No sticky rail, no progress indicator, no
 * scroll scrub, no pin, no per-cell reveal, no severity count, no summary
 * figure. A count of "3 partially mitigated, 7 accepted" would be a new claim
 * assembled from the chips, and a register that animates its own severity is
 * one nobody reads twice. The only motion in the section is a 0.4s fade on
 * each entry's chip and heading.
 *
 * NO HEADING OF ITS OWN. risks-contents already carries the section heading
 * ("All fifteen.") immediately above this, and each entry's numbered `<h2>` is
 * its own label — so this renders a landmark with an `aria-label` rather than
 * a second visible heading that would restate the one above it. The page's one
 * `<h1>` belongs to risks-hero.
 */
import type { JSX } from 'react';
import { ENTRIES } from './entries';
import { RiskArticle } from './RiskArticle';
import s from './RisksRegister.module.css';

/**
 * A landmark label, not published prose — the one category of new string the
 * build brief permits anywhere on this site, alongside the hero's fact-strip
 * labels and its "Illustrative" caption. It restates the heading risks-contents
 * already carries, so it introduces no claim.
 */
const LANDMARK_LABEL = 'All fifteen named risks';

export default function RisksRegister(): JSX.Element {
  return (
    <section className={s.register} aria-label={LANDMARK_LABEL}>
      <div className="wrap">
        {ENTRIES.map((entry) => (
          <RiskArticle key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
