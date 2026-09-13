import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEQUENCER_EXEMPT_CHAIN_IDS,
  SEQUENCER_EXEMPT_REASONS,
  bandBoundsTwoDecimalDrift,
  chainBindingVerdict,
  compareAggregatorPin,
  isUsdQuoted,
} from '../verify-chainlink-oracle.mjs';

// ---------------------------------------------------------------------------
// AGGREGATOR-SWAP DRIFT — the off-chain half of the accepted residual.
//
// The configured feed addresses are Chainlink `EACAggregatorProxy` instances, and Chainlink swaps
// the aggregator behind them as routine operation. `ChainlinkOracle` reads `decimals()` ONCE, in
// its constructor, and caches `scale = 10**(18 - decimals)` forever. Nothing on-chain re-checks —
// that is the decision recorded in docs/LAUNCH-READINESS.md §4 row 14, argued there against an
// on-chain re-check because a re-check turns a benign upstream swap into an unrecoverable
// vault-wide freeze (the vault's oracle is immutable and there is no rotation lever).
//
// So detection lives here. The rule this file pins: a swap is a NOTICE, never a failure. Hard
// failing on it would reproduce on-chain-freeze semantics in the deploy gate — blocking a correct
// deployment for an event Chainlink performs on purpose. The safety verdict stays with the
// separate `decimals() == 8` check, which is a COMPLETE test of the residual AT THE SAMPLING
// INSTANT regardless of how many swaps happened by then -- and says nothing about the interval
// between two runs, which is why the cadence (and, since #103, the canary's feed-identity signal)
// is the actual control.
//
// Real values below, read from Base mainnet 2026-08-30 (`aggregator()` / `phaseId()` on the
// ETH/USD proxy 0x50015f8b…3a8b, the launch WETH feed).
// ---------------------------------------------------------------------------

const IMPL = '0x05c84a58Fe042275b37DB038BAacd15F410c7bB0';
const PIN = { implementation: IMPL, phaseId: 1, decimals: 8, observedAt: '2026-08-30' };

test('unchanged aggregator and phaseId is ok, not a notice', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL, phaseId: '1' });
  assert.equal(r.status, 'ok');
  assert.match(r.message, /unchanged since the pin/);
});

test('address comparison is case-insensitive — cast prints lowercase, configs are checksummed', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL.toLowerCase(), phaseId: '1' });
  assert.equal(r.status, 'ok', 'a checksum-case difference must not read as a swap');
});

test('phaseId is compared as a string — RPC returns "1", config holds the number 1', () => {
  const r = compareAggregatorPin({ implementation: IMPL, phaseId: '1' }, { implementation: IMPL, phaseId: 1 });
  assert.equal(r.status, 'ok');
});

test('a new aggregator behind the same proxy is DRIFT — the exact event the residual is about', () => {
  // Base ETH/USD 0x71041ddd… really did move phase 1 -> 2 -> 3 with decimals 8 throughout.
  const r = compareAggregatorPin(PIN, {
    implementation: '0x1e0b2c3896338Fbb201C4F0a27c6904801dcA06b',
    phaseId: '2',
  });
  assert.equal(r.status, 'drift');
  assert.match(r.message, /AGGREGATOR SWAPPED/);
  assert.match(r.message, /NOT a failure/, 'the message must tell the operator this does not block a deploy');
  assert.match(r.message, /decimals/, 'and must point at the check that carries the actual verdict');
});

test('a bumped phaseId alone is DRIFT even if the implementation somehow matched', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL, phaseId: '2' });
  assert.equal(r.status, 'drift');
});

test('a missing pin is UNPINNED and hands back the exact JSON to paste', () => {
  const r = compareAggregatorPin(undefined, { implementation: IMPL, phaseId: '3' });
  assert.equal(r.status, 'unpinned');
  assert.match(r.message, new RegExp(`"implementation":"${IMPL}"`));
  assert.match(r.message, /"phaseId":3/);
});

test('an empty pin object is treated as unpinned, not as a mismatch', () => {
  assert.equal(compareAggregatorPin({}, { implementation: IMPL, phaseId: '1' }).status, 'unpinned');
});

test('a proxy answering neither view is UNREADABLE, distinct from a swap', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: null });
  assert.equal(r.status, 'unreadable', 'a non-EACAggregatorProxy feed must not be reported as a swap');
});

// This case is here because the FIRST live run of the notice produced a false alarm on it: a
// rate-limited public RPC dropped one `aggregator()` call mid-sweep and the notice announced
// "AGGREGATOR SWAPPED -> now null". A read that did not answer is not evidence of a swap, and a
// drift notice that cries wolf on network noise is one an operator learns to ignore.
test('an unanswered aggregator() read with a matching phaseId is UNREADABLE, never a swap', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: '1' });
  assert.equal(r.status, 'unreadable');
  assert.doesNotMatch(r.message, /SWAPPED/, 'a dropped RPC call must never be reported as a swap');
  assert.match(r.message, /NOT confirmed/);
});

