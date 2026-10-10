/**
 * EVERY SENTENCE ON THE DISCLAIMERS PAGE, IN ONE FILE.
 *
 * Ported verbatim from the retired site's disclaimers build (sections risks-hero, risks-contents,
 * risks-register, risks-review-status, risks-scope-additions, risks-verify, and the pinned strings
 * they share), then corrected in a second, separate pass.
 *
 * THE PORT AND THE CORRECTION WERE DELIBERATELY TWO STEPS, and it is worth saying why. The port
 * moved every sentence unchanged — including twenty that had become false, naming an abandoned
 * chain, a settlement token no longer used, and vaults that no longer hold anything. Correcting
 * them during the move would have mixed two kinds of change in one diff: a reviewer could not then
 * tell a relocated sentence from a rewritten one, which is precisely the review a disclosure
 * document most needs. So the port landed first and the twenty were listed, then each was REPLACED
 * — not annotated beside, not footnoted, not marked stale. A disclosure carrying both a claim and
 * its refutation has no truth value, and the appended correction is the form that survives review
 * because it looks like diligence.
 *
 * WHAT CHANGED IN THAT SECOND PASS: the settlement token is USDC; nothing was deployed then, so the
 * deployment paragraph, the vault capacity figures and the address ledger references said so (all
 * three were replaced again on 2026-09-24, when the first vault went live on Arc, from
 * contracts/config/deployments/arc-mainnet.json and a chain read of the live oracle); the
 * sequencer-gate entry records the Arc exemption, granted for chain 5042 on 2026-09-19, and what it
 * costs at price time; and figures that came out of a configuration file which has since
 * been deleted were removed rather than carried forward as though still sourced.
 *
 * THE TWO DERIVED SENTENCES. RisksContents' heading ("All fifteen.") and its closing clause
 * ("Seven of these have no mitigation...") were never hand-written on the source site: the heading
 * is the register's article count spelled as a word, and the clause is the count of entries whose
 * "What is done" cell opens with "Nothing", also spelled as a word. Both are computed below from
 * REGISTER_ENTRIES, not hardcoded, so an edit to the register moves both with it. See
 * CONTENTS_HEADING and UNMITIGATED_NOTE.
 */

export type RiskRow = {
  readonly dt: string;
  readonly dd: string;
};

export type RiskEntry = {
  readonly id: string;
  readonly severityLabel: string;
  readonly heading: string;
  readonly rows: readonly RiskRow[];
};

export type ContentsEntry = {
  readonly id: string;
  readonly text: string;
};

export type ScopeRow = {
  readonly key: string;
  readonly term: string;
  readonly body: string;
};

export type Group = {
  readonly title: string;
  readonly body: string;
};

export type Reference = {
  readonly key: string;
  readonly term: string;
  readonly body: string;
};

export type Action = {
  readonly href: string;
  readonly label: string;
  readonly primary?: boolean;
};

/* ---------------------------------------------------------------------------
 * Hero
 * ------------------------------------------------------------------------ */

export const HERO = {
  eyebrow: "Disclaimers",
  title: "Everything that can go wrong, in one place.",
  lede:
    "Every warning, limit and unresolved question on this site is on this page. The rest of this site describes mechanism. This one describes what that mechanism costs you when it does not go your way.",
  bannerOffer: "Nothing on this site is an offer, a solicitation, or financial advice.",
  deploymentParagraph:
    "Deployed on Arc mainnet. The first vault, the cirBTC Vault, is at <code>0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6</code>, and every protocol address is recorded in <code>contracts/config/deployments/arc-mainnet.json</code>. Every risk below describes code that is now running on Arc and can hold real USDC, and none of that code can be changed.",
  licence: "Open source under the MIT licence.",
  jurisdictionParagraph:
    "Interests in these vaults may be treated as securities or as collective investment scheme interests in some jurisdictions. Access from restricted jurisdictions is intended to be geofenced at the front end; that is a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone.",
  totalLossParagraph:
    "Spot crypto assets fall. Nobody in this system makes anyone whole, and there is no insurance fund, no backstop and no guarantee of any outcome. Do not deposit anything you cannot afford to lose entirely.",
} as const;

/* ---------------------------------------------------------------------------
 * Contents
 * ------------------------------------------------------------------------ */

export const CONTENTS_EYEBROW = 'Contents';

export const CONTENTS_ENTRIES: readonly ContentsEntry[] = [
  {
    "id": "r1",
    "text": "1. Immutability itself"
  },
  {
    "id": "r2",
    "text": "2. Oracle freeze traps exits"
  },
  {
    "id": "r3",
    "text": "3. A single price provider"
  },
  {
    "id": "r4",
    "text": "4. The settlement token is pinned at $1.00"
  },
  {
    "id": "r5",
    "text": "5. Sequencer downtime"
  },
  {
    "id": "r6",
    "text": "6. Forward-settled exits are irrevocable"
  },
  {
    "id": "r7",
    "text": "7. Governance capture and thin electorates"
  },
  {
    "id": "r8",
    "text": "8. The rules can freeze permanently"
  },
  {
    "id": "r9",
    "text": "9. Operator identity cannot be rotated"
  },
  {
    "id": "r10",
    "text": "10. Total loss is possible"
  },
  {
    "id": "r11",
    "text": "11. Securities and scheme recharacterization"
  },
  {
    "id": "r12",
    "text": "12. The reference agent is beta code"
  },
  {
    "id": "r13",
    "text": "13. An open licensing question"
  },
  {
    "id": "r14",
    "text": "14. This is experimental software"
  },
  {
    "id": "r15",
    "text": "15. There is no oracle rotation path"
  },
  {
    "id": "r16",
    "text": "16. A vault's creator chooses its trading adapters"
  }
];

