// @ts-check
/**
 * Exact fixed-point formatting for the two precisions this protocol mixes: USDC is 6 decimals,
 * internal WAD math is 18 (ARCHITECTURE §13). Every function here is BigInt-in, string-out and
 * loses nothing — `Number(BigInt(x))/1e6` (live-adapter's `usdFromBase`) is fine for a headline
 * but silently wrong past 2^53, which a $9,007,199,254.740993 cap or a WAD share count reaches.
 *
 * Rule this module encodes: a figure a user acts on is rendered EXACT and carries its unit.
 * A figure that is only glanceable may be abbreviated, and must then be visibly marked as
 * approximate — `approx()` returns the leading `≈` so a caller cannot forget it.
 */

export const USDC_DECIMALS = 6;
export const WAD_DECIMALS = 18;
/** WAD / USDC — the contract's `usdcScalar`. */
export const USDC_SCALAR = 10n ** BigInt(WAD_DECIMALS - USDC_DECIMALS);
export const BPS = 10_000n;

/**
 * Coerce anything the API might hand us into a BigInt without throwing. JSON carries bigints as
 * decimal strings (server.mjs `jsonStringify`), but a projection can also emit a Number.
 * @param {bigint|string|number|null|undefined} v
 * @returns {bigint|null} null when the value is absent or unparseable — never a silent 0, because
 *   "unknown balance" and "zero balance" are different facts and only one of them is safe to show.
 */
export function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) return null;
  return BigInt(s);
}

/**
 * Exact fixed-point render, no rounding at all. Trailing zeros are kept to `minFrac` places so a
 * column of amounts stays visually comparable.
 * @param {bigint} value base units
 * @param {number} decimals
 * @param {{minFrac?:number, maxFrac?:number, group?:boolean}} [opts]
 *        maxFrac TRUNCATES toward zero (the contract rounds against the actor everywhere —
 *        ARCHITECTURE §13 — so a display that rounds up would over-promise a payout).
 */
export function formatUnits(value, decimals, opts = {}) {
  const { minFrac = 2, maxFrac = decimals, group = true } = opts;
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let frac = (abs % unit).toString().padStart(decimals, '0');

  frac = frac.slice(0, Math.max(0, Math.min(maxFrac, decimals)));
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  while (frac.length < minFrac) frac += '0';

  const w = group ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole.toString();
  return `${neg ? '−' : ''}${w}${frac ? `.${frac}` : ''}`;
}

/** Exact USDC amount with its unit, e.g. `1,000.000000 USDC`. Use wherever a user acts on it. */
export function usdcExact(value, { unit = true } = {}) {
  const b = toBig(value);
  if (b === null) return unit ? '— USDC' : '—';
  return `${formatUnits(b, USDC_DECIMALS, { minFrac: USDC_DECIMALS })}${unit ? ' USDC' : ''}`;
}

/**
 * USDC to cents — for headlines and tables where the exact form is a click away. It TRUNCATES to
 * two places, so it marks itself with `≈` whenever there is a sub-cent remainder. A caller cannot
 * present a truncated figure as an exact one by forgetting to wrap it.
 */
export function usdcShort(value) {
  const b = toBig(value);
  if (b === null) return '—';
  const abs = b < 0n ? -b : b;
  const s = `$${formatUnits(b, USDC_DECIMALS, { minFrac: 2, maxFrac: 2 })}`;
  return abs % 10_000n === 0n ? s : approx(s); // 1e4 base units = one cent at 6dp
}

/**
 * A token amount held in its own decimals, expressed in WAD so it can be rendered by `wadExact`.
 * `VaultCore` rejects a basket asset with `decimals > 18` at construction, but this value arrives
 * from data, and a bare `10n ** BigInt(18 - decimals)` throws RangeError on a negative exponent
 * instead of rendering anything at all.
 * @returns {bigint|null} null when the amount or the decimals are unusable
 */
export function scaleToWad(amount, decimals) {
  const a = toBig(amount);
  if (a === null || !Number.isInteger(decimals) || decimals < 0) return null;
  return decimals > WAD_DECIMALS
    ? a / 10n ** BigInt(decimals - WAD_DECIMALS)
    : a * 10n ** BigInt(WAD_DECIMALS - decimals);
}

/** Exact WAD amount (share counts, NAV/share). */
export function wadExact(value, { maxFrac = WAD_DECIMALS } = {}) {
  const b = toBig(value);
  if (b === null) return '—';
  return formatUnits(b, WAD_DECIMALS, { minFrac: 2, maxFrac });
}

