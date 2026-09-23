// @ts-check
/**
 * Pure-logic tests for scripts/lib/safe-exec.mjs (card 208) — every function here takes its `cast`/
 * `call`/`callU` dependency as an argument, so these tests drive it with a hand-built fake and never
 * touch a real CHAIN. `realCast` below is the one exception, and deliberately so: `cast keccak` /
 * `cast abi-encode` / `cast concat-hex` are pure local hashing, no RPC and no network, so using the
 * REAL binary for the EIP-712 digest tests proves this file's encoding against cast's own EIP-712
 * implementation, not against a second hand-written mock of it that could share the same mistake.
 * The real-bytecode proof (does an ACTUAL deployed SafeL2 v1.4.1 agree with this digest, and does it
 * ACCEPT the resulting signature) lives in scripts/test/safe-route-fork.test.mjs, on a local anvil
 * fork — this file is the fast, deterministic complement: does the module itself compute the right
 * shapes, and does it refuse before signing when the RPC and the local recompute disagree (2026-09-23
 * MAJOR-1, `Obsidian Vault/Agent-Governed Vaults/Verdicts/2026-09-23-security-safe-signing-path.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readSafeState, buildPlan, safeTransactionHash, safeTransactionHashLocal, buildSafeTypedData,
  signAsOwner, packSignatures, execTransactionArgs, SafeTxHashMismatch,
  SAFE_OPERATION_CALL, SAFE_OPERATION_DELEGATECALL, SAFE_EXEC_TRANSACTION_SIG,
} from '../lib/safe-exec.mjs';

const SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACTORY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DATA = '0x49af0336' + '00'.repeat(200);
const CHAIN_ID = 84532; // Base Sepolia -- matches the fork suite, arbitrary otherwise for this file

/** The real `cast` binary -- see the file header for why this, and not a mock, is used for the
 *  EIP-712 digest tests. */
const realCast = (args) => execFileSync('cast', args, { encoding: 'utf8', windowsHide: true }).trim();

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

test('safeTransactionHash calls getTransactionHash with every plan field unchanged, in order', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 7n, value: 0n });
  const local = safeTransactionHashLocal({ cast: realCast, plan, chainId: CHAIN_ID });
  let seen;
  const call = (safe, sig, ...args) => {
    seen = { safe, sig, args };
    return [local]; // agrees with the local recompute, so this test isolates the on-chain-read shape
  };
  const hash = safeTransactionHash({ call, cast: realCast, plan, chainId: CHAIN_ID });
  assert.equal(seen.safe, SAFE);
  assert.match(seen.sig, /^getTransactionHash\(/);
  assert.deepEqual(seen.args, [
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, plan.nonce,
  ]);
  assert.equal(hash, local);
});

test('safeTransactionHash returns the hash when the on-chain read and the LOCAL EIP-712 recompute agree', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 3n });
  const expected = safeTransactionHashLocal({ cast: realCast, plan, chainId: CHAIN_ID });
  const hash = safeTransactionHash({ call: () => [expected], cast: realCast, plan, chainId: CHAIN_ID });
  assert.equal(hash, expected);
});

test('THE REPRO (2026-09-23 MAJOR-1): a stub RPC returning a hash for a DIFFERENT SafeTx than `plan` — safeTransactionHash refuses, and no signature is ever produced', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 7n, value: 0n });
  // An attacker-controlled/compromised RPC answers getTransactionHash with the hash of a SafeTx OF
  // ITS OWN CHOOSING (e.g. addOwnerWithThreshold(attacker, 1)) -- unrelated to `plan`. The exact
  // value does not matter; what matters is that it disagrees with the local recompute.
  const attackerHash = `0x${'ab'.repeat(32)}`;
  const call = () => [attackerHash];
  const seenCastArgs = [];
  const spyCast = (args) => { seenCastArgs.push(args); return realCast(args); };

  let thrown;
  try {
    // Mirrors scripts/smoke-test.mjs's routeThroughSafe: the hash is verified BEFORE any
    // signAsOwner call. If safeTransactionHash does not throw here, signAsOwner runs next and a
    // signature over the attacker's hash would be produced -- exactly MAJOR-1.
    const hash = safeTransactionHash({ call, cast: spyCast, plan, chainId: CHAIN_ID });
    signAsOwner({ cast: spyCast, plan, chainId: CHAIN_ID, signerArgs: ['--private-key', `0x${'11'.repeat(32)}`] });
    assert.fail(`expected safeTransactionHash to throw before a signature could be produced; got hash ${hash}`);
  } catch (e) { thrown = e; }

  assert.ok(thrown instanceof SafeTxHashMismatch, `expected SafeTxHashMismatch, got ${thrown}`);
  assert.match(thrown.message, /refusing to sign/);
  assert.match(thrown.message, new RegExp(attackerHash));
  assert.ok(
    !seenCastArgs.some((a) => a[0] === 'wallet' && a[1] === 'sign'),
    'no `cast wallet sign` invocation must occur once the on-chain hash and the local recompute disagree',
  );
});

