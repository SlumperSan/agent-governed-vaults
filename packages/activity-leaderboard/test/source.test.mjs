// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { createChainReader } from '../src/source.mjs';
import { assertHeadState, assertSameChainView, ConsistencyError } from '../src/consistency.mjs';
import { USDC, A, B, VAULT, addr, fakeChain } from './helpers.mjs';

const T0 = 1_000_000;

function chainWithOps() {
  const ch = fakeChain({ startTs: T0 });
  ch.deposit(A, 10n * USDC, T0 + 100);
  ch.deposit(B, 20n * USDC, T0 + 5000);
  ch.exit(A, 5n * USDC * 10n ** 12n, T0 + 9000);
  ch.advanceTo(T0 + 20_000);
  return ch;
}
const reader = (ch, o = {}) => createChainReader({ client: ch.client, chainId: 5042, confirmations: 0, ...o });

test('logs are paged in windows and never cross the configured size', async () => {
  const ch = chainWithOps();
  const r = reader(ch, { windowBlocks: 1000 });
  const ev = await r.vaultEvents([{ address: VAULT, fromBlock: 100 }], ch.head);
  assert.equal(ev.length, 3);
  assert.ok(ch.getLogsCalls.length > 1);
  for (const [from, to] of ch.getLogsCalls) assert.ok(to - from + 1 <= 1000);
  // windows tile [100, head] with no gap and no overlap
  assert.equal(ch.getLogsCalls[0][0], 100);
  assert.equal(ch.getLogsCalls.at(-1)[1], ch.head);
  for (let i = 1; i < ch.getLogsCalls.length; i += 1) assert.equal(ch.getLogsCalls[i][0], ch.getLogsCalls[i - 1][1] + 1);
});

test('events come back typed, lowercase, timestamped and ordered, whatever the window size', async () => {
  const ch = chainWithOps();
  const a = await reader(ch, { windowBlocks: 10_000 }).vaultEvents([{ address: VAULT.toUpperCase().replace('0X', '0x'), fromBlock: 100 }], ch.head);
  const b = await reader(ch, { windowBlocks: 37 }).vaultEvents([{ address: VAULT, fromBlock: 100 }], ch.head);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((e) => e.type), ['deposit', 'deposit', 'exit']);
  assert.equal(a[0].member, A);
  assert.equal(a[0].sharesAfter, 10n * USDC * 10n ** 12n);
  assert.equal(a[2].sharesBurned, 5n * USDC * 10n ** 12n);
  assert.equal(a[1].timestamp, T0 + 5000);
});

test('lastBlockBefore finds the largest block strictly before a timestamp', async () => {
  const ch = chainWithOps();
  const r = reader(ch);
  for (const ts of [T0 + 1, T0 + 4999, T0 + 5000, T0 + 5001, T0 + 19_999]) {
    const b = await r.lastBlockBefore(ts, ch.head);
    assert.ok(b.timestamp < ts);
    assert.ok((await r.blockInfo(b.number + 1)).timestamp >= ts);
  }
  // if the head itself is before the timestamp, the head is returned
  assert.equal((await r.lastBlockBefore(T0 + 99_999_999, ch.head)).number, ch.head);
  await assert.rejects(r.lastBlockBefore(0, ch.head), /no block before/);
});

test('a code hash is keccak256 of the deployed code; an externally owned address hashes empty code', async () => {
  const ch = chainWithOps();
  ch.setCode(B, '0x6001');
  const r = reader(ch);
  assert.equal(await r.codeHash(A), keccak256('0x'));
  assert.equal(await r.codeHash(B), keccak256('0x6001'));
});

test('confirmations hold the head back', async () => {
  const ch = chainWithOps();
  assert.equal((await reader(ch, { confirmations: 12 }).confirmedHead()).number, ch.head - 12);
});

test('bad window size is refused', () => {
  assert.throws(() => reader(fakeChain(), { windowBlocks: 0 }), /positive integer/);
});

test('head-state check passes on equal state and names every mismatch otherwise', async () => {
  const positions = new Map([
    [`${VAULT}|${A}`, { vault: VAULT, member: A, shares: 5n, basis: 7n }],
    [`${VAULT}|${B}`, { vault: VAULT, member: B, shares: 0n, basis: 0n }],
  ]);
  const same = async (_v, m) => (m === A ? { shares: 5n, basis: 7n } : { shares: 0n, basis: 0n });
  const total = async () => 5n;
  const base = { vaults: [VAULT], positions, readTotalShares: total, blockNumber: 1 };
  assert.deepEqual(await assertHeadState({ ...base, readPosition: same }), { checked: 2, vaultsChecked: 1 });
  const off = async (_v, m) => (m === A ? { shares: 5n, basis: 8n } : { shares: 1n, basis: 0n });
  await assert.rejects(assertHeadState({ ...base, readPosition: off }), (e) => e instanceof ConsistencyError && e.mismatches.length === 2);
});

