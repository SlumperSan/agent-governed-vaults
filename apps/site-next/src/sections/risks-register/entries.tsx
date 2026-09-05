/**
 * risks-register — the reviewed copy for r1..r15, held as HTML source bytes.
 *
 * WHERE IT CAME FROM. Every string in this file was originally lifted
 * byte-for-byte out of the fifteen `<article class="risk">` blocks of
 * `apps/site/risks.html`, by a script rather than by hand. The 2026-09-05
 * copy deck retired risks.html and moved this register, unchanged in shape,
 * onto `apps/site/disclaimers.html` — same fifteen `<article class="risk"
 * id="rN">` blocks, several cells reworded to reflect the Robinhood Chain
 * mainnet deployment. `__probe.mjs` (not updated in this pass — see its own
 * file) re-reads a corpus file and asserts the RENDERED markup is byte-equal
 * to it; point it at disclaimers.html rather than the retired risks.html.
 * Nothing here was rewritten, re-punctuated, shortened or newly written
 * beyond what the corpus itself changed. This section composes no prose:
 * a risk register is the last page on the site where a sentence should be
 * improved in passing.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe reaches `dist/risks.html` as `&#x27;` and a byte comparison
 * against the reviewed original fails on markup that reads perfectly in a
 * browser. Twelve of the cells below carry an apostrophe, a quotation mark, or
 * `<strong>` / `<code>` / `<em>` markup that must survive as markup. Every one
 * of them is rendered through `<Pinned>` (src/shell/PinnedText.tsx), which
 * writes the stored bytes straight onto the semantic element.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THE GUARDS READ OUT OF THIS DATA
 * ---------------------------------------------------------------------------
 * 1. THE UNMITIGATED COUNT IS DERIVED FROM THESE CELLS, NOT DECLARED.
 *    `apps/site/test/site.test.mjs` parses every
 *    `<dt>What is done</dt><dd>…</dd>` cell out of the built page, strips the
 *    tags, trims, and counts the ones whose text begins with "Nothing". That
 *    count is seven today — r1, r2, r4, r6, r8, r10, r15 — and it is what
 *    risks-hero must spell as "Seven of these have no mitigation" and
 *    who-its-for as "the seven where the honest answer is that nothing is
 *    done". Anything rendered before the word "Nothing" inside one of those
 *    cells — a label, a visually-hidden prefix, a wrapper element carrying
 *    text — drops the count and reds two sections nobody in this directory
 *    owns.
 *
 * 2. THE ANCHOR SET IS DERIVED THE SAME WAY. The contents heading
 *    ("All fifteen.") and the check that every `<article class="risk" id="rN">`
 *    has a matching `href="#rN"` are both computed from the ids emitted here.
 *    Adding, removing or renumbering an entry moves risks-contents with it.
 *
 * 3. r5 MUST NOT CARRY A MITIGATED CHIP, and must say the sequencer path has
 *    "never run against a real" or "never executed against a real" feed. Its
 *    severity class is plain `severity` for that reason, and the sentence is
 *    in its "What is done" cell. The guard slices the page between `id="r5"`
 *    and `id="r6"`, so both facts have to be inside this entry.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBERS, EACH READ OUT OF THE CONFIGURATION OR THE CONTRACT
 * ---------------------------------------------------------------------------
 * Every figure quoted in the cells below is a reference-configuration value
 * or a contract constant. As of the 2026-09-05 target-chain decision the
 * reference configuration is `contracts/config/robinhood-mainnet.json`, not
 * `contracts/config/base-mainnet.json` — see that file's own header note for
 * the small set of values that actually differ between the two (the oracle
 * heartbeat and the sequencer feed address; everything else is identical).
 *
 *   r3  "86,400 seconds" staleness bound, on Robinhood Chain
 *     contracts/config/robinhood-mainnet.json  chainlinkOracle.assets[].heartbeatSeconds = 86400
 *       (base-mainnet.json sets 3600 for Base; robinhood-mainnet.json's own header
 *       note explains the difference: the measured Chainlink heartbeat on chain 4663
 *       is 86,400 s, which is also `ChainlinkOracle.MAX_HEARTBEAT`.)
 *
 *   r5  the 3,600-second grace period (unchanged by the chain pivot — this is
 *       `ChainlinkOracle.GRACE_PERIOD`, a contract constant, not a per-chain config value)
 *
 *   r3  the two sane-price bands
 *     WETH  minPriceWad 100000000000000000000       = $100
 *           maxPriceWad 100000000000000000000000    = $100,000
 *     cbBTC minPriceWad 1000000000000000000000      = $1,000
 *           maxPriceWad 1000000000000000000000000   = $1,000,000
 *     All four are asserted present on how-it-works.html AND disclaimers.html.
 *
 *   r6  "24 hours in the reference configuration (a zero timelock plus a
 *       24-hour execution window)"
 *     contracts/config/robinhood-mainnet.json  smoke.gov.executionWindow = 86400
 *     The zero timelock is a parameter of the REFERENCE CONFIGURATION, not of
 *     any particular deployed vault — no vault has been created yet (see
 *     status.html), which is why the sentence names the configuration rather
 *     than a vault.
 *
 *   r7  "25% of voting-eligible stake" quorum floor, and the reference minimum
 *     contracts/config/robinhood-mainnet.json  smoke.gov.quorumBps = 2500
 *     contracts/config/robinhood-mainnet.json  smoke.minDepositUsdc = 100000000 (6 dp)
 *     "about 400 USDG" is four of those seats — the four a single-member vault
 *     needs to leave the sub-five regime.
 *
 *   r7  the delegate concentration cap named as "a cap on how much delegated
 *       weight any single delegate may receive"
 *     contracts/config/robinhood-mainnet.json  smoke.gov.concentrationCapBps = 4000
 *
 *   r8  "100% of voting-eligible stake plus a timelock" — the cell's own prose
 *       states the mechanism as "100%"; index.html's parallel card (see
 *       index-immutability) states the same mechanism as "full consensus"
 *       instead. Both are correct; the corpus itself uses both phrasings.
 *     contracts/src/Governance.sol:538-541  a RuleChange passes only on
 *       p.revealedWeight == p.snapshotTotal && p.forWeight >= p.snapshotTotal
 *     contracts/src/Governance.sol:531      passing starts the timelock
 *
 *   r14  REPOINTED 2026-09-05, copy deck v2. Owner: "I haven't created the
 *     safe vault yet. I want the pivot to the all-stocks index." The cell
 *     used to name a planned 50,000 USDG capacity cap; that figure described
 *     a vault that will not be created, so the cell states the honest,
 *     figure-free version instead — a capacity cap is a per-vault parameter
 *     and no vault exists. Its opening word is load-bearing: it must not
 *     start with "Nothing", or the risks-hero "Seven of these have no
 *     mitigation" count (derived from cells that DO start with "Nothing")
 *     goes to eight.
 *

 *   r6  the Mode-F trigger
 *     contracts/src/Governance.sol:648-659  hasPendingExecution returns true
 *       from p.commitDeadline onward — the reveal phase, not passage.
 */