/* ---------------------------------------------------------------------------
 * Register: the sixteen-entry risk register
 * ------------------------------------------------------------------------ */

export const REGISTER_ENTRIES: readonly RiskEntry[] = [
  {
    "id": "r1",
    "severityLabel": "Structural, no mitigation exists",
    "heading": "1. Immutability itself",
    "rows": [
      {
        "dt": "What it is",
        "dd": "The contracts carry no proxy, no upgrade path and no pause, and the source declares no owner and no admin role. One privileged caller exists &mdash; the deploy key &mdash; and its entire power is wiring: three one-shot calls that write four registry-pointer slots and revert the second time each is tried. None of the four is a path to member funds. The contracts are now deployed on Arc, so this is no longer hypothetical: their code is what runs, permanently, and nobody holds the power to replace it."
      },
      {
        "dt": "Worst case",
        "dd": "A critical bug that survived review is permanent. Funds may be unrecoverable, and no party has any power to stop it, patch it or claw anything back. That includes the people who wrote the code."
      },
      {
        "dt": "What is done",
        "dd": "Everything that is going to be done must be done before a deploy, because nothing can be done after one; that is the point. So far: an external security review whose report is held privately, with no public report to check it against, four internal adversarial review rounds, and an AI pre-audit. The project's own history shows that is not enough. The AI pre-audit found five Critical issues in a frozen tree that had already passed internal review, and every fix required a full redeploy because nothing can be edited in place."
      }
    ]
  },
  {
    "id": "r2",
    "severityLabel": "Accepted by design",
    "heading": "2. An oracle freeze traps every exit",
    "rows": [
      {
        "dt": "What it is",
        "dd": "If a price feed goes past its staleness bound, the oracle refuses to answer and every function that reads NAV reverts: deposits, rebalance execution and redemptions alike."
      },
      {
        "dt": "Worst case",
        "dd": "All active capital in the vault is frozen for as long as the feed stays past its bound, with exits included and no escape hatch. You cannot leave at any price while the freeze lasts. If the feed is deprecated or retired rather than merely late, the freeze does not end: a vault's oracle cannot be replaced, which is risk 15."
      },
      {
        "dt": "What is done",
        "dd": "Nothing, deliberately, and no hatch will be added. Any escape hatch is exactly the stale-price exit the breaker exists to prevent. The reasoning is that freezing beats mispricing: an exit priced off a stale feed is a transfer from the members who stay to whoever moves first. The one thing that stays reclaimable during a freeze is un-activated observation-window capital, because cancelling a pending deposit reads no oracle."
      }
    ]
  },
  {
    "id": "r3",
    "severityLabel": "Partially mitigated",
    "heading": "3. A single price provider, with no fallback",
    "rows": [
      {
        "dt": "What it is",
        "dd": "Each asset is priced from exactly one Chainlink Data Feed. The basket is one asset: cirBTC, priced through the BTC/USD feed &mdash; the underlying cirBTC claims to wrap, not a feed for some other wrapper. cirBTC is issued rather than trustless: its contract can be paused, upgraded, and can blacklist addresses, and those powers sit with whoever controls those roles &mdash; not with this protocol and not with its operator. Its own <code>name()</code> returns &ldquo;Circle Wrapped Bitcoin&rdquo;; who actually holds the keys is not something this page can verify from the chain. There is no ETH leg: of the 26,187 tokens that appear in a Uniswap v3 pool on Arc, 52 carry an ETH- or BTC-family symbol and every one of the 51 that is not cirBTC holds under $452 of depth. There is no second provider and no fallback source, so if that one feed goes stale or implausible the vault stops pricing rather than guess &mdash; and that freeze reaches exits too. This is a named residual risk, not an oversight."
      },
      {
        "dt": "Worst case",
        "dd": "A wrong answer that lands inside the sane-price band and inside the heartbeat is treated as truth, and the vault trades or settles on it. A feed deprecation fails that asset closed, which stops the vault rather than mispricing it. But there is nothing to fail over to."
      },
      {
        "dt": "What is done",
        "dd": "Three defences in the general case, and only two on Arc: a heartbeat and staleness bound per asset, a plausibility band per asset that rejects prices outside it, and the sequencer gate &mdash; mandatory wherever Chainlink publishes an L2 Sequencer Uptime Feed. Chainlink publishes none for Arc, which is an L1 rather than a rollup, so on Arc that gate would never run. The heartbeat and the band are per-deployment values, bounded above by the 90,000 seconds the oracle constructor accepts &mdash; deliberately an hour more than the 86,400-second cadence these feeds publish on, because a bound set at the cadence itself trips on a feed that is behaving normally. On the live Arc oracle, read from its <code>feedOf</code> entry for cirBTC: a staleness bound of 90,000 seconds and a band of $4,000 to $4,000,000 on the price read from the Chainlink BTC/USD feed at <code>0xa109B535C70C8Be9995be64Bb6751AcDB27e03De</code>. No sequencer feed is wired, as described above. A band is wide by nature: it rejects gross errors, and it does not reject an adverse but plausible price. The basket is limited to assets with a genuine Chainlink USD feed, rather than reaching for assets that would need a weaker price source."
      }
    ]
  },
  {
    "id": "r4",
    "severityLabel": "Accepted, no mitigation",
    "heading": "4. The settlement token is pinned at $1.00 in the oracle",
    "rows": [
      {
        "dt": "What it is",
        "dd": "The oracle does not price the settlement token. It assumes one dollar for USDC."
      },
      {
        "dt": "Worst case",
        "dd": "A sustained USDC depeg is mispriced by exactly the size of the depeg. Every NAV computed during it is wrong by that amount, and every deposit, redemption and rebalance priced off that NAV is wrong with it. There is no median and no second source to outvote the pin."
      },
      {
        "dt": "What is done",
        "dd": "Nothing. This one is accepted outright. If you think a sustained depeg is likely, this protocol misprices your position for the whole duration and you should treat that as disqualifying."
      }
    ]
  },
  {
    "id": "r5",
    "severityLabel": "Exempted on Arc, fails open",
    "heading": "5. Sequencer downtime",
    "rows": [
      {
        "dt": "What it is",
        "dd": "A chain that halts, or whose block production is controlled by few enough parties to stop, makes on-chain prices untrustworthy before it makes them unavailable. The feeds keep returning their last answer while the world moves."
      },
      {
        "dt": "Worst case",
        "dd": "On Arc the guard is exempted, so it fails open: while the chain is halted the oracle keeps serving the last answer for as long as that answer stays inside the heartbeat and the band. Where the guard does run, a sequencer incident can extend into a vault freeze that outlasts the incident, because the oracle will not price anything until the grace period has elapsed."
      },
      {
        "dt": "What is done",
        "dd": "A Chainlink L2 Sequencer Uptime Feed is mandatory, enforced at deploy time rather than at price time. The deploy script refuses any chain it has no sequencer policy for, and a pre-deploy check fails a configuration that omits the feed. Chainlink publishes no L2 Sequencer Uptime Feed for Arc, so deploying there requires exempting it, and that exemption has been granted &mdash; for chain 5042 alone, on 19 September 2026. The consequence is stated here rather than left in the commit that granted it: on Arc the sequencer guard never runs at price time, and the per-feed heartbeat and the sane-price band carry this risk alone. What makes that defensible is that Arc is an L1 rather than a rollup, so there is no sequencer, and no sequencer outage for the gate to catch. What it costs is that the oracle serves prices straight through whatever Arc&rsquo;s equivalent of a halt turns out to be, and never refuses on that account. Handed a zero address the oracle skips the gate silently rather than reverting, which is why the deploy-time refusal is the defence that carries the weight on every chain that is not on the exempt list. Where a feed is wired, the oracle enforces a 3,600-second grace period after the sequencer returns, and the mitigation and the risk are then the same mechanism: protection from stale-sequencer pricing comes from being locked out for an hour longer than the outage. This path has never executed against a real sequencer feed anywhere."
      }
    ]
  },
  {
    "id": "r6",
    "severityLabel": "Accepted by design",
    "heading": "6. Forward-settled exits are irrevocable",
    "rows": [
      {
        "dt": "What it is",
        "dd": "<strong>The reference configuration sets the timelock to zero, so a passed proposal is executable immediately and there is no delay in which to leave after seeing the outcome.</strong> And redemption requests queue in forward settlement mode, priced at post-execution NAV, from the moment the reveal phase opens on any live proposal (not from the moment one passes). The window lasts until that proposal executes, is defeated, or its execution window lapses. A proposal that is ultimately defeated still forced your exit into the queue while it was live."
      },
      {
        "dt": "Worst case",
        "dd": "You can be right about disliking a rebalance, vote against it, request your exit, and still carry the full effect of its execution. Once queued, the request cannot be withdrawn. Your shares stay outstanding and keep gaining and losing with the vault, but they are locked: non-transferable and excluded from voting-eligible stake. There is no cap on how often this window recurs. One passed proposal holds it for the vault's timelock plus its execution window: 24 hours in the reference configuration (a zero timelock plus a 24-hour execution window), and up to 120 days at the protocol's hard caps (a 30-day timelock cap plus a 90-day execution-window cap, <code>Governance.sol</code>). A member holding a single minimum deposit can re-open proposals to hold exits in this mode roughly half the time, indefinitely, for the cost of gas."
      },
      {
        "dt": "What is done",
        "dd": "Nothing, deliberately. The alternative is worse: instant exits during that window would be a free option to leave at pre-rebalance prices while already knowing the outcome, paid for by every member who stayed. The recurrence is a known, accepted, unmitigated finding (M-7): the proposal cooldown raises its cost and does not remove it, because the cooldown is keyed per proposer and a second address sidesteps it. If the proposal is defeated or its execution window lapses without execution, a queued exit settles at the NAV current at settlement. But settlement is not automatic in that case. <code>settleQueuedExit</code> has to be called, and anyone can call it. Separately, <code>requestExit</code> takes no minimum-value parameter: your exit is an unbounded market order against whatever NAV settlement produces, there is no transaction-level floor you can set, and one was deliberately dropped for contract-size reasons. The operator's rebalance swaps do carry a minimum-out bound. Your principal does not."
      }
    ]
  },
  {
    "id": "r7",
    "severityLabel": "Partially mitigated",
    "heading": "7. Governance capture and thin electorates",
    "rows": [
      {
        "dt": "What it is",
        "dd": "Voting is stake-weighted at five or more members, and at that size quorum counts only stake a member revealed in person &mdash; an absent member&rsquo;s cranked weight can help decide a result but can never be what makes one countable. Below five members the vault takes a different branch: a proposal passes on either a majority of the members-at-creation revealing, whichever way they vote, while the FOR side&rsquo;s own stake &mdash; a member&rsquo;s revealed vote or their own standing default, never weight a delegate applied on an absent member&rsquo;s behalf &mdash; still clears the quorum, or an outright majority of that same own-directed FOR stake. Both branches exclude cranked weight from the stake test itself, so neither can be carried by voting on somebody else&rsquo;s behalf. A rule change instead requires full consensus of eligible stake, with every member revealing in person &mdash; delegation contributes none of it there."
      },
      {
        "dt": "Worst case",
        "dd": "A small vault is governed by whoever holds the most. In the small-member regime the residual is not a cheap head-count flip: because both sub-five branches weigh stake, dust addresses cannot pass a proposal on numbers alone. What is still purchasable is the regime itself. Buying seats up to five moves the vault out of the signer-count branch and into the pure stake rule, and a seat costs one minimum deposit. At a 100 USDC minimum deposit that would be about 400 USDC for the four seats a single-member vault needs, and a lower minimum makes it cheaper in proportion. There is no contract-level floor here. The minimum deposit is chosen by whoever created the vault, and a low one makes capture cheap. Check it before you deposit. Proposals you oppose pass, and your exit settles after they execute."
      },
      {
        "dt": "What is done",
        "dd": "A protocol quorum floor of 25% of voting-eligible stake, a per-vault proposal threshold, a cap on how much delegated weight any single delegate may receive, and a minimum deposit that exists precisely as a listing constraint against cheap address-splitting in the small-member regime. There is also a per-proposer cooldown, which is not a defence against this: it is keyed per proposer, so a second address sidesteps it entirely. None of these makes a determined majority holder harmless, and the purchasable member count below five members remains open at the launch configuration as the one High-severity pre-audit finding reachable there."
      }
    ]
  },
  {
    "id": "r8",
    "severityLabel": "Accepted by design",
    "heading": "8. The rules can freeze permanently",
    "rows": [
      {
        "dt": "What it is",
        "dd": "After a vault is funded, changing its rules requires 100% of voting-eligible stake plus a timelock."
      },
      {
        "dt": "Worst case",
        "dd": "One permanently offline member (a lost key, a death, a walked-away wallet) freezes the vault's rules forever. Nobody can change a parameter again, no matter how much everyone else agrees."
      },
      {
        "dt": "What is done",
        "dd": "Nothing. Unanimity is what makes \"nobody can change the rules behind you\" true, and a lower bar would make it false. The consequence is stated here rather than discovered later."
      }
    ]
  },
  {
    "id": "r9",
    "severityLabel": "Accepted, no recovery path",
    "heading": "9. Operator identity cannot be rotated",
    "rows": [
      {
        "dt": "What it is",
        "dd": "The operator identity is attested by the registry at vault creation and is immutable for that vault. There is no rebind, and the payout address is permanent."
      },
      {
        "dt": "Worst case",
        "dd": "A compromised operator identity cannot be rotated, replaced or revoked. Whoever controls it controls the proposal right that identity carries, for as long as the vault exists."
      },
      {
        "dt": "What is done",
        "dd": "The remedy is procedural, not technical: wind the vault down through exits and launch a new one. The compromise cannot let an attacker move member funds, because operatorship confers no authority to vote, execute, pause, reprice, or move member funds. Nor can it be undone. Operators are told to use a multisig, because the address is permanent."
      }
    ]
  },
  {
    "id": "r10",
    "severityLabel": "Not mitigable",
    "heading": "10. Total loss is possible",
    "rows": [
      {
        "dt": "What it is",
        "dd": "The vault holds spot crypto assets. Spot crypto assets fall, sometimes a long way, sometimes permanently."
      },
      {
        "dt": "Worst case",
        "dd": "You lose everything you deposited. Market losses, a permanent bug, or both."
      },
      {
        "dt": "What is done",
        "dd": "Nothing, and nothing can be. There is no insurance fund, no backstop, no reimbursement and no party who makes anyone whole. Do not deposit what you cannot afford to lose entirely."
      }
    ]
  },
  {
    "id": "r11",
    "severityLabel": "Open, unresolved",
    "heading": "11. Securities and collective investment scheme recharacterization",
    "rows": [
      {
        "dt": "What it is",
        "dd": "Interests in these vaults may be treated as securities, or as collective investment scheme interests, in some jurisdictions. This is an unresolved legal question, not a settled one."
      },
      {
        "dt": "Worst case",
        "dd": "A regulator takes that view. Participants face consequences that depend entirely on where they are, and this project cannot indemnify anyone against them."
      },
      {
        "dt": "What is done",
        "dd": "Disclosure, and an intended geofence. Nothing on this site is an offer, a solicitation, or financial advice, and no part of it is intended to induce anyone to part with money. Access from restricted jurisdictions is intended to be geofenced at the front end, a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone, with or without a front end. Take your own advice about your own jurisdiction. This site will not characterize your position for you."
      }
    ]
  },
  {
    "id": "r12",
    "severityLabel": "Out of review scope",
    "heading": "12. The reference agent is beta code",
    "rows": [
      {
        "dt": "What it is",
        "dd": "A reference operator agent ships in the repository. It is beta reference code and it sat outside the scope of the contract security review. Running it live is what exposed two launch-class bugs in it: one gate could never admit a new operator, and a deposit path set no token allowance and therefore reverted in every configuration as shipped. Both are fixed with regression tests. Both were invisible to mocks."
      },
      {
        "dt": "Worst case",
        "dd": "An operator runs it as-is, it proposes something the operator did not intend, and the members pass it."
      },
      {
        "dt": "What is done",
        "dd": "It is labelled as reference code here and in the repository. It is an ordinary member address. In governance it can only propose and vote its own weight, so its failure mode is a bad proposal, not a theft. Read it before you run it, and do not run it against real capital on the assumption that anyone has checked it."
      }
    ]
  },
  {
    "id": "r13",
    "severityLabel": "Open, owner decision",
    "heading": "13. An open licensing question",
    "rows": [
      {
        "dt": "What it is",
        "dd": "Vendored third-party mathematics is under GPL-2.0-or-later and MIT terms in a repository whose own licence is MIT. The MIT half now matches the repository; the GPL-2.0-or-later half does not."
      },
      {
        "dt": "Worst case",
        "dd": "The combination is judged incompatible, and the licensing of part of the tree has to change."
      },
      {
        "dt": "What is done",
        "dd": "It is recorded as an open owner decision rather than quietly left alone. It is disclosed here because you should know about it before you build on the repository, not after."
      }
    ]
  },
  {
    "id": "r14",
    "severityLabel": "Structural",
    "heading": "14. This is experimental software",
    "rows": [
      {
        "dt": "What it is",
        "dd": "New contracts, a new governance mechanism and a new operator model, none of it battle-tested by time or volume."
      },
      {
        "dt": "Worst case",
        "dd": "Something nobody on this page thought of."
      },
      {
        "dt": "What is done",
        "dd": "A capacity cap is a per-vault parameter, so each vault's blast radius is bounded by whatever its creator set, but nothing bounds the protocol as a whole. <strong>The first Arc vault ships with no cap, by choice.</strong> That is not a promise of room: the market underneath it is thin, and a deposit large enough to matter moves the price against you before it is a capacity question at all. Do not read an absent cap as headroom. Do not deposit what you cannot afford to lose entirely."
      }
    ]
  },
  {
    "id": "r15",
    "severityLabel": "Accepted, no recovery path",
    "heading": "15. There is no oracle rotation path",
    "rows": [
      {
        "dt": "What it is",
        "dd": "Each vault's oracle address is fixed in immutable code at construction. Governance has no oracle-shaped proposal. The factory's allowlist is fixed in its constructor with no add, no remove and no owner, and it governs only which oracle a <em>new</em> vault may be created with."
      },
      {
        "dt": "Worst case",
        "dd": "If a feed is deprecated or permanently retired, the freeze in risk 2 is permanent. Members are locked out for good, with the funds visibly on-chain and no party able to change it: not the operator, not the members, not the deployers. A replacement oracle cannot be attached to an existing vault; it can only be blessed for new vaults on a new factory, and existing vaults keep pricing through the dead one."
      },
      {
        "dt": "What is done",
        "dd": "Nothing, deliberately. The alternative is an address able to bless a new oracle, which is an address able to bless a fake price feed. That is the exact attack the allowlist exists to close, and such an address would be the protocol's first standing privileged role. Creating a new vault against a dead feed fails loudly rather than producing a brick, so the failure mode is \"that asset becomes unlistable until a new factory is published\", never \"broken vaults ship\". Publishing a new factory also restarts the operator registry, the leaderboard and the loss carryforward in a fresh registry."
      }
    ]
  },
  {
    "id": "r16",
    "severityLabel": "Partially mitigated",
    "heading": "16. A vault's creator chooses its trading adapters",
    "rows": [
      {
        "dt": "What it is",
        "dd": "A vault can trade only through the execution adapters its creator listed when it was created, and that list is fixed for the life of the vault. Unlike oracles, adapters are not curated by the factory: any creator can list any adapter contract, reviewed or not. <strong>The live cirBTC Vault lists exactly one adapter, the reviewed AggregationRouterAdapter at <code>0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1</code></strong>, read from the vault's own creation transaction."
      },
      {
        "dt": "Worst case",
        "dd": "A future vault, created by someone else, lists an adapter that is faulty or hostile. That adapter still cannot move anything on its own: the vault calls an adapter only to execute a rebalance its members voted for, and the vote commits to every leg of it. On each leg, the most it can take is the slippage bound the vote approved, which the contract caps at 2% of that leg&rsquo;s oracle-priced value. That cap is per leg, not per rebalance: a rebalance has no limit on its number of legs, and legs can trade back and forth, so the losses compound. Twenty legs trading the same value back and forth at the 2% cap can lose about a third of it."
      },
      {
        "dt": "What is done",
        "dd": "The same checks run on every leg, whichever adapter is listed. The vault refuses an order whose minimum output is worth less than the voted slippage bound allows, priced by its own oracle. It measures what actually arrived from its own balance rather than taking the adapter&rsquo;s word, resets the adapter&rsquo;s token approval to zero after the swap, and returns any input the swap did not spend. Before depositing in any vault other than the cirBTC Vault, check which adapters its creation transaction lists."
      }
    ]
  }
];

