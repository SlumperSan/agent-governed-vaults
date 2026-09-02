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
import {
  checkDepegReference, LOWER_BOUND_WAD, UPPER_BOUND_WAD, DEFAULT_MAX_AGE_SEC, UNREADABLE_SWEEPS,
} from '../src/signals/depeg-reference.mjs';
import { createTransitionTracker } from '../src/transitions.mjs';
import { createTieredWebhookSink } from '../src/sinks.mjs';
import { mockReader, VAULT, USDC_USD_FEED } from './helpers.mjs';

const NOW = 1_700_000_000;

/** @param {{answer?:bigint, decimals?:number|{revert:string}, roundReverts?:boolean}} [opts] */
function contractsFor({ answer = 100_000000n, decimals = 8, roundReverts = false, decimalsReverts = false, ageSec = 10 } = {}) {
  const RV = { revert: '0xdeadbeef' };
  return {
    [USDC_USD_FEED]: {
      latestRoundData: () => (roundReverts ? RV : [1n, answer, BigInt(NOW - ageSec), BigInt(NOW - ageSec), 1n]),
      decimals: () => (decimalsReverts ? RV : decimals),
    },
  };
}

const run = async (opts = {}, feed = USDC_USD_FEED, extra = {}) => (
  await checkDepegReference({
    reader: mockReader({ contracts: contractsFor(opts), nowSec: NOW }),
    vault: VAULT, feed, chainId: 8453, nowSec: NOW, ...extra,
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

test('a non-positive answer is a DETECTOR FAULT, not depeg evidence', async () => {
  // Review115 F7. Folding `answer <= 0` into the out-of-band ALERT emitted, in as many words, "reads
  // $0.0000, outside the 0.995..1.005 band. This is EXTERNAL, informational evidence for the de-list
  // decision" — de-list evidence manufactured out of the monitor's own broken input. A zero or
  // negative answer is a broken aggregator; USDC has never been worth $0.00.
  for (const answer of [0n, -1n, -100_000000n]) {
    const r = await run({ answer });
    assert.equal(r.status, 'skipped', `answer ${answer}`);
    assert.equal(r.detail.detectorBroken, true);
    assert.match(r.message, /USDC DEPEG REFERENCE BLIND/);
    assert.match(r.message, /not a price/);
    assert.doesNotMatch(r.message, /evidence for the de-list decision/,
      'a monitor fault must never be reported as de-list evidence');
  }
});

test('one unit above zero is a real reading again, and out of band', async () => {
  const r = await run({ answer: 1n });
  assert.equal(r.status, 'alert', 'the fault branch is `<= 0`, not "implausibly small"');
  assert.match(r.message, /OUT OF BAND/);
});

// ── F6: a frozen feed reads in band forever unless staleness is checked ───────

test('a reading older than the bound is BLIND, not a healthy in-band $1.00', async () => {
  // The failure this closes: a USDC/USD aggregator frozen at $1.0000 reports "in band" indefinitely,
  // so the signal is silently dead in exactly the scenario G4 exists for — a depeg is precisely when
  // a feed is most likely to be disrupted (Review115 F6).
  const r = await run({ ageSec: DEFAULT_MAX_AGE_SEC + 1 });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.equal(r.detail.ageSec, DEFAULT_MAX_AGE_SEC + 1);
  assert.match(r.message, /USDC DEPEG REFERENCE STALE/);
  assert.match(r.message, /not current evidence either way/);
});

test('a reading EXACTLY at the bound is still current — the bar is `>`, not `>=`', async () => {
  const r = await run({ ageSec: DEFAULT_MAX_AGE_SEC });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.ageSec, DEFAULT_MAX_AGE_SEC);
});

test('one second under the bound is current', async () => {
  const r = await run({ ageSec: DEFAULT_MAX_AGE_SEC - 1 });
  assert.equal(r.status, 'ok');
});

test('the staleness bound is configurable, and the observed age always rides in detail', async () => {
  const fresh = await run({ ageSec: 400 }, USDC_USD_FEED, { maxAgeSec: 900 });
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.detail.ageSec, 400);
  assert.equal(fresh.detail.maxAgeSec, 900);
  const stale = await run({ ageSec: 901 }, USDC_USD_FEED, { maxAgeSec: 900 });
  assert.equal(stale.status, 'skipped');
  assert.match(stale.message, /901s ago, past the 900s bound/);
});

test('a stale feed that is ALSO out of band reports BLIND — a frozen number is not evidence', async () => {
  const r = await run({ answer: 90_000000n, ageSec: DEFAULT_MAX_AGE_SEC + 1 });
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /STALE/);
});

