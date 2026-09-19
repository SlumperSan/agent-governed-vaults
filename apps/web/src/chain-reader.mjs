// @ts-check
/**
 * Turns raw chain reads into the vault shape the rest of this app already speaks.
 *
 * WHY THIS EXISTS. `live-adapter.mjs` builds vaults from the indexer's event projection, and its
 * own `MISSING_IN_LIVE` lists what that can never carry: NAV and NAV/share, basket composition,
 * oracle freshness, proposal deadlines, the exit-fee ceiling, and per-member position. Every one
 * of those is a `view` function on a contract and none of them is emitted. So the projection is
 * not behind — it is structurally incapable, and the only fix is to call the contracts.
 *
 * WHY THERE IS NO viem IN THIS FILE, AND NO NETWORK. `apps/web/src` has zero cross-package imports
 * and zero dependencies; that is what makes it runnable under `node --test` with no fixture server
 * and importable by any surface. Transport is the caller's problem: this module says WHICH calls to
 * make (`plan*`) and what the answers MEAN (`assemble*`). The twenty lines of viem that sit between
 * them are the part no test could cover anyway, and the decoding is where the bugs actually live —
 * decimals, WAD scaling, enum ordinals, and which timestamp belongs to which feed.
 *
 * WHY THE ABI FRAGMENTS ARE NOT HERE. `packages/canary/src/abis.mjs` already declares every view
 * this needs — `VAULT_VIEWS`, `GOVERNANCE_VIEWS`, `CHAINLINK_ORACLE_VIEWS`, `AGGREGATOR_V3_VIEWS` —
 * and `packages/canary/test/abis.test.mjs` recomputes its selectors against the contracts. A second
 * copy would drift from the contract silently, which is the failure mode ABI duplication always
 * has. The caller passes fragments in; this module names functions, never signatures.
 *
 * READS COME IN FOUR ROUNDS because each one needs an address the previous round returned:
 *
 *   1. `planCore`       — vault scalars, plus `basketLength`, `oracle` and `governance`
 *   2. `planBasketAssets`/`planProposalId` — the asset addresses, and whether a proposal exists
 *   3. `planLegs`/`planProposal`           — per-asset balances and prices; the proposal record
 *   4. `planFeeds`      — `latestRoundData` per Chainlink feed, for oracle freshness
 *
 * A caller that can multicall should batch each round; a caller that cannot may issue them
 * serially. Neither changes what `assembleVault` does with the answers.
 *
 * ONE READ IS LOAD-BEARING IN ITS FAILURE. `navWad()` reverts when any basket asset's price is
 * stale, out of band, or behind a down sequencer — `ChainlinkOracle.priceWad` reverting IS the
 * freeze, and `VaultCore.navWad` propagates it. So a reverted `navWad` is a FACT about the vault,
 * not a transport error, and `assembleVault` records it as `frozen: true` rather than discarding
 * the vault or reporting a zero NAV. Zero NAV and frozen render identically to a careless UI and
 * mean opposite things to a holder deciding whether to exit.
 */

/** `Governance.ProposalType`, by ordinal. Mirrors `PROPOSAL_TYPES` in governance.mjs. */
export const PROPOSAL_TYPE_BY_ORDINAL = Object.freeze(['Rebalance', 'RuleChange', 'ChildAllocation']);

/**
 * `Governance.Status`, by ordinal. `None` is index 0 and means NO PROPOSAL — it is not a status a
 * live proposal can hold, and `assembleProposal` returns null for it rather than emitting a
 * proposal whose status string is "None".
 */
export const PROPOSAL_STATUS_BY_ORDINAL = Object.freeze([
  'None',
  'Active',
  'Passed',
  'Defeated',
  'Executed',
  'Expired',
]);

/** A planned read. `abi` names which fragment table the caller should encode against. */
const call = (address, abi, fn, args = []) => Object.freeze({ address, abi, fn, args });

/**
 * Round 1 — everything readable from the vault address alone.
 *
 * `navWad` is first because it is the read allowed to revert meaningfully; a caller batching these
 * must keep per-call failures rather than failing the whole batch (viem's `multicall` needs
 * `allowFailure: true`, which is its default, and `readContract` needs a try/catch).
 *
 * @param {string} vault
 */