test('the share total is checked per vault, including a vault the ledger holds nothing for', async () => {
  const V2 = addr(0xaa02);
  const positions = new Map([[`${VAULT}|${A}`, { vault: VAULT, member: A, shares: 5n, basis: 7n }]]);
  const readPosition = async () => ({ shares: 5n, basis: 7n });
  const totals = { [VAULT]: 5n, [V2]: 0n };
  const readTotalShares = async (v) => totals[v];
  const base = { vaults: [VAULT, V2], positions, readPosition, readTotalShares, blockNumber: 1 };
  assert.deepEqual(await assertHeadState(base), { checked: 1, vaultsChecked: 2 });
  totals[V2] = 9n; // shares exist in a vault the ledger saw no event for
  await assert.rejects(assertHeadState(base), (e) => e instanceof ConsistencyError && e.mismatches.length === 1 && e.mismatches[0].includes(V2) && /missed/.test(e.mismatches[0]));
  totals[V2] = 0n;
  totals[VAULT] = 4n; // the ledger holds more than the chain
  await assert.rejects(assertHeadState(base), (e) => e instanceof ConsistencyError && /ledger holds shares the chain does not/.test(e.mismatches[0]));
  await assert.rejects(assertHeadState({ ...base, vaults: [V2] }), /unconfigured vault/);
  await assert.rejects(assertHeadState({ ...base, vaults: [] }), /no vaults/);
});

test('the second endpoint must agree on the head block hash and on every vault total', async () => {
  const one = { blockInfo: async () => ({ hash: '0xaa' }), readTotalShares: async () => 5n };
  const base = { primary: one, vaults: [VAULT], blockNumber: 3 };
  await assertSameChainView({ ...base, secondary: { ...one } });
  await assert.rejects(assertSameChainView({ ...base, secondary: { ...one, blockInfo: async () => ({ hash: '0xbb' }) } }), (e) => e instanceof ConsistencyError && /hash/.test(e.mismatches[0]));
  await assert.rejects(assertSameChainView({ ...base, secondary: { ...one, readTotalShares: async () => 6n } }), (e) => e instanceof ConsistencyError && /totalShares/.test(e.mismatches[0]));
  await assert.rejects(assertSameChainView({ ...base, secondary: { ...one, blockInfo: async () => { throw new Error('block not found'); } } }), /block not found/);
});

test('the other chains are configured by id only', async () => {
  const { CHAINS } = await import('../src/chains.mjs');
  assert.deepEqual(Object.values(CHAINS).map((c) => c.chainId).sort((a, b) => a - b), [1, 137, 5042, 8453, 42161]);
  assert.equal(addr(1).length, 42);
});

test('a rate-limited read is retried with back-off; any other failure is not', async () => {
  const ch = chainWithOps();
  let failures = 2;
  const real = ch.client.getLogs;
  ch.client.getLogs = async (q) => {
    if (failures-- > 0) throw Object.assign(new Error('Request exceeds defined limit.'), { details: 'rate limit exceeded' });
    return real(q);
  };
  const waits = [];
  const r = reader(ch, { sleep: async (ms) => { waits.push(ms); } });
  const ev = await r.vaultEvents([{ address: VAULT, fromBlock: 100 }], ch.head);
  assert.equal(ev.length, 3);
  assert.deepEqual(waits, [500, 1000]);

  const broken = chainWithOps();
  let calls = 0;
  broken.client.getLogs = async () => { calls += 1; throw new Error('execution reverted'); };
  await assert.rejects(reader(broken, { sleep: async () => {} }).vaultEvents([{ address: VAULT, fromBlock: 100 }], broken.head), /reverted/);
  assert.equal(calls, 1);

  const limited = chainWithOps();
  let n = 0;
  limited.client.getLogs = async () => { n += 1; throw new Error('rate limit exceeded'); };
  await assert.rejects(reader(limited, { maxTries: 3, sleep: async () => {} }).vaultEvents([{ address: VAULT, fromBlock: 100 }], limited.head), /rate limit/);
  assert.equal(n, 3);
});
