/**
 * EVERY SENTENCE ON THE MARKETING PAGES, IN ONE FILE.
 *
 * VOICE, changed on 2026-09-18 by owner decision: marketing-forward and consumer-friendly. Short
 * sentences. Plain words. Say what it does for a person before saying how it works.
 *
 * WHAT THIS FILE DOES NOT DO, revised 2026-09-18 on the owner's point and CONDITIONAL since
 * 2026-09-19. It did not repeat that the protocol is not deployed, on the owner's stated ground
 * that a reader could not act on a status line: no deposit button, no address, no wallet connect
 * anywhere on these pages. **That ground expired the day connect-and-sign shipped in `apps/vaults-ui`
 * and this site's "Open the app" button started leading somewhere a wallet can actually connect.**
 * `steps.notice` below is the replacement. Until 2026-09-24 it said no vault was live and promised
 * to name one when there was; the first vault went live on Arc that day, so it now keeps that
 * promise. `apps/site/test/site.test.mjs` reads the vault's address out of
 * `contracts/config/deployments/arc-mainnet.json` and fails if the page does not print it.
 *
 * REAL MONEY NOW. The app signs real deposits into that vault, so no sentence on these pages may
 * describe it as a demo or a walkthrough with sample data — a reader who believes that could
 * approve real USDC thinking nothing moves. Where the app still renders sample vaults, those carry
 * their own visible label. The disclaimers page keeps its precise language for the same reason —
 * it is the page a reader goes to for exactly that.
 *
 * Also still true and still worded carefully, because each is checkable and each was wrong once:
 *   - MEMBERS pool and vote. An AI operator proposes; it does not pool capital and does not govern.
 *   - The operator's lack of power is ENUMERATED, never a blanket negative — the operator IS the
 *     sole recipient of the performance fee, so a wide claim is falsifiable in one transaction.
 *   - "Stake-weighted" is only true at five or more members, so it is not used here.
 *   - EXITS CANNOT BE VETOED, AND THEY CAN BE DELAYED. Never write that an exit is unconditional,
 *     instant, or that nothing can queue it. `VaultCore.sol:538` names the case in its own NatSpec:
 *     "Mode F — a pending execution exists => queued, settles at post-execution NAV", triggered from
 *     the reveal phase, so a proposal that is ultimately DEFEATED still queued every exit requested
 *     while it was live. A stale feed freezes exits too, and that freeze lifts only when the feed
 *     recovers. Settlement after a defeat is not automatic — `settleQueuedExit` has to be called,
 *     by anyone. The true reassurance is that nobody can REFUSE an exit; say that instead.
 *     `disclaimers-copy.ts` has stated all of this correctly throughout — the homepage said the
 *     opposite until 2026-09-18, so the site carried a claim and its refutation at the same time.
 */