export function planCore(vault) {
  return Object.freeze([
    call(vault, 'VAULT_VIEWS', 'navWad'),
    call(vault, 'VAULT_VIEWS', 'totalShares'),
    call(vault, 'VAULT_VIEWS', 'idleUsdc'),
    call(vault, 'VAULT_VIEWS', 'usdcScalar'),
    call(vault, 'VAULT_VIEWS', 'totalPendingUsdc'),
    call(vault, 'VAULT_VIEWS', 'basketLength'),
    call(vault, 'VAULT_VIEWS', 'childVaultCount'),
    call(vault, 'VAULT_VIEWS', 'oracle'),
    call(vault, 'VAULT_VIEWS', 'governance'),
    call(vault, 'VAULT_VIEWS', 'creator'),
    call(vault, 'VAULT_VIEWS', 'operatorRegistry'),
  ]);
}

/**
 * Round 2a — the basket asset addresses, once `basketLength` is known.
 * @param {string} vault
 * @param {number} basketLength
 */
export function planBasketAssets(vault, basketLength) {
  const out = [];
  for (let i = 0; i < basketLength; i += 1) out.push(call(vault, 'VAULT_VIEWS', 'basketAssets', [i]));
  return Object.freeze(out);
}

/**
 * Round 2b — the vault's active proposal id, if it has one.
 *
 * `activeProposalOf` returns 0 for "none". Zero is a real absence here, not a missing read, and the
 * distinction matters downstream: `governance.mjs` treats `null` as KNOWN-ABSENT (which resolves
 * exits to Mode I, instant) and the string `'unknown'` as UNREAD. Asserting instant settlement on a
 * vault whose proposal was merely not fetched is the one lie that costs a holder money.
 *
 * @param {string} governance
 * @param {string} vault
 */
export function planProposalId(governance, vault) {
  return Object.freeze([
    call(governance, 'GOVERNANCE_VIEWS', 'activeProposalOf', [vault]),
    call(governance, 'GOVERNANCE_VIEWS', 'configOf', [vault]),
  ]);
}

/**
 * Round 3a — per-asset balance, unit and price, plus the feed behind each price.
 *
 * `assetUnit` is read rather than derived from `decimals()`: it is the exact denominator
 * `VaultCore._assetValueWad` divides by, so reading it means this module re-derives nothing and
 * assumes nothing about any token's decimals.
 *
 * @param {string} vault
 * @param {string} oracle
 * @param {readonly string[]} assets
 */
export function planLegs(vault, oracle, assets) {
  const out = [];
  for (const a of assets) {
    out.push(call(vault, 'VAULT_VIEWS', 'assetUnit', [a]));
    out.push(call(vault, 'VAULT_VIEWS', 'assetBalance', [a]));
    out.push(call(oracle, 'CHAINLINK_ORACLE_VIEWS', 'priceWad', [a]));
    out.push(call(oracle, 'CHAINLINK_ORACLE_VIEWS', 'feedOf', [a]));
  }
  return Object.freeze(out);
}

/**
 * Round 3b — the proposal record and its cranked-FOR figure. Only planned when `activeProposalOf`
 * returned non-zero.
 * @param {string} governance
 * @param {number|bigint} pid
 */
export function planProposal(governance, pid) {
  return Object.freeze([
    call(governance, 'GOVERNANCE_VIEWS', 'proposals', [pid]),
    // VO-2b: `delegatedForWeight` is a separate mapping, and `finalize` subtracts it from
    // `forWeight` in both sub-five stake terms. Without it `quorumReadout` reports the sub-five
    // regime as unknown rather than guessing zero, so this call is what makes that regime legible.
    call(governance, 'GOVERNANCE_VIEWS', 'delegatedForWeight', [pid]),
  ]);
}

/**
 * Round 3c — `paused()` and `isBlacklisted(vault)` on EACH basket leg's OWN token contract.
 * Card #32. Separate from `planLegs` (3a) on purpose: those are valuation reads against the
 * VAULT (assetUnit/assetBalance/priceWad), these are safety reads against the TOKEN, and a caller
 * may legitimately want to poll them on a different cadence than price.
 *
 * One call pair per leg, in basket order — this is what makes the assembled result "per leg"
 * rather than one flag for the whole basket, and it is written to work for however many legs
 * `basketLength` reports, not for two.
 *
 * @param {string} vault
 * @param {readonly string[]} assets
 */
