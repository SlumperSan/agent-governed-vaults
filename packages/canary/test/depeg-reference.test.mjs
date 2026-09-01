// @ts-check
/**
 * Signal (i) — DEPEG REFERENCE, closing G4 (OPS-8, "USDC depeg. Undetected internally: days").
 *
 * Purely informational: the vault's own oracle pins USDC at $1.00 unconditionally, on every code
 * path, and nothing here changes that. Every test perturbs exactly one thing against a healthy
 * $1.00, 8-decimal reading and checks the signal reacts to that and nothing else.
 *
 * All mocked. No live RPC anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDepegReference, LOWER_BOUND_WAD, UPPER_BOUND_WAD } from '../src/signals/depeg-reference.mjs';
import { mockReader, VAULT, USDC_USD_FEED } from './helpers.mjs';

const NOW = 1_700_000_000;

/** @param {{answer?:bigint, decimals?:number|{revert:string}, roundReverts?:boolean}} [opts] */
function contractsFor({ answer = 100_000000n, decimals = 8, roundReverts = false, decimalsReverts = false } = {}) {
  const RV = { revert: '0xdeadbeef' };
  return {
    [USDC_USD_FEED]: {
      latestRoundData: () => (roundReverts ? RV : [1n, answer, BigInt(NOW - 10), BigInt(NOW - 10), 1n]),
      decimals: () => (decimalsReverts ? RV : decimals),
    },
  };
}

const run = async (opts = {}, feed = USDC_USD_FEED) => (
  await checkDepegReference({
    reader: mockReader({ contracts: contractsFor(opts), nowSec: NOW }),
    vault: VAULT, feed, chainId: 8453,
  })
)[0];

test('exact boundary constants match the Monitoring Gap Analysis spec (0.995 .. 1.005)', () => {
  assert.equal(LOWER_BOUND_WAD, 995_000000000000000n);
  assert.equal(UPPER_BOUND_WAD, 1_005000000000000000n);
});

// ── the healthy band ───────────────────────────────────────────────────────────

test('a $1.00 reading is OK, and says the contract pins USDC regardless', async () => {
  const r = await run();
  assert.equal(r.status, 'ok');
  assert.equal(r.signal, 'depeg-reference');
  assert.equal(r.detail.priceWad, '1000000000000000000');
  assert.match(r.message, /pins USDC at \$1\.00 regardless/);
});

test('exactly 0.995 is still OK — the lower bound is inclusive', async () => {
  const r = await run({ answer: 99_500000n }); // 0.99500000 at 8dp
  assert.equal(r.status, 'ok');
});

test('exactly 1.005 is still OK — the upper bound is inclusive', async () => {
  const r = await run({ answer: 100_500000n });
  assert.equal(r.status, 'ok');
});

// ── out of band ────────────────────────────────────────────────────────────────

test('one hundredth of a cent below 0.995 ALERTs, informationally, never claiming a contract freeze', async () => {
  const r = await run({ answer: 99_499999n }); // 0.99499999, one unit below the inclusive bound
  assert.equal(r.status, 'alert');
  assert.match(r.message, /USDC DEPEG REFERENCE OUT OF BAND/);
  assert.match(r.message, /outside the 0\.995\.\.1\.005 band/);
  assert.match(r.message, /pins USDC at exactly \$1\.00 for every deposit, exit and NAV computation regardless of this reading, by design/);
  assert.match(r.message, /EXTERNAL, informational evidence/);
  assert.equal(r.threshold, '0.995 .. 1.005');
});

test('a $0.99 reading formats measured as a clean 4dp dollar figure', async () => {
  const r = await run({ answer: 99_000000n }); // 0.99000000
  assert.equal(r.status, 'alert');
  assert.equal(r.measured, '$0.9900');
});

test('one hundredth of a cent above 1.005 also ALERTs', async () => {
  const r = await run({ answer: 100_500001n });
  assert.equal(r.status, 'alert');
});

test('a non-positive answer ALERTs — a feed reporting <= 0 is not a $1.00 reading', async () => {
  const r = await run({ answer: 0n });
  assert.equal(r.status, 'alert');
});

// ── the deliberate "never a contract-level remedy" framing ────────────────────

test('the ALERT never implies the vault will re-price or freeze — the pin is unconditional', async () => {
  const r = await run({ answer: 90_000000n }); // a real depeg, 0.90
  assert.match(r.message, /will keep doing so until a human relists or unwinds the vault/);
  assert.doesNotMatch(r.message, /\bfreeze\b/i, 'this is not oracle-freshness — no freeze happens here');
});

// ── configuration absence is a fact, not a blind detector ────────────────────

test('no feed configured reports skipped, not detectorBroken — this is a documented config gap', async () => {
  const [r] = await checkDepegReference({
    reader: mockReader({ contracts: {}, nowSec: NOW }), vault: VAULT, feed: null, chainId: 84532,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, undefined);
  assert.match(r.message, /not configured/);
  assert.match(r.message, /USDC_USD_FEED_ADDRESS/);
  assert.match(r.message, /84532/);
  assert.match(r.message, /pins USDC at \$1\.00 regardless/);
});

// ── an unreadable reference feed is a monitor blind spot ─────────────────────

test('the reference feed reverting is a BROKEN DETECTOR — this canary cannot see a depeg forming', async () => {
  const r = await run({ roundReverts: true });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /USDC DEPEG REFERENCE BLIND/);
  assert.match(r.message, /latestRoundData\(\)/);
  assert.match(r.message, /monitoring gap only/);
});

test('decimals() reverting is also a BROKEN DETECTOR — the reading cannot be normalized', async () => {
  const r = await run({ decimalsReverts: true });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /decimals\(\)/);
});

test('a decimals value no WAD scale can express is a BROKEN DETECTOR, not a thrown RangeError', async () => {
  const r = await run({ decimals: 19 });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /19 decimals/);
});