test('buildSafeTypedData shapes the EIP-712 domain/types/message from the plan — Safe v1.4.1\'s own domain has NO name/version', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 9n, value: 5n });
  const typed = buildSafeTypedData({ plan, chainId: CHAIN_ID });
  assert.deepEqual(Object.keys(typed.domain).sort(), ['chainId', 'verifyingContract']);
  assert.equal(typed.domain.chainId, CHAIN_ID);
  assert.equal(typed.domain.verifyingContract, SAFE);
  assert.equal(typed.primaryType, 'SafeTx');
  assert.deepEqual(typed.types.EIP712Domain.map((f) => f.name), ['chainId', 'verifyingContract']);
  assert.deepEqual(typed.types.SafeTx.map((f) => f.name), [
    'to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce',
  ]);
  assert.equal(typed.message.to, FACTORY);
  assert.equal(typed.message.data, DATA);
  assert.equal(typed.message.value, '5', 'BigInt plan fields must be stringified -- JSON has no BigInt');
  assert.equal(typed.message.nonce, '9');
  assert.equal(typed.message.operation, SAFE_OPERATION_CALL);
});

test('safeTransactionHashLocal is a deterministic pure function of plan+chainId, and is sensitive to every field (mutation coverage)', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 1n });
  const h1 = safeTransactionHashLocal({ cast: realCast, plan, chainId: CHAIN_ID });
  const h2 = safeTransactionHashLocal({ cast: realCast, plan, chainId: CHAIN_ID });
  assert.equal(h1, h2, 'must be a pure function of plan+chainId, not e.g. of call order or process state');

  assert.notEqual(h1, safeTransactionHashLocal({ cast: realCast, plan: { ...plan, nonce: 2n }, chainId: CHAIN_ID }));
  assert.notEqual(h1, safeTransactionHashLocal({ cast: realCast, plan, chainId: CHAIN_ID + 1 }));
  assert.notEqual(h1, safeTransactionHashLocal({ cast: realCast, plan: { ...plan, to: FACTORY.replace('b', 'c') }, chainId: CHAIN_ID }));
});

test('signAsOwner signs the EIP-712 typed data via --data (never a raw hash, never --no-hash), matching the plan\'s own fields', () => {
  const plan = buildPlan({ safe: SAFE, to: FACTORY, data: DATA, nonce: 3n });
  const invocations = [];
  const cast = (args) => {
    invocations.push(args);
    // The caller's `cast` is already-trimmed, the same shape smoke-test.mjs's own `cast()` returns
    // (it `.trim()`s the whole exec output before handing it back) -- no trailing newline here.
    if (args[0] === 'wallet' && args[1] === 'address') return '0xEEEE000000000000000000000000000000000e';
    if (args[0] === 'wallet' && args[1] === 'sign') return '0x' + 'ab'.repeat(65);
    throw new Error('unexpected cast ' + args.join(' '));
  };
  const { signer, signature } = signAsOwner({ cast, plan, chainId: CHAIN_ID, signerArgs: ['--account', 'x'] });
  assert.equal(signer, '0xEEEE000000000000000000000000000000000e');
  assert.equal(signature, '0x' + 'ab'.repeat(65));

  const signInvocation = invocations.find((a) => a[0] === 'wallet' && a[1] === 'sign');
  assert.ok(signInvocation.includes('--data'), '--data is load-bearing: cast must compute the EIP-712 digest itself from the typed data');
  assert.ok(!signInvocation.includes('--no-hash'), 'MAJOR-1\'s fix removes raw-hash --no-hash signing entirely');

  const typedData = JSON.parse(signInvocation[signInvocation.indexOf('--data') + 1]);
  assert.equal(typedData.primaryType, 'SafeTx');
  assert.deepEqual(typedData.domain, { chainId: CHAIN_ID, verifyingContract: SAFE });
  assert.equal(typedData.message.to, FACTORY);
  assert.equal(typedData.message.data, DATA);
  assert.equal(typedData.message.nonce, '3');
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