test('phaseId alone can convict: it moved, so a swap happened even with aggregator() unread', () => {
  const r = compareAggregatorPin(PIN, { implementation: null, phaseId: '2' });
  assert.equal(r.status, 'drift');
  assert.match(r.message, /phaseId moved 1 -> 2/);
  assert.match(r.message, /NOT a failure/);
});

// --- regression guard for the #75 denomination predicate --------------------
// Kept here because `compareAggregatorPin` and `isUsdQuoted` are the two pure decisions in this
// script, and the denomination one previously had no unit coverage at all — only the Solidity
// mirror in AuditFeedDenomination.t.sol. Both halves must agree byte for byte.

test('isUsdQuoted accepts the real launch descriptions', () => {
  for (const d of ['ETH / USD', 'BTC / USD', 'LINK / USD', 'CBETH / USD', 'ETH/USD']) {
    assert.equal(isUsdQuoted(d), true, d);
  }
});

test('isUsdQuoted rejects the ETH-denominated feed that caused cbETH to be dropped', () => {
  assert.equal(isUsdQuoted('CBETH / ETH'), false);
});

test('isUsdQuoted rejects a USD-ish TOKEN quote leg — the separator is what does it', () => {
  assert.equal(isUsdQuoted('ETH / PYUSD'), false, 'PYUSD is a token, not USD');
  assert.equal(isUsdQuoted('XUSD'), false);
});

test('isUsdQuoted rejects non-strings and short strings without throwing', () => {
  for (const d of [null, undefined, 42, '', 'USD']) assert.equal(isUsdQuoted(d), false, String(d));
});

// --- band width: the check that makes residual row 14 TRUE, not merely asserted ---
// Row 14 accepts the cached-`scale` risk because the sane-price band already fail-closes on every
// drift of >= 2 decimals. That argument holds only while the band is tight relative to the live
// price -- and the pre-existing verifier check only asked whether a band EXISTS. A band of
// $0.01..$1e12 satisfies "set" and catches nothing, silently voiding the acceptance. Live values
// below read from Base mainnet / Base Sepolia 2026-08-30.

const wad = (answer8) => BigInt(answer8) * 10n ** 10n;

test('the real launch bands DO bound a 2-decimal drift at live prices', () => {
  // WETH $2,459.11 in $100..$100k; cbBTC $78,123 in $1k..$1M; Sepolia LINK $11.39 in $1..$1k.
  assert.equal(bandBoundsTwoDecimalDrift(wad(245911590522), 10n ** 20n, 10n ** 23n).ok, true, 'WETH');
  assert.equal(bandBoundsTwoDecimalDrift(wad(7812300000000), 10n ** 21n, 10n ** 24n).ok, true, 'cbBTC');
  assert.equal(bandBoundsTwoDecimalDrift(wad(1139339364), 10n ** 18n, 10n ** 21n).ok, true, 'LINK/Sepolia');
});

test('a band that is merely SET but far too wide fails — the gap this check exists to close', () => {
  const r = bandBoundsTwoDecimalDrift(2440n * 10n ** 18n, 10n ** 16n, 10n ** 30n);
  assert.equal(r.ok, false);
  assert.match(r.detail, /BAND NO LONGER BOUNDS/);
  assert.match(r.detail, /row 14/, 'the message must name the acceptance it invalidates');
  assert.match(
    r.detail,
    /CHECK WHICH INPUT MOVED/,
    'the message must not assume the band is at fault: the same failure is produced by the PRICE moving, with no config change',
  );
});

test('the ceiling alone can fail it, and the message says which side', () => {
  // x100 = $244,000 vs a $1,000,000 ceiling: does not leave the band. Floor side is fine.
  const r = bandBoundsTwoDecimalDrift(2440n * 10n ** 18n, 10n ** 20n, 10n ** 24n);
  assert.equal(r.ok, false);
  assert.match(r.detail, /x100 .* is still <= the ceiling/);
  assert.doesNotMatch(r.detail, /is still >= the floor/);
});

test('the floor alone can fail it', () => {
  // /100 = $24.40 vs a $1 floor: does not leave the band. Ceiling side is fine.
  const r = bandBoundsTwoDecimalDrift(2440n * 10n ** 18n, 10n ** 18n, 10n ** 23n);
  assert.equal(r.ok, false);
  assert.match(r.detail, /\/100 .* is still >= the floor/);
  assert.doesNotMatch(r.detail, /<= the ceiling/);
});

test('it is a function of the LIVE PRICE, not of the band alone', () => {
  const band = [10n ** 20n, 10n ** 23n]; // the real WETH band, unchanged
  assert.equal(bandBoundsTwoDecimalDrift(2440n * 10n ** 18n, ...band).ok, true, 'at $2,440 the band bounds the drift');
  // A 5x crash to $488 leaves the config untouched and the residual genuinely wider: a +2-decimal
  // drift now reads $48,800, inside a $100,000 ceiling, and nothing would trip.
  assert.equal(bandBoundsTwoDecimalDrift(488n * 10n ** 18n, ...band).ok, false, 'at $488 the same band no longer does');
});