import { MODE_F_TRIGGER } from '../../shell/pinned';

/** One `<dt>`/`<dd>` pair. Both are HTML source bytes; both render bare. */
export type RiskRow = {
  /** Exactly "What it is", "Worst case" or "What is done". */
  readonly dt: string;
  readonly dd: string;
};

export type RiskEntry = {
  /** r1..r15. The anchor risks-contents links to, and the guard reads. */
  readonly id: string;
  /**
   * The chip class, verbatim from the source: `severity`, or
   * `severity severity--accepted` where the entry is an accepted residual.
   * `severity--mitigated` appears nowhere, and r5 must never acquire it.
   */
  readonly severityClass: string;
  readonly severityLabel: string;
  readonly heading: string;
  readonly rows: readonly RiskRow[];
};

/**
 * The Mode-F trigger clause as it reads mid-sentence in r6.
 *
 * The clause is a passage that travels — it appears on how-it-works, faq,
 * who-its-for, agents and here — so it is imported from the one place that
 * holds it rather than retyped into this file. The source cell opens the
 * clause mid-sentence, after "And ", so the first letter is folded and every
 * other byte is the constant's. The fold is checked two ways: the generator
 * asserted the spliced string reproduces the source cell exactly, and
 * __probe.mjs asserts the rendered r6 cell is byte-equal to the reviewed
 * original.
 *
 * Five misstatements of this clause are asserted ABSENT from every page —
 * "passed-but-pending", "passed-but-unexecuted", "between a vote passing",
 * "vote passing and execut", and "rebalance has passed but has not yet
 * executed". The queue opens when the reveal phase opens, which is when
 * Governance.hasPendingExecution starts returning true at p.commitDeadline
 * (contracts/src/Governance.sol:648-659), not when a proposal passes.
 */
