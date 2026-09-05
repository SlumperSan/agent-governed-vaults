/**
 * faq-questions — the fourteen answers on faq.html.
 *
 * ---------------------------------------------------------------------------
 * 2026-09-05 CORPUS SYNC — READ THIS BEFORE TOUCHING A SENTENCE BELOW
 * ---------------------------------------------------------------------------
 * The reviewed source of truth for this page is now the corpus `faq.html`
 * shipped alongside the Robinhood Chain mainnet deployment (grep that file for
 * `<article class="qa">` — there are fourteen, in the order below). It replaced
 * a fifteen-question, testnet-era draft: three questions with no corpus
 * counterpart were dropped (`Has it been security reviewed?`, `Which
 * jurisdictions?`, `What is x402 doing here?`), and every remaining question
 * was re-synced word for word, including four renamed to match the corpus's
 * own phrasing (`Is it running?`, `What happens if the oracle stops
 * answering?`, `When can I get out?`, `Why is the cap 50,000 USDG?`).
 *
 * WHY THE FOOTER-QUOTING BLOCKS ARE GONE. The two answers that used to carry a
 * second, counted copy of a footer standing-fact sentence — the no-token
 * paragraph and the opening of the licence answer — no longer quote either
 * sentence verbatim. The corpus now points a reader at the Disclaimers page
 * for "the standing form of that answer" / "the exact standing sentence"
 * instead of repeating it. That is a deliberate upstream change, not an
 * oversight this file should compensate for: `FOOTER_TOKEN` and
 * `FOOTER_LICENCE` are no longer imported or rendered here, and faq.html now
 * carries each of those two footer sentences exactly ONCE (in the footer),
 * not twice. Whoever owns the per-page sentence-count constant needs to move
 * faq.html from 2 to 1 for both.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe or an entity reaches `dist/faq.html` wrong for a guard matching
 * the raw file. Every answer below still goes through `<Pinned as="p"
 * html={…} />` for that reason and because several carry inline `<a>` or
 * `<code>` markup — see src/shell/PinnedText.tsx.
 *
 * WHAT STILL TRAVELS FROM src/shell/pinned.ts. Of the shared constants this
 * file used to import, only `EXIT_FEE_CORRECTION` survives the sync: the
 * corpus's second paragraph of `What does the operator earn…` is
 * byte-identical to that constant. `BANNER_STATUS`, `HIGH_WATER_MARK_RESET`,
 * `MODE_F_TRIGGER`, `SECURITY_REVIEW_ATTESTATION`, `FOOTER_TOKEN` and
 * `FOOTER_LICENCE` are no longer used on this page — the corpus rewrote or
 * dropped every passage that used to carry them here. That does not mean
 * those constants are wrong for the surfaces that still use them; it means
 * this page no longer quotes those particular sentences.
 *
 * EVERY `href="risks.html"` ON THIS PAGE BECAME `href="disclaimers.html"`.
 * risks.html no longer exists as a page; the corpus's cross-references to the
 * risk register now point at the Disclaimers page instead, several with a
 * `#rN` fragment carried over unchanged (e.g. `disclaimers.html#r2`,
 * `disclaimers.html#r13`).
 *
 * A reviewer changing any answer below changes it in the corpus faq.html
 * first, and in every other page that carries the same passage, not here.
 */
import { EXIT_FEE_CORRECTION } from '../../shell/pinned';

/**
 * One node of an answer, in document order.
 *
 * `pin` marks a paragraph that is a footer-counted standing-fact sentence and
 * nothing else. Nothing on this page's current answer set sets it — see the
 * corpus-sync note above — but the flag stays on the type in case a future
 * sync reintroduces a counted quote, so `QA.tsx`'s styling hook does not need
 * to change shape twice.
 */
export type Block = { readonly kind: 'p'; readonly html: string; readonly pin?: true };

export type QaEntry = {
  /** The question, as the corpus words it. Rendered as the `<h2>`. */
  readonly question: string;
  /** A stable slug for the article's `id`. Not published prose. */
  readonly id: string;
  readonly blocks: readonly Block[];
};

