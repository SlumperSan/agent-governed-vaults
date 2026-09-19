import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_BAND_RATIO as VERIFIER_MAX_BAND_RATIO,
  MAX_HEARTBEAT as VERIFIER_MAX_HEARTBEAT,
  MIN_HEARTBEAT as VERIFIER_MIN_HEARTBEAT,
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

// --- the SAME failure, the other read (#266) --------------------------------
// The two pin reads were not treated alike. A dropped `aggregator()` produced the UNREADABLE
// notice above; a dropped `phaseId()` produced `ok` with the message "unchanged since the pin" --
// an assertion that the pin was CONFIRMED, satisfied by a read that never happened. Exit 0, and
// exit 0 under `--strict` too, because only notices set that code.
//
// This is the detector for aggregator-swap drift, so its `ok` is what docs/LAUNCH-READINESS.md
// row 14 rests on. The rule these tests pin: nothing but two answered reads can produce `ok`.

test('an unanswered phaseId() read with a matching implementation is UNREADABLE, not confirmed', () => {
  const r = compareAggregatorPin(PIN, { implementation: IMPL, phaseId: null });
  assert.equal(r.status, 'unreadable', 'a dropped phaseId() read must not be reported as a confirmed pin');
  assert.doesNotMatch(
    r.message,
    /unchanged since the pin/,
    'a read that did not happen must never be reported as a read that matched',
  );
  assert.doesNotMatch(r.message, /SWAPPED/, 'a dropped RPC call is not evidence of a swap either');
  assert.match(r.message, /NOT confirmed/);
});

test('the implementation alone can convict: it moved, so a swap happened even with phaseId() unread', () => {
  const r = compareAggregatorPin(PIN, { implementation: '0x' + '11'.repeat(20), phaseId: null });
  assert.equal(r.status, 'drift');
  assert.match(r.message, /SWAPPED/);
  assert.match(r.message, /NOT a failure/);
});

