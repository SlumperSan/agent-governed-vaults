// @ts-check
/**
 * Pure-logic tests for scripts/lib/safe-exec.mjs (card 208) — every function here takes its `cast`/
 * `call`/`callU` dependency as an argument, so these tests drive it with a hand-built fake and never
 * touch a real chain. The real-bytecode proof (does the ACTUAL deployed Safe accept what this module
 * builds) lives in scripts/test/safe-route-fork.test.mjs, on a local anvil fork — this file is the
 * fast, deterministic complement: does the module itself compute the right shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSafeState, buildPlan, safeTransactionHash, signAsOwner, packSignatures, execTransactionArgs,
  SAFE_OPERATION_CALL, SAFE_OPERATION_DELEGATECALL, SAFE_EXEC_TRANSACTION_SIG,
} from '../lib/safe-exec.mjs';

const SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACTORY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DATA = '0x49af0336' + '00'.repeat(200);

test('readSafeState parses getOwners()(address[]) the way cast prints it, and reads threshold/nonce fresh', () => {
  const calls = [];
  const call = (to, sig) => {
    calls.push([to, sig]);
    if (sig.startsWith('getOwners')) return ['[0xCCCC000000000000000000000000000000000c, 0xdddd000000000000000000000000000000000d]'];
    throw new Error(`unexpected call() ${sig}`);
  };
  const callU = (to, sig) => {
    calls.push([to, sig]);
    if (sig.startsWith('getThreshold')) return 2n;
    if (sig.startsWith('nonce')) return 5n;
    throw new Error(`unexpected callU() ${sig}`);
  };
  const state = readSafeState({ call, callU, safe: SAFE });
  assert.equal(state.threshold, 2n);
  assert.equal(state.nonce, 5n);
  assert.deepEqual(state.owners, ['0xCCCC000000000000000000000000000000000c', '0xdddd000000000000000000000000000000000d']);
  // Fresh every call: three distinct reads landed, not a cached/derived value.
  assert.equal(calls.filter(([, sig]) => sig.startsWith('getThreshold') || sig.startsWith('getOwners') || sig.startsWith('nonce')).length, 3);
});

test('readSafeState handles a single-owner array and an empty array without throwing', () => {
  const call = (to, sig) => (sig.startsWith('getOwners') ? ['[0xcccc000000000000000000000000000000000c]'] : assert.fail('unexpected'));
  const callU = () => 1n;
  const one = readSafeState({ call, callU, safe: SAFE });
  assert.deepEqual(one.owners, ['0xcccc000000000000000000000000000000000c']);

  const callEmpty = (to, sig) => (sig.startsWith('getOwners') ? ['[]'] : assert.fail('unexpected'));
  const empty = readSafeState({ call: callEmpty, callU, safe: SAFE });
  assert.deepEqual(empty.owners, []);
});

test('buildPlan always sets safeTxGas, baseGas and gasPrice to 0, and operation to CALL — no caller override exists', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 3n });
  assert.equal(plan.safe, SAFE);
  assert.equal(plan.to, FACTORY);
  assert.equal(plan.data, DATA);
  assert.equal(plan.nonce, 3n);
  assert.equal(plan.value, 0n, 'value defaults to 0');
  assert.equal(plan.operation, SAFE_OPERATION_CALL);
  assert.equal(plan.safeTxGas, 0n);
  assert.equal(plan.baseGas, 0n);
  assert.equal(plan.gasPrice, 0n);
  assert.equal(plan.gasToken, '0x0000000000000000000000000000000000000000');
  assert.equal(plan.refundReceiver, '0x0000000000000000000000000000000000000000');
  // No parameter accepts an operation override -- DELEGATECALL is a value this module's OWN builder
  // can never produce; only a caller constructing a plan object by hand could set it, and that is
  // exactly what safeRoutingPlanRefusal exists to refuse before signing.
  assert.equal(Object.keys(buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 0n })).includes('operation'), true);
});

test('safeTransactionHash passes every plan field through to getTransactionHash unchanged, in order, and never recomputes it', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 7n, value: 0n });
  let seen;
  const call = (safe, sig, ...args) => {
    seen = { safe, sig, args };
    return ['0xdeadbeef00000000000000000000000000000000000000000000000000000000'];
  };
  const hash = safeTransactionHash({ call, plan });
  assert.equal(seen.safe, SAFE);
  assert.match(seen.sig, /^getTransactionHash\(/);
  assert.deepEqual(seen.args, [
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, plan.nonce,
  ]);
  assert.equal(hash, '0xdeadbeef00000000000000000000000000000000000000000000000000000000');
});

test('signAsOwner derives the signer via cast wallet address and signs with --no-hash, never a plain sign', () => {
  const invocations = [];
  const cast = (args) => {
    invocations.push(args);
    // The caller's `cast` is already-trimmed, the same shape smoke-test.mjs's own `cast()` returns
    // (it `.trim()`s the whole exec output before handing it back) -- no trailing newline here.
    if (args[0] === 'wallet' && args[1] === 'address') return '0xEEEE000000000000000000000000000000000e';
    if (args[0] === 'wallet' && args[1] === 'sign') return '0x' + 'ab'.repeat(65);
    throw new Error('unexpected cast ' + args.join(' '));
  };
  const { signer, signature } = signAsOwner({ cast, hash: '0x' + '11'.repeat(32), signerArgs: ['--account', 'x'] });
  assert.equal(signer, '0xEEEE000000000000000000000000000000000e');
  assert.equal(signature, '0x' + 'ab'.repeat(65));
  const signInvocation = invocations.find((a) => a[0] === 'wallet' && a[1] === 'sign');
  assert.ok(signInvocation.includes('--no-hash'), '--no-hash is load-bearing: without it cast applies the EIP-191 prefix and the Safe rejects every signature');
  assert.ok(signInvocation.includes('0x' + '11'.repeat(32)), 'the exact hash getTransactionHash returned must be what is signed, not a re-derivation');
});

test('packSignatures sorts strictly ascending by signer address, independent of input order', () => {
  const sigLow = '0x' + '11'.repeat(65);
  const sigHigh = '0x' + '22'.repeat(65);
  const packedA = packSignatures([
    { signer: '0xffff000000000000000000000000000000000f', signature: sigHigh },
    { signer: '0x1111000000000000000000000000000000000a', signature: sigLow },
  ]);
  const packedB = packSignatures([
    { signer: '0x1111000000000000000000000000000000000a', signature: sigLow },
    { signer: '0xffff000000000000000000000000000000000f', signature: sigHigh },
  ]);
  assert.equal(packedA, packedB, 'sort order must not depend on caller-supplied order');
  assert.equal(packedA, sigLow + sigHigh.slice(2), 'the low address\'s signature must come first');
});

test('packSignatures is case/whitespace-insensitive when sorting and deduplicating', () => {
  const sig1 = '0x' + '33'.repeat(65);
  const sig2 = '0x' + '44'.repeat(65);
  const packed = packSignatures([
    { signer: ' 0xAAAA000000000000000000000000000000000A ', signature: sig1 },
    { signer: '0xaaaa000000000000000000000000000000000a', signature: sig2 },
  ]);
  // Same signer under different casing/whitespace collapses to ONE signature, not two -- a repeated
  // signer must not count twice toward the Safe's threshold.
  assert.equal(packed.length, 2 + 130, `expected exactly one packed signature, got ${(packed.length - 2) / 130}`);
});

test('packSignatures on a single signer round-trips exactly (the 1-of-1 shape)', () => {
  const sig = '0x' + '55'.repeat(65);
  assert.equal(packSignatures([{ signer: SAFE, signature: sig }]), sig);
});

test('execTransactionArgs is the plan fields in execTransaction\'s own declared order, with the packed signatures last', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 0n });
  const packed = '0x' + 'aa'.repeat(65);
  const args = execTransactionArgs(plan, packed);
  assert.deepEqual(args, [
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, packed,
  ]);
  assert.match(SAFE_EXEC_TRANSACTION_SIG, /^execTransaction\(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes\)$/);
  assert.equal(args.length, SAFE_EXEC_TRANSACTION_SIG.match(/,/g).length + 1, 'one arg per parameter in the signature');
});

test('SAFE_OPERATION_CALL is 0 and SAFE_OPERATION_DELEGATECALL is 1 -- Safe\'s own Enum.Operation, not reordered', () => {
  assert.equal(SAFE_OPERATION_CALL, 0);
  assert.equal(SAFE_OPERATION_DELEGATECALL, 1);
});
