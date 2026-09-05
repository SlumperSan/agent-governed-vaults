/**
 * risks-scope-additions — the four new caveats copy deck v2 adds to
 * disclaimers.html's "The limits of every claim on this site" section.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * `apps/site/disclaimers.html` carries a section headed "The limits of every
 * claim on this site" (eyebrow) / "What the other eight pages leave out."
 * (h2): a seventeen-entry `<dl>` restating a caveat from each of the other
 * pages, followed by a "Four groups this is wrong for" grid.
 * `risks-verify/RisksVerify.tsx` records, as of the 2026-09-05 site-next port,
 * that this whole block has NO redesign counterpart — "Per the build brief,
 * no new component is invented for it here; it is reported as a corpus-only
 * block with no redesign counterpart." That decision predates this file and
 * is NOT reopened here: the thirteen pre-existing rows and the "Four groups"
 * grid still have no home in this build.
 *
 * What changed on 2026-09-05 (copy deck v2, the hive story and the pivot to
 * an all-stocks index) is that FOUR NEW rows were added to that same corpus
 * section, none of which existed before this deck and none of which restate
 * an existing page's caveat — they are new disclosures about the new Vision
 * page. Landing four new, deck-mandated sentences nowhere because their
 * intended section has no redesign counterpart would be a bigger and quieter
 * gap than adding a small section that carries exactly those four rows and
 * says so. That is what this file does: the same eyebrow and heading the
 * corpus section carries (both still literally true — this build does leave
 * things out, these four rows among them), a `<dl>` of exactly the four new
 * entries, and a comment naming the rows it does not carry so a future
 * session does not mistake this for the ported thirteen.
 *
 * DOCUMENT POSITION matches the corpus: after the register and the
 * security-review status block, before "How to check every claim on this
 * page." — see DisclaimersPage.tsx.
 *
 * SOURCE. Every row is carried byte-for-byte from `apps/site/disclaimers.html`
 * (grep any of the four `<dt>` strings below), the reviewed source of truth.
 *
 * WHY EVERY BODY GOES THROUGH <Pinned>. `renderToString` escapes text
 * children, so `the factory's oracle allowlist` would reach the built page as
 * `the factory&#x27;s oracle allowlist`. All four bodies are rendered as HTML
 * source bytes for that reason, even the ones with no apostrophe today.
 *
 * NO MOTION, matching risks-verify: the brief's shape for a static
 * disclosures list. No `Reveal`, no effect, no `useReducedMotion` call.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './RisksScopeAdditions.module.css';

const EYEBROW = 'The limits of every claim on this site';

const HEADING = 'What the other eight pages leave out.';

/**
 * NOT the corpus's full seventeen-entry list — see the file header. These are
 * the four rows copy deck v2 adds; the thirteen pre-existing rows this
 * section also carries on apps/site remain unported.
 */
const ROWS: ReadonlyArray<{ key: string; term: string; body: string }> = [
  {
    key: 'vision-is-design-intent',
    term: 'Everything on the Vision page is design intent',
    // "RWLY does not exist" leads this sentence rather than trailing it — that ordering is the
    // corpus's own, not a stylistic choice this port made: it is what keeps this row's "RWLY"
    // inside the 160-character qualifier window the site-next claims suite checks (apps/site's
    // hand-written markup carries no CSS-module class attributes, so the same two sentences sit
    // measurably closer together there; matching its exact word order is what carries that margin
    // across).
    body:
      'RWLY does not exist, and neither is the rest of the Vision page built: no stRWLY, no staking, no hourly epoch, no keeper, no treasury, no buyback and no stock index. What is on chain is seven contracts and no vault. Design intent is not a commitment, a schedule, or a promise that any of it ships in that shape or at all.',
  },
  {
    key: 'token-economics-not-live',
    term: 'The token economics are not live',
    body:
      'RWLY does not exist. No token is staked, nothing votes by token, and no fee reaches any holder. Governance, FeeEngine and VaultCore contain no reference to any such token, so nothing on chain enforces any of it.',
  },
  {
    key: 'treasury-buyback-not-live',
    term: 'The treasury and the buyback are not live',
    body:
      'There is no treasury, no protocol-owned liquidity and no buyback. The 10% performance fee that does exist accrues to an operator address and is claimed by that address; a fee reaching a treasury or a token holder is designed, not built.',
  },
  {
    key: 'stock-index-needs-different-oracle',
    term: 'The stock index needs a different oracle',
    body:
      'The deployed oracle prices two assets and the factory&rsquo;s oracle allowlist is fixed in its constructor with no add, no remove and no owner. The Robinhood equity feeds publish on market days, and a weekend silence measured at 52 hours exceeds the oracle&rsquo;s 86,400-second ceiling &mdash; so on the design deployed today an all-stocks index would freeze every weekend. That is unsolved design work, not a parameter.',
  },
];

export function RisksScopeAdditions(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="scope-additions-heading">
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h2 id="scope-additions-heading" className={s.heading}>
          {HEADING}
        </h2>

        <dl className={s.rows}>
          {ROWS.map((row) => (
            <div key={row.key} className={s.row}>
              <dt className={s.term}>{row.term}</dt>
              <Pinned as="dd" className={s.body} html={row.body} />
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export default RisksScopeAdditions;