test('an unpinned phaseId is not the same as an unanswered one — only the first can still be ok', () => {
  // `pin.phaseId === undefined` is "nothing was pinned to compare", which the implementation match
  // legitimately satisfies. `obsPhase === null` is "the read did not answer". Collapsing the two is
  // exactly the defect; this asserts they stayed apart.
  const unpinned = compareAggregatorPin({ implementation: IMPL }, { implementation: IMPL, phaseId: null });
  assert.equal(unpinned.status, 'ok');
  const unanswered = compareAggregatorPin({ implementation: IMPL, phaseId: 1 }, { implementation: IMPL, phaseId: null });
  assert.equal(unanswered.status, 'unreadable');
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
function runVerifier({ configChainId, rpcChainId }) {
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
  const r = runVerifier({ configChainId: 4663, rpcChainId: 8453 });
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
  const r = runVerifier({ configChainId: 4663, rpcChainId: 4663 });
  assert.doesNotMatch(r.stderr, /WRONG CHAIN|UNPROVEN/, 'a matching chain id must not be refused');
  assert.match(
    r.stdout,
    /sequencer uptime feed/,
    'the run must reach the feed checks — this fixture then fails them, which is the config being judged rather than the chain',
  );
  assert.doesNotMatch(r.stderr, /unexpected invocation/, 'no cast subcommand beyond chain-id should have been needed');
});

// --- #266 end to end: a dropped phaseId() must not exit 0 -------------------
// The pure tests above prove the decision; this proves the PROCESS. It matters separately because
// the defect's whole signature was the exit code: `compareAggregatorPin` returned `ok`, `main`
// recorded it with `check(..., true, ...)` rather than `notice(...)`, and only notices set the exit
// code under `--strict`. So the run exited 0 and printed "unchanged since the pin".
//
// The fixture is deliberately GREEN IN EVERY OTHER ROW. If any other check failed, the process
// would exit 1 whether or not this bug is present, and the assertion below would pass against the
// unfixed script — a mutation-insensitive test, which is the same class of defect as the bug.
// `assert.match(stdout, /checks passed/)` with no FAIL row is what holds that property in place.

/**
 * Run the verifier over one healthy feed, with `phaseId()` either answering or dropped.
 * Same CAST=node + NODE_OPTIONS=--require stub mechanism as `runVerifier` above.
 */
/**
 * A constant read from ChainlinkOracle.sol. The end-to-end heartbeat tests below are driven by the
 * CONTRACT's value, not by the verifier's mirror of it: if they used the mirror, inlining a stale
 * number at the verifier's bound check would move both sides together and prove nothing.
 */
/**
 * Every shipped file a reader would take a heartbeat bound or an owner-decision claim from. Named,
 * not globbed, so a new config is a deliberate addition here rather than silently uncovered.
 */
const FILES = [
  'contracts/config/arc-mainnet.json',
  'contracts/config/base-mainnet.json',
  'contracts/config/base-sepolia.json',
  'docs/evidence/arc-mainnet-survey.json',
];

function oracleConstant(name) {
  const src = fs.readFileSync(path.join(REPO, 'contracts', 'src', 'oracle', 'ChainlinkOracle.sol'), 'utf8');
  const m = new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)`).exec(src);
  assert.ok(m, `${name} is no longer declared as a numeric constant in ChainlinkOracle.sol`);
  return Number(m[1].replace(/_/g, ''));
}

function runVerifierOverFeed({ dropPhaseId, heartbeatSeconds = 3600 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aggregator-pin-'));
  const stub = path.join(dir, 'stub-cast.cjs');
  const FEED = '0x' + 'ab'.repeat(20);
  fs.writeFileSync(
    stub,
    [
      `'use strict';`,
      `const p = require('node:path');`,
      `const argv = process.argv.slice(1);`,
      `const sub = p.basename(String(argv[0] ?? ''));`,
      // The verifier's own process inherits NODE_OPTIONS; there argv[1] is the .mjs entry point.
      `if (/[.](mjs|cjs|js)$/.test(sub)) { return; }`,
      `if (sub === 'chain-id') { console.log('4663'); process.exit(0); }`,
      `if (sub === 'code') { console.log('0x60806040'); process.exit(0); }`,
      `if (sub === 'call') {`,
      `  const sig = String(argv[2] ?? '');`,
      // `cast` prints a string return wrapped in quotes and the verifier strips them if present;
      // printing it bare keeps this generated file free of nested quoting.
      `  if (/^description/.test(sig)) { console.log('ETH / USD'); process.exit(0); }`,
      `  if (/^decimals/.test(sig)) { console.log('8'); process.exit(0); }`,
      `  if (/^aggregator/.test(sig)) { console.log('${IMPL}'); process.exit(0); }`,
      `  if (/^phaseId/.test(sig)) {`,
      // THE DEFECT UNDER TEST: one read of the two that make up the pin never answers. `castRetry`
      // retries once, so failing unconditionally is what a genuinely dropped read looks like.
      `    if (${dropPhaseId ? 'true' : 'false'}) { console.error('stub-cast: phaseId() dropped'); process.exit(1); }`,
      `    console.log('1'); process.exit(0);`,
      `  }`,
      `  if (/^latestRoundData/.test(sig)) {`,
      `    const now = Math.floor(Date.now() / 1000);`,
      // (roundId, answer, startedAt, updatedAt, answeredInRound); answer is $3,000.00 at 8 decimals.
      `    console.log([1, 300000000000, now, now, 1].join('\\n'));`,
      `    process.exit(0);`,
      `  }`,
      `}`,
      `console.error('stub-cast: unexpected invocation ' + argv.join(' '));`,
      `process.exit(3);`,
      '',
    ].join('\n'),
  );
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      // 4663 is sequencer-exempt, so an empty uptime feed PASSES rather than failing a row.
      chainId: 4663,
      chainlinkOracle: {
        sequencerUptimeFeed: '',
        assets: [
          {
            symbol: 'ETH',
            feed: FEED,
            feedDescriptionOnChain: 'ETH / USD',
            heartbeatSeconds,
            // Band sized so every band row passes against the stub's $3,000 answer: the live price
            // 3e21 WAD sits inside [1e20, 1e23], the ratio is exactly the 1000x ceiling, and a
            // +/-2-decimal drift (3e23 / 3e19) leaves it in both directions.
            minPriceWad: '100000000000000000000',
            maxPriceWad: '100000000000000000000000',
            aggregatorPin: { implementation: IMPL, phaseId: 1 },
          },
        ],
      },
    }),
  );
  const env = { ...process.env, CONFIG: cfg, CAST: process.execPath };
  delete env.BASE_MAINNET_RPC;
  delete env.BASE_RPC;
  const r = spawnSync(process.execPath, [VERIFIER, '--strict'], {
    encoding: 'utf8',
    env: { ...env, NODE_OPTIONS: `--require "${stub.split(path.sep).join('/')}"` },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('end to end: the control fixture is green — every row passes and --strict exits 0', () => {
  const r = runVerifierOverFeed({ dropPhaseId: false });
  assert.doesNotMatch(r.stdout, /^FAIL /m, `a row failed, so the fixture proves nothing: ${r.stdout}`);
  assert.doesNotMatch(r.stderr, /unexpected invocation/, `the stub was asked for a call it does not implement: ${r.stderr}`);
  assert.equal(r.status, 0, `expected exit 0 with both pin reads answering. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /unchanged since the pin/, 'two answered, matching reads are what may legitimately confirm the pin');
});