test('a disabled or malformed band fails rather than dividing by nothing', () => {
  for (const [mn, mx] of [[0n, 0n], [10n ** 20n, 0n], [0n, 10n ** 23n], [10n ** 23n, 10n ** 20n]]) {
    assert.equal(bandBoundsTwoDecimalDrift(2440n * 10n ** 18n, mn, mx).ok, false, `${mn}/${mx}`);
  }
});

test('no live price means the band cannot be sized — fail, never silently pass', () => {
  assert.equal(bandBoundsTwoDecimalDrift(0n, 10n ** 20n, 10n ** 23n).ok, false);
});

// ---------------------------------------------------------------------------
// TRANSPORT IS NOT A VERDICT — the whole script, end to end, against a fake `cast`.
//
// A failed RPC call and a contract revert both used to reach `main` as the same `null` / `'0x'`,
// so a rate limit printed "code.length == 0", "description=null", "decimals=null",
// "latestRoundData reverted" and "reverted / no code" — findings about a deployment nobody had
// read — and exited 1 with "do NOT deploy the oracle". The same shape was fixed in the soak harness (#173) and the canary
// (#179); this is the verifier's turn. The rule these tests pin: a read that fails WITHOUT a
// confirmed revert is ERR (an un-run check, exit 2), a confirmed revert keeps its FAIL (exit 1),
// and a FAIL is never masked by an ERR.
//
// The helpers under test are module-private and shell out to `cast`, so the script is run as a
// child process with `CAST` pointed at node itself and scripts/test/fake-cast.cjs preloaded — see
// that file for why. Every stderr wording the fake emits is one cast 1.7.1 actually printed.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'verify-chainlink-oracle.mjs');
const FAKE_CAST = path.join(HERE, 'fake-cast.cjs').replace(/\\/g, '/');
const SEQ = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
const FEED = '0x5000000000000000000000000000000000000001';
const LRD = 'latestRoundData()(uint80,int256,uint256,uint256,uint80)';
const CONFIG = {
  chainId: 8453,
  chainlinkOracle: {
    sequencerUptimeFeed: SEQ,
    assets: [
      {
        symbol: 'WETH',
        asset: '0x4200000000000000000000000000000000000006',
        feed: FEED,
        feedDescriptionOnChain: 'ETH / USD',
        heartbeatSeconds: 1200,
        minPriceWad: '100000000000000000000',
        maxPriceWad: '100000000000000000000000',
        aggregatorPin: { implementation: IMPL, phaseId: 1 },
      },
    ],
  },
};

/**
 * Run the verifier once. `fail` is the fake-cast scenario ("<sig>=<transport|revert|nocode>;…").
 * Returns the parsed --json report (or the text report when `json` is false), the exit status, and
 * the list of cast invocations the fake logged. `raw: true` skips JSON.parse and hands back stdout
 * and stderr untouched — needed when the run is expected to REFUSE before printing any report at
 * all (see the missing-cast-binary test below), where stdout is empty and parsing it would throw.
 */
function runVerifier({ fail = '', json = true, strict = false, cast = process.execPath, raw = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vco-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(CONFIG));
  const log = path.join(dir, 'calls.log');
  const args = [SCRIPT, ...(json ? ['--json'] : []), ...(strict ? ['--strict'] : [])];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONFIG: cfgPath,
      BASE_RPC: 'http://127.0.0.1:1', // never contacted: every cast is the fake
      CAST: cast,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${FAKE_CAST}"`.trim(),
      FAKE_CAST_FAIL: fail,
      FAKE_CAST_LOG: log,
      FAKE_CAST_SEQ: SEQ,
    },
  });
  assert.equal(r.error, undefined, String(r.error));
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  if (raw) return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  if (!json) return { status: r.status, text: r.stdout, calls };
  const out = JSON.parse(r.stdout);
  assert.equal(out.passed + out.failed + out.errored + out.drift, out.total, 'the four counts must partition the results');
  return { status: r.status, out, calls };
}
const byName = (out, re) => out.results.filter((r) => re.test(r.name));
const details = (out) => out.results.map((r) => r.detail).join('\n');

test('baseline: the fake feed passes every check and exits 0 — the harness itself is sound', () => {
  const { status, out } = runVerifier();
  assert.equal(status, 0, JSON.stringify(out, null, 2));
  assert.equal(out.failed, 0);
  assert.equal(out.errored, 0);
  assert.equal(out.drift, 0);
  assert.equal(out.passed, out.total);
  assert.ok(out.total >= 14, `expected the full sweep, got ${out.total} results`);
});

test('a transport failure on description() is ERR on both description checks — never "description=null", exit 2', () => {
  const { status, out, calls } = runVerifier({ fail: 'description()(string)=transport' });
  assert.equal(status, 2, 'incomplete is exit 2: neither verified (0) nor failed (1)');
  assert.equal(out.failed, 0, details(out));
  assert.equal(out.errored, 2);
  for (const r of byName(out, /description/)) {
    assert.equal(r.error, true, r.name);
    assert.equal(r.ok, false, r.name);
    assert.match(r.detail, /no revert was observed/);
    assert.match(r.detail, /NOT a verdict/);
  }
  assert.doesNotMatch(details(out), /description=null/, 'the old false finding must be gone');
  assert.equal(calls.filter((c) => c.includes('description()(string)')).length, 2, 'a non-revert failure is retried exactly once');
});

