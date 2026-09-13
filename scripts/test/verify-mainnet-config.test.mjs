// @ts-check
/**
 * End-to-end tests for the chain-binding refusal added to `scripts/verify-mainnet-config.mjs`
 * (issue #204) — that `main` proves the RPC is chain 8453 BEFORE any address is read, and refuses
 * (exit 1, no check rows) rather than sweeping a config against a chain nobody named.
 *
 * The pure decision (`chainBindingVerdict`) already has its own unit tests in
 * `scripts/test/chain-binding.test.mjs`; these prove it is WIRED into this script specifically —
 * that `main` consults it first and that the process actually refuses.
 *
 * `cast` is stubbed: no RPC, no network. This script (unlike `verify-chainlink-oracle.mjs`) always
 * reads the real `contracts/config/base-mainnet.json` — it has no `CONFIG` override — so the
 * stub answers `chain-id` with whatever the test wants and answers every OTHER `cast` subcommand
 * with a REVERT-shaped failure. `cast()`'s own retry logic in this script only retries a failure
 * `classifyCallError` calls 'transport' (its default for unrecognised wording — see
 * `packages/canary/src/call-error.mjs`), so an unrecognised stub failure would retry 5 times with
 * exponential backoff and make this test slow for no reason; spelling it as a revert
 * ("execution reverted: …") makes `cast()` throw immediately, keeping the whole run under a
 * second. Windows cannot exec a script file as a program, so CAST is node itself with the stub
 * preloaded via `NODE_OPTIONS=--require`, the same technique
 * `scripts/test/verify-chainlink-oracle.test.mjs` uses for its own chain-binding end-to-end tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFIER = fileURLToPath(new URL('../verify-mainnet-config.mjs', import.meta.url));

/**
 * Run the verifier with `cast chain-id` stubbed to answer `chainIdAnswer` verbatim (a number
 * string for a normal answer, or any non-numeric text to simulate an unreadable id — the script's
 * own `Number.isInteger` check is what turns that into `null`). Every other `cast` subcommand is
 * answered with a revert, so the stub never has to know the real base-mainnet.json addresses.
 */
function runVerifier(chainIdAnswer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mainnet-chain-binding-'));
  const stub = path.join(dir, 'stub-cast.cjs');
  fs.writeFileSync(
    stub,
    [
      `'use strict';`,
      `const p = require('node:path');`,
      `const sub = p.basename(String(process.argv[1] ?? ''));`,
      `if (sub === 'chain-id') { console.log(${JSON.stringify(String(chainIdAnswer))}); process.exit(0); }`,
      // Any other subcommand is a check trying to read a real address; refuse it as a REVERT so
      // `cast()`'s retry logic does not classify it as transport and retry 5 times for nothing.
      `if (!/[.](mjs|cjs|js)$/.test(sub)) {`,
      `  console.error('execution reverted: stub-cast does not implement ' + JSON.stringify(process.argv.slice(1)));`,
      `  process.exit(1);`,
      `}`,
      '',
    ].join('\n'),
  );
  const env = { ...process.env, CAST: process.execPath, VERIFY_THROTTLE_MS: '0' };
  delete env.BASE_MAINNET_RPC;
  const r = spawnSync(process.execPath, [VERIFIER], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...env,
      // Forward slashes: NODE_OPTIONS is parsed shell-like, and a Windows backslash path is an
      // escape sequence there — see the identical comment in verify-chainlink-oracle.test.mjs.
      NODE_OPTIONS: `--require "${stub.split(path.sep).join('/')}"`,
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('end to end: chain 8453 answering proceeds past the refusal, into the real checks', () => {
  const r = runVerifier(8453);
  assert.doesNotMatch(r.stderr, /WRONG CHAIN|UNPROVEN/, 'a matching chain id must not be refused');
  assert.match(
    r.stdout,
    /usdc: symbol/,
    'the run must reach the config checks — this fixture then fails them (no real RPC), which is the config being judged, not the chain',
  );
});

test('end to end: chain 1 answering REFUSES before any check row, naming both ids', () => {
  const r = runVerifier(1);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /WRONG CHAIN/);
  assert.match(r.stderr, /\b1\b/, 'must name what the RPC reported');
  assert.match(r.stderr, /8453/, 'must name what base-mainnet.json declares');
  assert.doesNotMatch(
    r.stdout,
    /usdc: symbol|router: has code|\[PASS\]|\[FAIL\]/,
    'the refusal must come BEFORE any check row: a tally scored against the wrong chain must not print at all',
  );
});

test('end to end: an unreadable chain id REFUSES as UNPROVEN, not as a pass', () => {
  const r = runVerifier('not-a-number');
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /UNPROVEN/);
  assert.doesNotMatch(r.stderr, /WRONG CHAIN/, 'unreadable is not the same finding as a mismatch');
  assert.doesNotMatch(r.stdout, /usdc: symbol|\[PASS\]|\[FAIL\]/, 'no check may run on an unproven binding');
});