test('end to end: the verifier accepts the SHIPPED 90,000 s heartbeat, not just the 3,600 s fixture', () => {
  // THE ROUND-2 RESIDUAL, closed. Every end-to-end fixture used 3,600 s, so the bound row never
  // exercised the ceiling: inlining `86400n` in place of MAX_HEARTBEAT at the bound check survived
  // the whole suite, and the mirrors being pinned to the Solidity source covered the DECLARATION
  // rather than its USE. arc-mainnet.json ships 90,000 s, so a verifier that still believed the old
  // ceiling would refuse the config it is meant to verify.
  const r = runVerifierOverFeed({ dropPhaseId: false, heartbeatSeconds: oracleConstant('MAX_HEARTBEAT') });
  assert.doesNotMatch(r.stdout, /^FAIL /m, `a row failed at the shipped heartbeat: ${r.stdout}`);
  assert.match(r.stdout, /heartbeat within on-chain bounds/, 'the bound row must actually have been evaluated');
  assert.equal(r.status, 0, `expected exit 0 at ${oracleConstant('MAX_HEARTBEAT')}s. stdout: ${r.stdout}`);
});

test('end to end: one second ABOVE the ceiling fails the bound row, so the ceiling is not decorative', () => {
  // The other direction. Without this the test above passes with a bound check that accepts anything.
  const r = runVerifierOverFeed({ dropPhaseId: false, heartbeatSeconds: oracleConstant('MAX_HEARTBEAT') + 1 });
  assert.match(r.stdout, /FAIL .*heartbeat within on-chain bounds/, `expected the bound row to fail: ${r.stdout}`);
  assert.notEqual(r.status, 0, 'a config the constructor would reject must not verify green');
});

test('end to end: one second BELOW the floor fails too — the floor freezes a healthy feed', () => {
  const r = runVerifierOverFeed({ dropPhaseId: false, heartbeatSeconds: oracleConstant('MIN_HEARTBEAT') - 1 });
  assert.match(r.stdout, /FAIL .*heartbeat within on-chain bounds/, `expected the bound row to fail: ${r.stdout}`);
  assert.notEqual(r.status, 0);
});

