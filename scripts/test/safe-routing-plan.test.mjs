// @ts-check
/**
 * `safeRoutingPlanRefusal` / `requireSafeRoutingPlan` (card 208, scripts/smoke-preflight.mjs) --
 * does an already-BUILT Safe execTransaction plan actually route createVault through the declared
 * contract creator, at the declared factory, as a plain call? Mutation-tested field by field: every
 * check is flipped independently and shown to fire alone, then a fully-correct plan is shown to pass
 * — so a deleted check cannot hide behind a plan that never reaches it, and a check that always
 * refuses cannot hide behind a plan that never reaches the happy case either.
 *
 * `contractCreatorRoutingRefusal` (the direct-send refusal #329 shipped) is untouched by this file —
 * its own tests live in smoke-preflight.test.mjs and still pass unmodified; this file only exercises
 * the NEW routed-plan verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  safeRoutingPlanRefusal, requireSafeRoutingPlan, requireIntendedCreator, CreationRefused,
  CREATE_VAULT_SIG, EXPECTED_CREATE_VAULT_SELECTOR,
} from '../smoke-preflight.mjs';
import { buildPlan, SAFE_OPERATION_DELEGATECALL } from '../lib/safe-exec.mjs';

const SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACTORY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DATA = EXPECTED_CREATE_VAULT_SELECTOR + '00'.repeat(200);

/** A correctly-routed plan: the one shape `safeRoutingPlanRefusal` must pass. Every negative test
 * below mutates exactly one field off of this baseline. */
function happyArgs(overrides = {}) {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 0n });
  return {
    intended: SAFE, safe: plan.safe, to: plan.to, factory: FACTORY, data: plan.data,
    operation: plan.operation, value: plan.value, safeTxGas: plan.safeTxGas, baseGas: plan.baseGas,
    gasPrice: plan.gasPrice, ...overrides,
  };
}

test('EXPECTED_CREATE_VAULT_SELECTOR is really keccak256(CREATE_VAULT_SIG)[:4] -- re-derived via a real `cast sig`, not hand-transcribed', () => {
  const real = execFileSync('cast', ['sig', CREATE_VAULT_SIG], { encoding: 'utf8' }).trim();
  assert.equal(EXPECTED_CREATE_VAULT_SELECTOR, real,
    'the literal in smoke-preflight.mjs has drifted from what CREATE_VAULT_SIG actually hashes to');
});

test('a correctly-routed plan passes -- the baseline every negative test below mutates exactly one field of', () => {
  assert.equal(safeRoutingPlanRefusal(happyArgs()), null);
  assert.equal(requireSafeRoutingPlan(happyArgs()), SAFE);
});

test('safe != intended: routing through the WRONG Safe refuses, even though every other field is correct', () => {
  const OTHER_SAFE = '0xcccccccccccccccccccccccccccccccccccccccccccc'.slice(0, 42);
  const r = safeRoutingPlanRefusal(happyArgs({ safe: OTHER_SAFE }));
  assert.match(r, /REFUSING TO CREATE/);
  assert.match(r, /execTransaction against/);
  assert.throws(() => requireSafeRoutingPlan(happyArgs({ safe: OTHER_SAFE })), CreationRefused);
});

test('to != factory: the inner call target is refused, even routed through the right Safe', () => {
  const WRONG = '0xdddddddddddddddddddddddddddddddddddddddddddd'.slice(0, 42);
  const r = safeRoutingPlanRefusal(happyArgs({ to: WRONG }));
  assert.match(r, /REFUSING TO CREATE/);
  assert.match(r, /inner call targets/);
});

test('operation DELEGATECALL refuses -- a DELEGATECALL runs the factory\'s code AS the Safe, in the Safe\'s own storage', () => {
  const r = safeRoutingPlanRefusal(happyArgs({ operation: SAFE_OPERATION_DELEGATECALL }));
  assert.match(r, /not CALL/);
  assert.match(r, /DELEGATECALL/);
});

