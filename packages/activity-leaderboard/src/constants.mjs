// @ts-check
/**
 * Fixed parameters of the activity leaderboard. One file, under version control, so a verifier reads
 * the same numbers the publisher used. Changing any of them changes `FORMULA_VERSION`.
 */

/** Names the arithmetic. Bump it whenever the measurement below changes. */
export const FORMULA_VERSION = 'usdc-days-1';

/** Output schema identifier, written into every board. */
export const SCHEMA = 'activity-leaderboard/1';

/** Seven days. Epochs are counted from a per-chain anchor timestamp (see epoch.mjs). */
export const EPOCH_SECONDS = 604_800;

/**
 * A closed epoch is published only once this long after it ended, so a short reorg cannot move a
 * file that is meant to be final (24 hours).
 */
export const SETTLE_SECONDS = 86_400;

/** USDC has 6 decimals on every configured chain (the vault's cost basis is in raw USDC units). */
export const USDC_DECIMALS = 6;

export const SECONDS_PER_DAY = 86_400n;

/**
 * Fractional digits in a rendered `usdcDays` string. `usdcSeconds / SECONDS_PER_DAY` is exactly the
 * number of 10^-6 USDC-days (raw USDC units are 10^-6 USDC), so six digits is exact up to a floor.
 */
export const USDC_DAYS_DECIMALS = 6;

/** Window the RPC allows for `eth_getLogs` on Arc (10,000 blocks). */
export const DEFAULT_WINDOW_BLOCKS = 10_000;

/** Blocks behind the chain head that count as settled for the consistency read. */
export const DEFAULT_CONFIRMATIONS = 12;