export function planLegSafety(vault, assets) {
  const out = [];
  for (const a of assets) {
    out.push(call(a, 'TOKEN_SAFETY_VIEWS', 'paused'));
    out.push(call(a, 'TOKEN_SAFETY_VIEWS', 'isBlacklisted', [vault]));
  }
  return Object.freeze(out);
}

/**
 * Round 4 — `latestRoundData` per feed, for the `updatedAt` that oracle freshness turns on.
 *
 * Only the asset feeds belong here. The L2 sequencer uptime feed reads the SAME tuple but consumes
 * `answer` and `startedAt` and ignores `updatedAt` entirely, because it is event-driven and writes
 * only on an up↔down transition — so feeding it through this helper would report a months-old
 * sequencer feed as a stale price. See `ChainlinkOracle._requireSequencerUp`.
 *
 * @param {readonly string[]} feeds
 */
export function planFeeds(feeds) {
  return Object.freeze(feeds.map((f) => call(f, 'AGGREGATOR_V3_VIEWS', 'latestRoundData')));
}

/**
 * Per-member reads. Separate from the vault rounds because they are the only ones that need a
 * connected wallet, and a disconnected visitor must still see the whole vault.
 * @param {string} vault
 * @param {string} member
 */
export function planPosition(vault, member) {
  return Object.freeze([
    call(vault, 'VAULT_VIEWS', 'sharesOf', [member]),
    call(vault, 'VAULT_VIEWS', 'queuedExitShares', [member]),
    call(vault, 'VAULT_VIEWS', 'costBasisUsdc', [member]),
  ]);
}

/**
 * A member's vote-custody reads for one proposal — `apps/web/src/vote-custody.mjs`'s only source
 * of truth. Separate from `planPosition`: those are read for every connected member on every
 * vault, these only when a member is looking at a proposal they may have committed on.
 *
 * @param {string} governance
 * @param {number|bigint} pid
 * @param {string} member
 */
export function planVoteCommit(governance, pid, member) {
  return Object.freeze([
    call(governance, 'GOVERNANCE_VIEWS', 'commitOf', [pid, member]),
    call(governance, 'GOVERNANCE_VIEWS', 'revealedOf', [pid, member]),
    call(governance, 'GOVERNANCE_VIEWS', 'revealedSupportOf', [pid, member]),
  ]);
}

const ZERO_BYTES32 = '0x' + '0'.repeat(64);
const isBytes32Hex = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Assemble `planVoteCommit`'s three reads into the shape `vote-custody.mjs` expects.
 *
 * Mirrors `assembleLegSafety` / `PROPOSAL_UNKNOWN`: only an EXACT typed value earns "known". A
 * `bytes32(0)` commitment IS a real, known "no commit" answer — `commitOf` cannot revert on a
 * well-formed call, so a zero here means the mapping is genuinely empty. Anything else (`null`,
 * `undefined`, a revert, a timeout, a call never attempted, or a malformed string) is left
 * `undefined` — UNREAD, never coerced into "no commit" or "not revealed". Reporting a member
 * ready to reveal off an unread commit is the exact failure this module exists to prevent.
 *
 * @param {{commitOfValue: unknown, revealedValue: unknown, revealedSupportValue: unknown}} r
 * @returns {{onChainCommitment: string|undefined, revealed: boolean|undefined, revealedSupport: boolean|undefined}}
 */
export function assembleVoteCommit(r) {
  return Object.freeze({
    onChainCommitment: isBytes32Hex(r.commitOfValue) ? r.commitOfValue : undefined,
    revealed: r.revealedValue === true || r.revealedValue === false ? r.revealedValue : undefined,
    revealedSupport:
      r.revealedSupportValue === true || r.revealedSupportValue === false ? r.revealedSupportValue : undefined,
  });
}

/** Exported so `vote-custody.mjs` and its tests share one definition of "genuinely no commit". */
export const VOTE_COMMIT_ZERO = ZERO_BYTES32;

/**
 * NAV per share, in WAD.
 *
 * Returns 0n for an empty vault rather than dividing by zero. An empty vault has no price per
 * share; 0n is how the fixtures and `vaultView` already spell that, and it renders as "—".
 *
 * @param {bigint} navWad
 * @param {bigint} totalShares
 */
export function navPerShareWad(navWad, totalShares) {
  return totalShares === 0n ? 0n : (navWad * 10n ** 18n) / totalShares;
}

