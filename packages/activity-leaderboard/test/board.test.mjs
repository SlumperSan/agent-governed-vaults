// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, verifyBoard, usdcDaysString, boardFileText } from '../src/board.mjs';
import { buildTeamSet } from '../src/team.mjs';
import { canonicalJson } from '../src/canonical.mjs';
import { epochBounds, epochOf } from '../src/epoch.mjs';
import { EPOCH_SECONDS } from '../src/constants.mjs';
import { A, B, C, USDC, addr, rng, shuffled } from './helpers.mjs';

const EOA = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const WALLET = '0x' + 'ab'.repeat(32);
const SEEDED_DOC = { addresses: [] };
const epoch = { number: 3, start: 1000, end: 1000 + EPOCH_SECONDS, status: /** @type {const} */ ('closed') };

function chain(chainId, entries, extra = {}) {
  const usdcSeconds = new Map(entries);
  return {
    chainId, name: `c${chainId}`, vaults: [addr(0xaa00 + chainId)], fromBlock: 10, toBlock: 99, toBlockHash: '0x' + '11'.repeat(32), integratedUntil: epoch.end,
    usdcSeconds, codeHashes: new Map(entries.map(([a]) => [a, EOA])), ...extra,
  };
}
const make = (chains, team = new Map()) =>
  buildBoard({ epoch, codeCommit: 'abc123', seededAddressesSha256: 'ff', team, chains });

test('usdcDays renders exact decimals, floored', () => {
  assert.equal(usdcDaysString(0n), '0.000000');
  assert.equal(usdcDaysString(86_400n), '0.000001');
  assert.equal(usdcDaysString(86_399n), '0.000000');
  assert.equal(usdcDaysString(5n * USDC * 86_400n + 86_400n * 250_000n), '5.250000');
});

test('same inputs give a byte-identical file and hash, whatever order they arrive in', () => {
  const rand = rng(3);
  const entries = [[A, 5n * USDC * 86_400n], [B, 9n * USDC * 86_400n], [C, 9n * USDC * 86_400n], [addr(0x77), 123n]];
  const first = make([chain(5042, entries), chain(8453, entries.slice(0, 2))]);
  for (let i = 0; i < 10; i += 1) {
    const again = make(shuffled([chain(5042, shuffled(entries, rand)), chain(8453, shuffled(entries.slice(0, 2), rand))], rand));
    assert.equal(boardFileText(again), boardFileText(first));
    assert.equal(again.contentSha256, first.contentSha256);
  }
  assert.ok(verifyBoard(first));
});

test('the hash covers every field: changing any value breaks verification', () => {
  const b = make([chain(5042, [[A, 100n]])]);
  assert.ok(verifyBoard(b));
  assert.ok(verifyBoard(JSON.parse(canonicalJson(b))), 'the written form verifies');
  for (const mutate of [
    (x) => { x.chains[0].rows[0].usdcSeconds = '101'; },
    (x) => { x.chains[0].toBlockHash = '0x' + '22'.repeat(32); },
    (x) => { x.epoch.number = 4; },
    (x) => { x.codeCommit = 'other'; },
    (x) => { x.global.rows[0].rank = 2; },
  ]) {
    const x = JSON.parse(canonicalJson(b));
    mutate(x);
    assert.equal(verifyBoard(x), false);
  }
});

test('ranking: usdcSeconds descending, ties by address, zero rows absent', () => {
  const b = make([chain(5042, [[addr(3), 10n], [addr(1), 50n], [addr(2), 50n]])]);
  const rank = Object.fromEntries(b.chains[0].rows.map((r) => [r.address, r.rank]));
  assert.deepEqual(rank, { [addr(1)]: 1, [addr(2)]: 2, [addr(3)]: 3 });
  // file order is by address
  assert.deepEqual(b.chains[0].rows.map((r) => r.address), [addr(1), addr(2), addr(3)]);
});

