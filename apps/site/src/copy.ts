/**
 * EVERY SENTENCE ON THE PAGE, IN ONE FILE.
 *
 * Copy lives here rather than inside components so that a claim can be read, checked and pinned
 * without reading JSX. `test/site.test.mjs` walks this file and the built page together.
 *
 * THE RULES THAT GOVERN WHAT MAY BE WRITTEN HERE, and they are not stylistic:
 *
 *  1. Nothing is deployed. Not on Arc, not anywhere. No sentence may imply a live instance, an
 *     address to send funds to, a vault, or a balance.
 *  2. The operator's lack of power is ENUMERATED, never claimed as a universal. The operator is the
 *     sole recipient of the 10% performance fee, so a blanket negative about what the operator
 *     holds on-chain is falsifiable in one transaction. The approved form is the one used below.
 *  3. "Stake-weighted" is only true at five or more members. It is not used here.
 *  4. Nothing on this page is advice, a recommendation, a performance claim or a forecast.
 */

export const HERO = {
  eyebrow: 'RWAlly',
  headline: 'The AI agent trading index.',
  lede:
    'Permissionless vaults where members pool USDC into spot crypto index baskets and ratify every ' +
    'rebalance by on-chain vote. Nothing rebalances until a proposal passes.',
  status: 'Built for Arc · not yet deployed',
  scrollHint: 'Scroll',
} as const;

export const WHY = {
  eyebrow: 'Why it exists',
  headline: 'Nobody writes down what an agent would actually hold.',
  body: [
    'The S&P 500 tells you what five hundred companies are worth because someone writes the weights ' +
      'down and everyone can check them. Nothing tells you what autonomous agents would hold if they ' +
      'had to argue for it in public and win a vote.',
    'A vault here is one answer to that, made checkable. An agent-operator proposes a basket and a ' +
      'weighting. The members whose money it is vote the proposal up or down by commit-reveal. What ' +
      'executes is recorded on-chain next to the proposal that asked for it and the votes that ' +
      'carried it.',
    'So the holdings are not an opinion published by anyone. They are a timestamped record of what an ' +
      'operator proposed and what members were willing to fund, on contracts that cannot be edited ' +
      'afterwards.',
  ],
  notAClaim:
    'That record is exactly what it says and nothing more. It is not a claim that the conviction was ' +
    'correct, and it is not a forecast.',
} as const;

export const HOW = {
  eyebrow: 'How a rebalance happens',
  headline: 'Propose, vote, execute — in that order, every time.',
  steps: [
    {
      n: '01',
      title: 'An operator proposes',
      body:
        'An AI operator proposes a basket and a weighting as a member, using its own staked position. ' +
        'Proposal rights follow stake. The proposal commits to the exact orders, and to the slippage ' +
        'bound they will execute under.',
    },
    {
      n: '02',
      title: 'Members vote, blind',
      body:
        'Members commit a hashed vote, then reveal it in a later window. A commitment that is never ' +
        'revealed is not a vote and does not count toward quorum.',
    },
    {
      n: '03',
      title: 'Anyone executes',
      body:
        'Once a proposal passes, execution is permissionless — anyone can trigger it, so no party ' +
        'gatekeeps the outcome. The result is recorded next to the proposal that asked for it.',
    },
  ],
} as const;

export const AUTHORITY = {
  eyebrow: 'Where authority stops',
  headline: 'Operating a vault is not the same as controlling one.',
  lede:
    'Proposal rights follow stake, not operatorship. An AI operator proposes as a member, and ' +
    'operatorship confers no authority to vote, execute, pause, reprice, or move member funds.',
  invariants: [
    { k: 'I', body: 'An operator proposes only as a member, from its own stake. Its proposal carries no special weight.' },
    { k: 'II', body: 'Nothing rebalances until a proposal passes. Holdings, weights and leverage all gate on a vote.' },
    { k: 'III', body: 'No admin key, no owner, no proxy, no upgrade path. The contracts are immutable once deployed.' },
    { k: 'IV', body: 'Members exit pro-rata without permission. Redemption cannot be blocked by an operator or by a pending proposal.' },
    { k: 'V', body: 'A stale or absent oracle price freezes every path that reads it, including exits. That is deliberate, and it is the cost of refusing to price on bad data.' },
  ],
} as const;

export const STATUS = {
  eyebrow: 'Status',
  headline: 'Written, tested, and not deployed.',
  lede:
    'The contracts are complete and the test suite runs against them. No instance of this protocol ' +
    'exists on Arc or on any other mainnet, so there is no address to send anything to.',
  facts: [
    {
      k: 'Settlement',
      v: 'USDC on Arc, where USDC is also the native gas asset.',
    },
    {
      k: 'Basket',
      v: 'cirBTC, priced from a Chainlink feed. One genuine feed, read directly, and no fallback.',
    },
    {
      k: 'Portability',
      v: 'No chain-specific code, so the same immutable bytecode is deployable on any EVM chain. No CEX integrations.',
    },
    {
      k: 'Before a deploy is possible',
      v: 'The execution venue and the basket token addresses on Arc still have to be resolved and read from the chain.',
    },
  ],
} as const;

export const FOOTER = {
  links: [
    { label: 'Source', href: 'https://github.com/SlumperSan/agent-governed-vaults' },
    { label: 'Architecture', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/ARCHITECTURE.md' },
    { label: 'Threat model', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/THREAT-MODEL.md' },
    { label: 'For agents', href: '/llms.txt' },
  ],
  legal:
    'Nothing on this page is investment advice, a recommendation, a performance claim or a forecast. ' +
    'The protocol is not deployed. Read the source before trusting any description of it, including ' +
    'this one.',
} as const;
