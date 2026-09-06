/**
 * risks-scope-additions: disclaimers.html's "The limits of every claim on this
 * site" section: the twenty-two-entry caveat list, and the "Four groups this is
 * wrong for" grid that closes it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * `apps/site/disclaimers.html` carries a section headed "The limits of every
 * claim on this site" (eyebrow) / "What the other eight pages leave out." (h2):
 * an intro sentence, a twenty-two-entry `<dl>` restating a caveat from each of
 * the other pages, and then a "Four groups this is wrong for" grid. This
 * section is that whole block, in that document position, with those heading
 * levels.
 *
 * IT WAS NOT ALWAYS. Until 2026-09-05 the redesign carried only the four rows
 * copy deck v2 had added, and reported the other eighteen as corpus-only with
 * no redesign counterpart. A claims review of the redesign found that eighteen
 * headings the corpus discloses were absent here, five of them with no
 * counterpart anywhere in the nine built pages, and three of them because the
 * home page was still carrying their content. All eighteen are ported now, from
 * `apps/site/disclaimers.html`, verbatim and in the corpus's order. See the
 * comment on ROWS below for the five and the three by name.
 *
 * THE "FOUR GROUPS" GRID arrived here in round 8, in the document position the
 * corpus puts it in: after the `<dl>`, inside the same `<section>`, under an
 * `<h3>`. It did not arrive from nowhere: this build rendered the identical
 * four entries on who-its-for.html, as a section headed `Not for you if` /
 * `Four groups this is explicitly wrong for at launch.`, which is the shape
 * `apps/site/who-its-for.html` carried until PR #220 (`2faed164`) deleted it
 * there and put the four groups here under the shorter corpus heading below.
 * See `groups.ts` for the provenance of each and for why who-its-for.html needs
 * no new pointer sentence.
 *
 * DOCUMENT POSITION matches the corpus: after the register and the
 * security-review status block, before "How to check every claim on this
 * page." — see DisclaimersPage.tsx.
 *
 * SOURCE. Every string is carried byte-for-byte from
 * `apps/site/disclaimers.html` (grep any `<dt>` below), the reviewed source of
 * truth.
 *
 * THREE ROWS NOW DIVERGE FROM THAT SOURCE, DELIBERATELY, AND THIS IS THE
 * RECORD. `vision-is-design-intent`, `token-economics-not-live` and
 * `treasury-buyback-not-live` were carried across saying that RWLY does not
 * exist and that no fee mechanism does either. RWLY was created at
 * 2026-09-05T21:51:57Z and the launchpad's curve charges a creator tax that
 * reaches a multisig this project controls, so all three said something false
 * the moment that block was mined. They are corrected here rather than left
 * matching a corpus that has not been through its own flip yet; each carries a
 * note at the row saying what changed. When `apps/site` is flipped, the
 * byte-for-byte rule reasserts itself and these three should be re-checked
 * against it rather than assumed still equal.
 *
 * WHY EVERY BODY GOES THROUGH <Pinned>. `renderToString` escapes text children,
 * so `the factory's oracle allowlist` would reach the built page as
 * `the factory&#x27;s oracle allowlist`, and several bodies additionally carry
 * markup the corpus renders: `<strong>`, `<code>` and two `<a href="#r..">`
 * links into the register above. All of them are rendered as HTML source bytes
 * for that reason, even the ones that carry neither today.
 *
 * NO MOTION, matching risks-verify: the brief's shape for a static disclosures
 * list. No `Reveal`, no effect, no `useReducedMotion` call.
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
 * The section's intro sentence, byte-for-byte from `apps/site/disclaimers.html`
 * (grep `Each entry below was lifted`). It is the sentence that tells a reader
 * why twenty-two caveats are in one list rather than one per page, so it lands
 * with them rather than after them.
 */