/**
 * One basket leg's USD value in WAD — the same arithmetic as `VaultCore._assetValueWad`:
 * `balance * priceWad / assetUnit`, multiplying before dividing so the division truncates once.
 *
 * @param {{balance: bigint, priceWad: bigint, assetUnit: bigint}} leg
 */
export function legValueWad(leg) {
  return leg.assetUnit === 0n ? 0n : (leg.balance * leg.priceWad) / leg.assetUnit;
}

/**
 * Basket weights in basis points of NAV.
 *
 * Weights are computed against `navWad`, NOT against the summed basket value, because idle USDC and
 * any child-vault value are part of NAV too. Dividing by the basket total instead would show a
 * vault that is 90% idle cash as fully allocated.
 *
 * @param {readonly {valueWad: bigint}[]} legs
 * @param {bigint} navWad
 */
export function weightsBps(legs, navWad) {
  if (navWad === 0n) return legs.map(() => 0);
  return legs.map((l) => Number((l.valueWad * 10_000n) / navWad));
}

/**
 * Assemble one basket leg from its four reads.
 *
 * `maxStalenessSec` comes from the feed's `heartbeat`, which is what `ChainlinkOracle` itself
 * compares `updatedAt` against — not a constant chosen here.
 *
 * @param {{address: string, symbol?: string, decimals?: number, assetUnit: bigint,
 *          balance: bigint, priceWad: bigint, feed: {feed: string, heartbeat: number|bigint},
 *          oracleUpdatedAt: number}} r
 */
export function assembleLeg(r) {
  const leg = {
    address: r.address,
    symbol: r.symbol ?? '',
    decimals: r.decimals ?? 0,
    assetUnit: r.assetUnit,
    balance: r.balance,
    priceWad: r.priceWad,
    feed: r.feed.feed,
    oracleUpdatedAt: r.oracleUpdatedAt,
    maxStalenessSec: Number(r.feed.heartbeat),
    weightBps: 0,
    valueWad: 0n,
  };
  leg.valueWad = legValueWad(leg);
  return leg;
}

/**
 * The tri-state a per-leg safety read renders as. Deliberately NOT a boolean — see
 * `assembleLegSafety`, which is the function this whole card (#32) exists for.
 * @typedef {'active'|'paused'|'unknown'} PausedState
 * @typedef {'clear'|'blacklisted'|'unknown'} BlacklistState
 */

/** What a leg's safety reads look like before any call has been attempted — unknown, never "fine". */
/** An address lowercased for comparison, or '' when there is nothing usable to compare. */
const lcAddr = (a) => (typeof a === 'string' ? a.toLowerCase() : '');

export const LEG_SAFETY_UNREAD = Object.freeze({
  paused: /** @type {PausedState} */ ('unknown'),
  pausedReadAt: null,
  blacklisted: /** @type {BlacklistState} */ ('unknown'),
  blacklistedReadAt: null,
});

/**
 * Turn one leg's two safety reads into a tri-state record — never a boolean.
 *
 * `pausedValue`/`blacklistedValue` must be the EXACT boolean the contract returned, or anything
 * else to mean "not established": `null` for a revert, a timeout, or a call the caller never made;
 * `undefined` for the same; and — on purpose — any other shape too (a string, a number, an object),
 * because a decode failure downstream is exactly as untrustworthy as an explicit revert and must
 * not be laundered into a boolean by whatever coerced it. Only `=== true` reads as the alarming
 * state and only `=== false` reads as the clear one; everything else is `'unknown'`. There is no
 * `?? false` in this function, on purpose — that is the exact defect card #32 exists to prevent: an
 * unreachable RPC endpoint must never render as "this asset is fine", because that is precisely the
 * moment nobody can verify it.
 *
 * `pausedReadAt`/`blacklistedReadAt` are carried through UNCHANGED, per call, from whatever the
 * caller stamped when that specific call answered (or failed) — never overwritten with a shared
 * "now" here. Two legs, or even the two calls on one leg, read seconds apart are two distinct facts
 * about two distinct moments; collapsing them onto one batch timestamp would let a stale answer
 * borrow a fresh one's clock, which is exactly how a member is shown a paused asset as current.
 *
 * @param {{address: string, pausedValue: unknown, pausedReadAt: number|null,
 *          blacklistedValue: unknown, blacklistedReadAt: number|null}} r
 * @returns {{address: string, paused: PausedState, pausedReadAt: number|null,
 *            blacklisted: BlacklistState, blacklistedReadAt: number|null}}
 */
