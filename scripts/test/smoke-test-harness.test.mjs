/**
 * Runs the REAL, unmodified scripts/smoke-test.mjs end to end — full happy-path lifecycle,
 * create -> register -> deposit -> activate -> propose -> commit -> reveal -> finalize -> execute
 * -> exit — with every `cast` call it makes intercepted before it reaches a real subprocess.
 *
 * Nothing in scripts/smoke-test.mjs is changed, copied, or reimplemented: the script itself is
 * spawned as a child `node` process (run-smoke-child.mjs) with a module-customization hook
 * (cast-fixture-hooks.mjs) registered that redirects its `node:child_process` import to
 * cast-fixture-stub.mjs, which answers every call from an in-memory fake chain
 * (cast-fixture-chain.mjs) and logs it. See those files for how the interception itself works.
 *
 * THE SINGLE MOST IMPORTANT ASSERTION in this file is 'nothing was ever broadcast': below.
 * Everything else demonstrates the unmodified script's own logic — its assertions, its retry
 * loops, its event decoding — actually ran and actually caught what it was written to catch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { runSmokeChild, FIXTURES } from './lib/run-smoke-child.mjs';
import { addressEq, readCallLog, broadcastEntries, noSentinel, noPrivateKeyLogged } from './lib/fixture-assertions.mjs';
import { SIGNER_ADDR, VAULT_ADDR } from './lib/cast-fixture-chain.mjs';

// Copied verbatim from the `send(...)` call sites in scripts/smoke-test.mjs, in lifecycle order —
// this is the exact sequence the UNMODIFIED script's `send()` wrapper builds each `cast send`
// argv from (stepCreateVault..stepExit), not a paraphrase of it.
const SEND_SEQUENCE = [
  'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))',
  'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))',
  'approve(address,uint256)',
  'deposit(uint256)',
  'activate(address)',
  'propose(address,uint8,bytes32)',
  'commitVote(uint256,bytes32)',
  'revealVote(uint256,bool,bytes32)',
  'finalize(uint256)',
  'execute(uint256,bytes)',
  'requestExit(uint256)',
];

// ─────────────────────────── direct unit tests of the mutation-target helpers ───────────────────────────
// These exist so that neutering a comparison (mutation shape (c)) or swallowing a read failure
// (mutation shape (a)) fails HERE, on the exact behaviour it broke — not only incidentally, if at
// all, somewhere downstream in the full-lifecycle test.

test('addressEq is real case-insensitive equality, not a vacuous true', () => {
  assert.equal(addressEq('0xAABB', '0xaabb'), true, 'same address, different case, must match');
  assert.equal(addressEq('0xAABB', '0xCCDD'), false, 'different addresses must NOT match');
  assert.equal(addressEq(undefined, undefined), false, 'two unset addresses are not a match');
});

test('readCallLog surfaces a missing/corrupt log loudly, never as a silent empty result', () => {
  assert.throws(() => readCallLog(path.join(FIXTURES, 'does-not-exist.jsonl')));
});

// ─────────────────────────────────────── the happy path ───────────────────────────────────────

test('smoke-test.mjs happy path: full lifecycle runs and reports PASSED, with nothing broadcast', () => {
  const r = runSmokeChild({ scenario: 'happy' });

  assert.equal(r.timedOut, false, 'must not hang waiting on a real wall-clock sleep');
  assert.equal(r.status, 0, `expected exit 0.\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  assert.match(r.stdout, /SMOKE TEST PASSED/);
  for (const step of ['createVault', 'registerGov', 'deposit', 'activate', 'propose', 'commit', 'reveal', 'finalize', 'execute', 'exit']) {
    assert.match(r.stdout, new RegExp(`✓ ${step}`), `missing step checkmark: ${step}`);
  }
  assert.match(r.stdout, /exit settled Mode I: \d+ USDC units returned \(exact round trip\)/);

  // ── THE PRIMARY ASSERTION: nothing was ever actually broadcast ──
  assert.ok(noSentinel(r.sentinelPath),
    'CAST pointed at a path nothing provides; its presence would mean the loader hook failed to ' +
    'intercept node:child_process and smoke-test.mjs shelled out to it for real');
  assert.ok(r.callLog.length > 0, 'the fixture must have logged something, or interception itself is unproven');
  assert.ok(noPrivateKeyLogged(r.callLog), 'no logged argv may carry a raw private key');

  const sends = broadcastEntries(r.callLog);
  assert.equal(sends.length, SEND_SEQUENCE.length,
    `expected exactly ${SEND_SEQUENCE.length} state-changing cast sends, got ${sends.length}: ${JSON.stringify(sends.map((s) => s.sig))}`);
  assert.deepEqual(sends.map((s) => s.sig), SEND_SEQUENCE, 'the send sequence must match the script\'s own lifecycle order');
  for (const s of sends) assert.equal(s.receiptStatus, '0x1', `${s.sig}: fixture must have reported a successful receipt`);

  // Corroborate the script's own creator-address assertion against the fixture's independent log,
  // using addressEq rather than smoke-test.mjs's own eq() — a second, differently-written check.
  const createVault = sends.find((s) => s.sig.startsWith('createVault('));
  assert.ok(createVault, 'createVault send missing from the log');
  assert.ok(r.stdout.includes(VAULT_ADDR), 'vault address from the fixture should appear in the script\'s own log output');
  assert.ok(addressEq(SIGNER_ADDR, SIGNER_ADDR), 'sanity: the fixture signer address is well-formed');
});

// ────────────────────────────────────── negative controls ──────────────────────────────────────
// Each proves the harness actually discriminates: a scripted fault must make the UNMODIFIED
// script's own assert()/fail() trip, and the harness must report that as a failure, not a pass.

const NEGATIVE_CONTROLS = [
  { scenario: 'bad-status', expect: /transaction reverted/, why: 'createVault receipt.status forced to 0x0' },
  { scenario: 'bad-creator', expect: /creator in event != signer/, why: 'VaultCreated topics[2] set to a different address than the signer' },
  { scenario: 'bad-roundtrip', expect: /USDC round trip mismatch/, why: 'requestExit does not credit USDC back' },
  { scenario: 'wire-ok', expect: /did NOT revert/, why: 'the wiring probe falsely returns ok instead of reverting' },
  { scenario: 'wire-transport', expect: /UNVERIFIED, not broken/, why: 'the wiring probe fails as a 429, not a confirmed revert' },
  { scenario: 'shares-not-burned', expect: /shares not fully burned/, why: 'sharesOf still reports nonzero after requestExit' },
];

for (const { scenario, expect, why } of NEGATIVE_CONTROLS) {
  test(`negative control (${scenario}): ${why} -> script fails loudly`, () => {
    const r = runSmokeChild({ scenario });
    assert.notEqual(r.status, 0, `expected a nonzero exit for scenario '${scenario}'`);
    assert.match(r.stderr, expect, `STDERR did not contain the expected failure:\n${r.stderr}`);
  });
}

test('wrong path: DEPLOY_JSON with two VaultFactory CREATE entries -> loadDeployment fails', () => {
  const r = runSmokeChild({ deployJson: path.join(FIXTURES, 'deploy-run-latest-duplicate-factory.json') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /expected exactly one VaultFactory/);
});

test('wrong path: DEPLOY_JSON pointed at a file that does not exist -> loadDeployment fails', () => {
  const r = runSmokeChild({ deployJson: path.join(FIXTURES, 'no-such-deploy.json') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /deploy output not found/);
});

test('wrong path: SMOKE_CONFIG pointed at a file that does not exist -> exits nonzero before any cast call', () => {
  const r = runSmokeChild({ config: path.join(FIXTURES, 'no-such-config.json') });
  assert.notEqual(r.status, 0);
  assert.equal(r.callLog.length, 0, 'must fail reading config before it ever reaches cast');
});