test('without a chain clock the staleness leg is simply not run, and nothing is invented', async () => {
  const r = await run({ ageSec: 999_999 }, USDC_USD_FEED, { nowSec: undefined });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.ageSec, null);
});

// ── F8: the damping constant is now actually wired up ────────────────────────

test('an unreadable feed damps: one blind sweep is RPC noise, three consecutive is the feed', async () => {
  // `UNREADABLE_SWEEPS` was declared, documented as "same damping feed-identity uses", and only ever
  // stuffed into `detail.minConsecutive` on a result the first failed read returned immediately —
  // the damping it promised did not exist (Review115 F8). `transitions.mjs` honours
  // `detail.minConsecutive`, so setting it IS the damping; this drives the real tracker to prove it.
  assert.equal(UNREADABLE_SWEEPS, 3);
  const tracker = createTransitionTracker();
  const blind = async (poll) => tracker.observe(
    await checkDepegReference({
      reader: mockReader({ contracts: contractsFor({ roundReverts: true }), nowSec: NOW }),
      vault: VAULT, feed: USDC_USD_FEED, chainId: 8453, nowSec: NOW,
    }),
    { poll },
  );
  // Seed a known-healthy state first: `transitions.mjs` announces an already-wrong FIRST sighting
  // immediately (a canary that starts up blind must say so), and damps only a change from a state
  // it has already seen — which is the case this constant is about.
  tracker.observe(await checkDepegReference({
    reader: mockReader({ contracts: contractsFor(), nowSec: NOW }),
    vault: VAULT, feed: USDC_USD_FEED, chainId: 8453, nowSec: NOW,
  }), { poll: 0 });
  assert.deepEqual(await blind(1), [], 'one empty eth_call is transport noise');
  assert.deepEqual(await blind(2), [], 'two is still not conclusive');
  const third = await blind(3);
  assert.equal(third.length, 1, 'three consecutive is the feed');
  assert.match(third[0].line, /DETECTOR BROKEN/);
});

test('a stale-but-answering feed is NOT damped — it is a definite observation, not transport noise', async () => {
  const tracker = createTransitionTracker();
  const ts = tracker.observe(await checkDepegReference({
    reader: mockReader({ contracts: contractsFor({ ageSec: DEFAULT_MAX_AGE_SEC + 1 }), nowSec: NOW }),
    vault: VAULT, feed: USDC_USD_FEED, chainId: 8453, nowSec: NOW,
  }), { poll: 1 });
  assert.equal(ts.length, 1, 'reported on the first sweep');
});

// ── the tier, proven by dispatch rather than by set membership ───────────────

test('a real depeg ALERT physically POSTs to the PAGE endpoint; a blind detector does not', async () => {
  const hits = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://page.invalid/hook',
    logUrl: 'https://log.invalid/hook',
    fetchImpl: async (url, init) => {
      hits.push({ endpoint: url.includes('page.invalid') ? 'PAGE' : 'LOG', status: JSON.parse(init.body).status });
      return { ok: true, status: 200 };
    },
  });
  const sweep = async (tracker, opts, poll) => {
    for (const t of tracker.observe(await checkDepegReference({
      reader: mockReader({ contracts: contractsFor(opts), nowSec: NOW }),
      vault: VAULT, feed: USDC_USD_FEED, chainId: 8453, nowSec: NOW,
    }), { poll })) await sink.emit(t);
  };

  const depeg = createTransitionTracker();
  await sweep(depeg, {}, 1);                          // healthy first sighting: silent
  await sweep(depeg, { answer: 90_000000n }, 2);      // USDC at $0.90
  assert.deepEqual(hits, [{ endpoint: 'PAGE', status: 'alert' }],
    'the one line that prompts the de-list decision must reach a human, not a log');

  hits.length = 0;
  const broken = createTransitionTracker();
  await sweep(broken, {}, 0); // healthy, so the blind sweeps below go through the damping path
  for (const poll of [1, 2, 3]) await sweep(broken, { roundReverts: true }, poll);
  assert.deepEqual(hits, [{ endpoint: 'LOG', status: 'skipped' }],
    'a blind detector is not an incident — it escalates on the backoff, it does not page');
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