/**
 * Mark a figure as approximate. Abbreviated/derived numbers MUST go through this so no rounded
 * value can be mistaken for the exact one.
 */
export function approx(s) {
  return s === '—' ? s : `≈ ${s}`;
}

/**
 * Compact glanceable magnitude ($4.82M). Always wrap in `approx()` at the call site — the return
 * value is deliberately lossy and is never correct to act on.
 */
export function usdcCompact(value) {
  const b = toBig(value);
  if (b === null) return '—';
  const neg = b < 0n;
  const whole = (neg ? -b : b) / 10n ** BigInt(USDC_DECIMALS);
  const sign = neg ? '−' : '';
  const n = Number(whole);
  if (whole >= 1_000_000_000n) return `${sign}$${(n / 1e9).toFixed(2)}B`;
  if (whole >= 1_000_000n) return `${sign}$${(n / 1e6).toFixed(2)}M`;
  if (whole >= 10_000n) return `${sign}$${(n / 1e3).toFixed(1)}k`;
  return `${sign}$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * Basis points as an exact percentage. bps are integers on-chain, so 2 decimals is lossless.
 * @param {bigint|number|string} bps
 */
export function bpsPct(bps) {
  const b = toBig(typeof bps === 'number' ? Math.trunc(bps) : bps);
  if (b === null) return '—';
  const neg = b < 0n;
  const abs = neg ? -b : b;
  return `${neg ? '−' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}%`;
}

/** `0x1234…5678`. Returns `—` rather than a misleading fragment for a malformed address. */
export function shortAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

/**
 * Whole-unit duration, largest-two components: `3h 42m`, `2d 4h`, `18s`. Used for countdowns and
 * for data age, so the same reading of "how old / how long" appears everywhere.
 * @param {number} seconds
 */
export function duration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const parts = [
    ['d', Math.floor(s / 86400)],
    ['h', Math.floor((s % 86400) / 3600)],
    ['m', Math.floor((s % 3600) / 60)],
    ['s', s % 60],
  ].filter(([, v]) => v > 0);
  return parts.slice(0, 2).map(([u, v]) => `${v}${u}`).join(' ');
}

/**
 * The countdown threshold just crossed, for a live region that announces at meaningful points
 * rather than every second.
 *
 * `thresholds` is descending — `[3600, 900, 300, 60, 0]` — so `find(t => left <= t)` returns 3600
 * for EVERY value below an hour: one announcement at T-1h and silence for the rest, expiry
 * included. The threshold that has actually just been reached is the SMALLEST one still cleared.
 *
 * @param {number} left seconds remaining
 * @param {number[]} thresholds in any order
 * @returns {number|null} null while the countdown is above every threshold. Monotonically
 *   decreasing as `left` falls, so a caller that announces on change fires once per threshold.
 */
export function crossedThreshold(left, thresholds) {
  let best = null;
  for (const t of thresholds ?? []) {
    if (left <= t && (best === null || t < best)) best = t;
  }
  return best;
}

/** Zero-padded clock for a live countdown: `03:59:12`. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * Parse user-typed decimal input into base units, exactly. Returns null on anything ambiguous
 * rather than coercing — a deposit amount is not a place to guess what someone meant.
 * Excess decimals are an ERROR, not a truncation: silently dropping them would deposit a
 * different amount than the one the user read back.
 * @param {string} input
 * @param {number} decimals
 * @param {{unit?:string}} [opts] the unit being parsed — this function is called with 18 for SHARE
 *   amounts as well as with 6 for USDC, and the error must name the right one.
 * @returns {{ok:true, value:bigint}|{ok:false, error:string}}
 */
export function parseUnits(input, decimals = USDC_DECIMALS, { unit = 'USDC' } = {}) {
  const s = String(input ?? '').trim().replace(/,/g, '').replace(/_/g, '');
  if (s === '') return { ok: false, error: 'Enter an amount.' };
  if (!/^\d*(\.\d*)?$/.test(s)) return { ok: false, error: 'Digits and one decimal point only.' };
  const [w = '', f = ''] = s.split('.');
  if (w === '' && f === '') return { ok: false, error: 'Enter an amount.' };
  if (f.length > decimals) {
    return { ok: false, error: `${unit} amounts take ${decimals} decimals — ${f.length} given. Remove ${f.length - decimals}.` };
  }
  const value = BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f || '').padEnd(decimals, '0') || '0');
  if (value === 0n) return { ok: false, error: 'Amount must be more than zero.' };
  return { ok: true, value };
}