/* ---------------------------------------------------------------------------
 * The two sentences RisksContents derives from the register above, rather than
 * hardcoding. Ported behaviour, not just ported text: see the file header.
 * ------------------------------------------------------------------------ */

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
] as const;

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1);
}

function countUnmitigated(entries: readonly RiskEntry[]): number {
  return entries.filter((entry) => {
    const doneRow = entry.rows.find((row) => row.dt === 'What is done');
    return doneRow !== undefined && doneRow.dd.startsWith('Nothing');
  }).length;
}

/** Verbatim shape: "All fifteen." with a lowercase word, computed from REGISTER_ENTRIES.length. */
export const CONTENTS_HEADING = `All ${numberWord(REGISTER_ENTRIES.length)}.`;

/** Verbatim shape: "Seven of these have no mitigation...", computed from the register's cells. */
export const UNMITIGATED_NOTE =
  `${capitalize(numberWord(countUnmitigated(REGISTER_ENTRIES)))} of these have no mitigation and are simply accepted. They are marked as accepted rather than buried, because a page that only lists solved problems is a marketing page wearing a warning label.`;

/* ---------------------------------------------------------------------------
 * Review: "What the security review covers, and what it does not."
 * ------------------------------------------------------------------------ */

export const REVIEW = {
  eyebrow: "Review",
  heading: "What the security review covers, and what it does not.",
  attestation:
    "An external security review was commissioned against the launch tree. The owner attests it returned no major issues. The report is held privately and no public report exists to verify that attestation. Alongside it, four internal adversarial review rounds and an AI pre-audit were run; the AI pre-audit found 41 issues including 5 Critical. All five Criticals are resolved or closed by launch configuration. One High, the purchasable member count below five members, remains open at the launch configuration, and a set of Medium and Low findings are accepted residuals that will not be fixed. A further class is dormant only because sub-vaults are disabled at launch: those are not repaired in code and would return if sub-vaults were ever enabled.",
  caveat:
    "Read that as it is written. An attestation you cannot check is weaker evidence than a report you can, and this site will not use a word that implies you can check it.",
} as const;