export function assembleLegSafety(r) {
  const paused = r.pausedValue === true ? 'paused' : r.pausedValue === false ? 'active' : 'unknown';
  const blacklisted =
    r.blacklistedValue === true ? 'blacklisted' : r.blacklistedValue === false ? 'clear' : 'unknown';
  return Object.freeze({
    address: r.address,
    paused,
    pausedReadAt: r.pausedReadAt ?? null,
    blacklisted,
    blacklistedReadAt: r.blacklistedReadAt ?? null,
  });
}

/**
 * Assemble the proposal record, or null when the vault has none.
 *
 * Returns null ONLY for a genuine absence — `pid` of 0, or `Status.None`. A caller that did not
 * read governance at all must not call this; it should pass `PROPOSAL_UNKNOWN` through instead, so
 * that "no proposal" and "not looked" stay distinguishable all the way to the exit-mode readout.
 *
 * Deadlines arrive as `uint64` and are converted to Number. Every one is a unix second; 2^53
 * seconds is past the heat death of the sun, so the conversion is lossless for any real value.
 *
 * @param {number|bigint} pid
 * @param {null | {ptype: number|bigint, proposer: string, createdAt: number|bigint,
 *   commitDeadline: number|bigint, revealDeadline: number|bigint, executableAt: number|bigint,
 *   expiresAt: number|bigint, status: number|bigint, actionHash: string, snapshotTotal: bigint,
 *   memberCount: bigint, forWeight: bigint, againstWeight: bigint, revealedWeight: bigint,
 *   revealedVoterCount: bigint}} p
 * @param {bigint|number|null} [delegatedForWeight] from the sibling `delegatedForWeight(pid)` call
 */
export function assembleProposal(pid, p, delegatedForWeight) {
  if (!p || BigInt(pid) === 0n) return null;
  const status = PROPOSAL_STATUS_BY_ORDINAL[Number(p.status)];
  if (status === undefined || status === 'None') return null;

  // A deadline of 0 is "not set for this type", not "1 January 1970". RuleChange carries no
  // executableAt until it passes, and Rebalance carries no expiresAt until then either;
  // `proposalPhase` reads a missing deadline as unknown and an epoch-zero one as long past.
  const at = (v) => (BigInt(v) === 0n ? null : Number(v));

  return {
    pid: Number(pid),
    ptype: PROPOSAL_TYPE_BY_ORDINAL[Number(p.ptype)] ?? 'unknown',
    status,
    proposer: p.proposer,
    createdAt: Number(p.createdAt),
    commitDeadline: at(p.commitDeadline),
    revealDeadline: at(p.revealDeadline),
    executableAt: at(p.executableAt),
    expiresAt: at(p.expiresAt),
    actionHash: p.actionHash,
    snapshotTotal: p.snapshotTotal,
    memberCount: Number(p.memberCount),
    forWeight: p.forWeight,
    againstWeight: p.againstWeight,
    revealedWeight: p.revealedWeight,
    revealedVoterCount: Number(p.revealedVoterCount),
    // Left `undefined` when the second call is absent or reverted, NEVER 0n: `quorumReadout` reads
    // an absent figure as "unknown" and a zero as "no cranked weight", and those are different
    // answers in the sub-five regime (VO-2b).
    delegatedForWeight: delegatedForWeight === undefined || delegatedForWeight === null
      ? undefined
      : BigInt(delegatedForWeight),
  };
}

/**
 * Assemble the whole vault from every round's decoded answers.
 *
 * `navWad` of null means the read REVERTED, which is the frozen state — see the header. The vault
 * is still returned, with its basket and proposal intact, because a frozen vault is exactly when a
 * holder most needs to see why. `navPerShareWad` is 0n in that case and `frozen` is true.
 *
 * @param {{
 *   address: string,
 *   core: {navWad: bigint|null, totalShares: bigint, idleUsdc: bigint, usdcScalar: bigint,
 *          totalPendingUsdc: bigint, oracle: string, governance: string, creator: string,
 *          childVaultCount?: number|bigint},
 *   legs?: readonly {valueWad: bigint}[],
 *   legSafety?: readonly ({address: string, paused: PausedState, pausedReadAt: number|null,
 *     blacklisted: BlacklistState, blacklistedReadAt: number|null} | undefined)[],
 *   proposal?: unknown,
 *   governanceConfig?: Record<string, unknown> | null,
 *   name?: string, operatorName?: string, operatorAddress?: string, attested?: boolean,
 *   holderCount?: number,
 *   blockNumber?: bigint|number|null,
 * }} r
 */