const LEDE =
  'Each entry below was lifted from the page it used to sit on, so that a reader who wants the caveats finds all of them together instead of one per page.';

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
 * THE CORPUS'S FULL TWENTY-TWO-ENTRY LIST, in the corpus's own order: the
 * eighteen entries lifted from the pages they used to sit on, then the four
 * rows copy deck v2 adds. Every `term` and every `body` below is byte-identical
 * to `apps/site/disclaimers.html`, grep any `<dt>` string in that file, and
 * the order here is that file's order, top to bottom.
 *
 * THE EIGHTEEN WERE PORTED ON 2026-09-05, and five of them had no counterpart
 * anywhere in this build before that: `Execution can be sandwiched`,
 * `The cash-redemption path is not built`,
 * `You carry the execution you voted against`,
 * `Whether you can always get out` and
 * `Two mechanisms, neither of which warns you`. The last two bear directly on
 * whether and when a member can leave, so the build was disclosing less than
 * the corpus on the question a reader most needs answered. Three more
 * (`Immutability, read the other way`, `An index of conviction is not a
 * forecast`, `Three ways this loses your money`) were on the home page instead;
 * they were deleted there in the same change, because the owner's 2026-09-05
 * decision puts every caveat on this page and only on this page. See
 * src/pages/IndexPage.tsx, index-why/IndexWhy.tsx and
 * index-immutability/copy.ts.
 *
 * TWO ROWS LINK INTO THE REGISTER ABOVE, at `#r13` and `#r15`. Those ids are
 * rendered by risks-register on this same page; the anchors are the corpus's
 * and are carried rather than composed.
 *
 * DO NOT SHORTEN, RE-PUNCTUATE OR RE-ORDER THESE. They are the site's only
 * statement of each caveat, and a shortened caveat is a weakened one.
 */