export const ENTRIES: readonly QaEntry[] = [
  {
    question: 'Is there a token?',
    id: 'token',
    blocks: [
      {
        kind: 'p',
        html: `No. There is nothing to buy and nothing to claim. The next iteration, RWLY, is designed to accrue the protocol&rsquo;s fees into official Robinhood Stock Tokens &mdash; and RWLY does not exist yet.`,
      },
      {
        kind: 'p',
        html: `The standing form of that answer is on the <a href="disclaimers.html">Disclaimers</a>.`,
      },
    ],
  },

  {
    question: 'Is it running?',
    id: 'running',
    blocks: [
      {
        kind: 'p',
        html: `Yes. The protocol is on Robinhood Chain mainnet, chain id 4663, broadcast on 2026-09-05 from <code>protocol/main</code> at <code>b1cde122</code>.`,
      },
      {
        kind: 'p',
        html: `Every address is on the <a href="status.html">status page</a> and in the committed deployment record, <code>contracts/config/deployments/robinhood-mainnet.json</code>. Anyone showing you an address that is not in that record is not showing you this protocol.`,
      },
    ],
  },

  {
    question: 'Can you rug me?',
    id: 'rug',
    blocks: [
      // The enumerated operator sentence, in the form this page carries it. The
      // list after "no authority" is what makes it true; compressing it into a
      // universal is the single most likely claims violation on this site.
      {
        kind: 'p',
        html: `Not through the contracts. They are non-custodial, with no seize function, no privileged withdrawal and no admin key. Operatorship confers no authority to vote, execute, pause, reprice, or move member funds. Its one power beyond proposing and voting like any member of equal stake is economic: the operator identity receives the 10% performance fee, which no other member does.`,
      },
      {
        kind: 'p',
        html: `You can still lose money. The <a href="disclaimers.html">Disclaimers</a> set out how.`,
      },
    ],
  },

  {
    question: 'Can you pause it?',
    id: 'pause',
    blocks: [
      {
        kind: 'p',
        html: `No. The contracts carry no pause function, no proxy and no upgrade path. Nobody can stop a vault. Not the operator. Not the members. Not the people who wrote it. The only thing that halts a vault is the oracle staleness breaker, and that is a property of the code rather than a switch anyone holds.`,
      },
    ],
  },

  {
    question: 'What happens if the oracle stops answering?',
    id: 'oracle',
    blocks: [
      {
        kind: 'p',
        html: `Every function that reads NAV reverts: deposits, rebalance execution and redemptions. Capital still sitting in an un-activated observation window stays reclaimable, because cancelling a pending deposit reads no oracle.`,
      },
      {
        kind: 'p',
        html: `What that means for capital already in shares is in the <a href="disclaimers.html#r2">Disclaimers</a>.`,
      },
    ],
  },

  {
    question: 'When can I get out?',
    id: 'exit',
    blocks: [
      {
        kind: 'p',
        html: `Instantly, unless a live proposal has reached its reveal phase. From that moment until the proposal executes, is defeated, or its execution window lapses, the request is queued and settles at post-execution NAV. <code>Governance.hasPendingExecution(vault)</code> is the exact predicate.`,
      },
      {
        kind: 'p',
        html: `The cases where you cannot get out at all are in the <a href="disclaimers.html">Disclaimers</a>.`,
      },
    ],
  },

  {
    question: 'What does the operator earn, and what do they have to lock?',
    id: 'operator-earn',
    blocks: [
      {
        kind: 'p',
        html: `They earn 10% of realized profit, crystallized when a member redeems, never accrued on paper gains, and subject to a high-water mark kept per member and per operator that follows that operator identity across vaults. There is no management fee.`,
      },
      // Byte-identical to the corpus's second paragraph — imported rather than
      // retyped. See EXIT_FEE_CORRECTION in src/shell/pinned.ts.
      { kind: 'p', html: EXIT_FEE_CORRECTION },
      {
        kind: 'p',
        html: `They lock capital. The creator withdrawal gate is 5% of the vault's share supply: a creator's redemption reverts if it would take their share below 5% while at least one non-creator member remains. The figure moves with the vault, and none has been created yet. Separately, the proposal threshold decays passively as others deposit, and losing it means losing the right to propose anything. That threshold is 5% of voting-eligible stake in the reference configuration. The full breakdown is on the <a href="operators.html">operators page</a>.`,
      },
    ],
  },

  {
    // REPOINTED 2026-09-05, copy deck v2. Owner: "I haven't created the safe
    // vault yet. I want the pivot to the all-stocks index." The whole
    // question was about a planned 50,000 USDG pilot vault that will not be
    // created, so it is replaced rather than edited. Carried verbatim from
    // the question that opens `apps/site/faq.html`'s "What can the contracts
    // on chain today actually hold?" answer.
    question: 'What can the contracts on chain today actually hold?',
    id: 'what-it-can-hold',
    blocks: [
      {
        kind: 'p',
        html: `Two assets. The oracle prices ETH and BTC, held as WETH and cbBTC.`,
      },
      {
        kind: 'p',
        html: `The factory's oracle allowlist is fixed in its constructor with no add, no remove and no owner, so that set cannot be extended on this deployment.`,
      },
      {
        kind: 'p',
        html: `The all-stocks index needs its own deployment. What it is designed to be is on the <a href="vision.html">Vision page</a>.`,
      },
    ],
  },

  {
    question: 'Can I fork it? What licence is the code under?',
    id: 'licence',
    blocks: [
      {
        kind: 'p',
        html: `The licence is BUSL-1.1, and the exact standing sentence for it is on the <a href="disclaimers.html">Disclaimers</a>. You can read every line, and you should. You cannot treat it as freely reusable, and the licence terms in the repository govern what you may do with it. That restriction is on the source, not on the chain: a vault on Robinhood Chain has no admin key and no setters, so no one can gate or revoke anyone's access to it once it exists.`,
      },
      {
        kind: 'p',
        html: `There is an open licensing question about vendored third-party mathematics in the tree; it is set out on the <a href="disclaimers.html#r13">Disclaimers</a>.`,
      },
    ],
  },

  {
    question: 'What if I disagree with a rebalance?',
    id: 'disagree',
    blocks: [
      {
        kind: 'p',
        html: `Vote against it. Voting is commit then reveal: you submit a hash of your vote and a salt, then reveal it after the commit deadline. An unrevealed commit is forfeit and counts as an abstain, so committing is not enough. You have to come back.`,
      },
      {
        kind: 'p',
        html: `What is on-chain when a proposal opens is a 32-byte hash of the intended action, not the action. The swap target, amounts and route appear only in the execution transaction: after the vote, after finalization, after the timelock. That is deliberate: publishing the route up front would let anyone front-run the rebalance. The cost is that you vote on a commitment rather than a description. Any explanation an operator publishes is off-chain, and the contracts never check it against what finally executes.`,
      },
      {
        kind: 'p',
        html: `If it passes anyway, your options are to stay or to leave, and leaving during that window means a forward-settled exit that prices after the swap. There is no way to opt out of an executed rebalance while remaining in the vault.`,
      },
    ],
  },

  {
    question: 'What happens if everyone leaves?',
    id: 'everyone-leaves',
    blocks: [
      {
        kind: 'p',
        html: `The vault empties out in order. Redemption is pro-rata and in kind, so each member takes their share of every basket asset plus their share of the idle USDG. In kind means tokens, not dollars: you receive the ETH and BTC the vault holds, as the wrapped ERC-20s the <a href="status.html">status page</a> names by address, and converting them back is your transaction, your routing and your cost. The exit fee decays with tenure and is waived entirely for the last member out, so the final redeemer is not penalised for turning the lights off.`,
      },
      {
        kind: 'p',
        html: `The creator's withdrawal gate binds only while at least one non-creator member remains; once they are gone, the creator can redeem in full. While members remain it binds hard: a creator diluted below 5% has every redemption revert, not merely the part below the line. Nothing lingers, and there is no residual claim on an empty vault.`,
      },
    ],
  },

  {
    question: 'Am I an investor?',
    id: 'investor',
    blocks: [
      // "stake-weighted" is qualified in the same breath — it is true only at
      // five or more members.
      {
        kind: 'p',
        html: `Mechanically, you hold shares in a vault whose rules you govern by on-chain vote, alongside other members. That vote is stake-weighted at five or more members, and follows a signer-count-plus-stake rule below five. The operator can open a proposal and vote the weight of its own stake. Nothing executes without a member vote.`,
      },
      {
        kind: 'p',
        html: `Whether that makes you an investor where you live is a legal question. The <a href="disclaimers.html">Disclaimers</a> say what is known and what is not.`,
      },
    ],
  },

  {
    question: 'How do I get in?',
    id: 'get-in',
    blocks: [
      {
        kind: 'p',
        html: `Deposit USDG into a vault. There is no list to join, no allocation to claim and no priority to earn. The contracts gate on amount alone and screen nobody.`,
      },
      {
        kind: 'p',
        html: `There is no form on this site and no wallet connection on this site. If someone offers you a place in a queue for this protocol, they are not connected to it.`,
      },
    ],
  },

  {
    question: 'Is this ERC-4626?',
    id: 'erc4626',
    blocks: [
      {
        kind: 'p',
        html: `No, and it makes no ERC-4626 claim. It exposes 4626-shaped read-only views for convenience. Treat them as indicative only, and do not integrate against them expecting the standard's semantics to hold.`,
      },
    ],
  },
];
