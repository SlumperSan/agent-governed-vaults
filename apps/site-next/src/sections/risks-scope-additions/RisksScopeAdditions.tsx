/**
 * risks-scope-additions — the four new caveats copy deck v2 adds to
 * disclaimers.html's "The limits of every claim on this site" section, and the
 * "Four groups this is wrong for" grid that closes the same corpus section.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 * `apps/site/disclaimers.html` carries a section headed "The limits of every
 * claim on this site" (eyebrow) / "What the other eight pages leave out."
 * (h2): a seventeen-entry `<dl>` restating a caveat from each of the other
 * pages, followed by a "Four groups this is wrong for" grid.
 * `risks-verify/RisksVerify.tsx` recorded, as of the 2026-09-05 site-next
 * port, that this whole block had NO redesign counterpart: "Per the build
 * brief, no new component is invented for it here; it is reported as a
 * corpus-only block with no redesign counterpart." That decision is only
 * half-reopened here: the THIRTEEN pre-existing `<dl>` rows still have no home
 * in this build and this round does not give them one.
 *
 * THE "FOUR GROUPS" GRID NOW DOES HAVE A HOME, and it is this section, in the
 * document position the corpus puts it in, after the `<dl>`, inside the same
 * `<section>`, under an `<h3>`. It did not arrive from nowhere: this build
 * rendered the identical four entries on who-its-for.html, as a section headed
 * `Not for you if` / `Four groups this is explicitly wrong for at launch.`,
 * which is the shape `apps/site/who-its-for.html` carried until PR #220
 * (`2faed164`) deleted it there and put the four groups here under the shorter
 * corpus heading below. Round 8 completes that migration rather than starting
 * one: two strings the corpus had already retired go with it, and the eight
 * that remain, four titles and four bodies, are byte-identical to
 * `apps/site/disclaimers.html`. See `groups.ts` for the provenance of each and
 * for why who-its-for.html needs no new pointer sentence.
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
import {
  CARD_1_BODY,
  CARD_1_TITLE,
  CARD_2_BODY,
  CARD_2_TITLE,
  CARD_3_BODY,
  CARD_3_TITLE,
  CARD_4_BODY,
  CARD_4_TITLE,
} from './groups';
import s from './RisksScopeAdditions.module.css';

const EYEBROW = 'The limits of every claim on this site';

const HEADING = 'What the other eight pages leave out.';

/**
 * The corpus's own <h3>, byte for byte from `apps/site/disclaimers.html`.
 * Shorter than the `Four groups this is explicitly wrong for at launch.` this
 * build printed on who-its-for.html, because PR #220 shortened it when it moved
 * the block; the corpus wording is the current one and this is now the site's
 * only copy of either.
 */
const GROUPS_HEADING = 'Four groups this is wrong for';

const GROUPS: ReadonlyArray<{ title: string; body: string }> = [
  { title: CARD_1_TITLE, body: CARD_1_BODY },
  { title: CARD_2_TITLE, body: CARD_2_BODY },
  { title: CARD_3_TITLE, body: CARD_3_BODY },
  { title: CARD_4_TITLE, body: CARD_4_BODY },
];

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

        {/* An h3 under this section's own h2, and an h4 per entry: the corpus's
            heading levels, and the reason this block is not a section of its
            own. It closes the same run of disclosures the dl above opens. */}
        <h3 className={s.groupsHeading}>{GROUPS_HEADING}</h3>
        <div className={s.groups}>
          {GROUPS.map((group) => (
            <div className={s.entry} key={group.title}>
              <h4 className={s.entryTitle}>{group.title}</h4>
              {/* CARD_4_BODY carries the exempted good-faith clause and the
                  jurisdiction sentence, from one string. */}
              <Pinned as="p" className={s.entryBody} html={group.body} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default RisksScopeAdditions;