/* ---------------------------------------------------------------------------
 * Scope additions: "The limits of every claim on this site" and
 * "Four groups this is wrong for"
 * ------------------------------------------------------------------------ */

export const SCOPE_EYEBROW = "The limits of every claim on this site";

export const SCOPE_HEADING = "What the other eight pages leave out.";

export const SCOPE_LEDE =
  "Each entry below was lifted from the page it used to sit on, so that a reader who wants the caveats finds all of them together instead of one per page.";

export const SCOPE_ROWS: readonly ScopeRow[] = [
  {
    "key": "immutability-read-the-other-way",
    "term": "Immutability, read the other way",
    "body": "Every immutability claim is also a limitation. A unanimity requirement means one permanently offline member freezes the rules forever. No pause means no circuit breaker if something is wrong. No upgrade means a critical bug that survived review is permanent, and funds may be unrecoverable. Those are not features and this site will not present them as features."
  },
  {
    "key": "an-index-of-conviction-is",
    "term": "An index of conviction is not a forecast",
    "body": "An index of agent conviction is not a claim that the conviction is correct, and none of this is a reason to expect any particular outcome. A public record of what was proposed and funded is exactly that, and nothing more. Read it as evidence about what agents proposed, never as a forecast."
  },
  {
    "key": "three-ways-this-loses-your",
    "term": "Three ways this loses your money",
    "body": "<strong>A permanent bug.</strong> Nothing can be patched. An external security review whose report is held privately, with no public report to check it against, and four internal adversarial rounds are not proof of correctness. An AI pre-audit of a tree that had already passed internal review still found five Critical issues, and every fix required a full redeploy because nothing can be edited in place. <strong>An oracle freeze.</strong> If a price feed goes stale, every function that reads NAV reverts, exits included, and active capital stays in the vault for as long as the feed is stale. <strong>A USDC depeg.</strong> The oracle pins the settlement token at $1.00, with no median and no second source to outvote the pin, so a sustained depeg is mispriced by exactly the size of the depeg."
  },
  {
    "key": "why-mode-f-exists-and",
    "term": "Why Mode F exists, and what it costs you",
    "body": "Without it, anyone watching the outcome form during the reveal phase could exit at pre-rebalance prices while already knowing it. That is a free option, paid for by everyone who stayed. Closing it has a price you pay directly: you can be right about disliking a rebalance and still carry its execution. There is no cap on how often the window recurs, and a member holding a single minimum deposit can re-open proposals to hold exits in this mode roughly half the time, indefinitely, for the cost of gas. That recurrence is a known, accepted, unmitigated finding (M-7): the proposal cooldown is keyed per proposer and a second address sidesteps it. If the proposal is defeated or its execution window lapses without execution, <code>settleQueuedExit</code> has to be called, and anyone can call it."
  },
  {
    "key": "your-exit-has-no-floor",
    "term": "Your exit has no floor",
    "body": "<code>requestExit</code> takes no minimum-value parameter. Your exit is an unbounded market order against whatever NAV settlement produces; there is no transaction-level floor you can set. One was deliberately dropped for contract-size reasons. The operator's rebalance swaps do carry a minimum-out bound. Your principal does not."
  },
  {
    "key": "what-stands-behind-the-three",
    "term": "What stands behind the three oracle guards",
    "body": "Nothing. The heartbeat and the band are the only defences that would run at price time on Arc, and the sequencer gate joins them only where Chainlink publishes an uptime feed to wire. There is one price provider, no second provider and no fallback. A feed deprecation or freeze fails that asset closed &mdash; the vault stops rather than guesses. But there is no backup to switch to, and no way to point the vault at a different one. There is also no escape hatch from the staleness breaker and none will be added, because an escape hatch is exactly the stale-price exit the breaker exists to prevent."
  },
  {
    "key": "the-high-water-mark-can",
    "term": "The high-water mark can be reset",
    "body": "Nothing stops an operator abandoning a loss-carrying identity and registering a fresh one, which resets the mark. The only cost is a visibly empty track record on the leaderboard. The enforcement here is reputation, not code."
  },
  {
    "key": "execution-can-be-sandwiched",
    "term": "Execution can be sandwiched",
    "body": "Protection against being sandwiched on execution is an off-chain concern for whoever submits the transaction; the contracts do not provide it."
  },
  {
    "key": "the-cash-redemption-path-is",
    "term": "The cash-redemption path is not built",
    "body": "A cash-redemption path through the execution adapter is described in the architecture notes and is not built. Redemption in v1 is in kind: you receive the basket tokens, and converting them back is your own transaction, your own routing and your own cost."
  },
  {
    "key": "sub-vault-findings-are-dormant",
    "term": "Sub-vault findings are dormant, not repaired",
    "body": "Root-only is not a preference. It is what closes Critical C-1 and a group of High findings; they are dormant, not repaired. If sub-vaults were ever enabled, those findings would return."
  },
  {
    "key": "skipwindow-forfeits-the-one-exit",
    "term": "skipWindow forfeits the one exit that works during a freeze",
    "body": "Pending capital is the only capital that stays reclaimable while the oracle is frozen. Opting out of the observation window forfeits that permanently, and the opt-out cannot be undone."
  },
  {
    "key": "two-mechanisms-neither-of-which",
    "term": "Two mechanisms, neither of which warns you",
    "body": "Your capital is locked by one mechanism while your proposal rights decay under another, and neither one tells you it is happening. Watch your own share. Anyone telling you an agent can operate one of these vaults without putting capital at risk is describing a different protocol."
  },
  {
    "key": "there-is-no-key-rotation",
    "term": "There is no key rotation",
    "body": "A compromised operator identity cannot be rotated, replaced or revoked. The only remedy is to wind the vault down through exits and launch a new one. Choose the payout address as if you can never change it, because you cannot."
  },
  {
    "key": "you-carry-the-execution-you",
    "term": "You carry the execution you voted against",
    "body": "You carry the execution you voted against, and a proposal that is ultimately defeated still forced your exit into the queue while it was live."
  },
  {
    "key": "you-have-to-accept-a",
    "term": "You have to accept a frozen door",
    "body": "If a price feed goes stale, everything that reads NAV reverts, including your exit. Only capital still inside an un-activated observation window stays reclaimable. If the feed is deprecated or retired rather than merely late, the freeze does not end: a vault's oracle address is fixed at construction and cannot be replaced by anyone. That is <a href=\"#r15\">risk 15</a>."
  },
  {
    "key": "whether-you-can-always-get",
    "term": "Whether you can always get out",
    "body": "No. Two situations stop you. During an oracle freeze you cannot exit at all, at any price, for as long as the feed stays past its bound, and permanently if it is retired rather than late. And from the moment the reveal phase opens on any live proposal, your request queues in forward settlement mode: irrevocable once submitted, settling at post-execution NAV, so you carry the execution whether you voted for it or not."
  },
  {
    "key": "which-jurisdictions",
    "term": "Which jurisdictions",
    "body": "Interests in these vaults may be treated as securities or as collective investment scheme interests in some jurisdictions. Access from restricted jurisdictions is intended to be geofenced at the front end. That is a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone, with or without a front end. None of this site is directed at anyone in a jurisdiction where it would be unlawful."
  },
  {
    "key": "the-vendored-mathematics-licensing-question",
    "term": "The vendored-mathematics licensing question",
    "body": "Vendored third-party mathematics in the tree is under GPL-2.0-or-later and MIT terms in a repository whose own licence is MIT. The MIT half now matches the repository; the GPL-2.0-or-later half does not. That is a licensing question the owner has recorded as open, and it is disclosed here rather than left for you to find. It also stands as <a href=\"#r13\">risk 13</a>."
  },
  {
    "key": "treasury-buyback-not-live",
    "term": "The treasury and the buyback are not live",
    "body": "There is no treasury contract, no protocol-owned liquidity and no buyback; each of those is design intent. A live fee stream is not that: the 10% performance fee accrues to an operator address and is claimed by that address. It does not reach a treasury contract, and a fee reaching a treasury contract is designed, not built."
  },
  {
    "key": "stock-index-needs-different-oracle",
    "term": "The stock index needs a different oracle",
    "body": "The oracle prices the assets it is constructed with, and the factory&rsquo;s oracle allowlist is fixed in its constructor with no add, no remove and no owner. Equity feeds publish on market days, and a weekend silence longer than the oracle&rsquo;s 90,000-second ceiling would make an all-stocks index freeze every weekend under this design. That is unsolved design work, not a parameter."
  }
];

