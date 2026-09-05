/**
 * hiw-reference-config — "The parameters in the repository's Robinhood Chain
 * mainnet configuration." The twelve-row reference table and the
 * launch-configuration note, on how-it-works.html.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE MOVES, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * No reveal, no scrub, no enter animation, no `Reveal` wrapper. This is a
 * reference table: a reader arrives at it to check a number against the
 * repository, and anything that delays a number appearing is a cost with no
 * matching benefit. There is therefore no reduced-motion branch either, since
 * there is no motion to suppress — the prerendered markup is the finished
 * section in every state.
 *
 * The prose constants hold HTML SOURCE BYTES and render through `<Pinned>`,
 * because `renderToString` escapes text children: three of these sentences
 * contain an apostrophe, and as a text child each one would reach
 * `dist/how-it-works.html` as `&#x27;`. That is invisible in a browser and
 * fatal to any guard that does `html.includes(SENTENCE)`.
 *
 * ---------------------------------------------------------------------------
 * TWO STRUCTURAL RULES THIS SECTION MUST NOT BREAK
 * ---------------------------------------------------------------------------
 *   1. `<caption>` CARRIES NO ATTRIBUTE. The "tables carry a caption and scoped
 *      headers" check matches `/<caption>/i` — literally, with no attribute
 *      slot — so a `className` on it fails a check that reads as though the
 *      caption were missing entirely. It is styled from the parent selector.
 *   2. The row shape is whitespace-sensitive and attribute-free. See the long
 *      note at the head of `rows.ts`; that regex is the highest-value check on
 *      the site and it is broken by things that look like tidying.
 *
 * The one string here that is not carried from the source is the scroll
 * region's `aria-label`, which the brief permits as new copy: it is a landmark
 * name rather than published prose, and it repeats the caption's opening
 * words so a screen-reader user hears the same name a sighted reader sees.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { ROWS } from './rows';
import s from './HiwReferenceConfig.module.css';

/* --------------------------------------------------------------------------
 * COPY — HTML source bytes, carried verbatim from
 * apps/site/how-it-works.html, section "Reference configuration".
 * ----------------------------------------------------------------------- */

const EYEBROW = 'Reference configuration';

const HEADING = "The parameters in the repository's Robinhood Chain mainnet configuration.";

/**
 * The qualifier that keeps this table from being read as a protocol rule. It
 * is doing the same job on this page that the word "Illustrative" does beside
 * the hero canvas, and its last clause is a deployment-status disclosure.
 *
 * Carries the reference-config path and the stated target chain inline, as
 * `apps/site/how-it-works.html:221` does with a `<code>` element — hence HTML
 * source bytes rather than a plain string.
 */
const QUALIFIER =
  "These are the values in <code>contracts/config/robinhood-mainnet.json</code>, read from Robinhood Chain mainnet, chain id 4663. They are one vault's settings. They are not protocol rules and they bind no other vault.";

const CAPTION = 'Reference mainnet configuration: one example vault, not a protocol rule';

const NOTE_LABEL = 'Launch configuration';

/**
 * Root-only at launch. The approved form: what the launch FACTORY permits,
 * never what "the protocol ships with" — `allowSubVaults` is a constructor
 * immutable and the testnet factory reads `true`, so a universal about the
 * protocol is false. What that closes, and what it merely leaves dormant, is
 * pointed at the Disclaimers page rather than restated here.
 */
const NOTE_ROOT_ONLY =
  'The factory permits root vaults only; nested sub-vaults are disabled. What that closes, and what it merely leaves dormant, is in the <a href="disclaimers.html">Disclaimers</a>.';

/**
 * The capacity-cap paragraph. It is also this page's supply of the word
 * `planned`, which every page mentioning 50,000 is required to contain —
 * the number is a parameter of a vault that does not exist, and the word is
 * what stops it reading as a live figure.
 */
const NOTE_CAP =
  "The first vault's planned capacity cap is 50,000 USDG. A capacity cap is immutable per vault, so raising it means creating a new vault rather than editing that one.";

/** The h2 names the section for assistive technology; no new copy is invented. */
const HEADING_ID = 'reference-configuration';

export default function HiwReferenceConfig(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby={HEADING_ID}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <Pinned as="h2" id={HEADING_ID} className={s.heading} html={HEADING} />
        <Pinned as="p" className={s.qualifier} html={QUALIFIER} />

        {/* An overflow-x container needs a name and a tab stop, or its content
            is unreachable by keyboard on a narrow viewport. */}
        <div
          className={s.tablewrap}
          role="region"
          aria-label="Reference mainnet configuration"
          tabIndex={0}
        >
          <table>
            <caption>{CAPTION}</caption>
            <thead>
              <tr>
                <th scope="col">Parameter</th>
                <th scope="col">Reference value</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <Pinned as="td" html={row.valueHtml} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={s.note}>
          <span className={s.noteLabel}>{NOTE_LABEL}</span>
          <Pinned as="p" html={NOTE_ROOT_ONLY} />
          <Pinned as="p" html={NOTE_CAP} />
        </div>
      </div>
    </section>
  );
}