test('a genuine revert on description() keeps its FAIL — description=null, exit 1 — and is not retried', () => {
  const { status, out, calls } = runVerifier({ fail: 'description()(string)=revert' });
  assert.equal(status, 1);
  assert.equal(out.errored, 0, 'a confirmed revert is evidence, not a missing read');
  const [usd] = byName(out, /USD-quoted/);
  assert.equal(usd.ok, false);
  assert.equal(usd.detail, 'description=null');
  assert.equal(calls.filter((c) => c.includes('description()(string)')).length, 1, 'a revert is thrown on the first try');
});

test('a transport failure on latestRoundData() is ERR, names the checks that did not run, and says "reverted" nowhere', () => {
  const { status, out } = runVerifier({ fail: `${LRD}=transport` });
  assert.equal(status, 2);
  assert.equal(out.failed, 0, details(out));
  // Both the sequencer feed and the asset feed read latestRoundData; both are ERR.
  assert.equal(out.errored, 2);
  const [lrd] = byName(out, /WETH: latestRoundData answers/);
  assert.equal(lrd.error, true);
  assert.match(lrd.detail, /did not run/, 'the operator must be told the dependent checks were skipped, not just that one read failed');
  assert.equal(byName(out, /answer > 0/).length, 0, 'the dependent checks were not scored');
  assert.doesNotMatch(details(out), /reverted/, 'the literal "reverted" used to be printed for every failure cause');
});

test('a genuine revert on latestRoundData() still FAILs as "latestRoundData reverted", exit 1', () => {
  const { status, out } = runVerifier({ fail: `${LRD}=revert` });
  assert.equal(status, 1);
  assert.equal(out.errored, 0);
  const [lrd] = byName(out, /WETH: latestRoundData answers/);
  assert.equal(lrd.ok, false);
  assert.equal(lrd.detail, 'latestRoundData reverted');
  const [seq] = byName(out, /sequencer uptime feed answers/);
  assert.equal(seq.ok, false);
  assert.equal(seq.detail, 'latestRoundData reverted');
});

test('a transport failure on cast code is ERR on both has-code checks — not "code.length == 0"', () => {
  const { status, out } = runVerifier({ fail: 'code=transport' });
  assert.equal(status, 2);
  assert.equal(out.failed, 0, details(out));
  assert.equal(out.errored, 2);
  for (const r of byName(out, /has code/)) assert.equal(r.error, true, r.name);
  assert.doesNotMatch(details(out), /== 0/, 'a feed nobody could read must not be reported as having no code');
});

test('a transport failure on decimals() is ERR on the decimals check AND on the live-price check that needs it', () => {
  const { status, out } = runVerifier({ fail: 'decimals()(uint8)=transport' });
  assert.equal(status, 2);
  assert.equal(out.failed, 0, details(out));
  assert.equal(out.errored, 2);
  const [dec] = byName(out, /decimals == 8/);
  assert.equal(dec.error, true);
  // The cascade: the WAD spot is scaled from decimals(), so this used to FAIL as
  // "could not scale the live answer to WAD" — a second false finding from the same 429.
  const [live] = byName(out, /live price inside the band/);
  assert.equal(live.error, true);
  assert.match(live.detail, /band-width check .* did not run/);
  assert.equal(byName(out, /band bounds a 2-decimal drift/).length, 0);
  assert.doesNotMatch(details(out), /could not scale/);
  // phaseId() goes through the same helper with a different signature and is unaffected.
  assert.equal(byName(out, /aggregator unchanged since pin/)[0]?.ok, true);
});

test('a transport failure on BOTH pin reads is ERR, not a DRIFT notice inferring "not an EACAggregatorProxy" — even under --strict', () => {
  for (const strict of [false, true]) {
    const { status, out } = runVerifier({ fail: 'aggregator()(address)=transport;phaseId()(uint16)=transport', strict });
    assert.equal(status, 2, `strict=${strict}: an un-run pin is incomplete, not a strict-mode notice failure`);
    assert.equal(out.failed, 0, details(out));
    assert.equal(out.drift, 0);
    const [pin] = byName(out, /aggregator pin/);
    assert.equal(pin.error, true);
    assert.doesNotMatch(details(out), /not an EACAggregatorProxy/, 'two reads that never answered prove nothing about the proxy');
  }
});

test('a transport failure on aggregator() ALONE still goes through compareAggregatorPin as a notice — phaseId can still convict', () => {
  // Deliberately unchanged: `compareAggregatorPin` was written for a dropped `aggregator()` read
  // (the false "SWAPPED -> now null" alarm above), and a phaseId that moved is a swap whether or
  // not aggregator() answered. Routing a single failed read to ERR would lose that conviction.
  const { status, out } = runVerifier({ fail: 'aggregator()(address)=transport' });
  assert.equal(status, 0, 'a notice does not set the exit code outside --strict');
  assert.equal(out.errored, 0);
  const [pin] = byName(out, /aggregator pin/);
  assert.equal(pin.drift, true);
  assert.match(pin.detail, /NOT confirmed/);
  assert.doesNotMatch(pin.detail, /SWAPPED/);
});