export const HOME = {
  hero: {
    eyebrow: 'Built for Arc',
    headline: 'Index funds that argue for themselves.',
    sub:
      'An AI picks the basket. You and the other members vote on it. What this vault invests in ' +
      'is decided by vote — and every decision stays on-chain where anyone can check it.',
    primary: { label: 'Open the app', kind: 'app' },
    secondary: { label: 'How it works', href: '/how-it-works.html' },
  },

  proof: [
    { k: 'Settles in', v: 'Kind' },
    { k: 'Built for', v: 'Arc' },
    { k: 'Votes are', v: 'On-chain' },
    { k: 'Contracts are', v: 'Immutable' },
  ],

  pitch: {
    eyebrow: 'The idea',
    headline: 'Nobody writes down what an AI would actually buy.',
    body: [
      'The S&P 500 works because someone writes the weights down and everyone can check them.',
      'There is no such list for AI. Plenty of bots trade. None of them have to explain the ' +
        'position in public and win a vote before taking it.',
      'A RWAlly vault is that list, made checkable. An AI operator proposes a basket. The members ' +
        'whose money it is vote it up or down. What happens next is recorded next to the proposal ' +
        'that asked for it.',
    ],
  },

  steps: {
    eyebrow: 'Four steps',
    headline: 'Four steps, and the second one is yours to come back for.',
    notice:
      'The first RWAlly vault is deployed on Arc: the cirBTC Vault, at ' +
      '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6. Its contracts cannot be changed. A deposit ' +
      'there is real USDC — read the risks before you put anything in.',
    items: [
      {
        n: '01',
        title: 'Put USDC in',
        body:
          'Your first deposit is held for four hours before it becomes anything. It is not ' +
          'shares yet. You can cancel and take it back at any point in that window — that is ' +
          'the one action that keeps working even if the vault freezes.',
      },
      {
        n: '02',
        title: 'Then it has to be activated',
        body:
          'Once the four hours elapse the deposit can be activated by any caller, not just you. ' +
          'The shares mint to you either way — but they are priced at the moment the call is ' +
          'made, not the moment you deposited, so you do not choose that price. Until someone ' +
          'makes it you are holding your own money in escrow, not a position, and you cannot vote.',
      },
      {
        n: '03',
        title: 'Vote on every trade',
        body:
          'The operator proposes a basket. You vote in secret, then reveal. The vault does not ' +
          'buy or sell into that basket until enough members say yes. If you appoint a delegate ' +
          'or set a standing default, anyone may then apply your weight on your behalf — and ' +
          'committing your own vote always overrides it.',
      },
      {
        n: '04',
        title: 'Ask to leave any time',
        body:
          'Nobody can refuse you — not the operator, not the other members. You are paid in ' +
          'kind: a slice of everything the vault holds. If a vote is live your exit queues, and ' +
          'settling it is a separate call once the vote resolves — anyone can make it, but ' +
          'somebody has to.',
      },
    ],
  },

  trust: {
    eyebrow: 'Why it is safe to leave',
    headline: 'The operator runs the vault. It does not control your money.',
    lede:
      'Proposal rights follow stake, not operatorship. The AI proposes as a member, using its own ' +
      'position — and operatorship confers no authority to vote, execute, pause, reprice, or move ' +
      'member funds.',
    points: [
      { t: 'One key, and all it does is wiring', d: 'No owner, no admin role, no proxy, no upgrade path, no pause switch. One deploy key exists and its entire power is pointing the registries at each other — three one-shot calls writing four address slots, each reverting the second time it is tried. That is the whole list of what any key can do here, and none of it is a path to your money.' },
      { t: 'No vetoed exits', d: 'Nobody can refuse, gate or veto your exit. It can be delayed — a live vote queues it, a stale feed freezes it — but a delay is a rule anyone can read, not a decision someone makes about you.' },
      { t: 'Every trade is on the record', d: 'Every trade is recorded on-chain, with the proposal and the votes that authorised it where there was one. Every rebalance needs a passed vote, and the orders are fixed before anyone votes on them.' },
      { t: 'No guessing on price', d: 'If a price feed goes stale the vault freezes rather than trading on bad data. That includes exits.' },
    ],
  },

  cta: {
    headline: 'Have a look around.',
    sub: 'The cirBTC Vault is deployed on Arc. Connect a wallet to see it as it stands on-chain — and ' +
      'read the risks before you put anything in.',
    label: 'Open the app',
  },
} as const;

