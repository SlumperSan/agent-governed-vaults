/**
 * FactStrip — three verifiable facts, each linking to the thing that proves it.
 *
 * IT SAT IN THE HERO UNTIL 2026-09-05, round 8. It moved here, under the two
 * cards, so the doors could stand inside the first viewport at 1440x900: the
 * strip was 139px of the 620px that had to come out of the fold, and it is the
 * one block above the doors with no counterpart in `apps/site`: three
 * shortened restatements of sentences published elsewhere on the site, rather
 * than deck copy. Nothing about it changed but its position and the stylesheet
 * it reads from. Under the doors it still does the job the comment below
 * describes: it is the row a reference layout fills with partner logos, and it
 * now reads as the proof under the two cards instead of as a fourth block to
 * get past before reaching them.
 *
 * WHAT THIS REPLACES. The reference layout puts a row of partner logos here.
 * We have no partners, and inventing one is the cheapest possible way to make
 * this page a lie, so the row carries facts instead — each one a sentence
 * already published on this site, each one shortened rather than rewritten, and
 * each one pointing at where a reader checks it.
 *
 * WHERE EACH LINE CAME FROM, and what was cut:
 *
 *   1. VERBATIM from the "Cannot be paused or upgraded" card on
 *      apps/site/index.html. Not one character changed. The leading `As
 *      written,` is the load-bearing part: the bare form — "the contracts are
 *      immutable" — is a claim about deployed bytecode, and nothing is
 *      deployed.
 *
 *   2. ADAPTED from the meta description of apps/site/index.html:
 *        before  Members deposit USDG into a shared vault holding a spot
 *                basket of ETH and BTC, and ratify every rebalance by
 *                on-chain vote.
 *        after   Members pool USDG and ratify every rebalance by on-chain vote.
 *      `Members`, never `agents`: the claims guard reds any sentence that puts
 *      an agent within a few words of pool / govern / manage / trade, and it
 *      is right to — members pool and vote, an operator proposes.
 *
 *   3. ADAPTED from the Source column of the footer on every page:
 *        before  It is public, including every review round.
 *        after   The repository is public, including every review round.
 *      The pronoun is resolved because this line stands alone. Nothing else
 *      moved.
 *
 * WHAT MAY NEVER GO HERE. Neither of the two counted footer sentences — the
 * licence characterisation, or the no-token statement — however well either
 * would fit. Each is permitted exactly once per page, and the scrubber removes
 * only that permitted count before the absence checks run. A second copy in
 * this strip would therefore leave the three words those two sentences are the
 * only licensed home for exposed to the banned-outside-the-footer check, with
 * no exemption left to cover them. Those words are enumerated in the guard and
 * are deliberately not repeated here.
 *
 * The source labels are existing navigation strings, not new copy: `Risks` and
 * `How it works` are the masthead's own labels, and `Source and docs` is the
 * action label the current hero already uses.
 */
import type { JSX } from 'react';
import { REPO_URL } from '../../shell/pinned';
import s from './IndexDoors.module.css';

type Fact = {
  /** The sentence. Shortened from an existing one; never composed. */
  text: string;
  /** Where a reader checks it. */
  href: string;
  /** An existing navigation or action label for that destination. */
  source: string;
};

const FACTS: readonly Fact[] = [
  {
    text: 'As written, the contracts contain no proxy, no upgrade path, no pause function and no admin key.',
    // r1 is the immutability entry of the fifteen-entry register, now on disclaimers.html.
    href: 'disclaimers.html#r1',
    source: 'Disclaimers',
  },
  {
    text: 'Members pool USDG and ratify every rebalance by on-chain vote.',
    href: 'how-it-works.html',
    source: 'How it works',
  },
  {
    text: 'The repository is public, including every review round.',
    href: REPO_URL,
    source: 'Source and docs',
  },
];

export function FactStrip(): JSX.Element {
  return (
    <ul className={s.facts}>
      {FACTS.map((fact) => (
        <li className={s.fact} key={fact.href}>
          <a className={s.factLink} href={fact.href}>
            <span className={s.factText}>{fact.text}</span>
            <span className={s.factSource}>{fact.source}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