test('end to end: dropping ONLY phaseId() must not exit 0 and must not claim the pin was confirmed', () => {
  const r = runVerifierOverFeed({ dropPhaseId: true });
  // Nothing else changed between the two runs, so any failure here is attributable to the dropped
  // read alone — the control above is what establishes that.
  assert.doesNotMatch(r.stdout, /^FAIL /m, `a row failed for an unrelated reason: ${r.stdout}`);
  assert.doesNotMatch(
    r.stdout,
    /unchanged since the pin/,
    'a read that did not happen was reported as a read that matched',
  );
  assert.match(r.stdout, /^DRIFT .*pin NOT confirmed/m, 'the unanswered read must be surfaced as an unconfirmed pin');
  assert.notEqual(r.status, 0, `--strict must not exit 0 when a pin read never answered. stdout: ${r.stdout}`);
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

/**
 * Both cites in an exemption reason must land inside `priceWad` AND on the line that actually
 * performs the guard they name.
 *
 * SHARED RATHER THAN COPIED, and that is the finding it came from. The 5042 reason's cites were
 * range-checked only — inside the function, any line — so pointing its heartbeat cite at
 * `if (answer <= 0)` passed while the identical mutation killed 4663's. The newest entry was held to
 * a weaker bar than the one beside it. One checker means the sixth entry cannot be either.
 *
 * Inside `priceWad` specifically, because the band is enforced in the constructor too and only the
 * read-time copy survives an outage: a cite that drifted onto the constructor check would be the
 * right claim spelled wrong.
 */
function assertGuardCites(chainId, heartbeatCite, bandCite) {
  const src = fs.readFileSync(path.join(REPO, 'contracts', 'src', 'oracle', 'ChainlinkOracle.sol'), 'utf8');
  const lines = src.split(/\r?\n/);
  const fn = extractFunctionSource(src, 'function priceWad(address asset) external view returns (uint256)');
  assert.ok(fn, 'priceWad(address) is no longer declared in ChainlinkOracle.sol with that signature');
  const firstLine = src.slice(0, src.indexOf(fn)).split(/\r?\n/).length;
  const lastLine = firstLine + fn.split(/\r?\n/).length - 1;

  const at = (cite, label) => {
    const n = Number(cite);
    assert.ok(
      n >= firstLine && n <= lastLine,
      `chain ${chainId}: the ${label} cite ChainlinkOracle.sol:${n} is outside priceWad (lines ${firstLine}-${lastLine})`,
    );
    return lines[n - 1] ?? '';
  };

  const heartbeatLine = at(heartbeatCite, 'heartbeat');
  assert.match(heartbeatLine, /updatedAt < minUpdated/, `chain ${chainId}: ChainlinkOracle.sol:${heartbeatCite} is not the staleness bound`);
  assert.match(heartbeatLine, /revert StaleOracle/, `chain ${chainId}: ChainlinkOracle.sol:${heartbeatCite} no longer fails closed`);

  const bandLine = at(bandCite, 'sane-price band');
  assert.match(bandLine, /cfg\.maxPriceWad != 0/, `chain ${chainId}: ChainlinkOracle.sol:${bandCite} is not the sane-price band check`);
  assert.match(bandLine, /cfg\.minPriceWad/, `chain ${chainId}: ChainlinkOracle.sol:${bandCite} no longer compares against the band floor`);
}

test('the revert string names EVERY exempt chain, so a fifth cannot be added silently', () => {
  // THE DEFECT THAT PRODUCED THE STALE STRING IN THE FIRST PLACE. Six `expectRevert` sites pin the
  // whole string, so a one-character change reds six of twelve — but a reviewer who added a fifth
  // exempt chain the way anyone would (constant, wiring, reason map, EXEMPT_CONSTANTS, exact-set
  // test) and left the string enumerating four kept every forge and node test green. The string is
  // pinned; it was never COUPLED to the set it describes.
  //
  // The revert text is what an operator reads when a deploy refuses, so a chain missing from it reads
  // as "this chain is not exempt" at exactly the moment they are checking whether it is.
  const src = fs.readFileSync(path.join(REPO, 'contracts', 'script', 'DeployChainlinkOracle.s.sol'), 'utf8');
  const revert = /"DeployChainlinkOracle: ORACLE_SEQUENCER[^"]*"/.exec(src);
  assert.ok(revert, 'the ORACLE_SEQUENCER revert string is no longer a single literal in the deploy script');
  const text = revert[0];
  // SET equality on TOKENS, not substring containment. `text.includes('1337')` is true for a string
  // that only says `31337`, so a sixth exempt chain of 1337 - the local chain id already in this very
  // file, not a contrived value - passed the forward check unchanged. And the inverse matched
  // `\b\d{4,7}\b`, so a string claiming `999` or `11155111` (Sepolia) passed the backward check too,
  // both outside that width. One tokenisation, compared both ways, has neither failure mode.
  //
  // A chain id here is always a STANDALONE number, so the token rule is "a digit run not glued to a
  // letter or digit". Bare `\d+` is wrong for a reason worth keeping: the message says "L2 sequencer
  // uptime feed", and it took `2` as a claimed chain id. The lookarounds are the narrowest fix that
  // still refuses any free-standing number which is not an exempt chain - which is the property.
  const claimed = new Set([...text.matchAll(/(?<![A-Za-z0-9])\d+(?![0-9])/g)].map((m) => Number(m[0])));
  const missing = [...SEQUENCER_EXEMPT_CHAIN_IDS].filter((id) => !claimed.has(id));
  assert.deepEqual(
    missing,
    [],
    `these exempt chain ids do not appear in the revert string an operator reads on refusal:\n  ${missing.join(', ')}\n  string: ${text}`,
  );
  const overclaimed = [...claimed].filter((id) => !SEQUENCER_EXEMPT_CHAIN_IDS.has(id));
  assert.deepEqual(
    overclaimed,
    [],
    `the revert string names numbers that are NOT exempt chain ids: ${overclaimed.join(', ')}\n  string: ${text}`,
  );
});

test('the sequencer-exempt set is exactly {31337, 84532, 4663, 5042}', () => {
  assert.deepEqual(
    [...SEQUENCER_EXEMPT_CHAIN_IDS].sort((a, b) => a - b),
    [4663, 5042, 31337, 84532].sort((a, b) => a - b),
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
/**
 * THE SAME BAR FOR THE NEWEST MEMBER, because a set pinned exactly while its new entry's printed
 * reason is unguarded is the shape this repository keeps finding: coverage of the container, none of
 * the contents. `SEQUENCER_EXEMPT_REASONS.get(5042)` is interpolated into a PASSING pre-deploy row,
 * so it is what an operator reads off a green run on the chain we are actually deploying to.
 *
 * It additionally has to say what 4663's does not: that Arc is an L1 and the guard therefore does not
 * APPLY, rather than having been weakened. Those two entries look identical in the code and are
 * different decisions, and an operator comparing them should be able to tell which is which.
 */
test('the 5042 exemption reason names both surviving guards, and says the guard does not APPLY', () => {
  const reason = SEQUENCER_EXEMPT_REASONS.get(5042);
  assert.ok(reason, '5042 is not in SEQUENCER_EXEMPT_REASONS; the printed row would have no reason to state');

  const heartbeat = reason.match(/heartbeat[^()]*\(ChainlinkOracle\.sol:(\d+)\)/);
  assert.ok(heartbeat, 'the 5042 reason no longer names the per-asset heartbeat/staleness bound with a line cite');
  const band = reason.match(/sane-price band[^()]*\(ChainlinkOracle\.sol:(\d+)\)/);
  assert.ok(band, 'the 5042 reason no longer names the sane-price band with a line cite');

  // Same undercount ban as 4663's, by shape rather than by one phrasing.
  assert.doesNotMatch(
    reason,
    /only guard|as the only|only remaining|heartbeat alone|sole guard/i,
    'the 5042 reason claims a single surviving guard; two survive a zero uptime feed',
  );

  // The distinction from 4663, asserted rather than left to the comment: an L1 has no sequencer, so
  // this is not an owner-approved WEAKENING of an applicable guard.
  assert.match(reason, /\bL1\b/, 'the 5042 reason must say Arc is an L1 — that is WHY no feed exists');
  assert.match(
    reason,
    /does not apply|no sequencer|not a rollup/i,
    'the 5042 reason must say the guard does not apply, not merely that a feed is unavailable',
  );

  // Held to the SAME checker as 4663's, not a copy of it: see assertGuardCites.
  assertGuardCites(5042, heartbeat[1], band[1]);
});

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

  // The same checker the 5042 case uses. ONE implementation, so neither entry can be held to a
  // weaker bar than the other — which is exactly what happened while this was a copy.
  assertGuardCites(4663, heartbeat[1], band[1]);
});

test('the deploy script exempts the same four ids, so the two lists cannot drift apart', () => {
  const src = fs.readFileSync(path.join(REPO, 'contracts', 'script', 'DeployChainlinkOracle.s.sol'), 'utf8');
  // NAMED constants, not every `*_CHAIN_ID` in the file. A sweep would also collect a constant that
  // has nothing to do with this guard -- `runWithSequencer`'s Base-mainnet band rule still compares
  // a bare `block.chainid != 8453`, and tidying that into a `BASE_MAINNET_CHAIN_ID` constant is a
  // correct refactor that touches nothing here. Under a sweep that refactor would go red saying the
  // exempt sets disagree, which would be false: a guard that fails with the wrong explanation costs
  // more than one that does not fire.
  const EXEMPT_CONSTANTS = ['LOCAL_CHAIN_ID', 'BASE_SEPOLIA_CHAIN_ID', 'ROBINHOOD_CHAIN_ID', 'ARC_CHAIN_ID'];
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

// ---------------------------------------------------------------------------------------------
// THE BOUNDS THIS SCRIPT MIRRORS MUST BE THE BOUNDS THE CONSTRUCTOR ENFORCES.
//
// `verify-chainlink-oracle.mjs` keeps its own MIN_HEARTBEAT / MAX_HEARTBEAT / MAX_BAND_RATIO, and the
// duplication is deliberate: catching a bad config BEFORE `--broadcast` costs a read-only run, and
// catching it after costs a redeploy of an immutable contract.
//
// NOTHING HELD THEM TO THE CONTRACT, AND ONE DRIFTED. #307 raised the contract's MAX_HEARTBEAT to
// 90,000 s — because Arc's BTC/USD worst gap is 86,423 s and the old ceiling sat 23 s below a healthy
// feed — and this script's copy stayed at 86,400 for a day. The consequence was not cosmetic: the
// pre-deploy verifier would have REJECTED the Arc config's 90,000, a value the constructor accepts, so
// gate 5 could not have gone green on the chain we are deploying to. A mirror that drifts fails toward
// blocking a correct deploy, which is the safe direction and still wrong.
// ---------------------------------------------------------------------------------------------

test('the verifier bounds mirror ChainlinkOracle exactly, so the next raise cannot leave them behind', () => {
  const oracle = fs.readFileSync(path.join(REPO, 'contracts', 'src', 'oracle', 'ChainlinkOracle.sol'), 'utf8');
  /** A private constant's value from the contract source, with underscores stripped. */
  const constant = (name) => {
    const m = new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)`).exec(oracle);
    assert.ok(m, `${name} is no longer declared as a numeric constant in ChainlinkOracle.sol`);
    return BigInt(m[1].replace(/_/g, ''));
  };
  assert.equal(VERIFIER_MIN_HEARTBEAT, constant('MIN_HEARTBEAT'), 'MIN_HEARTBEAT drifted from the contract');
  assert.equal(VERIFIER_MAX_HEARTBEAT, constant('MAX_HEARTBEAT'), 'MAX_HEARTBEAT drifted from the contract');
  assert.equal(VERIFIER_MAX_BAND_RATIO, constant('MAX_BAND_RATIO'), 'MAX_BAND_RATIO drifted from the contract');
});

test('no shipped file restates the heartbeat bounds as literals that disagree with the contract', () => {
  // THE DEFECT THIS EXISTS FOR, and it is the revert string's defect in a different costume: a
  // sentence that DESCRIBES a shared on-chain constant, copied into several files, corrected in one.
  // `heartbeatSeconds in [600, 86400]` was true until MAX_HEARTBEAT was raised to 90,000 on
  // 2026-09-18, and it survived in base-mainnet.json and base-sepolia.json because the fix was
  // scoped to the file being edited (arc-mainnet.json) rather than to the sentence's SHAPE. A third
  // copy called 86,400 the ceiling in docs/evidence/arc-mainnet-survey.json, in the same file that
  // records the raise. The bound belongs to ONE constructor, so its description is coupled to the
  // Solidity source here rather than trusted to whoever edits a config next.
  const oracle = fs.readFileSync(path.join(REPO, 'contracts', 'src', 'oracle', 'ChainlinkOracle.sol'), 'utf8');
  const decl = (name) => {
    const m = new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)`).exec(oracle);
    assert.ok(m, `${name} is no longer declared in ChainlinkOracle.sol -- this check cannot be evaluated`);
    return Number(m[1].replace(/_/g, ''));
  };
  const MIN = decl('MIN_HEARTBEAT');
  const MAX = decl('MAX_HEARTBEAT');
  assert.ok(MIN > 0 && MAX > MIN, `nonsense bounds read from source: [${MIN}, ${MAX}]`);

  // `heartbeat...[a, b]`, digits with or without separators. The `heartbeat` requirement is what
  // keeps base-mainnet's TWAP `[300, 86400] (MIN_WINDOW/MAX_WINDOW)` out of this: that is a DIFFERENT
  // constant pair, and "correcting" it to the heartbeat ceiling would be a false correction.
  // TWO forms, because this round REMOVED the one the first version coupled to. The bracket literal
  // `[600, 86400]` is gone from every config -- replaced with `[MIN_HEARTBEAT, MAX_HEARTBEAT] ... (600 s
  // and 90,000 s today; ...)`, which the bracket matcher does not see. So the real-file scan returned
  // NOTHING and the suite would have redded on its own fixtures rather than on a config: the coupling
  // was the point of the round and was coupled to text that no longer existed. Exactly the shape this
  // guard exists to catch, in the guard.
  //
  // FORM A -- a literal pair: `heartbeat... [lo, hi]`. Kept for any file that still writes numbers.
  // FORM B -- the named form: after `MIN_HEARTBEAT` and `MAX_HEARTBEAT` are named, the first two
  //   numbers before the next `;` are the values being attributed to them. The `;` bound matters:
  //   these notes legitimately go on to discuss 86,400 s as the feed's own cadence and as the OLD
  //   ceiling, and a guard that redded on true historical prose would be deleted.
  const num = (t) => Number(String(t).replace(/[,_\s]/g, ''));
  const scan = (label, text) => {
    const out = [];
    for (const m of text.matchAll(/heartbeat\w*[^.\[\]]{0,80}\[\s*([\d,_]+)\s*,\s*([\d,_]+)\s*\]/gi)) {
      const lo = num(m[1]);
      const hi = num(m[2]);
      if (lo !== MIN || hi !== MAX) out.push(`${label}: literal pair [${lo}, ${hi}] vs contract [${MIN}, ${MAX}] -- ${m[0].slice(0, 80)}`);
    }
    for (const m of text.matchAll(/MIN_HEARTBEAT[^;]{0,120}?MAX_HEARTBEAT([^;]{0,160})/g)) {
      const nums = [...m[1].matchAll(/(\d[\d,_]*)\s*s\b/g)].map((x) => num(x[1]));
      if (nums.length < 2) continue; // names given with no numbers attributed to them: nothing to check
      const [lo, hi] = nums;
      if (lo !== MIN || hi !== MAX) {
        out.push(`${label}: names the constants then attributes (${lo}, ${hi}) to them vs contract (${MIN}, ${MAX})`);
      }
    }
    return out;
  };

  // NON-VACUITY, and every fixture is DERIVED from the contract's own constants rather than writing
  // 600 and 90,000 in. The first version hardcoded them, so raising MAX_HEARTBEAT redded the fixture
  // that says "a correct literal must not be flagged" -- the guard reporting a failure in itself
  // instead of in the configs, which is the same defect as coupling to text that no longer exists.
  const stale = MAX + 1234; // any number the contract does not hold
  assert.equal(scan('fx', `heartbeatSeconds in [${MIN}, ${stale}]; an enabled band...`).length, 1, 'form A: a stale literal must be seen');
  assert.equal(scan('fx', `heartbeat bounds are [${MIN}, ${MAX}] today`).length, 0, 'form A: a correct literal must not be flagged');
  assert.equal(scan('fx', `Bounds are [300, ${stale}] (MIN_WINDOW/MAX_WINDOW) for the TWAP window.`).length, 0, 'the TWAP window is a different constant pair');
  assert.equal(
    scan('fx', `heartbeatSeconds in [MIN_HEARTBEAT, MAX_HEARTBEAT] as declared (${MIN} s and ${stale} s today; the ceiling moved)`).length,
    1,
    'form B: stale numbers attributed to the named constants must be seen -- THIS is the form the tree now uses',
  );
  assert.equal(
    scan('fx', `heartbeatSeconds in [MIN_HEARTBEAT, MAX_HEARTBEAT] as declared (${MIN} s and ${MAX} s today; raised from ${stale} s on 2026-09-18)`).length,
    0,
    'form B: correct numbers pass, and a historical figure after the `;` is not read as a claim',
  );
  assert.equal(scan('fx', 'bounded by MIN_HEARTBEAT and MAX_HEARTBEAT as the contract declares them').length, 0,
    'naming the constants with no numbers attributed is the strongest form and must pass');

  const offenders = [];
  for (const rel of FILES) {
    const abs = path.join(REPO, rel);
    assert.ok(fs.existsSync(abs), `${rel} is gone -- update this list deliberately rather than letting it skip`);
    offenders.push(...scan(rel, fs.readFileSync(abs, 'utf8')));
  }

  // The scan must actually SEE the tree's current form, or it is coupled to nothing again. Every
  // *-mainnet/sepolia config states the bound; at least one must be reachable by form B.
  const seen = FILES.filter((rel) => /MIN_HEARTBEAT[^;]{0,120}?MAX_HEARTBEAT[^;]{0,160}\d[\d,_]*\s*s\b/.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
  assert.ok(
    seen.length >= 3,
    `only ${seen.length} of the listed files state the heartbeat bound in a form this scan can read. `
      + 'The bracket form was removed from the configs once already and the coupling silently stopped '
      + `covering anything: ${FILES.join(', ')}`,
  );

  assert.deepEqual(
    offenders,
    [],
    `these files restate the ChainlinkOracle heartbeat bounds as literals the contract does not hold:\n  ${offenders.join('\n  ')}\n`
      + 'Name the constants (MIN_HEARTBEAT / MAX_HEARTBEAT) instead of the numbers, or update every copy.',
  );
});

test('no config or evidence note asserts an owner decision and denies it in the same field', () => {
  // THREE ROUNDS on `smoke.govNote`, then three defects in the guard written to stop it. All three are
  // worth naming because each is a shape this repo keeps shipping.
  //
  // 1. THE MARKER EXEMPTED THE FIELD, NOT THE DENIAL. Any historical marker anywhere in the field
  //    cleared it, so the live contradiction could be left exactly as it was and one unrelated
  //    parenthetical -- "(An earlier revision used a different number.)" -- turned it green. The
  //    three-round defect was reinsertable in one clause. The marker is now required in the SAME
  //    SENTENCE as the denial, which is what "this denial is history" actually means.
  // 2. NO FLOOR. The sibling heartbeat guard has `seen.length >= 3`; this had none, so narrowing the
  //    file filter made it walk nothing at full green -- the identical defect that produced blocker 2
  //    of this PR, inside the guard added to prevent recurrence.
  // 3. THE CORPUS EXCLUDED THE FILE IT POLICES. `f.includes('config')` dropped
  //    docs/evidence/arc-mainnet-survey.json, which is where four of this round's contradictions were.
  const DENIES = /do not treat[^.]{0,120}as the owner having said so|has NOT said so|the owner has not decided|not yet chosen|is NOT established/i;
  const HISTORICAL = /an earlier revision|used to say|previously said|it no longer does|superseded|was not updated|this entry was stale/i;
  const ASSERTS = /IS (?:him|the owner) having said so|RE-DECIDED FOR|SET by owner decision|CHOSEN|RESOLVED/;

  /**
   * Sentences, so a marker cannot vouch for a denial it does not sit beside. Split on sentence-ending
   * punctuation followed by whitespace; a parenthetical containing both stays one unit, which is the
   * case the prescribed dated form actually uses.
   */
  const sentences = (text) => String(text).split(/(?<=[.!?])\s+/);

  const classify = (text) => {
    if (!ASSERTS.test(text)) {
      // A denial with nothing asserted against it is a true statement about a value nobody has set.
      return 'no-assertion';
    }
    const live = sentences(text).filter((one) => DENIES.test(one) && !HISTORICAL.test(one));
    return live.length > 0 ? 'contradiction' : 'clean';
  };

  const offenders = [];
  let fieldsWalked = 0;
  for (const rel of FILES) {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    (function walk(node, trail) {
      if (typeof node === 'string') {
        ++fieldsWalked;
        if (classify(node) === 'contradiction') {
          const live = sentences(node).filter((one) => DENIES.test(one) && !HISTORICAL.test(one));
          offenders.push(`${rel} ${trail}: asserts a decision AND denies it live -- ${JSON.stringify(live[0].slice(0, 120))}`);
        }
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, trail ? `${trail}.${k}` : k);
      }
    })(parsed, '');
  }
  assert.deepEqual(offenders, [], `${offenders.length} field(s) carry a claim and a LIVE refutation:\n  ${offenders.join('\n  ')}`);

  // FLOOR. Without it, narrowing the corpus makes this walk nothing and report green -- which is the
  // defect it exists to stop, so it is the one thing this test must not be able to do.
  assert.ok(
    fieldsWalked >= 200,
    `walked only ${fieldsWalked} string fields across ${FILES.length} files. These configs carry `
      + 'hundreds of notes; a number this low means the corpus or the walk is broken, not that the '
      + 'tree is clean.',
  );
  // And the file this round is fixing must be IN the corpus, not outside the guard policing it.
  assert.ok(FILES.includes('docs/evidence/arc-mainnet-survey.json'), 'the survey must be policed too');

  // NON-VACUITY across every quadrant, plus the smuggle the reviewer found.
  assert.equal(
    classify('timelockDuration 0 was RE-DECIDED FOR Arc, so its presence here IS him having said so. Do not treat its presence in this file as the owner having said so for Arc.'),
    'contradiction',
    'the shape that survived three rounds',
  );
  assert.equal(
    classify('timelockDuration 0 was RE-DECIDED FOR Arc, so its presence here IS him having said so. Do not treat its presence in this file as the owner having said so for Arc. (An earlier revision of this note used a different number.)'),
    'contradiction',
    'THE SMUGGLE: an unrelated historical parenthetical must not vouch for a live denial elsewhere in the field',
  );
  assert.equal(
    classify('timelockDuration 0 was RE-DECIDED FOR Arc. (An earlier revision of this note ended by saying the opposite: do not treat its presence in this file as the owner having said so.)'),
    'clean',
    'the prescribed dated form -- marker and denial in ONE sentence -- must not red, or the guard rewards deleting the history',
  );
  assert.equal(
    classify('These six are carried from base-mainnet.json; do not treat their presence in this file as the owner having said so.'),
    'no-assertion',
    'a denial with nothing asserted against it is true',
  );
  assert.equal(classify('proposalThresholdBps 500 is SET by owner decision 2026-09-19.'), 'clean',
    'an assertion on its own is not a contradiction');
  assert.equal(
    classify('The heartbeat is CHOSEN at 90,000 s. What is NOT established is the basket shape.'),
    'contradiction',
    'the fourth instance: a summary field that still counts a settled decision as open',
  );
});