test('team-operated addresses are labelled, unranked, and totalled apart', () => {
  const creator = addr(0xc0de);
  const seeded = addr(0x5eed);
  const deployer = addr(0xdede);
  const team = buildTeamSet({
    seededDoc: { addresses: [{ address: seeded.toUpperCase().replace('0X', '0x') }] },
    creators: [creator], deployers: [deployer, creator],
  });
  assert.deepEqual(team.get(creator), ['creator', 'deployer']);
  assert.deepEqual(team.get(seeded), ['seeded']);
  const b = make([chain(5042, [[A, 10n * 86_400n], [seeded, 99n * 86_400n], [creator, 77n * 86_400n], [deployer, 1n * 86_400n]])], team);
  const rows = Object.fromEntries(b.chains[0].rows.map((r) => [r.address, r]));
  assert.equal(rows[A].rank, 1);
  for (const t of [seeded, creator, deployer]) {
    assert.equal(rows[t].teamOperated, true);
    assert.equal(rows[t].rank, null);
  }
  assert.equal(b.chains[0].totals.others.addresses, 1);
  assert.equal(b.chains[0].totals.others.usdcSeconds, 10n * 86_400n);
  assert.equal(b.chains[0].totals.teamOperated.addresses, 3);
  assert.equal(b.chains[0].totals.teamOperated.usdcSeconds, 177n * 86_400n);
  assert.equal(b.global.rows.find((r) => r.address === seeded)?.rank, null);
});

test('team set rejects malformed input instead of skipping it', () => {
  assert.throws(() => buildTeamSet({ seededDoc: { addresses: [{ address: 'nope' }] } }), /not an address/);
  assert.throws(() => buildTeamSet({ seededDoc: /** @type {any} */ ({}) }), /no addresses array/);
});

test('global row: summed across chains only where the code hash matches the largest position', () => {
  const entriesArc = [[A, 100n], [B, 100n]];
  const arc = chain(5042, entriesArc);
  const base = chain(8453, [[A, 40n], [B, 60n]], { codeHashes: new Map([[A, EOA], [B, WALLET]]) });
  const b = make([base, arc]);
  const g = Object.fromEntries(b.global.rows.map((r) => [r.address, r]));
  assert.equal(g[A].usdcSeconds, 140n);
  assert.deepEqual(g[A].chainsCounted, [5042, 8453]);
  // B: same address, different deployed code on Base. Arc is its largest position, so Base is left out.
  assert.equal(g[B].usdcSeconds, 100n);
  assert.deepEqual(g[B].chainsCounted, [5042]);
  assert.deepEqual(g[B].chainsExcluded, [8453]);
  // per-chain boards are unaffected
  assert.equal(b.chains.find((c) => c.chainId === 8453)?.rows.find((r) => r.address === B)?.usdcSeconds, 60n);
});

test('global row: a position without a code hash is an error, not a silent inclusion', () => {
  const c = chain(5042, [[A, 5n]], { codeHashes: new Map() });
  assert.throws(() => make([c]), /no code hash for/);
});

test('epoch arithmetic', () => {
  assert.deepEqual(epochBounds(1000, 0), { start: 1000, end: 1000 + EPOCH_SECONDS });
  assert.deepEqual(epochBounds(1000, 2), { start: 1000 + 2 * EPOCH_SECONDS, end: 1000 + 3 * EPOCH_SECONDS });
  assert.equal(epochOf(1000, 1000 + EPOCH_SECONDS - 1), 0);
  assert.equal(epochOf(1000, 1000 + EPOCH_SECONDS), 1);
  assert.throws(() => epochOf(1000, 999), /before the anchor/);
  assert.throws(() => epochBounds(1000, -1), /non-negative/);
});

test('canonical JSON refuses what it cannot write one way', () => {
  assert.throws(() => canonicalJson({ a: undefined }), /cannot encode/);
  assert.throws(() => canonicalJson({ a: 1.5 }), /safe integer/);
  assert.equal(canonicalJson({ b: 1n, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":"1"}');
});