// A missing `cast` binary used to reach the ERR machinery below (every helper's read fails, so
// every check row comes back ERR, exit 2 — see the sibling PR that added it). Merged with the
// chain-binding refusal above, it no longer gets that far: `readRpcChainId` calls `cast` too, so a
// missing binary means the chain id can never be read, and `main` refuses BEFORE the sweep runs at
// all — the same "unproven binding is not a binding" path a bad RPC hits, not the ERR path a single
// bad feed read hits. That is a stricter fail-closed, not a weaker one: nothing is scored, and
// nothing claims to have swept a config it never touched. Pinned against the refusal here rather
// than against a full ERR sweep, since the refusal is what the merged script actually does.
test('a missing cast binary refuses at the chain-binding step — exit 1, UNPROVEN, no check rows at all', () => {
  const cast = `definitely-not-a-real-binary-${'x'.repeat(8)}`;
  const { status, stdout, stderr } = runVerifier({ cast, raw: true });
  assert.equal(status, 1, 'a chain id that could never be read refuses; it does not sweep and score ERR rows');
  assert.equal(stdout, '', 'a refusal prints no report at all, JSON or text — an empty result list is never a silent pass');
  assert.match(stderr, /UNPROVEN/);
  assert.match(stderr, /Refusing rather than sweeping/);
  assert.doesNotMatch(stderr, /do NOT deploy/, 'that sentence is the FAIL verdict, and nothing was read');
});

test('a real FAIL alongside an ERR exits 1 — an un-run check never masks a failed one', () => {
  const { status, out } = runVerifier({ fail: 'decimals()(uint8)=revert;description()(string)=transport' });
  assert.equal(status, 1);
  assert.equal(out.errored, 2);
  assert.ok(out.failed >= 1);
  const [dec] = byName(out, /decimals == 8/);
  assert.equal(dec.ok, false);
  assert.equal(dec.detail, 'decimals=null');
});

test('a feed with no code: `cast code` FAILs it, and the reads that depend on it are ERR quoting cast — not "reverted"', () => {
  // cast 1.7.1 refuses a call to a codeless address with "contract 0x… does not have any code",
  // which the shared classifier files as 'transport' (not a confirmed revert). The finding is
  // carried, truthfully, by the has-code check; the dependent reads say what cast said.
  const fail = ['code', 'description()(string)', 'decimals()(uint8)', 'aggregator()(address)', 'phaseId()(uint16)', LRD]
    .map((k) => `${k}=nocode`)
    .join(';');
  const { status, out } = runVerifier({ fail });
  assert.equal(status, 1, 'a genuine finding still exits 1 even with ERRs beside it');
  for (const r of byName(out, /has code/)) {
    assert.equal(r.ok, false, r.name);
    assert.equal(r.error, undefined, `${r.name} is a FAIL, not an ERR`);
  }
  assert.ok(out.errored >= 4);
  for (const r of out.results.filter((x) => x.error)) assert.match(r.detail, /does not have any code/, r.name);
  assert.doesNotMatch(details(out), /reverted/);
});

// --- chain binding: the RPC must BE the chain the config names -------------------
// Every other check in the verifier reads an address, and an address means nothing without a
// chain. The gap this closes was silent by construction: `BASE_MAINNET_RPC` takes precedence over
// `BASE_RPC` and over the per-chain default, so one stale export in a shell sent a run launched
// with ANY config to Base mainnet, where the configured feeds are other contracts or nothing --
// and the sweep printed a pass tally for a chain nobody had asked about.

