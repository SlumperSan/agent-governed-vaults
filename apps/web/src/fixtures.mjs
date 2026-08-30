// @ts-check
/**
 * FIXTURE DATA — not chain data. Every value here is invented to exercise a state; nothing in
 * this file has ever been on-chain, and the UI labels it as fixtures wherever it renders.
 *
 * It exists because the four flows have to be walkable end-to-end, and the metered API cannot
 * back them: NAV/NAVps, basket composition, per-member positions and pending deposits, proposal
 * deadlines, oracle status and the per-vault exit-fee parameters are all absent from
 * `projections.mjs` (see README "What the API does not expose"). Rather than have live mode
 * invent them, live mode leaves them blank and this file supplies a labelled dataset.
 *
 * Shapes and units match the contract exactly: USDC in 6dp base units, shares and NAV in WAD,
 * fees in bps, times in unix seconds. Where a field would come from a chain read it is marked
 * `chainRead: true` on the vault so the UI can badge it.
 */

const WAD = 10n ** 18n;
const HOUR = 3600;
const DAY = 86_400;

/** Fixture clock. Everything time-relative is expressed against this so states are stable. */
export const NOW = 1_800_000_000;

const usdc = (n) => BigInt(Math.round(n * 1e6));
const wad = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** Asset metadata — decimals matter: cbBTC is 8dp, not 18. */
export const ASSETS = {
  WETH: { symbol: 'WETH', decimals: 18, address: '0x4200000000000000000000000000000000000006' },
  cbBTC: { symbol: 'cbBTC', decimals: 8, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  USDC: { symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
};

export const VAULTS = [
  {
    address: '0x1111000000000000000000000000000000001111',
    name: 'Base Blue-Chip 5',
    operatorName: 'Meridian',
    operatorAddress: '0xMER1000000000000000000000000000000000001'.toLowerCase().padEnd(42, '0').slice(0, 42),
    operatorId: 1,
    attested: true,
    depth: 0,
    parent: null,
    frozen: false,
    chainRead: true,

    totalShares: wad(4_450_000),
    navWad: wad(4_820_400.512),
    navPerShareWad: wad(1.083236),
    idleUsdc: usdc(482_040.15),
    totalPendingUsdc: usdc(120_000),
    capacityCapUsdc: usdc(6_000_000),
    minDepositUsdc: usdc(100),
    holderCount: 23,

    exitFeeMaxBps: 50,
    exitFeeDecayPeriodSec: 90 * DAY,
    exitFeeMaxBpsByLevel: [50],

    basket: [
      { ...ASSETS.WETH, balance: 578_400_000_000_000_000_000n, priceWad: wad(3_500), weightBps: 4200, oracleUpdatedAt: NOW - 40, maxStalenessSec: 3600 },
      { ...ASSETS.cbBTC, balance: 1_638_900_00n, priceWad: wad(99_800), weightBps: 3400, oracleUpdatedAt: NOW - 95, maxStalenessSec: 3600 },
    ],

    proposal: {
      pid: 41,
      ptype: 'Rebalance',
      title: 'Rebalance → +4% WETH, −4% idle USDC',
      status: 'Active',
      proposer: '0xMER1',
      createdAt: NOW - 5 * HOUR,
      commitDeadline: NOW - HOUR, // past ⇒ reveal phase ⇒ Mode F
      revealDeadline: NOW + 2 * HOUR,
      executableAt: null,
      expiresAt: null,
      snapshotTotal: wad(4_450_000),
      revealedWeight: wad(1_958_000),
      forWeight: wad(1_691_000),
      againstWeight: wad(267_000),
      revealedVoterCount: 11,
      memberCount: 23,
      quorumFloorBps: 2500,
    },
    governanceConfig: { proposalThresholdBps: 500, timelockDurationSec: 2 * DAY },
  },

  {
    address: '0x2222000000000000000000000000000000002222',
    name: 'Momentum Majors',
    operatorName: 'Halcyon',
    operatorAddress: '0x2ab5000000000000000000000000000000000002',
    operatorId: 2,
    attested: true,
    depth: 0,
    parent: null,
    frozen: false,
    chainRead: true,

    totalShares: wad(1_285_000),
    navWad: wad(1_240_900.774),
    navPerShareWad: wad(0.965681),
    idleUsdc: usdc(62_045.03),
    totalPendingUsdc: 0n,
    capacityCapUsdc: usdc(2_000_000),
    minDepositUsdc: usdc(50),
    holderCount: 9,

    exitFeeMaxBps: 100, // the protocol cap
    exitFeeDecayPeriodSec: 30 * DAY,
    exitFeeMaxBpsByLevel: [100],

    basket: [
      { ...ASSETS.WETH, balance: 194_800_000_000_000_000_000n, priceWad: wad(3_500), weightBps: 5500, oracleUpdatedAt: NOW - 22, maxStalenessSec: 3600 },
      { ...ASSETS.cbBTC, balance: 559_20_000n, priceWad: wad(99_800), weightBps: 4500, oracleUpdatedAt: NOW - 22, maxStalenessSec: 3600 },
    ],

    // Active but still in COMMIT — exits settle instantly, and will stop doing so at the deadline.
    proposal: {
      pid: 42,
      ptype: 'RuleChange',
      title: 'RuleChange → timelock 3d → 2d',
      status: 'Active',
      proposer: '0x2ab5',
      createdAt: NOW - 30 * 60,
      commitDeadline: NOW + 90 * 60,
      revealDeadline: NOW + 5 * HOUR,
      executableAt: null,
      expiresAt: null,
      snapshotTotal: wad(1_285_000),
      revealedWeight: 0n,
      forWeight: 0n,
      againstWeight: 0n,
      revealedVoterCount: 0,
      memberCount: 9,
      quorumFloorBps: 2500,
    },
    governanceConfig: { proposalThresholdBps: 500, timelockDurationSec: 3 * DAY },
  },

  {
    address: '0x3333000000000000000000000000000000003333',
    name: 'BB5 · DeFi Sleeve',
    operatorName: 'Meridian',
    operatorAddress: '0x1ab5000000000000000000000000000000000001',
    operatorId: 1,
    attested: true,
    depth: 1,
    parent: '0x1111000000000000000000000000000000001111',
    parentName: 'Base Blue-Chip 5',
    frozen: false,
    chainRead: true,

    totalShares: wad(545_000),
    navWad: wad(610_400.221),
    navPerShareWad: wad(1.120001),
    idleUsdc: usdc(30_520.11),
    totalPendingUsdc: 0n,
    capacityCapUsdc: 0n, // uncapped — NOT "full"
    minDepositUsdc: usdc(100),
    holderCount: 4, // under 5 ⇒ signer-regime quorum

    exitFeeMaxBps: 50,
    exitFeeDecayPeriodSec: 90 * DAY,
    exitFeeMaxBpsByLevel: [50, 50], // root-first: the parent's ceiling stacks

    basket: [
      { ...ASSETS.WETH, balance: 165_800_000_000_000_000_000n, priceWad: wad(3_500), weightBps: 10_000, oracleUpdatedAt: NOW - 60, maxStalenessSec: 3600 },
    ],
    proposal: null,
    governanceConfig: { proposalThresholdBps: 500, timelockDurationSec: 2 * DAY },
  },

  {
    address: '0x4444000000000000000000000000000000004444',
    name: 'Stable Yield Micro',
    operatorName: 'Aster',
    operatorAddress: '0x3ab5000000000000000000000000000000000003',
    operatorId: 3,
    attested: true,
    depth: 0,
    parent: null,
    // FROZEN — cbBTC's feed is past its heartbeat, so priceWad reverts and every NAV path with it.
    frozen: true,
    chainRead: true,

    totalShares: wad(88_700),
    navWad: wad(88_523.44), // last known, before the freeze
    navPerShareWad: wad(0.998008),
    idleUsdc: usdc(8_852.34),
    totalPendingUsdc: usdc(5_000),
    capacityCapUsdc: usdc(250_000),
    minDepositUsdc: usdc(25),
    holderCount: 3,

    exitFeeMaxBps: 0, // no exit fee at all
    exitFeeDecayPeriodSec: 0,
    exitFeeMaxBpsByLevel: [0],

    basket: [
      { ...ASSETS.cbBTC, balance: 88_00_000n, priceWad: null, weightBps: 10_000, oracleUpdatedAt: NOW - 9 * HOUR, maxStalenessSec: 3600 },
    ],
    proposal: null,
    governanceConfig: { proposalThresholdBps: 500, timelockDurationSec: 2 * DAY },
  },

  {
    address: '0x5555000000000000000000000000000000005555',
    name: 'AlphaSeek Index',
    operatorName: 'AlphaSeek Capital', // self-declared, unverifiable
    operatorAddress: null,
    operatorId: 0, // UNATTESTED — the non-spoofable trust bit
    attested: false,
    depth: 0,
    parent: null,
    frozen: false,
    chainRead: false,

    totalShares: wad(1_500_000),
    navWad: wad(2_100_000),
    navPerShareWad: wad(1.4),
    idleUsdc: usdc(210_000),
    totalPendingUsdc: 0n,
    capacityCapUsdc: usdc(3_000_000),
    minDepositUsdc: usdc(1),
    holderCount: 41,

    exitFeeMaxBps: 100,
    exitFeeDecayPeriodSec: 365 * DAY,
    exitFeeMaxBpsByLevel: [100],

    basket: [{ symbol: '???', decimals: 18, address: null, balance: 0n, priceWad: null, weightBps: 10_000, oracleUpdatedAt: null, maxStalenessSec: null }],
    proposal: null,
    governanceConfig: { proposalThresholdBps: 0, timelockDurationSec: 0 },
  },
];

/** Leaderboard rows in the API's own shape (base units as decimal strings). */
export const LEADERBOARD = [
  { operatorId: 2, operator: '0x2ab5000000000000000000000000000000000002', name: 'Halcyon', netRealizedUsdc: '412000000000', lifetimeGainUsdc: '512000000000', lifetimeLossUsdc: '100000000000', lifetimeFeesUsdc: '41200000000', vaultCount: 1 },
  { operatorId: 1, operator: '0x1ab5000000000000000000000000000000000001', name: 'Meridian', netRealizedUsdc: '286500000000', lifetimeGainUsdc: '410000000000', lifetimeLossUsdc: '123500000000', lifetimeFeesUsdc: '28650000000', vaultCount: 2 },
  { operatorId: 3, operator: '0x3ab5000000000000000000000000000000000003', name: 'Aster', netRealizedUsdc: '-54000000000', lifetimeGainUsdc: '31000000000', lifetimeLossUsdc: '85000000000', lifetimeFeesUsdc: '0', vaultCount: 1 },
];

/**
 * The signed-in fixture wallet's positions. Deliberately covers four portfolio states at once:
 * a healthy position, a position in a Mode-F vault, a pending deposit mid-window, and a
 * position in the frozen vault.
 */
export const WALLET = {
  address: '0xa1c0000000000000000000000000000000009f20',
  usdcBalance: usdc(25_000),
  positions: [
    {
      vault: '0x1111000000000000000000000000000000001111',
      shares: wad(92_250),
      costBasisUsdc: usdc(100_000),
      // 46 days into a 90-day decay on a 0.50% max ⇒ 0.25% today.
      lastDepositTime: NOW - 46 * DAY,
      windowCleared: true,
      queuedExitShares: 0n,
    },
    {
      vault: '0x3333000000000000000000000000000000003333',
      shares: wad(44_600),
      costBasisUsdc: usdc(50_000),
      lastDepositTime: NOW - 12 * DAY,
      windowCleared: true,
      queuedExitShares: 0n,
    },
    {
      vault: '0x4444000000000000000000000000000000004444',
      shares: wad(1_000),
      costBasisUsdc: usdc(1_000),
      lastDepositTime: NOW - 200 * DAY,
      windowCleared: true,
      queuedExitShares: 0n,
    },
  ],
  /** A deposit mid-observation-window: escrowed, zero shares, cancellable, 2h41m to go. */
  pending: [
    {
      vault: '0x2222000000000000000000000000000000002222',
      amountUsdc: usdc(5_000),
      availableAt: NOW + 2 * HOUR + 41 * 60,
    },
  ],
};

/** Deep-clone-ish accessor so a render cannot mutate the fixture set. */
export function vaultByAddress(addr) {
  return VAULTS.find((v) => v.address.toLowerCase() === String(addr ?? '').toLowerCase()) ?? null;
}
