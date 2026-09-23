// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveItemData } from '../lib/sign-queue-resolve.mjs';
import { preValidatedSignature } from '../lib/safe-exec.mjs';

const SAFE = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
const OWNER = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
const FACTORY = '0xF000000000000000000000000000000000000f';

/** A stub `cast` that logs every call and returns a distinguishable fake result — no real `cast`
 * binary is required to run this file. */
function makeCast(log) {
  return (args) => {
    log.push(args);
    if (args[0] === 'calldata') return `0xcalldata(${args.slice(1).join('|')})`;
    throw new Error(`unstubbed cast call: ${args.join(' ')}`);
  };
}

test('resolveItemData: an item with a literal `data` string is returned unchanged (no cast call at all)', () => {
  const item = { data: '0xalreadyresolved' };
  const log = [];
  const r = resolveItemData(item, new Map(), makeCast(log));
  assert.deepEqual(r, { ok: true, resolved: '0xalreadyresolved' });
  assert.equal(log.length, 0);
});

test('resolveItemData: an item with no data and no dataTemplate refuses', () => {
  const r = resolveItemData({ data: null, dataTemplate: null }, new Map(), makeCast([]));
  assert.equal(r.ok, false);
});

test('resolveItemData: a safe-exec recipe with fully static args encodes inner then outer calldata via cast, never hand-rolled', () => {
  const log = [];
  const item = {
    data: null,
    dataTemplate: {
      kind: 'safe-exec', safe: SAFE, to: FACTORY, innerSig: 'createVault((address))',
      innerArgsTemplate: ['(0xusdc)'], safeNonce: 3, safeOwner: OWNER,
    },
  };
  const r = resolveItemData(item, new Map(), makeCast(log));
  assert.equal(r.ok, true);
  // Two cast calldata calls: the inner call, then the outer execTransaction.
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], ['calldata', 'createVault((address))', '(0xusdc)']);
  assert.equal(log[1][0], 'calldata');
  assert.equal(log[1][1], 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)');
  // The pre-validated signature is the LAST arg, packed for the owner given.
  assert.equal(log[1][log[1].length - 1], preValidatedSignature(OWNER));
});

test('resolveItemData: a safe-exec recipe whose inner arg is a {{item:...}} template resolves it BEFORE encoding — never passes the literal template string to cast', () => {
  const log = [];
  const vault = '0x2222222222222222222222222222222222222222';
  const itemsById = new Map([['create', {
    id: 'create', status: 'done', receipt: { contractAddress: null, logs: [{
      topics: ['0x4dda9a6d0ba03769e9813c47681795a7210f951e6ef31e64772e13b9ea0f1406', `0x${'00'.repeat(12)}${vault.slice(2)}`],
      address: FACTORY,
    }] },
  }]]);
  const item = {
    data: null,
    dataTemplate: {
      kind: 'safe-exec', safe: SAFE, to: FACTORY, innerSig: 'registerVault(address,(uint32))',
      innerArgsTemplate: ['{{item:create.log:VaultCreated.vault}}', '(1)'], safeNonce: 4, safeOwner: OWNER,
    },
  };
  const r = resolveItemData(item, itemsById, makeCast(log));
  assert.equal(r.ok, true);
  assert.equal(log[0][2].toLowerCase(), vault.toLowerCase());
  assert.ok(!log.some((call) => call.some((a) => String(a).includes('{{item:'))), 'no {{item:...}} literal ever reached cast');
});

test('resolveItemData: an unresolvable {{item:...}} inner arg refuses BEFORE calling cast at all', () => {
  const log = [];
  const item = {
    data: null,
    dataTemplate: {
      kind: 'safe-exec', safe: SAFE, to: FACTORY, innerSig: 'registerVault(address,(uint32))',
      innerArgsTemplate: ['{{item:missing.log:VaultCreated.vault}}', '(1)'], safeNonce: 4, safeOwner: OWNER,
    },
  };
  const r = resolveItemData(item, new Map(), makeCast(log));
  assert.equal(r.ok, false);
  assert.equal(log.length, 0);
});

test('resolveItemData: an unknown dataTemplate.kind refuses rather than guessing', () => {
  const r = resolveItemData({ data: null, dataTemplate: { kind: 'something-else' } }, new Map(), makeCast([]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown dataTemplate kind/);
});