export function assembleVault(r) {
  const frozen = r.core.navWad === null;
  const navWad = r.core.navWad ?? 0n;
  const legs = r.legs ?? [];
  const weights = weightsBps(legs, navWad);

  /**
   * Safety records keyed by the address they name, so a leg is matched by IDENTITY rather than by its
   * position in an array the caller happened to build in some order.
   *
   * FAILS CLOSED TWICE OVER. A record with no usable address is dropped, and two records naming the
   * same address make that address ambiguous — so it maps to nothing and the leg reads `unknown`,
   * rather than one of the two being picked. Both are "no answer", which is the only safe answer
   * about whether an asset is paused or blacklisted.
   */
  const safetyByAddress = new Map();
  const ambiguous = new Set();
  for (const rec of r.legSafety ?? []) {
    const key = lcAddr(rec?.address);
    if (!key) continue;
    if (safetyByAddress.has(key) || ambiguous.has(key)) {
      safetyByAddress.delete(key);
      ambiguous.add(key);
      continue;
    }
    safetyByAddress.set(key, rec);
  }

  return {
    address: r.address,
    name: r.name ?? '',
    operatorName: r.operatorName ?? '',
    operatorAddress: r.operatorAddress ?? '',
    attested: r.attested ?? false,
    frozen,
    chainRead: true,

    navWad,
    navPerShareWad: frozen ? 0n : navPerShareWad(navWad, r.core.totalShares),
    totalShares: r.core.totalShares,
    idleUsdc: r.core.idleUsdc,
    totalPendingUsdc: r.core.totalPendingUsdc,
    usdcScalar: r.core.usdcScalar,
    holderCount: r.holderCount ?? 0,
    childVaultCount: Number(r.core.childVaultCount ?? 0),

    oracle: r.core.oracle,
    governance: r.core.governance,
    creator: r.core.creator,

    // Card #32: every leg carries its own paused/blacklisted tri-state and its own read
    // timestamps. A leg whose safety reads were never supplied gets LEG_SAFETY_UNREAD — unknown,
    // not a silent "active"/"clear" — rather than omitting the fields and letting some later
    // `leg.paused === false` read an absence as a clean bill of health.
    //
    // MATCHED ON ADDRESS, NEVER ON POSITION. This merged `r.legSafety[i]` by index and threw away the
    // `address` every safety record already carries. A reordered array then rendered a **paused and
    // blacklisted** asset as `active` / `clear` with a fresh timestamp — a confident wrong answer,
    // which is strictly worse than the `unknown` this whole tri-state exists to preserve: the review
    // that found it demonstrated it live, and the test below only ever passed a perfectly ordered
    // array, so it asserted the property in the one case where index and identity agree.
    basket: legs.map((l, i) => {
      const safety = safetyByAddress.get(lcAddr(l.address));
      return {
        ...l,
        weightBps: weights[i],
        paused: safety?.paused ?? LEG_SAFETY_UNREAD.paused,
        pausedReadAt: safety?.pausedReadAt ?? LEG_SAFETY_UNREAD.pausedReadAt,
        blacklisted: safety?.blacklisted ?? LEG_SAFETY_UNREAD.blacklisted,
        blacklistedReadAt: safety?.blacklistedReadAt ?? LEG_SAFETY_UNREAD.blacklistedReadAt,
      };
    }),
    proposal: r.proposal ?? null,
    governanceConfig: r.governanceConfig ?? null,

    // Freshness travels with the data, so a stale render is visible rather than silent.
    blockNumber: r.blockNumber ?? null,
  };
}

/**
 * The fields this reader fills that the indexer projection cannot — the complement of
 * `live-adapter.mjs`'s `MISSING_IN_LIVE`, kept beside it so the two lists are checked against each
 * other by test rather than by memory.
 */
export const FILLED_BY_CHAIN_READ = Object.freeze([
  'NAV, NAV/share, basket composition',
  'Oracle freshness / frozen state',
  'Proposal deadlines — so exit Mode I vs F',
  'Your position, pending deposit and queued exit',
]);