test('a non-createVault selector refuses, derived INDEPENDENTLY of the data being checked (not sliced from the same mutated data)', () => {
  const wrongSelectorData = '0xdeadbeef' + '00'.repeat(200);
  const r = safeRoutingPlanRefusal(happyArgs({ data: wrongSelectorData }));
  assert.match(r, /not createVault's/);
});

test('nonzero value refuses -- createVault needs none, and a misrouted plan with value would drain the Safe', () => {
  const r = safeRoutingPlanRefusal(happyArgs({ value: 1n }));
  assert.match(r, /wei of value/);
});

test('nonzero safeTxGas refuses -- it can starve the inner call and produce a false ExecutionFailure-under-success-receipt', () => {
  const r = safeRoutingPlanRefusal(happyArgs({ safeTxGas: 1n }));
  assert.match(r, /safeTxGas to 1/);
});

test('nonzero gasPrice refuses -- it routes through Safe\'s refund branch instead of skipping it', () => {
  const r = safeRoutingPlanRefusal(happyArgs({ gasPrice: 1n }));
  assert.match(r, /gasPrice to 1/);
});

test('nonzero baseGas refuses -- buildPlan never produces one, so a nonzero value is unexplained provenance', () => {
  const r = safeRoutingPlanRefusal(happyArgs({ baseGas: 1n }));
  assert.match(r, /baseGas to 1/);
});

test('shape checks run before comparisons -- a malformed intendedCreator, safe, to or factory refuses with a shape message, not a silent false-negative equality', () => {
  assert.match(safeRoutingPlanRefusal(happyArgs({ intended: 'not-an-address' })), /not a 20-byte hex address/);
  assert.match(safeRoutingPlanRefusal(happyArgs({ safe: 'not-an-address' })), /not a 20-byte hex address/);
  assert.match(safeRoutingPlanRefusal(happyArgs({ to: 'not-an-address' })), /not a 20-byte hex address/);
  assert.match(safeRoutingPlanRefusal(happyArgs({ factory: 'not-an-address' })), /not a 20-byte hex address/);
});

test('safeRoutingPlanRefusal is chain-free and cast-free -- callable with plain objects, no network, no subprocess', () => {
  // If this function ever grew a network or `cast` dependency, this test's own happy-path call
  // above would already be flaky/slow; this test exists so that property is asserted rather than
  // merely relied upon by every other test in this file.
  const start = Date.now();
  for (let i = 0; i < 1000; i++) safeRoutingPlanRefusal(happyArgs());
  assert.ok(Date.now() - start < 200, 'safeRoutingPlanRefusal took too long for 1000 calls -- suspect a hidden I/O dependency');
});

// ─────────────────────── requireIntendedCreator: the dispatcher, both branches ───────────────────────

test('requireIntendedCreator(deployment, signer) with NO routing argument still refuses a contract-kind creator UNCONDITIONALLY -- #329\'s behaviour, byte-for-byte unchanged', () => {
  const deployment = { intendedCreator: SAFE, intendedCreatorKind: 'contract' };
  assert.throws(
    () => requireIntendedCreator(deployment, SAFE),
    (e) => e instanceof CreationRefused && /execTransaction/.test(e.message) && /ROUTED THROUGH IT/.test(e.message),
    'the direct-send refusal message must still name the missing routed-execution path',
  );
});

test('requireIntendedCreator(deployment, signer, routing) with a CORRECT routing plan returns the declared creator -- the new capability', () => {
  const deployment = { intendedCreator: SAFE, intendedCreatorKind: 'contract' };
  const result = requireIntendedCreator(deployment, 'irrelevant-for-the-routed-branch', happyArgs());
  assert.equal(result, SAFE);
});

test('requireIntendedCreator(deployment, signer, routing) with a WRONG routing plan still refuses -- routing exists, but only for the declared Safe', () => {
  const deployment = { intendedCreator: SAFE, intendedCreatorKind: 'contract' };
  const WRONG = '0xdddddddddddddddddddddddddddddddddddddddddddd'.slice(0, 42);
  assert.throws(
    () => requireIntendedCreator(deployment, 'irrelevant', happyArgs({ to: WRONG })),
    CreationRefused,
  );
});

test('requireIntendedCreator: an "eoa"-kind record ignores a routing argument entirely -- routing is only consulted for kind "contract"', () => {
  const eoa = '0x1111111111111111111111111111111111111111';
  const deployment = { intendedCreator: eoa, intendedCreatorKind: 'eoa' };
  // Passing a routing plan that would refuse if it were consulted -- proves it is NOT consulted for
  // an eoa-kind record, which keeps requireIntendedCreator(deployment, signer) callers unaffected.
  const result = requireIntendedCreator(deployment, eoa, happyArgs({ to: '0xdead' }));
  assert.equal(result, eoa);
});