const MODE_F_CLAUSE = MODE_F_TRIGGER.charAt(0).toLowerCase() + MODE_F_TRIGGER.slice(1);

/** The fifteen entries, in document order. */
export const ENTRIES: readonly RiskEntry[] = [
  {
    id: "r1",
    severityClass: "severity severity--accepted",
    severityLabel: "Structural, no mitigation exists",
    heading: "1. Immutability itself",
    rows: [
      { dt: "What it is", dd: "The contracts carry no proxy, no upgrade path, no pause and no admin key, and they are deployed on Robinhood Chain mainnet, chain id 4663, broadcast on 2026-09-05. What runs is what runs, permanently." },
      { dt: "Worst case", dd: "A critical bug that survived review is permanent. Funds may be unrecoverable, and no party has any power to stop it, patch it or claw anything back. That includes the people who wrote the code." },
      { dt: "What is done", dd: "Nothing can be done now that it is on Robinhood Chain; that is the point. Before then: an external security review whose report is held privately, with no public report to check it against, four internal adversarial review rounds, and an AI pre-audit. The project's own history shows that is not enough. The AI pre-audit found five Critical issues in a frozen tree that had already passed internal review, and every fix required a full redeploy because nothing can be edited in place." },
    ],
  },
  {
    id: "r2",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted by design",
    heading: "2. An oracle freeze traps every exit",
    rows: [
      { dt: "What it is", dd: "If a price feed goes past its staleness bound, the oracle refuses to answer and every function that reads NAV reverts: deposits, rebalance execution and redemptions alike." },
      { dt: "Worst case", dd: "All active capital in the vault is frozen for as long as the feed stays past its bound, with exits included and no escape hatch. You cannot leave at any price while the freeze lasts. If the feed is deprecated or retired rather than merely late, the freeze does not end: a vault's oracle cannot be replaced, which is risk 15." },
      { dt: "What is done", dd: "Nothing, deliberately, and no hatch will be added. Any escape hatch is exactly the stale-price exit the breaker exists to prevent. The reasoning is that freezing beats mispricing: an exit priced off a stale feed is a transfer from the members who stay to whoever moves first. The one thing that stays reclaimable during a freeze is un-activated observation-window capital, because cancelling a pending deposit reads no oracle." },
    ],
  },
  {
    id: "r3",
    severityClass: "severity",
    severityLabel: "Partially mitigated",
    heading: "3. A single price provider, with no fallback",
    rows: [
      { dt: "What it is", dd: "Each asset is priced from exactly one Chainlink Data Feed. The basket is written on this site as ETH and BTC because that is what people call them, and on Robinhood Chain it is held as WETH at <code>0x0bd7d308f8e1639fab988df18a8011f41eacad73</code>, priced through ETH/USD, and cbBTC at <code>0xcec185eb182c47d1ba1efc84e6959e18cd620be4</code>, priced through CBBTC/USD. There is no second provider and no fallback source. This is a named residual risk, not an oversight." },
      { dt: "Worst case", dd: "A wrong answer that lands inside the sane-price band and inside the heartbeat is treated as truth, and the vault trades or settles on it. A feed deprecation fails that asset closed, which stops the vault rather than mispricing it. But there is nothing to fail over to." },
      { dt: "What is done", dd: "Three defences in the general case, and only two on Robinhood Chain: a heartbeat and staleness bound per asset (86,400 seconds in the reference mainnet configuration, which is the loosest bound the oracle constructor accepts), a plausibility band per asset that rejects prices outside it, and the sequencer gate &mdash; mandatory wherever Chainlink publishes an L2 Sequencer Uptime Feed, and Robinhood Chain has none to wire, so there it never runs. The band is wide. In the reference configuration that is $100 to $100,000 for WETH and $1,000 to $1,000,000 for cbBTC. It rejects gross errors. It does not reject an adverse but plausible price. The basket is limited to the two assets the reference configuration prices from a genuine Chainlink USD feed on Robinhood Chain, rather than reaching for assets that would need a weaker price source." },
    ],
  },
  {
    id: "r4",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted, no mitigation",
    heading: "4. USDG is pinned at $1.00 in the oracle",
    rows: [
      { dt: "What it is", dd: "The oracle does not price the settlement token. It assumes one dollar for USDG." },
      { dt: "Worst case", dd: "A sustained USDG depeg is mispriced by exactly the size of the depeg. Every NAV computed during it is wrong by that amount, and every deposit, redemption and rebalance priced off that NAV is wrong with it. There is no median and no second source to outvote the pin." },
      { dt: "What is done", dd: "Nothing. This one is accepted outright. If you think a sustained depeg is likely, this protocol misprices your position for the whole duration and you should treat that as disqualifying." },
    ],
  },
  {
    id: "r5",
    severityClass: "severity",
    severityLabel: "Handled in code, never exercised",
    heading: "5. Sequencer downtime",
    rows: [
      { dt: "What it is", dd: "Robinhood Chain is an Arbitrum Orbit L2 with a centralised sequencer. When it stops, on-chain prices stop being trustworthy before they stop being available." },
      { dt: "Worst case", dd: "A sequencer incident extends into a vault freeze that outlasts the incident itself, because the oracle will not price anything until the grace period has elapsed." },
      { dt: "What is done", dd: "A Chainlink L2 Sequencer Uptime Feed is mandatory, enforced at deploy time rather than at price time. The deploy script refuses any chain outside a local node, Base Sepolia and Robinhood Chain mainnet (chain id 4663) without one, and a pre-deploy check fails a configuration that omits it. Robinhood Chain was exempted by an owner-approved weakening of 2026-09-04, because Chainlink publishes no L2 Sequencer Uptime Feed for that network and is no longer expanding that feed set to additional networks, so there is no address an operator could supply. That exemption is a deliberate weakening: on Robinhood Chain the sequencer guard never runs at price time, so the per-feed heartbeat and the sane-price band carry this risk alone there. Handed a zero address the oracle skips the gate silently rather than reverting, which is why the deploy-time refusal is the defence that carries the weight everywhere it still applies. Where the feed is wired, the oracle enforces a 3,600-second grace period after the sequencer comes back up. The mitigation and the risk are the same mechanism: protection from stale-sequencer pricing comes from being locked out for an hour longer than the outage. This path has never executed against a real sequencer feed. Testnet leaves the feed address at zero by design, and Robinhood Chain has no feed to supply, so on Robinhood Chain it never executes at all." },
    ],
  },
  {
    id: "r6",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted by design",
    heading: "6. Forward-settled exits are irrevocable",
    rows: [
      { dt: "What it is", dd: "<strong>The reference configuration sets the timelock to zero, so a passed proposal is executable immediately and there is no delay in which to leave after seeing the outcome.</strong> And redemption requests queue in forward settlement mode, priced at post-execution NAV, " + MODE_F_CLAUSE + ". The window lasts until that proposal executes, is defeated, or its execution window lapses. A proposal that is ultimately defeated still forced your exit into the queue while it was live." },
      { dt: "Worst case", dd: "You can be right about disliking a rebalance, vote against it, request your exit, and still carry the full effect of its execution. Once queued, the request cannot be withdrawn. Your shares stay outstanding and keep gaining and losing with the vault, but they are locked: non-transferable and excluded from voting-eligible stake. There is no cap on how often this window recurs. One passed proposal holds it for the vault's timelock plus its execution window: 24 hours in the reference configuration (a zero timelock plus a 24-hour execution window), and up to 120 days at the protocol's hard caps (a 30-day timelock cap plus a 90-day execution-window cap, <code>Governance.sol</code>). A member holding a single minimum deposit can re-open proposals to hold exits in this mode roughly half the time, indefinitely, for the cost of gas." },
      { dt: "What is done", dd: "Nothing, deliberately. The alternative is worse: instant exits during that window would be a free option to leave at pre-rebalance prices while already knowing the outcome, paid for by every member who stayed. The recurrence is a known, accepted, unmitigated finding (M-7): the proposal cooldown raises its cost and does not remove it, because the cooldown is keyed per proposer and a second address sidesteps it. If the proposal is defeated or its execution window lapses without execution, a queued exit settles at the NAV current at settlement. But settlement is not automatic in that case. <code>settleQueuedExit</code> has to be called, and anyone can call it. Separately, <code>requestExit</code> takes no minimum-value parameter: your exit is an unbounded market order against whatever NAV settlement produces, there is no transaction-level floor you can set, and one was deliberately dropped for contract-size reasons. The operator's rebalance swaps do carry a minimum-out bound. Your principal does not." },
    ],
  },
  {
    id: "r7",
    severityClass: "severity",
    severityLabel: "Partially mitigated",
    heading: "7. Governance capture and thin electorates",
    rows: [
      { dt: "What it is", dd: "Voting is stake-weighted at five or more members, so a large enough holder can pass proposals. Below five members the vault takes a different branch: a proposal passes on either a majority of the members-at-creation revealing in favour while the favouring stake still clears the quorum, or an outright favouring stake majority. Both branches are stake-sensitive, so neither is a pure head count, and a rule change instead requires full consensus of eligible stake." },
      { dt: "Worst case", dd: "A small vault is governed by whoever holds the most. In the small-member regime the residual is not a cheap head-count flip: because both sub-five branches weigh stake, dust addresses cannot pass a proposal on numbers alone. What is still purchasable is the regime itself. Buying seats up to five moves the vault out of the signer-count branch and into the pure stake rule, and a seat costs one minimum deposit. At the reference 100 USDG minimum deposit that is about 400 USDG for the four seats a single-member vault needs. There is no contract-level floor here. The minimum deposit is chosen by whoever created the vault, and a low one makes capture cheap. Check it before you deposit. Proposals you oppose pass, and your exit settles after they execute." },
      { dt: "What is done", dd: "A protocol quorum floor of 25% of voting-eligible stake, a per-vault proposal threshold, a cap on how much delegated weight any single delegate may receive, and a minimum deposit that exists precisely as a listing constraint against cheap address-splitting in the small-member regime. There is also a per-proposer cooldown, which is not a defence against this: it is keyed per proposer, so a second address sidesteps it entirely. None of these makes a determined majority holder harmless, and the purchasable member count below five members remains open at the launch configuration as the one High-severity pre-audit finding reachable there." },
    ],
  },
  {
    id: "r8",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted by design",
    heading: "8. The rules can freeze permanently",
    rows: [
      { dt: "What it is", dd: "After a vault is funded, changing its rules requires 100% of voting-eligible stake plus a timelock." },
      { dt: "Worst case", dd: "One permanently offline member (a lost key, a death, a walked-away wallet) freezes the vault's rules forever. Nobody can change a parameter again, no matter how much everyone else agrees." },
      { dt: "What is done", dd: "Nothing. Unanimity is what makes \"nobody can change the rules behind you\" true, and a lower bar would make it false. The consequence is stated here rather than discovered later." },
    ],
  },
  {
    id: "r9",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted, no recovery path",
    heading: "9. Operator identity cannot be rotated",
    rows: [
      { dt: "What it is", dd: "The operator identity is attested by the registry at vault creation and is immutable for that vault. There is no rebind, and the payout address is permanent." },
      { dt: "Worst case", dd: "A compromised operator identity cannot be rotated, replaced or revoked. Whoever controls it controls the proposal right that identity carries, for as long as the vault exists." },
      { dt: "What is done", dd: "The remedy is procedural, not technical: wind the vault down through exits and launch a new one. The compromise cannot let an attacker move member funds, because operatorship confers no authority to vote, execute, pause, reprice, or move member funds. Nor can it be undone. Operators are told to use a multisig, because the address is permanent." },
    ],
  },
  {
    id: "r10",
    severityClass: "severity severity--accepted",
    severityLabel: "Not mitigable",
    heading: "10. Total loss is possible",
    rows: [
      { dt: "What it is", dd: "The vault holds spot crypto assets. Spot crypto assets fall, sometimes a long way, sometimes permanently." },
      { dt: "Worst case", dd: "You lose everything you deposited. Market losses, a permanent bug, or both." },
      { dt: "What is done", dd: "Nothing, and nothing can be. There is no insurance fund, no backstop, no reimbursement and no party who makes anyone whole. Do not deposit what you cannot afford to lose entirely." },
    ],
  },
  {
    id: "r11",
    severityClass: "severity severity--accepted",
    severityLabel: "Open, unresolved",
    heading: "11. Securities and collective investment scheme recharacterization",
    rows: [
      { dt: "What it is", dd: "Interests in these vaults may be treated as securities, or as collective investment scheme interests, in some jurisdictions. This is an unresolved legal question, not a settled one." },
      { dt: "Worst case", dd: "A regulator takes that view. Participants face consequences that depend entirely on where they are, and this project cannot indemnify anyone against them." },
      { dt: "What is done", dd: "Disclosure, and an intended geofence. Nothing on this site is an offer, a solicitation, or financial advice, and no part of it is intended to induce anyone to part with money. Access from restricted jurisdictions is intended to be geofenced at the front end, a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone, with or without a front end. Take your own advice about your own jurisdiction. This site will not characterize your position for you." },
    ],
  },
  {
    id: "r12",
    severityClass: "severity",
    severityLabel: "Out of review scope",
    heading: "12. The reference agent is beta code",
    rows: [
      { dt: "What it is", dd: "A reference operator agent ships in the repository. It is beta reference code and it sat outside the scope of the contract security review. Running it live is what exposed two launch-class bugs in it: one gate could never admit a new operator, and a deposit path set no token allowance and therefore reverted in every configuration as shipped. Both are fixed with regression tests. Both were invisible to mocks." },
      { dt: "Worst case", dd: "An operator runs it as-is, it proposes something the operator did not intend, and the members pass it." },
      { dt: "What is done", dd: "It is labelled as reference code here and in the repository. It is an ordinary member address. In governance it can only propose and vote its own weight, so its failure mode is a bad proposal, not a theft. Read it before you run it, and do not run it against real capital on the assumption that anyone has checked it." },
    ],
  },
  {
    id: "r13",
    severityClass: "severity",
    severityLabel: "Open, owner decision",
    heading: "13. An open licensing question",
    rows: [
      { dt: "What it is", dd: "Vendored third-party mathematics is under GPL-2.0-or-later and MIT terms in a repository whose own licence is MIT. The MIT half now matches the repository; the GPL-2.0-or-later half does not." },
      { dt: "Worst case", dd: "The combination is judged incompatible, and the licensing of part of the tree has to change." },
      { dt: "What is done", dd: "It is recorded as an open owner decision rather than quietly left alone. It is disclosed here because you should know about it before you build on the repository, not after." },
    ],
  },
  {
    id: "r14",
    severityClass: "severity severity--accepted",
    severityLabel: "Structural",
    heading: "14. This is experimental software",
    rows: [
      { dt: "What it is", dd: "New contracts, a new governance mechanism and a new operator model, none of it battle-tested by time or volume." },
      { dt: "Worst case", dd: "Something nobody on this page thought of." },
      { dt: "What is done", dd: "A capacity cap is a per-vault parameter and no vault exists, so there is no blast-radius bound in place today. Do not deposit what you cannot afford to lose entirely." },
    ],
  },
  {
    id: "r15",
    severityClass: "severity severity--accepted",
    severityLabel: "Accepted, no recovery path",
    heading: "15. There is no oracle rotation path",
    rows: [
      { dt: "What it is", dd: "Each vault's oracle address is fixed in immutable code at construction. Governance has no oracle-shaped proposal. The factory's allowlist is fixed in its constructor with no add, no remove and no owner, and it governs only which oracle a <em>new</em> vault may be created with." },
      { dt: "Worst case", dd: "If a feed is deprecated or permanently retired, the freeze in risk 2 is permanent. Members are locked out for good, with the funds visibly on-chain and no party able to change it: not the operator, not the members, not the deployers. A replacement oracle cannot be attached to an existing vault; it can only be blessed for new vaults on a new factory, and existing vaults keep pricing through the dead one." },
      { dt: "What is done", dd: "Nothing, deliberately. The alternative is an address able to bless a new oracle, which is an address able to bless a fake price feed. That is the exact attack the allowlist exists to close, and such an address would be the protocol's first standing privileged role. Creating a new vault against a dead feed fails loudly rather than producing a brick, so the failure mode is \"that asset becomes unlistable until a new factory is published\", never \"broken vaults ship\". Publishing a new factory also restarts the operator registry, the leaderboard and the loss carryforward in a fresh registry." },
    ],
  },
];