export const GROUPS_HEADING = "Four groups this is wrong for";

export const GROUPS: readonly Group[] = [
  {
    "title": "DAO treasuries and larger allocators",
    "body": "A capacity cap is a per-vault parameter, chosen by whoever creates a vault and frozen when it is funded. The first Arc vault ships with no cap, by choice, so there is no figure to read and an absent one is not headroom. A later vault may set one; read it directly if so. Either way the binding constraint on a treasury-sized allocation is the depth of the market underneath, not the cap."
  },
  {
    "title": "Anyone who wants set-and-forget",
    "body": "There is no autopilot. Skipping votes does not park your position neutrally: it moves quorum and wastes your commit; it hands the outcome to whoever did turn up."
  },
  {
    "title": "Anyone who cannot survive a total loss",
    "body": "Spot crypto assets fall. The code cannot be patched. There is no insurance fund and no backstop. Nobody makes anyone whole. Deposit only what you can lose entirely."
  },
  {
    "title": "Anyone in a restricted jurisdiction",
    "body": "Interests in these vaults may be treated as securities or as collective investment scheme interests where you live. Front-end geofencing is intended, but it is a good-faith measure and not a guarantee. The contracts are permissionless and can be called directly by anyone. Take your own advice about your own jurisdiction."
  }
];

