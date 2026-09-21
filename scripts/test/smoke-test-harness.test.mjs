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
import { addressEq, readCallLog, broadcastEntries, noPrivateKeyLogged } from './lib/fixture-assertions.mjs';
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
  // CAST is pointed at a path nothing provides (run-smoke-child.mjs's `castPath`, deliberately
  // never created by anything). If the loader hook had failed to redirect node:child_process, the
  // script's own cast() would have shelled out to that nonexistent binary for real on its very
  // first call and failed with ENOENT before ever reaching the stub — so `status === 0` together
  // with a non-empty, stub-authored call log is the proof: either one alone could be a fluke, but
  // a real exec attempt cannot produce BOTH a clean exit and a log only the stub ever writes to.
  assert.equal(r.status, 0);
  assert.ok(r.callLog.length > 0, 'the fixture must have logged something, or interception itself is unproven');
  assert.ok(noPrivateKeyLogged(r.callLog), 'no logged argv may carry a raw private key');

  const sends = broadcastEntries(r.callLog);
  assert.equal(sends.length, SEND_SEQUENCE.length,
    `expected exactly ${SEND_SEQUENCE.length} state-changing cast sends, got ${sends.length}: ${JSON.stringify(sends.map((s) => s.sig))}`);
  assert.deepEqual(sends.map((s) => s.sig), SEND_SEQUENCE, 'the send sequence must match the script\'s own lifecycle order');
  for (const s of sends) assert.equal(s.receiptStatus, '0x1', `${s.sig}: fixture must have reported a successful receipt`);

  const createVault = sends.find((s) => s.sig.startsWith('createVault('));
  assert.ok(createVault, 'createVault send missing from the log');
  assert.ok(r.stdout.includes(VAULT_ADDR), 'vault address from the fixture should appear in the script\'s own log output');

  // Real cross-check: smoke-test.mjs itself logs the signer it derived from `cast wallet address`
  // (scripts/smoke-test.mjs:232, `log(\`signer ${state.signer}\`)`). Compare what the SCRIPT
  // reported against what the FIXTURE returned for that call — two independently produced values,
  // not one value checked against itself. (On the happy path the two are equal by construction, so
  // this line cannot itself distinguish addressEq from `() => true`; addressEq's own unit test
  // above — which asserts its FALSE case — is what is required to catch that mutation, and does.)
  const signerLine = r.stdout.match(/signer (0x[0-9a-fA-F]+)/);
  assert.ok(signerLine, `script did not report a derived signer.\nSTDOUT:\n${r.stdout}`);
  assert.ok(addressEq(signerLine[1], SIGNER_ADDR),
    `the signer the script derived (${signerLine[1]}) must be the one the fixture returned from 'cast wallet address' (${SIGNER_ADDR})`);
});

// ────────────────────────────────────── negative controls ──────────────────────────────────────
// Each proves the harness actually discriminates: a scripted fault must make the UNMODIFIED
// script's own assert()/fail() trip, and the harness must report that as a failure, not a pass.

const NEGATIVE_CONTROLS = [
  { scenario: 'bad-status', expect: /transaction reverted/, why: 'createVault receipt.status forced to 0x0' },
  // The expected TEXT changed with #329, and deliberately: the old check compared the event's
  // creator against the signer who had just signed, which is true by construction and passed on
  // chain 4663 every time. It now compares against the record's DECLARED intendedCreator.
  { scenario: 'bad-creator', expect: /creator in event is .*declared intendedCreator is/, why: 'VaultCreated topics[2] set to a different address than the declared creator' },
  // The vault's own creator() disagreeing with the event it emitted — the SECOND, post-broadcast
  // assertion, which no other scenario reaches because in all of them the two agree and the first
  // assertion fails first.
  { scenario: 'creator-reread-differs', expect: /creator\(\) reads .*declared intendedCreator is/, why: "the vault's own creator() returns a different address than the event reported" },
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

// ────────────────────── card 179: the declared creator must EXIST on chain ──────────────────────
// These are the two directions of `creatorCodeRefusal` driven through the REAL runner, which is the
// thing the unit tests in creator-code.test.mjs cannot reach: that the refusal actually stops the
// process before `createVault` is broadcast. `gate.mjs` only `node --check`s smoke-test.mjs, so
// without this harness the only available assertion was a regex over its source — and a regex can
// see that a call exists and never that it does anything.

test('card 179: a creator declared CONTRACT with no bytecode refuses, and nothing is broadcast', () => {
  // The live Arc failure: the owner recorded Safe 0x99e805294F1f1465C96f68e36264E99991Ef9E82 as the
  // mainnet creator and eth_getCode on chain 5042 returns 0x — a Safe address is deterministic, so a
  // predicted-but-unactivated one passes every string comparison. `creator` is immutable.
  const r = runSmokeChild({
    env: { SMOKE_DEPLOYMENT: path.join(FIXTURES, 'deployment-creator-contract.json') },
  });
  assert.notEqual(r.status, 0, 'the run must fail rather than create a vault against an address that is not there');
  assert.match(r.stderr, /NO BYTECODE/, `STDERR did not carry the refusal:\n${r.stderr}`);
  assert.equal(
    broadcastEntries(r.callLog).length,
    0,
    'NOTHING may be broadcast: the whole point is that this refuses BEFORE the transaction, because afterwards there is nothing to do about it',
  );
});

test('card 179: a creator declared EOA that reports bytecode refuses too, and nothing is broadcast', () => {
  // The other direction, on the REAL shipped record (which declares `eoa`): if the chain reports
  // code at it, whatever key the operator holds is not what would own the vault.
  const r = runSmokeChild({ scenario: 'creator-has-code' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is a contract/, `STDERR did not carry the refusal:\n${r.stderr}`);
  assert.equal(broadcastEntries(r.callLog).length, 0, 'nothing may be broadcast');
});

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
