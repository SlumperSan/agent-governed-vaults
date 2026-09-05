/**
 * ops-hero — the hero of operators.html, and that page's one <h1>.
 *
 * ---------------------------------------------------------------------------
 * COPY PROVENANCE
 * ---------------------------------------------------------------------------
 * All four strings are the bytes of the `.hero--plain` block of
 * `apps/site/operators.html`, extracted from that file rather than retyped —
 * retyping is how a straight apostrophe becomes a curly one and an em-dash
 * becomes an en-dash, neither of which is visible in review. Nothing here was
 * rewritten, tightened or re-punctuated, and no sentence was composed for this
 * build.
 *
 * ---------------------------------------------------------------------------
 * THE CLAUSE THAT MUST STAY AN ENUMERATION — READ BEFORE EDITING THE LEDE
 * ---------------------------------------------------------------------------
 * The lede's last sentence enumerates the specific verbs operatorship does not
 * confer, beyond acting as a member of equal stake. That enumeration is the
 * whole reason the sentence is true and is CLAUDE.md's own approved form for
 * this claim. A blanket negative about what the operator holds on-chain is
 * falsifiable in one transaction: FeeEngine.sol:104 credits
 * `claimableFees[registry.operatorAddressOf(opId)][token]`, so the operator
 * address does hold one real unilateral on-chain right that no other member
 * has. That is the exact shape guard 6 of
 * scripts/test/claims-lede-truth.test.mjs exists to catch, and CLAUDE.md notes
 * that the guard reds a file even when it quotes the wide form only to
 * prohibit it — so do not summarise this sentence, even briefly, to see
 * whether the guard still catches the summary. Enumerations pass; summaries
 * and universals do not. Leave the list of verbs whole.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LEDE ASSERTS, AND WHERE EACH PART IS CHECKABLE
 * ---------------------------------------------------------------------------
 *   - "proposes rebalances … propose, and vote its own weight":
 *     contracts/src/Governance.sol:286 `propose(address vault, ProposalType
 *     ptype, bytes32 actionHash)` carries no operator check. It gates on stake
 *     alone — :304 `require(own > 0, NoWeight())`, then :306
 *     `require(own * BPS >= uint256(cfg.proposalThresholdBps) * total, …)`.
 *     An operator holding no shares may not propose; a member over the
 *     threshold may.
 *   - "no authority to vote, execute, pause, reprice, or move member funds":
 *     a grep over contracts/src for `function pause`, `_authorizeUpgrade`,
 *     `UUPS` and `Ownable` returns nothing at all, so there is no address —
 *     operator or otherwise — that can pause or upgrade anything. "Vote" and
 *     "execute" are the same stake-gated, no-operator-check paths cited above
 *     for propose; "move member funds" has no function anywhere in the file.
 *     The sentence is about every address rather than about the operator
 *     specifically, which is the point of stating it beyond the "member of
 *     equal stake" clause that precedes it.
 *
 * This section states no figure, so there is no number to cite to a line.
 * The page's numbers are quantified in ops-obligation against the reference
 * configuration.
 *
 * ---------------------------------------------------------------------------
 * ESCAPING — CHECKED PER STRING, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * `renderToString` escapes `'`, `&`, `<`, `>` and `"` in text children, and a
 * guard doing `html.includes(SENTENCE)` against the raw file fails on an
 * escaped apostrophe that looks perfect in a browser.
 *
 * ---------------------------------------------------------------------------
 * NO CANVAS, AND THAT IS THE SPEC RATHER THAN A SHORTFALL
 * ---------------------------------------------------------------------------
 * The one WebGL field on the site belongs to index-hero. Two reasons, and both
 * bite here if ignored: a field on this page would have nothing true to render
 * — this page reads no chain, so there is no state to draw and anything drawn
 * would be invented rather than fetched; and the six deep pages must not carry
 * a three.js chunk for a page whose whole job is to be read.
 *
 * MOTION. Opacity and an eight-pixel rise, 0.6s on the shared enter curve,
 * staggered 80ms, expressed entirely in OpsHero.module.css with an explicit
 * reduced-motion branch. Not <Reveal>: that primitive returns early for
 * anything already on screen, which a hero always is. See the stylesheet header.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import s from './OpsHero.module.css';

/* --- copy, verbatim from the .hero--plain block of apps/site/operators.html - */

const EYEBROW = 'Operators';

const TITLE = 'Low capital cost. Not no capital cost.';

/**
 * HTML source bytes. Held this way per the section's byte-rendering rule; the
 * current sentence happens to contain no apostrophe, ampersand or em-dash, but
 * the next edit might reintroduce one, and Pinned costs nothing to keep.
 */
const LEDE =
  'An operator is the agent identity that proposes rebalances. It is the smallest set of powers that still lets an agent be useful: propose, and vote its own weight. Beyond acting as a member of equal stake, operatorship confers no authority to vote, execute, pause, reprice, or move member funds.';

/**
 * The standing deployment-status qualifier. It travels: index-hero carries the
 * identical sentence, and risks r1 carried it as the tail of a longer body
 * before risks.html was retired in favour of disclaimers.html. There is no
 * constant for it in src/shell/pinned.ts, and Shell owns that file, so this
 * section holds its own reviewed bytes. Raised as a Shell request: this
 * sentence wants one exported constant, the same request hiw-pricing raised for
 * the oracle-freeze passage, or the surfaces carrying it will drift apart on
 * the first edit to any one of them.
 *
 * UNPAIRED WITH THE CURRENT CORPUS. `apps/site/operators.html`'s hero is now
 * eyebrow + h1 + lede and nothing else — this qualifier has no corpus block to
 * map onto. Left in place per the rule for redesign-only content: nothing here
 * contradicts the corpus, so nothing is deleted on an inference.
 */
const LEDE_NOTE =
  'This describes source code. Nothing is deployed to mainnet, and the current testnet deployment carries no value.';

export function OpsHero(): JSX.Element {
  // A <div> rather than a <section>, matching hiw-hero. A section is a landmark
  // and a landmark wants an accessible name, which would be either an
  // aria-label — a string that exists nowhere in the reviewed source — or the
  // <h1>, which already names the page through <main>. Neither is worth a new
  // string on a page whose copy rule is that nothing is invented.
  return (
    <div className={s.hero}>
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h1 className={s.title}>{TITLE}</h1>
        <Pinned as="p" className={s.lede} html={LEDE} />
        <p className={s.note}>{LEDE_NOTE}</p>
      </div>
    </div>
  );
}

export default OpsHero;
