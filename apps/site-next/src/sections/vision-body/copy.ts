/**
 * vision-body — the nine design-intent sections of vision.html, held as HTML
 * source bytes.
 *
 * NEW, copy deck v2 (2026-09-05). Every string below is lifted byte-for-byte
 * from the nine `<section>` blocks of `apps/site/vision.html` that sit between
 * the hero and the close (grep any `<h2>` below), the reviewed source of
 * truth. Nothing here was rewritten, tightened or re-punctuated.
 *
 * THE STATUS CHIP. Every one of the nine sections opens with the exact
 * sentence `Designed, not built. RWLY does not exist yet.` — this is the
 * device `apps/site/test/site.test.mjs`'s RWLY guard uses for this page: a
 * 160-character window over flowing prose cannot be satisfied roughly thirty
 * times without being unreadable, so the page instead requires that every
 * `<section>` mentioning RWLY (and `stRWLY` CONTAINS `RWLY`) also contains
 * this exact chip. `VisionSections.tsx` renders it once per section rather
 * than storing it nine times here — see the `RWLY_CHIP` export.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so
 * `the chain's Uniswap` would reach `dist/vision.html` as
 * `the chain&#x27;s Uniswap`. Several bodies below carry an apostrophe or an
 * em-dash; all nine sections' paragraphs are rendered through `<Pinned>`
 * uniformly, so the rule is one rule rather than an exception per string.
 */

/** The exact status chip every section carries. Also exported for the guard note above. */
export const RWLY_CHIP = 'Designed, not built. RWLY does not exist yet.';

export type VisionRow = { readonly dt: string; readonly dd: string };

export type VisionSection = {
  readonly key: string;
  readonly heading: string;
  /** The section's lede paragraph, always present. */
  readonly lede: string;
  /** Body paragraphs after the lede, in document order. */
  readonly paragraphs?: readonly string[];
  /** Zero, one or two `<dl class="rows">` blocks, in document order (section 9 carries two). */
  readonly dlGroups?: readonly (readonly VisionRow[])[];
};

export const SECTIONS: readonly VisionSection[] = [
  {
    key: 'agents-create-indexes',
    heading: 'An agent can create a vault.',
    lede: 'That part is true today: vault creation is permissionless, and the contracts screen nobody.',
    paragraphs: [
      'Each vault is one index &mdash; one basket, one set of rules, frozen when it is funded.',
      'Vault 1 is designed to be the overall index: not a strategy, but the whole market.',
    ],
  },
  {
    key: 'every-stock-a-feed-can-price',
    heading: 'Every stock a feed can price.',
    lede: 'Vault 1 is designed to accumulate the stock tokens on Robinhood Chain that a Chainlink feed prices &mdash; the whole set, gradually, as the feeds appear.',
    paragraphs: [
      'Only feed-priced tokens. A stock token with no Chainlink feed has no oracle-shaped price, and this protocol will not reach for a weaker source.',
      'The equity feeds publish on market days. A weekend of silence measured at 52 hours exceeds the oracle&rsquo;s 86,400-second ceiling, so an all-stocks index needs oracle work that does not exist yet. This is the main reason vault 1 is designed, not deployed.',
    ],
  },
  {
    key: 'the-index-buys-itself',
    heading: 'The index buys itself.',
    lede: 'RWLY is designed to pair with stock tokens on the chain&rsquo;s Uniswap, and the treasury is designed to be the liquidity provider.',
    paragraphs: [
      'The fees those pools generate are designed to flow to the treasury and buy stock into vault 1.',
      'SPY first. Then down the list, highest on-chain trading fees to lowest, as the fees allow.',
      'Protocol-owned liquidity, on the chain&rsquo;s Uniswap.',
    ],
  },
  {
    key: 'one-staked-token-one-vote',
    heading: 'One staked token, one vote.',
    lede: 'RWLY is designed to be the governance token.',
    paragraphs: [
      'Every vote is designed to require staking: RWLY in, stRWLY out, and stRWLY is what votes.',
      'Agents and humans on the same terms &mdash; one staked token, one vote, no separate class.',
      'The contracts deployed on Robinhood Chain weigh votes by vault shares, stake-weighted at five or more members and by a signer-count-plus-stake rule below five, through commit and reveal. Nothing on chain reads a token.',
    ],
  },
  {
    key: 'an-epoch-every-hour',
    heading: 'An epoch every hour.',
    lede: 'One vote per hour, so a person can keep pace with an agent.',
    paragraphs: [
      'When the epoch closes, anyone can execute it. A permissionless keeper call, open to anyone; Rwally runs one too.',
      'The governance deployed on Robinhood Chain runs on a longer clock &mdash; a one-hour commit, a one-hour reveal and a 24-hour execution window in the reference configuration.',
    ],
  },
  {
    key: 'staked-does-not-mean-stuck',
    heading: 'Staked does not mean stuck.',
    lede: 'stRWLY is designed to swap back to RWLY at any time on a bonded curve, and to unstake free after a cooldown for anyone willing to wait.',
    paragraphs: ['Two doors out, priced differently: immediate at a curve price, or slow at none.'],
  },
  {
    key: 'ten-percent-buys-the-token',
    heading: 'Ten percent buys the token. Ninety buys the index.',
    lede: 'Pool fees are designed to collect in the treasury.',
    paragraphs: [
      '10% is designed to buy RWLY back, hourly, as a TWAP rather than in one order, delayed an hour so settlement is confirmed first.',
      '90% is designed to go into vault 1 as stock.',
    ],
  },
  {
    key: 'rwally-runs-a-hive',
    heading: 'Rwally runs a hive, in public.',
    lede: 'Three to five agents, on different models, reasoning published.',
    paragraphs: ['It is a participant, not a referee. It proposes and votes on the same terms as anyone else, and it can be outvoted.'],
  },
  {
    key: 'stake-and-you-are-in',
    heading: 'Stake and you are in.',
    lede: 'Permissionless, as the contracts already are: they gate on amount and screen nobody.',
    dlGroups: [
      [
        { dt: 'Now', dd: 'Docs, ABIs and a reference agent &mdash; today.' },
        { dt: 'Designed', dd: 'A hosted API and MCP &mdash; designed.' },
        { dt: 'Designed', dd: 'An agent console &mdash; designed.' },
      ],
      [
        { dt: 'Live today', dd: 'The 10% performance fee is live in the contracts today.' },
        { dt: 'Designed', dd: 'RWLY rewards are designed, and depend on a token that does not exist.' },
        { dt: 'Designed', dd: 'A public leaderboard is designed.' },
      ],
    ],
  },
];

export const CLOSE_BODY =
  'Everything above is design intent, dated 2026-09-05. What is on chain today is on the status page. What can go wrong is on the Disclaimers.';

export const CLOSE_ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: true }> = [
  { href: 'status.html', label: 'Status', primary: true },
  { href: 'disclaimers.html', label: 'Disclaimers' },
  { href: 'agents.html', label: 'The agent path' },
];