export const HOW = {
  hero: {
    eyebrow: 'How it works',
    headline: 'A vote, then a trade. Never the other way round.',
    sub: 'The mechanics, in the order they happen.',
  },
  phases: [
    {
      n: '01',
      title: 'Someone proposes',
      body:
        'An AI operator puts up a basket, and how much of the vault should sit in it. It proposes ' +
        'as a member, from its own stake, so its proposal carries no extra weight. The exact ' +
        'orders are locked in at ' +
        'this point — including how much slippage is acceptable.',
    },
    {
      n: '02',
      title: 'Members commit a vote',
      body:
        'You submit a hashed vote, so nobody can see which way you went. That stops the late voter ' +
        'from simply following the crowd.',
    },
    {
      n: '03',
      title: 'Members reveal',
      body:
        'You reveal what you committed. A vote that is never revealed does not count — not toward ' +
        'the result, not toward quorum.',
    },
    {
      n: '04',
      title: 'Anyone executes',
      body:
        'If it passes, anybody can trigger it. Not just the operator, not an admin. That means no ' +
        'single party can sit on a result they dislike.',
    },
    {
      n: '05',
      title: 'It is on the record',
      body:
        'The trade is recorded next to the proposal that asked for it and the votes that carried ' +
        'it. Anyone can reconstruct the decision from chain data alone.',
    },
  ],
  fees: {
    eyebrow: 'Fees',
    headline: 'Two, and you can read both.',
    items: [
      { t: 'Performance fee', d: '10% of realised gains, paid to the vault operator. Charged when you exit, on the gain only, with a high-water mark so you are not charged twice for the same rise.' },
      { t: 'Exit fee', d: 'Up to 1%, shrinking the longer you have been in. It stays in the vault, so it adds to the value of the shares every remaining member holds, including the operator if it holds a position. A sole holder pays nothing.' },
    ],
  },
} as const;

export const ABOUT = {
  hero: {
    eyebrow: 'About',
    headline: 'A record, not a recommendation.',
    sub: 'What RWAlly is for, and what it deliberately refuses to be.',
  },
  body: [
    {
      t: 'The problem',
      d:
        'AI is already trading. What is missing is any public record of what an AI would hold if ' +
        'it had to make the case first and get agreement from the people whose money it is.',
    },
    {
      t: 'What a vault is',
      d:
        'A pool of USDC, a basket of assets, and a rule that what it invests in is decided by ' +
        'vote. The ' +
        'holdings are not an opinion anyone published. They are a timestamped record of what an ' +
        'operator proposed and what members were willing to fund.',
    },
    {
      t: 'What it is not',
      d:
        'That record is exactly what it says and nothing more. It is not a claim that the ' +
        'conviction was right, and it is not a forecast. Spot crypto falls. Nobody here makes ' +
        'anyone whole.',
    },
    {
      t: 'Where it runs',
      d:
        'Built for Arc, Circle’s chain, where USDC is also the gas. The contracts carry no ' +
        'chain-specific code, so the same bytecode runs on any EVM chain. No centralised exchanges ' +
        'anywhere in the design.',
    },
  ],
  status: {
    eyebrow: 'Where it stands',
    headline: 'Built, tested, and deployed on Arc.',
    body:
      'A full test suite runs against the contracts on every change, alongside guards that check ' +
      'the claims on this site against the code. All of it is public. The first vault, the cirBTC ' +
      'Vault, is deployed on Arc, and a deposit through the app moves real USDC.',
  },
} as const;

export const DOCS = {
  hero: {
    eyebrow: 'Docs',
    headline: 'Everything is readable.',
    sub: 'The contracts, the threat model and the audit trail are public. Start wherever you like.',
  },
  groups: [
    {
      t: 'Start here',
      items: [
        { label: 'Architecture', d: 'NAV maths, exits, governance, safety.', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/ARCHITECTURE.md' },
        { label: 'Threat model', d: 'Every mechanic, its attack, and what is done about it.', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/THREAT-MODEL.md' },
        { label: 'Disclaimers', d: 'Fifteen risks, written plainly. Six have no mitigation.', href: '/disclaimers.html' },
      ],
    },
    {
      t: 'For builders',
      items: [
        { label: 'Source', d: 'The contracts, the tests and the guards.', href: 'https://github.com/SlumperSan/agent-governed-vaults' },
        { label: 'Audit handoff', d: 'Scope, proven invariants, known residuals.', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/AUDIT-HANDOFF.md' },
        { label: 'Agent quickstart', d: 'The calls an agent makes, and the rules it must respect.', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/AGENT-QUICKSTART.md' },
      ],
    },
    {
      t: 'For agents',
      items: [
        { label: '/llms.txt', d: 'Machine-readable orientation for integrating agents.', href: '/llms.txt' },
        { label: 'Arc survey', d: 'What was read off Arc, and what is still unresolved.', href: 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/evidence/arc-mainnet-survey.json' },
      ],
    },
  ],
} as const;
