// @ts-check
/**
 * Precision guards. USDC is 6dp and internal math is WAD 18dp (ARCHITECTURE §13), and the two get
 * mixed in every screen — these tests exist so a display can never round a figure a user acts on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBig, formatUnits, usdcExact, usdcShort, usdcCompact, wadExact, bpsPct,
  shortAddress, duration, clock, parseUnits, approx, USDC_SCALAR, scaleToWad, crossedThreshold,
} from '../src/format.mjs';

test('toBig distinguishes absent from zero', () => {
  assert.equal(toBig('0'), 0n);
  assert.equal(toBig(undefined), null);
  assert.equal(toBig(''), null);
  assert.equal(toBig('12.5'), null); // base units are integers; a decimal here is a bug upstream
  assert.equal(toBig('not-a-number'), null);
  assert.equal(toBig(-100n), -100n);
  assert.equal(toBig(Number.MAX_SAFE_INTEGER + 2), null); // refuses lossy Numbers
});

test('formatUnits is exact past 2^53 where Number()/1e6 is not', () => {
  // 9,007,199,254.740993 USDC — one base unit past Number's safe integer range.
  const v = 9007199254740993n;
  assert.equal(usdcExact(v), '9,007,199,254.740993 USDC');
  // The lossy form the live adapter uses for headlines, shown here to pin WHY this module exists.
  assert.notEqual(String(Number(v) / 1e6), '9007199254.740993');
});

test('formatUnits truncates toward zero, never rounds up', () => {
  // The contract rounds against the actor everywhere; a display that rounds up over-promises.
  assert.equal(formatUnits(1999999n, 6, { maxFrac: 2 }), '1.99');
  assert.equal(formatUnits(1n, 6, { minFrac: 6 }), '0.000001');
  assert.equal(formatUnits(-2500000n, 6, { minFrac: 2 }), '−2.50');
});

test('usdcExact always carries its unit and shows absent as absent', () => {
  assert.equal(usdcExact(1_000_000n), '1.000000 USDC');
  assert.equal(usdcExact(undefined), '— USDC');
  assert.equal(usdcExact(null, { unit: false }), '—');
});

test('lossy renderings are opt-in and marked', () => {
  // usdcShort TRUNCATES to cents, so it marks itself whenever it drops anything. A caller cannot
  // present $4,820,400.12 as the exact value of …123456 by forgetting to wrap it.
  assert.equal(usdcShort(4_820_400_123456n), '≈ $4,820,400.12');
  assert.equal(usdcShort(4_820_400_120000n), '$4,820,400.12', 'nothing dropped ⇒ nothing to mark');
  assert.equal(usdcShort(0n), '$0.00');
  assert.equal(usdcShort(-1_234_567n), '≈ $−1.23');
  assert.equal(usdcCompact(4_820_400_123456n), '$4.82M');
  assert.equal(approx(usdcCompact(4_820_400_123456n)), '≈ $4.82M');
  assert.equal(approx('—'), '—'); // nothing to approximate
});

test('scaleToWad survives a token claiming more than 18 decimals', () => {
  // VaultCore rejects such an asset at construction, but the value arrives from data and
  // `10n ** BigInt(18 - decimals)` throws RangeError rather than rendering anything.
  assert.equal(scaleToWad(163_890_000n, 8), 1_638_900_000_000_000_000n); // cbBTC, 8dp
  assert.equal(scaleToWad(5n * 10n ** 18n, 18), 5n * 10n ** 18n);
  assert.equal(scaleToWad(10n ** 20n, 20), 10n ** 18n, 'scales down instead of throwing');
  assert.equal(scaleToWad(1n, undefined), null);
  assert.equal(scaleToWad(undefined, 18), null);
});

test('crossedThreshold announces at every threshold, expiry included', () => {
  // `find(t => left <= t)` over a DESCENDING array returns 3600 for everything under an hour, so
  // a countdown announced once at T-1h and never again — "the deadline has passed" unreachable.
  const T = [3600, 900, 300, 60, 0];
  assert.equal(crossedThreshold(3601, T), null);
  assert.equal(crossedThreshold(3600, T), 3600);
  assert.equal(crossedThreshold(3599, T), 3600);
  assert.equal(crossedThreshold(900, T), 900);
  assert.equal(crossedThreshold(301, T), 900);
  assert.equal(crossedThreshold(300, T), 300);
  assert.equal(crossedThreshold(60, T), 60);
  assert.equal(crossedThreshold(1, T), 60);
  assert.equal(crossedThreshold(0, T), 0);
  assert.equal(crossedThreshold(-5, T), 0);
  // Monotonically non-increasing, so a caller announcing on change fires once per threshold.
  let prev = null;
  const fired = [];
  for (let left = 3700; left >= -5; left--) {
    const c = crossedThreshold(left, T);
    if (c !== null && c !== prev) fired.push(c);
    prev = c;
  }
  assert.deepEqual(fired, [3600, 900, 300, 60, 0]);
});

test('parseUnits names the unit it is parsing, not always USDC', () => {
  // index.html parses SHARE amounts at 18dp with this; "USDC has 18 decimals" is the wrong unit.
  assert.match(parseUnits('1.1234567').error, /USDC amounts take 6 decimals/);
  assert.match(parseUnits('1.' + '1'.repeat(19), 18, { unit: 'Share' }).error, /Share amounts take 18 decimals/);
});

test('wadExact renders 18dp share counts without loss', () => {
  assert.equal(wadExact(1_000_000_000_000_000_000n), '1.00');
  assert.equal(wadExact(1_234_567_890_123_456_789n, { maxFrac: 18 }), '1.234567890123456789');
});

test('bpsPct is exact — bps are integers on-chain', () => {
  assert.equal(bpsPct(1900), '19.00%');
  assert.equal(bpsPct(50), '0.50%');
  assert.equal(bpsPct(1), '0.01%');
  assert.equal(bpsPct(10_000), '100.00%');
  assert.equal(bpsPct(-250), '−2.50%');
});

test('shortAddress refuses to render a malformed address as if it were one', () => {
  assert.equal(shortAddress('0x' + '1'.repeat(40)), '0x1111…1111');
  assert.equal(shortAddress('0xdead'), '—');
  assert.equal(shortAddress(null), '—');
});

test('duration and clock', () => {
  assert.equal(duration(45), '45s');
  assert.equal(duration(4 * 3600), '4h');
  assert.equal(duration(4 * 3600 + 125), '4h 2m');
  assert.equal(duration(2 * 86400 + 3 * 3600), '2d 3h');
  assert.equal(duration(-5), '0s');
  assert.equal(clock(4 * 3600), '04:00:00');
  assert.equal(clock(59), '00:00:59');
});

test('parseUnits rejects excess decimals instead of silently truncating', () => {
  // Truncating would deposit a different amount than the one the user read back.
  const bad = parseUnits('1.1234567');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /6 decimals/);

  assert.deepEqual(parseUnits('1000'), { ok: true, value: 1_000_000_000n });
  assert.deepEqual(parseUnits('1,000.50'), { ok: true, value: 1_000_500_000n });
  assert.deepEqual(parseUnits('0.000001'), { ok: true, value: 1n });
  assert.equal(parseUnits('0').ok, false);
  assert.equal(parseUnits('').ok, false);
  assert.equal(parseUnits('abc').ok, false);
  assert.equal(parseUnits('1.2.3').ok, false);
});

test('USDC_SCALAR matches the contract usdcScalar (WAD/USDC)', () => {
  assert.equal(USDC_SCALAR, 10n ** 12n);
});
