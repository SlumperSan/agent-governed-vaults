// @ts-check
/**
 * Demo scenario — three vaults chosen to exercise every branch of the policy in one pass.
 *
 * This is FIXTURE DATA, not live protocol state. The contracts are not deployed yet (issue #10,
 * `VaultFactory` over the EIP-170 cap), so there is no chain to read and no indexer with real
 * history. Rather than run the demo against an empty snapshot — which produces "0 vaults known"
 * and an incoherent narrative — the same events are folded through the REAL projection code
 * (`seed-snapshot.mjs` → `packages/indexer/src/projections.mjs`) so the API serves them exactly as
 * it would serve real ones, and the chain half comes from the stub reader, which marks every value
 * it produces `[stub-chain]`.
 *
 * The story the three vaults tell:
 *
 *   MERIDIAN  attested, profitable operator, room under the cap, fees in bounds → JOIN
 *   DRIFTER   operatorId 0 — unattested, the scam-quarantine signal              → REFUSE
 *   HELIOS    already held; operator's realized net has gone negative, an active Rebalance
 *             proposal is in its reveal phase with a commit this agent already made, and a
 *             passed-but-unexecuted rebalance is outstanding
 *             → REVEAL (the S-4 path), then EXIT as Mode F (forward-priced)
 */

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;

export const DEMO_VAULTS = Object.freeze({
  meridian: '0x1111111111111111111111111111111111111111',
  drifter: '0x2222222222222222222222222222222222222222',
  helios: '0x3333333333333333333333333333333333333333',
});

export const DEMO_OPERATORS = Object.freeze({
  meridian: { opId: 1, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' },
  helios: { opId: 2, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2' },
});

/** The active Rebalance proposal on HELIOS. */
export const DEMO_PID = 42n;

/** vault ⇒ chain-read fixture consumed by createStubChainReader. */
export const DEMO_FIXTURE_CHAIN = Object.freeze({
  [DEMO_VAULTS.meridian]: {
    operatorId: 1,
    navPerShareWad: (WAD * 1042n) / 1000n, // +4.2% since inception
    totalAssetsUsdc: 400_000n * USDC,
    idleUsdc: 8_000n * USDC, // 200bps idle — inside the drift band
    totalPendingUsdc: 5_000n * USDC,
    totalShares: 384_000n * USDC,
    capacityCapUsdc: 1_000_000n * USDC,
    isCapped: true,
    minDepositUsdc: 10n * USDC,
    stackedPerfFeeBps: 1000,
    stackedExitFeeCapBps: 100,
    depth: 0,
    self: {}, // no position yet
  },

  [DEMO_VAULTS.drifter]: {
    operatorId: 0, // unattested
    navPerShareWad: WAD,
    totalAssetsUsdc: 12_000n * USDC,
    idleUsdc: 12_000n * USDC,
    totalPendingUsdc: 0n,
    totalShares: 12_000n * USDC,
    capacityCapUsdc: 0n, // uncapped — the case a naive `deposit <= cap` gets wrong
    isCapped: false,
    minDepositUsdc: 1n * USDC,
    stackedPerfFeeBps: 1000,
    stackedExitFeeCapBps: 100,
    depth: 0,
    self: {},
  },

  [DEMO_VAULTS.helios]: {
    operatorId: 2,
    navPerShareWad: (WAD * 862n) / 1000n, // 13.8% below the entry mark seeded below
    totalAssetsUsdc: 90_000n * USDC,
    idleUsdc: 27_000n * USDC, // 3000bps idle — above the drift band, below the max
    totalPendingUsdc: 0n,
    totalShares: 104_000n * USDC,
    capacityCapUsdc: 250_000n * USDC,
    isCapped: true,
    minDepositUsdc: 10n * USDC,
    stackedPerfFeeBps: 1000,
    stackedExitFeeCapBps: 100,
    depth: 0,
    self: {
      shares: 1_500n * USDC,
      exitFeeBps: 60,
      queuedExitShares: 0n,
      windowCleared: true,
      skipOptIn: false,
      pendingAmount: 0n,
      pendingAvailableAt: 0,
    },
  },
});

/**
 * Governance fixture. The HELIOS proposal sits in its REVEAL phase with an outstanding commit,
 * which is the restart scenario: the agent holds no vote state and must recover the salt from its
 * wallet to reveal. `commitment` is filled in at run time by `withDemoCommitment` once a demo
 * account exists, because the commitment is a function of that account's address and signature.
 *
 * @param {number} nowSec
 */
export function demoGovernance(nowSec) {
  return {
    [DEMO_VAULTS.meridian]: {
      hasPendingExecution: false,
      activePid: 0n,
      proposal: null,
      commitment: null,
      hasOutstandingCommit: false,
      revealed: null,
    },
    [DEMO_VAULTS.helios]: {
      // This vault has a pending execution, which is what turns an exit into Mode F (§4.4) —
      // here a passed-but-unexecuted rebalance, but any active proposal past reveal start does it.
      hasPendingExecution: true,
      activePid: DEMO_PID,
      proposal: {
        pid: DEMO_PID,
        vault: DEMO_VAULTS.helios,
        ptype: 0,
        ptypeName: 'Rebalance',
        proposer: DEMO_OPERATORS.helios.address,
        createdAt: nowSec - 7200,
        commitDeadline: nowSec - 600, // commit phase closed
        revealDeadline: nowSec + 2400, // 40 minutes to forfeiture
        executableAt: nowSec + 6000,
        expiresAt: nowSec + 86400,
        status: 1,
        statusName: 'Active',
        actionHash: '0x' + 'ab'.repeat(32),
        snapshotTotal: 104_000n * USDC,
        memberCount: 11,
        forWeight: 0n,
        againstWeight: 0n,
        revealedWeight: 0n,
        revealedVoterCount: 0n,
      },
      commitment: null,
      hasOutstandingCommit: false,
      revealed: false,
    },
  };
}

/** Frozen default for callers that do not need a live clock (tests pass their own nowSec). */
export const DEMO_FIXTURE_GOV = demoGovernance(Math.floor(Date.now() / 1000));

/**
 * Install a real commitment for the demo account, so the reveal path is genuinely exercised:
 * the fixture's on-chain commitment is one the account actually produced, and `recoverVote` has
 * to re-derive the salt to match it. Without this the demo would only prove that a refusal path
 * logs nicely.
 *
 * @param {Record<string, any>} gov
 * @param {string} commitment
 */
export function withDemoCommitment(gov, commitment) {
  return {
    ...gov,
    [DEMO_VAULTS.helios]: { ...gov[DEMO_VAULTS.helios], commitment, hasOutstandingCommit: true, revealed: false },
  };
}

/** The agent's entry mark on HELIOS — the drawdown baseline the exit policy measures against. */
export const DEMO_ENTRY_MARKS = Object.freeze({ [DEMO_VAULTS.helios]: WAD });
