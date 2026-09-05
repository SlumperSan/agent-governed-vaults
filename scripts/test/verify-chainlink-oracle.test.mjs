import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