/* ---------------------------------------------------------------------------
 * Verify: "How to check every claim on this page."
 * ------------------------------------------------------------------------ */

export const VERIFY_EYEBROW = "Do not take this page's word for it";

export const VERIFY_HEADING = "How to check every claim on this page.";

export const VERIFY_LEDE =
  "Every entry above is recorded somewhere in the repository, usually in harsher terms than here. File paths rather than links, so they stay valid as the repository moves.";

export const REFERENCES: readonly Reference[] = [
  {
    "key": "launch-readiness",
    "term": "<code>docs/LAUNCH-READINESS.md</code> §4",
    "body": "The residual-risk register, including the curation-immobility row behind risks 2 and 15, and the record of which findings are closed by launch configuration rather than by code."
  },
  {
    "key": "threat-model",
    "term": "<code>docs/THREAT-MODEL.md</code>",
    "body": "K-4, CM-2, CM-4, CM-7, EE-9, EE-10, EX-2 and VO-7: the high-water-mark reset, the operator's share of the exit fee, the readable mid-reveal tally, and the execution-slippage bound."
  },
  {
    "key": "ai-audit-report",
    "term": "<code>docs/audit/AI-AUDIT-REPORT.md</code>",
    "body": "H-8, M-7, M-8, M-10 and M-15: the open High at the launch configuration, the Mode-F recurrence, the opaque proposal payload, and the missing exit-side slippage floor."
  },
  {
    "key": "arc-mainnet-config",
    "term": "<code>contracts/config/arc-mainnet.json</code>",
    "body": "Every reference value quoted on this site: the governance durations, the quorum and threshold, the minimum deposit, the exit-fee schedule, the staleness bound and the price band. Each field carries a note recording how the number was arrived at. <code>docs/evidence/arc-mainnet-survey.json</code> is the raw chain survey it was built from; where the two disagree, the config is the one written against the contracts."
  },
  {
    "key": "deployment-record",
    "term": "<code>contracts/config/deployments/arc-mainnet.json</code>",
    "body": "The address ledger: every contract deployed on Arc mainnet, the transactions that created them, and the first vault's creation and registration. Check any address here against the chain before you send it anything."
  },
  {
    "key": "contracts",
    "term": "<code>contracts/src/VaultCore.sol</code> and <code>contracts/src/Governance.sol</code>",
    "body": "The mechanisms themselves: the immutable oracle reference, the creator gate, the exit queue and its trigger condition, and the rebalance slippage constant."
  }
];

export const ACTIONS: readonly Action[] = [
  {
    "href": "https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/contracts/config/deployments/arc-mainnet.json",
    "label": "The address ledger",
    "primary": true
  },
  {
    "href": "index.html#how",
    "label": "The mechanism"
  },
  {
    "href": "https://github.com/SlumperSan/agent-governed-vaults",
    "label": "Read the code yourself"
  }
];

export const SELF_REFERENCE = "You are reading the <a href=\"disclaimers.html\">Disclaimers</a>.";