test('a matching chain id binds, and the message names the chain and the config', () => {
  const r = chainBindingVerdict({
    configChainId: 4663, rpcChainId: 4663, rpc: 'https://rpc.example', configPath: 'contracts/config/x.json',
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /chain 4663/);
  assert.match(r.message, /contracts\/config\/x\.json/);
});

test('a config chainId of 4663 against an RPC answering 8453 REFUSES, naming both ids', () => {
  const r = chainBindingVerdict({
    configChainId: 4663, rpcChainId: 8453, rpc: 'https://rpc.example', configPath: 'contracts/config/x.json',
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /WRONG CHAIN/);
  assert.match(r.message, /8453/, 'the message must name what the RPC reported');
  assert.match(r.message, /4663/, 'and what the config declared');
  assert.match(
    r.message,
    /BASE_MAINNET_RPC/,
    'and must point at the env var whose precedence produces this, since a stale export is the likely cause',
  );
});

test('the config chainId is compared as a number — JSON holds 4663, cast prints "4663"', () => {
  assert.equal(chainBindingVerdict({ configChainId: '4663', rpcChainId: 4663, rpc: 'r', configPath: 'c' }).ok, true);
});

test('an UNREADABLE chain id refuses too — an unproven binding is not a binding', () => {
  const r = chainBindingVerdict({ configChainId: 4663, rpcChainId: null, rpc: 'https://rpc.example', configPath: 'c' });
  assert.equal(r.ok, false, 'a chain id that could not be read must never pass as a match');
  assert.match(r.message, /UNPROVEN/);
  assert.doesNotMatch(r.message, /WRONG CHAIN/, 'unreadable is not the same finding as a mismatch');
});

test('a config with no usable chainId refuses rather than binding to whatever answers', () => {
  for (const bad of [undefined, null, 0, -1, 'base']) {
    assert.equal(chainBindingVerdict({ configChainId: bad, rpcChainId: 8453, rpc: 'r', configPath: 'c' }).ok, false, String(bad));
  }
});

// --- the same rule, end to end through the real script ---------------------------
// The pure tests above prove the decision; these prove it is WIRED -- that `main` consults it
// before reading a feed, and that the process actually exits 1. `cast` is stubbed, so there is no
// RPC and no network: the verifier runs `execFileSync(CAST, ['chain-id', …])`, and Windows cannot
// exec a script file as a program, so CAST is node itself with the stub preloaded via
// `NODE_OPTIONS=--require`. Node runs preloads before resolving the main entry, so the stub answers
// and exits before node looks for a script named "chain-id". In the verifier's own process (which
// inherits NODE_OPTIONS) argv[1] is the .mjs path, so the stub recognises no subcommand and does
// nothing. It implements ONLY `chain-id`: any other cast invocation exits 3 with a message, which
// is itself the assertion that no feed was read.

const VERIFIER = fileURLToPath(new URL('../verify-chainlink-oracle.mjs', import.meta.url));

/** Run the verifier with `cast chain-id` stubbed to `rpcChainId`, against a written config. */
function runChainBindingVerifier({ configChainId, rpcChainId }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-binding-'));
  const stub = path.join(dir, 'stub-cast.cjs');
  // Written with console.log/console.error rather than fs.writeSync so the stub's own source needs
  // no escape sequences — the newline is the logger's, not a backslash-n surviving two layers of
  // quoting into a generated file.
  fs.writeFileSync(
    stub,
    [
      `'use strict';`,
      `const p = require('node:path');`,
      `const sub = p.basename(String(process.argv[1] ?? ''));`,
      `if (sub === 'chain-id') { console.log('${rpcChainId}'); process.exit(0); }`,
      // Anything that is not a JS entry point is a cast subcommand this stub does not implement.
      // Exiting 3 with a message is how the tests assert that no feed read was attempted.
      `if (!/[.](mjs|cjs|js)$/.test(sub)) {`,
      `  console.error('stub-cast: unexpected invocation ' + process.argv.slice(1).join(' '));`,
      `  process.exit(3);`,
      `}`,
      '',
    ].join('\n'),
  );
  const cfg = path.join(dir, 'cfg.json');
  // No feeds and an empty sequencer address: past the binding, `main` fails on those two checks
  // without spawning `cast` again. That keeps the stub to one subcommand and makes "did any feed
  // get read?" answerable from the output alone.
  fs.writeFileSync(cfg, JSON.stringify({ chainId: configChainId, chainlinkOracle: { sequencerUptimeFeed: '', assets: [] } }));
  // Neither override is set, so the RPC comes from DEFAULT_RPC — which exercises the new 4663
  // entry as well as the binding. `delete` rather than '': the script resolves with `??`, so an
  // empty string is a value and would fall through to "no default RPC for chainId 4663".
  // No request is made either way; `cast` is the stub.
  const env = { ...process.env, CONFIG: cfg, CAST: process.execPath };
  delete env.BASE_MAINNET_RPC;
  delete env.BASE_RPC;
  const r = spawnSync(process.execPath, [VERIFIER], {
    encoding: 'utf8',
    env: {
      ...env,
      // Forward slashes, not the native separator. NODE_OPTIONS is parsed as a shell-like string
      // and a backslash there is an escape, so a real Windows path arrives as
      // "C:UsersMichaAppData…" and the preload fails with MODULE_NOT_FOUND before the verifier
      // starts. Node accepts forward slashes on Windows, so this is the portable spelling.
      NODE_OPTIONS: `--require "${stub.split(path.sep).join('/')}"`,
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('end to end: a 4663 config against a cast answering 8453 refuses, and reads no feed', () => {
  const r = runChainBindingVerifier({ configChainId: 4663, rpcChainId: 8453 });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /WRONG CHAIN/);
  assert.match(r.stderr, /8453/);
  assert.match(r.stderr, /4663/);
  assert.doesNotMatch(
    r.stdout,
    /sequencer uptime feed|at least one asset feed listed/,
    'the refusal must come BEFORE any check row: a tally scored against the wrong chain must not be printed at all',
  );
});

test('end to end: matching ids proceed into the sweep, which then judges the config itself', () => {
  const r = runChainBindingVerifier({ configChainId: 4663, rpcChainId: 4663 });
  assert.doesNotMatch(r.stderr, /WRONG CHAIN|UNPROVEN/, 'a matching chain id must not be refused');
  assert.match(
    r.stdout,
    /sequencer uptime feed/,
    'the run must reach the feed checks — this fixture then fails them, which is the config being judged rather than the chain',
  );
  assert.doesNotMatch(r.stderr, /unexpected invocation/, 'no cast subcommand beyond chain-id should have been needed');
});

// ---------------------------------------------------------------------------
// THE SEQUENCER EXEMPT SET — two lists, one rule.
//
// `DeployChainlinkOracle.requiresSequencerUptimeFeed` is the guard that actually blocks a deploy;
// this script's SEQUENCER_EXEMPT_CHAIN_IDS is the pre-deploy mirror of it. Nothing but a test makes
// them agree, and they have drifted before in the other direction (the script used to exempt
// `chainId === 8453` while the deploy script used a denylist, fixed 2026-08-29). Pinning the set
// EXACTLY -- not `.has(4663)` -- is what makes an id added to one list and not the other go red.
// ---------------------------------------------------------------------------

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * The source of one Solidity function, from its signature to the `}` that CLOSES it -- counted,
 * not guessed. Returns null if the signature is absent or the braces never balance.
 *
 * Written because the regex this replaces (`...\(uint256 chainId\)[^}]*}`) stopped at the first
 * `}` in the file after the signature. While the body is one `return` expression that is the right
 * `}`; the moment it is not, the match silently becomes a PREFIX of the function, and every
 * assertion downstream is made about a fragment. The dangerous direction is a pass, not a failure:
 * `if (chainId != A && chainId != B && chainId != C) { return true; } return true;` truncates to a
 * fragment carrying all three terms and the right term count, so the old form reported the wiring
 * as correct while the function exempted nothing. Braces inside string literals and comments would
 * defeat this counter too, which is why the single-expression assertion at the call site stays: the
 * two together are what make the haystack trustworthy.
 */
function extractFunctionSource(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

test('the sequencer-exempt set is exactly {31337, 84532, 4663}', () => {
  assert.deepEqual(
    [...SEQUENCER_EXEMPT_CHAIN_IDS].sort((a, b) => a - b),
    [4663, 31337, 84532].sort((a, b) => a - b),
    'an id was added to or removed from the exempt set; the deploy-script allowlist must match',
  );
});

/**
 * THE 4663 REASON IS PRINTED, so it is a public claim and not a comment.
 *
 * `SEQUENCER_EXEMPT_REASONS.get(4663)` is interpolated into the `sequencer uptime feed` row detail
 * ("guard intentionally skipped on exempt chain 4663: <reason>"), so whatever it says is what an
 * operator reads off a passing pre-deploy run. It said "leaving the per-asset heartbeat as the only
 * guard", which undercounts: `priceWad` keeps the staleness bound AND the sane-price band when the
 * uptime feed is address(0). docs/DEPLOYMENT.md, apps/site/how-it-works.html, apps/site/disclaimers.html
 * and contracts/config/robinhood-mainnet.json all already said two, so the printed string was the
 * one place a reader was told one.
 *
 * Pinned against the CONTRACT rather than against the other prose, because agreeing with a document
 * that is itself wrong is the failure this class of test exists to catch. Both cited lines are also
 * required to fall inside `priceWad` — the band is enforced twice, once in the constructor
 * (ChainlinkOracle.sol:218-220) and once at read time, and only the read-time one survives an
 * outage, so a cite that drifted onto the constructor check would be the wrong claim spelled right.
 */
test('the 4663 exemption reason names BOTH surviving guards, and both cites land inside priceWad', () => {
  const reason = SEQUENCER_EXEMPT_REASONS.get(4663);
  assert.ok(reason, '4663 is no longer in SEQUENCER_EXEMPT_REASONS; the printed row has no reason to state');

  // Both guards named. Two assertions, not one combined regex, so the failure says which vanished.
  const heartbeat = reason.match(/heartbeat[^()]*\(ChainlinkOracle\.sol:(\d+)\)/);
  assert.ok(heartbeat, 'the 4663 reason no longer names the per-asset heartbeat/staleness bound with a line cite');
  const band = reason.match(/sane-price band[^()]*\(ChainlinkOracle\.sol:(\d+)\)/);
  assert.ok(band, 'the 4663 reason no longer names the sane-price band with a line cite');

  // The undercount itself, banned by shape rather than by the one phrasing that was there before.
  assert.doesNotMatch(
    reason,
    /only guard|as the only|only remaining|heartbeat alone|sole guard/i,
    'the 4663 reason is back to claiming a single surviving guard; two survive a zero uptime feed',
  );

  const src = fs.readFileSync(path.join(REPO, 'contracts', 'src', 'oracle', 'ChainlinkOracle.sol'), 'utf8');
  const lines = src.split(/\r?\n/);

  // Read-time, not construction-time: the cites must sit inside priceWad's own braces.
  const fn = extractFunctionSource(src, 'function priceWad(address asset) external view returns (uint256)');
  assert.ok(fn, 'priceWad(address) is no longer declared in ChainlinkOracle.sol with that signature');
  const firstLine = src.slice(0, src.indexOf(fn)).split(/\r?\n/).length;
  const lastLine = firstLine + fn.split(/\r?\n/).length - 1;

  const at = (cite, label) => {
    const n = Number(cite);
    assert.ok(
      n >= firstLine && n <= lastLine,
      `the ${label} cite ChainlinkOracle.sol:${n} is outside priceWad (lines ${firstLine}-${lastLine})`,
    );
    return lines[n - 1] ?? '';
  };

  const heartbeatLine = at(heartbeat[1], 'heartbeat');
  assert.match(heartbeatLine, /updatedAt < minUpdated/, `ChainlinkOracle.sol:${heartbeat[1]} is not the staleness bound`);
  assert.match(heartbeatLine, /revert StaleOracle/, `ChainlinkOracle.sol:${heartbeat[1]} no longer fails closed`);

  const bandLine = at(band[1], 'sane-price band');
  assert.match(bandLine, /cfg\.maxPriceWad != 0/, `ChainlinkOracle.sol:${band[1]} is not the sane-price band check`);
  assert.match(bandLine, /cfg\.minPriceWad/, `ChainlinkOracle.sol:${band[1]} no longer compares against the band floor`);
});

test('the deploy script exempts the same three ids, so the two lists cannot drift apart', () => {
  const src = fs.readFileSync(path.join(REPO, 'contracts', 'script', 'DeployChainlinkOracle.s.sol'), 'utf8');
  // NAMED constants, not every `*_CHAIN_ID` in the file. A sweep would also collect a constant that
  // has nothing to do with this guard -- `runWithSequencer`'s Base-mainnet band rule still compares
  // a bare `block.chainid != 8453`, and tidying that into a `BASE_MAINNET_CHAIN_ID` constant is a
  // correct refactor that touches nothing here. Under a sweep that refactor would go red saying the
  // exempt sets disagree, which would be false: a guard that fails with the wrong explanation costs
  // more than one that does not fire.
  const EXEMPT_CONSTANTS = ['LOCAL_CHAIN_ID', 'BASE_SEPOLIA_CHAIN_ID', 'ROBINHOOD_CHAIN_ID'];
  // Extracted BEFORE the loop, because the two assertions below need two different haystacks. The
  // constants are declared at contract scope, OUTSIDE this function, so the declaration check has to
  // read the whole file; the wiring check must read only the function body, or a constant named in a
  // doc comment or in any other function satisfies it while the guard exempts something else. The
  // slice starts at the signature, so the doc comment above the function is outside `guard`.
  //
  // BALANCED BRACES, not the `[^}]*}` this used to be. That regex stopped at the FIRST `}`, so a
  // body that ever gained one -- an `if (...) { ... }` fast path, an `unchecked` block -- truncated
  // the haystack SILENTLY: the fragment can still carry all three `chainId != NAME` terms and the
  // right term count while the code after the truncation point does something else entirely.
  // Counting braces makes the haystack the whole function no matter what the body grows into.
  const guard = extractFunctionSource(src, 'function requiresSequencerUptimeFeed(uint256 chainId)');
  assert.ok(guard, 'requiresSequencerUptimeFeed(uint256 chainId) is no longer declared in DeployChainlinkOracle.s.sol');
  // The single-expression property, now ASSERTED rather than implied. The old `assert.ok(guard, ...)`
  // carried this message while checking nothing of the kind -- `[^}]*}` matched a multi-statement
  // body just as happily, it merely matched less of it. Asserted as an invariant of the BODY (no
  // nested block, exactly one statement) rather than as a signature regex, so an unrelated edit --
  // reordering `public pure`, rewording the NatSpec, renaming a constant -- does not red this test
  // with the wrong explanation, which is the failure mode the comment above warns about.
  const guardBody = guard.slice(guard.indexOf('{') + 1, guard.lastIndexOf('}'));
  assert.ok(
    !guardBody.includes('{') && [...guardBody.matchAll(/;/g)].length === 1,
    'requiresSequencerUptimeFeed is no longer a plain single-expression function',
  );
  const declared = EXEMPT_CONSTANTS.map((name) => {
    const m = src.match(new RegExp(`uint256 constant ${name} = (\\d+);`));
    assert.ok(m, `${name} is no longer declared in DeployChainlinkOracle.s.sol`);
    // Declared is not enough: it must be wired into the guard, not merely sitting beside it.
    assert.ok(
      new RegExp(`chainId != ${name}`).test(guard),
      `${name} is declared but requiresSequencerUptimeFeed does not exempt it`,
    );
    return Number(m[1]);
  });
  assert.deepEqual(
    declared.sort((a, b) => a - b),
    [...SEQUENCER_EXEMPT_CHAIN_IDS].sort((a, b) => a - b),
    'DeployChainlinkOracle declares a different set of exempt chain ids than this script exempts',
  );
  // The other direction, which naming the constants would otherwise lose: a FOURTH id exempted in
  // the guard and never added here. Count the terms in the guard rather than trusting the list.
  assert.equal(
    [...guard.matchAll(/chainId != /g)].length,
    EXEMPT_CONSTANTS.length,
    'requiresSequencerUptimeFeed exempts a different NUMBER of ids than EXEMPT_CONSTANTS names',
  );
});