const ROWS: ReadonlyArray<{ key: string; term: string; body: string }> = [
  {
    key: 'immutability-read-the-other-way',
    term: 'Immutability, read the other way',
    body:
      'Every immutability claim is also a limitation. A unanimity requirement means one permanently offline member freezes the rules forever. No pause means no circuit breaker if something is wrong. No upgrade means a critical bug that survived review is permanent, and funds may be unrecoverable. Those are not features and this site will not present them as features.',
  },
  {
    key: 'an-index-of-conviction-is',
    term: 'An index of conviction is not a forecast',
    body:
      'An index of agent conviction is not a claim that the conviction is correct, and none of this is a reason to expect any particular outcome. A public record of what was proposed and funded is exactly that, and nothing more. Read it as evidence about what agents proposed, never as a forecast.',
  },
  {
    key: 'three-ways-this-loses-your',
    term: 'Three ways this loses your money',
    body:
      '<strong>A permanent bug.</strong> Nothing can be patched. An external security review whose report is held privately, with no public report to check it against, and four internal adversarial rounds are not proof of correctness. An AI pre-audit of a tree that had already passed internal review still found five Critical issues, and every fix required a full redeploy because nothing can be edited in place. <strong>An oracle freeze.</strong> If a price feed goes stale, every function that reads NAV reverts, exits included, and active capital stays in the vault for as long as the feed is stale. <strong>A USDG depeg.</strong> The oracle pins the settlement token at $1.00, with no median and no second source to outvote the pin, so a sustained depeg is mispriced by exactly the size of the depeg.',
  },
  {
    key: 'why-mode-f-exists-and',
    term: 'Why Mode F exists, and what it costs you',
    body:
      'Without it, anyone watching the outcome form during the reveal phase could exit at pre-rebalance prices while already knowing it. That is a free option, paid for by everyone who stayed. Closing it has a price you pay directly: you can be right about disliking a rebalance and still carry its execution. There is no cap on how often the window recurs, and a member holding a single minimum deposit can re-open proposals to hold exits in this mode roughly half the time, indefinitely, for the cost of gas. That recurrence is a known, accepted, unmitigated finding (M-7): the proposal cooldown is keyed per proposer and a second address sidesteps it. If the proposal is defeated or its execution window lapses without execution, <code>settleQueuedExit</code> has to be called, and anyone can call it.',
  },
  {
    key: 'your-exit-has-no-floor',
    term: 'Your exit has no floor',
    body:
      '<code>requestExit</code> takes no minimum-value parameter. Your exit is an unbounded market order against whatever NAV settlement produces; there is no transaction-level floor you can set. One was deliberately dropped for contract-size reasons. The operator\'s rebalance swaps do carry a minimum-out bound. Your principal does not.',
  },
  {
    key: 'what-stands-behind-the-three',
    term: 'What stands behind the three oracle guards',
    body:
      'Nothing. The heartbeat and the band are the only defences that run at price time on Robinhood Chain, and the sequencer gate joins them only where Chainlink publishes an uptime feed to wire. There is one price provider, no second provider and no fallback. A feed deprecation or freeze fails that asset closed &mdash; the vault stops rather than guesses. But there is no backup to switch to, and no way to point the vault at a different one. There is also no escape hatch from the staleness breaker and none will be added, because an escape hatch is exactly the stale-price exit the breaker exists to prevent.',
  },
  {
    key: 'the-high-water-mark-can',
    term: 'The high-water mark can be reset',
    body:
      'Nothing stops an operator abandoning a loss-carrying identity and registering a fresh one, which resets the mark. The only cost is a visibly empty track record on the leaderboard. The enforcement here is reputation, not code.',
  },
  {
    key: 'execution-can-be-sandwiched',
    term: 'Execution can be sandwiched',
    body:
      'Protection against being sandwiched on execution is an off-chain concern for whoever submits the transaction; the contracts do not provide it.',
  },
  {
    key: 'the-cash-redemption-path-is',
    term: 'The cash-redemption path is not built',
    body:
      'A cash-redemption path through the execution adapter is described in the architecture notes and is not built. Redemption in v1 is in kind: you receive the basket tokens, and converting them back is your own transaction, your own routing and your own cost.',
  },
  {
    key: 'sub-vault-findings-are-dormant',
    term: 'Sub-vault findings are dormant, not repaired',
    body:
      'Root-only is not a preference. It is what closes Critical C-1 and a group of High findings; they are dormant, not repaired. If sub-vaults were ever enabled, those findings would return.',
  },
  {
    key: 'skipwindow-forfeits-the-one-exit',
    term: 'skipWindow forfeits the one exit that works during a freeze',
    body:
      'Pending capital is the only capital that stays reclaimable while the oracle is frozen. Opting out of the observation window forfeits that permanently, and the opt-out cannot be undone.',
  },
  {
    key: 'two-mechanisms-neither-of-which',
    term: 'Two mechanisms, neither of which warns you',
    body:
      'Your capital is locked by one mechanism while your proposal rights decay under another, and neither one tells you it is happening. Watch your own share. Anyone telling you an agent can operate one of these vaults without putting capital at risk is describing a different protocol.',
  },
  {
    key: 'there-is-no-key-rotation',
    term: 'There is no key rotation',
    body:
      'A compromised operator identity cannot be rotated, replaced or revoked. The only remedy is to wind the vault down through exits and launch a new one. Choose the payout address as if you can never change it, because you cannot.',
  },
  {
    key: 'you-carry-the-execution-you',
    term: 'You carry the execution you voted against',
    body:
      'You carry the execution you voted against, and a proposal that is ultimately defeated still forced your exit into the queue while it was live.',
  },
  {
    key: 'you-have-to-accept-a',
    term: 'You have to accept a frozen door',
    body:
      'If a price feed goes stale, everything that reads NAV reverts, including your exit. Only capital still inside an un-activated observation window stays reclaimable. If the feed is deprecated or retired rather than merely late, the freeze does not end: a vault\'s oracle address is fixed at construction and cannot be replaced by anyone. That is <a href="#r15">risk 15</a>.',
  },
  {
    key: 'whether-you-can-always-get',
    term: 'Whether you can always get out',
    body:
      'No. Two situations stop you. During an oracle freeze you cannot exit at all, at any price, for as long as the feed stays past its bound, and permanently if it is retired rather than late. And from the moment the reveal phase opens on any live proposal, your request queues in forward settlement mode: irrevocable once submitted, settling at post-execution NAV, so you carry the execution whether you voted for it or not.',
  },
  {
    key: 'which-jurisdictions',
    term: 'Which jurisdictions',
    body:
      'Interests in these vaults may be treated as securities or as collective investment scheme interests in some jurisdictions. Access from restricted jurisdictions is intended to be geofenced at the front end. That is a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone, with or without a front end. None of this site is directed at anyone in a jurisdiction where it would be unlawful.',
  },
  {
    key: 'the-vendored-mathematics-licensing-question',
    term: 'The vendored-mathematics licensing question',
    body:
      'Vendored third-party mathematics in the tree is under GPL-2.0-or-later and MIT terms in a repository whose own licence is MIT. The MIT half now matches the repository; the GPL-2.0-or-later half does not. That is an open licensing question the owner has recorded as open, and it is disclosed here rather than left for you to find. It also stands as <a href="#r13">risk 13</a>.',
  },
  /* --- copy deck v2, 2026-09-05: four rows about the Vision page ---------- */
  {
    key: 'vision-is-design-intent',
    term: 'Everything around the token is design intent',
    // REWRITTEN 2026-09-05, TWICE OVER. The term used to read "Everything on the Vision page is
    // design intent" and vision.html was retired before this build shipped, so it named a page
    // no reader can reach. The body used to open "RWLY does not exist", which the launch that
    // evening made false.
    //
    // THE WORD ORDER IS STILL LOAD-BEARING, for the same reason it was before: this build's
    // markup carries a hashed CSS-module class on most elements, so a qualifier that sits
    // comfortably close in apps/site's hand-written HTML can fall outside the site-next claims
    // suite's window here. The qualifier is no longer "does not exist" but the address, the
    // fixed supply and the phrase "design intent", and all three are pulled to the FRONT of the
    // body so that both this row's "RWLY" and its "stRWLY" carry one inside the window.
    body:
      'RWLY exists, at <code>0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9</code> and with a fixed supply of 1,000,000,000, and nothing else in that design does: no stRWLY, no staking, no hourly epoch, no keeper, no treasury contract, no buyback and no stock index, all of it design intent rather than code. What is on chain is seven contracts, no vault, and a token none of those seven references. Design intent is not a commitment, a schedule, or a promise that any of it ships in that shape or at all.',
  },
  {
    key: 'token-economics-not-live',
    term: 'The token economics are not live',
    body:
      'RWLY exists and its economics are design intent: nothing is staked, nothing votes by token, and no fee reaches any holder. Governance, FeeEngine and VaultCore contain no reference to it, so nothing on chain enforces any of it.',
  },
  {
    key: 'treasury-buyback-not-live',
    term: 'The treasury and the buyback are not live',
    // CORRECTED 2026-09-05. The old body said "There is no treasury, no protocol-owned liquidity
    // and no buyback" and then described one live fee stream. There are two, and the second one
    // is new: the launchpad's own curve charges a creator tax that accrues to a multisig this
    // project controls. A blanket "no fee mechanism exists" is now falsifiable in one
    // transaction, so the row separates the fee stream that exists from the treasury contract
    // that does not, rather than collapsing them into a single reassuring negative.
    body:
      'There is no treasury contract, no protocol-owned liquidity and no buyback; each of those is design intent. Two live fee streams are not that. The 10% performance fee accrues to an operator address and is claimed by that address, and the launchpad curve&rsquo;s 8 basis point creator tax accrues to a multisig this project controls. Neither of them reaches a token holder, and a fee reaching a treasury contract or a holder is designed, not built.',
  },
  {
    key: 'stock-index-needs-different-oracle',
    term: 'The stock index needs a different oracle',
    body:
      'The oracle deployed on Robinhood Chain prices two assets, and the factory&rsquo;s oracle allowlist is fixed in its constructor with no add, no remove and no owner. The Robinhood equity feeds publish on market days, and a weekend silence measured at 52 hours exceeds the oracle&rsquo;s 86,400-second ceiling &mdash; so on the design deployed today an all-stocks index would freeze every weekend. That is unsolved design work, not a parameter.',
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
        <Pinned as="p" className={s.lede} html={LEDE} />

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
