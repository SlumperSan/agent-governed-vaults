// @ts-check
/**
 * scripts/lib/safe-tx-builder-checksum.mjs — ported from safe-global/safe-react-apps commit
 * `118f25df89f781631386e6b279d812dfc837204a` (see that file's own header for the exact source
 * paths). Every hash below is computed with a REAL `cast keccak` subprocess (not a stub), since the
 * property under test is "does this match Safe's own algorithm", which a stubbed hash cannot show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  serializeJSONObject, calculateChecksum, addChecksum, validateChecksum,
  transactionsInBatchAreImportable,
} from '../lib/safe-tx-builder-checksum.mjs';

const keccak = (s) => execFileSync('cast', ['keccak', s], { encoding: 'utf8' }).trim();

// The EXACT fixture from safe-global/safe-react-apps apps/tx-builder/src/lib/checksum.test.js at the
// same commit, transcribed verbatim (including its `meta.checksum: ''`) — this is `addChecksum`'s own
// published test vector, not one derived here.
const KNOWN_VECTOR_BATCH = {
  version: '1.0',
  chainId: '4',
  createdAt: 1646321521061,
  meta: {
    name: 'test batch file',
    txBuilderVersion: '1.4.0',
    checksum: '',
    createdFromSafeAddress: '0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa',
    createdFromOwnerAddress: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
  },
  transactions: [
    {
      to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
      value: '0',
      contractMethod: {
        inputs: [{ internalType: 'address', name: 'paramAddress', type: 'address' }],
        name: 'testAddress',
        payable: false,
      },
      contractInputsValues: { paramAddress: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6' },
    },
    {
      to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
      value: '0',
      contractMethod: {
        inputs: [{ internalType: 'bool', name: 'paramBool', type: 'bool' }],
        name: 'testBool',
        payable: false,
      },
      contractInputsValues: { paramAddress: '', paramBool: 'false' },
    },
    {
      to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
      value: '2000000000000000000',
      data: '0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6',
    },
  ],
};
const KNOWN_VECTOR_CHECKSUM = '0x4ecbfd364aa6759983915644e73f8bd411e85a2dc306f252a387c2728c4db64c';

test('addChecksum reproduces safe-react-apps checksum.test.js\'s own known vector, via a real `cast keccak`', () => {
  const withChecksum = addChecksum(KNOWN_VECTOR_BATCH, keccak);
  assert.equal(withChecksum.meta.checksum, KNOWN_VECTOR_CHECKSUM);
});

test('checksum survives reordering the top-level and meta keys (serializeJSONObject sorts keys)', () => {
  const reversedMeta = {};
  for (const k of Object.keys(KNOWN_VECTOR_BATCH.meta).reverse()) reversedMeta[k] = KNOWN_VECTOR_BATCH.meta[k];
  const reversed = {};
  for (const k of Object.keys(KNOWN_VECTOR_BATCH).reverse()) {
    reversed[k] = k === 'meta' ? reversedMeta : KNOWN_VECTOR_BATCH[k];
  }
  assert.equal(addChecksum(reversed, keccak).meta.checksum, KNOWN_VECTOR_CHECKSUM);
});

test('checksum changes when transaction order changes', () => {
  const a = addChecksum(KNOWN_VECTOR_BATCH, keccak).meta.checksum;
  const swapped = { ...KNOWN_VECTOR_BATCH, transactions: [...KNOWN_VECTOR_BATCH.transactions].reverse() };
  const b = addChecksum(swapped, keccak).meta.checksum;
  assert.notEqual(a, b);
});

// ─────────────────────────── the semantics that actually decide the owner's import ───────────────────────────
//
// `validateChecksum` DELETES `meta.checksum` before recomputing — a different serialization than
// `addChecksum` sees when `meta.checksum` is already present (as `KNOWN_VECTOR_BATCH` deliberately is,
// matching Safe's own published fixture). Safe's real `generateBatchFile` -> `addChecksum` pipeline
// never sets `meta.checksum` before calling `addChecksum`, so a checksum computed the way
// `KNOWN_VECTOR_BATCH` does (with `checksum: ''` already present) does NOT round-trip through
// `validateChecksum` -- confirmed empirically here, not merely argued, because Safe's own
// "Validate checksum" test in checksum.test.js asserts nothing (a bare `expect(...)` with no
// `.toBe(...)`) and would not have caught this.

test('KNOWN VECTOR DOES NOT SELF-VALIDATE: addChecksum over an object that already carries meta.checksum fails validateChecksum -- Safe\'s own "Validate checksum" test never actually asserts this (a bare `expect()`), which is why this is worth pinning down explicitly rather than trusted from their test name', () => {
  const withChecksum = addChecksum(KNOWN_VECTOR_BATCH, keccak);
  assert.equal(validateChecksum(withChecksum, keccak), false);
});

test('THE SHAPE THAT ACTUALLY MATTERS: a batch built with NO meta.checksum key (matching Safe\'s real generateBatchFile output) DOES self-validate after addChecksum -- this is the invariant scripts/lib/safe-tx-builder.mjs\'s buildBatchFile relies on', () => {
  const noChecksumKey = {
    version: '1.0', chainId: '84532', createdAt: 1700000000000,
    meta: { name: 'n', description: 'd', txBuilderVersion: 'x', createdFromSafeAddress: '0xaaaa000000000000000000000000000000000a', createdFromOwnerAddress: '' },
    transactions: [{ to: '0xbbbb000000000000000000000000000000000b', value: '0', data: '0xdeadbeef' }],
  };
  assert.equal('checksum' in noChecksumKey.meta, false, 'the fixture must not carry a checksum key before addChecksum, matching generateBatchFile');
  const withChecksum = addChecksum(noChecksumKey, keccak);
  assert.equal(validateChecksum(withChecksum, keccak), true);
});

test('validateChecksum returns false for a tampered file even when the SHAPE is the self-validating one', () => {
  const base = {
    version: '1.0', chainId: '84532', createdAt: 1700000000000,
    meta: { name: 'n', createdFromSafeAddress: '0xaaaa000000000000000000000000000000000a', createdFromOwnerAddress: '' },
    transactions: [{ to: '0xbbbb000000000000000000000000000000000b', value: '0', data: '0xdeadbeef' }],
  };
  const signed = addChecksum(base, keccak);
  const tampered = { ...signed, transactions: [{ ...signed.transactions[0], data: '0xffffffff' }] };
  assert.equal(validateChecksum(tampered, keccak), false);
});

test('serializeJSONObject: undefined values serialize as null, the same substitution checksum.ts applies before JSON.stringify', () => {
  assert.equal(serializeJSONObject({ b: undefined, a: 1 }), '{["a","b"]1,null,}');
});

test('serializeJSONObject: arrays serialize element-wise without key sorting (order preserved)', () => {
  assert.equal(serializeJSONObject([3, 1, 2]), '[3,1,2]');
});

// ─────────────────────────── the hard import-time check ───────────────────────────

test('transactionsInBatchAreImportable: true for a batch shaped like everything this generator emits', () => {
  assert.equal(transactionsInBatchAreImportable({
    transactions: [{ to: '0x1', value: '0', contractInputsValues: { p: '(1,2,3)' } }],
  }), true);
});

test('transactionsInBatchAreImportable: false when `value` is a JS number instead of a string', () => {
  assert.equal(transactionsInBatchAreImportable({
    transactions: [{ to: '0x1', value: 0, contractInputsValues: {} }],
  }), false);
});

test('transactionsInBatchAreImportable: false when a contractInputsValues entry is a JS number', () => {
  assert.equal(transactionsInBatchAreImportable({
    transactions: [{ to: '0x1', value: '0', contractInputsValues: { amount: 5 } }],
  }), false);
});

test('transactionsInBatchAreImportable: null/undefined contractInputsValues is fine (matches Safe\'s own `=== null` check)', () => {
  assert.equal(transactionsInBatchAreImportable({
    transactions: [{ to: '0x1', value: '0', contractInputsValues: null }],
  }), true);
  assert.equal(transactionsInBatchAreImportable({
    transactions: [{ to: '0x1', value: '0' }],
  }), true);
});

test('calculateChecksum passes its serialized string to the injected keccak unchanged -- a stub proves the dependency is used, not merely present', () => {
  let seen;
  const stubKeccak = (s) => { seen = s; return '0xSTUB'; };
  const batch = { meta: { name: 'x' }, version: '1', chainId: '1', createdAt: 0, transactions: [] };
  const result = calculateChecksum(batch, stubKeccak);
  assert.equal(result, '0xSTUB');
  assert.equal(seen, serializeJSONObject({ ...batch, meta: { name: null } }));
});
