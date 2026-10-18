// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEpoch } from '../src/run.mjs';
import { createChainReader } from '../src/source.mjs';
import { ConsistencyError } from '../src/consistency.mjs';
import { boardFileText, verifyBoard } from '../src/board.mjs';
import { EPOCH_SECONDS, SETTLE_SECONDS } from '../src/constants.mjs';
import { DAY, USDC, A, B, VAULT, addr, fakeChain } from './helpers.mjs';

const ANCHOR = 1_000_000;
const CREATOR = addr(0xc0de);
const DEPLOYER = addr(0xdede);

/** A chain with a known history. Epoch 0 is [ANCHOR, ANCHOR + 7 days). */
function history({ extra = false } = {}) {
  const ch = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  ch.deposit(A, 100n * USDC, ANCHOR + 1 * DAY);
  ch.deposit(B, 50n * USDC, ANCHOR + 2 * DAY);
  ch.deposit(CREATOR, 1000n * USDC, ANCHOR + 2 * DAY + 10);
  ch.exit(A, 100n * USDC * 10n ** 12n / 2n, ANCHOR + 3 * DAY); // half of A's shares
  if (extra) {
    ch.deposit(A, 25n * USDC, ANCHOR + 8 * DAY); // after epoch 0
    ch.exit(B, 50n * USDC * 10n ** 12n, ANCHOR + 9 * DAY);
  }
  ch.advanceTo(ANCHOR + (extra ? 15 : 8) * DAY);
  return ch;
}

const seededDoc = { addresses: [] };
const now = (ch) => ch.ts + SETTLE_SECONDS + EPOCH_SECONDS; // comfortably after epoch 0 settled

function run(ch, { windowBlocks = 10_000, nowSec = now(ch), epochNumber = 0, chainId = 5042, vaults = [{ address: VAULT, fromBlock: 100 }], doc = seededDoc, crossClient = null } = {}) {
  const reader = createChainReader({ client: ch.client, chainId: 5042, windowBlocks, confirmations: 0 });
  const crossReader = crossClient ? createChainReader({ client: crossClient, chainId: 5042, windowBlocks, confirmations: 0 }) : null;
  return runEpoch({
    chains: [{ chainId, name: 'arc', vaults, deployers: [DEPLOYER], reader, crossReader }],
    anchor: ANCHOR, epochNumber, nowSec, seededDoc: doc, seededSha256: 'aa', codeCommit: 'deadbeef',
  });
}

test('a closed epoch measures held USDC-days and labels the creator as team-operated', async () => {
  const { board, diagnostics } = await run(history());
  assert.equal(board.epoch.status, 'closed');
  const rows = Object.fromEntries(board.chains[0].rows.map((r) => [r.address, r]));
  // A: 100 USDC from day 1 to day 3 = 200, then 50 USDC from day 3 to day 7 = 200.
  assert.equal(rows[A].usdcDays, '400.000000');
  // B: 50 USDC from day 2 to day 7 = 250.
  assert.equal(rows[B].usdcDays, '250.000000');
  assert.equal(rows[CREATOR].teamOperated, true);
  assert.deepEqual(rows[CREATOR].teamReasons, ['creator']);
  assert.equal(rows[CREATOR].rank, null);
  assert.equal(rows[A].rank, 1);
  assert.equal(rows[B].rank, 2);
  assert.equal(board.chains[0].totals.others.usdcDays, '650.000000');
  assert.ok(verifyBoard(board));
  assert.equal(diagnostics[0].positionsChecked, 3);
});

test('the epoch end block is the last block before the end, and its hash is recorded', async () => {
  const ch = history();
  const { board } = await run(ch);
  const c = board.chains[0];
  const end = ANCHOR + EPOCH_SECONDS;
  const ts = async (n) => Number((await ch.client.getBlock({ blockNumber: BigInt(n) })).timestamp);
  assert.ok((await ts(c.toBlock)) < end);
  assert.ok((await ts(c.toBlock + 1)) >= end);
  assert.equal(c.toBlockHash, `0x${c.toBlock.toString(16).padStart(64, '0')}`);
  assert.equal(c.integratedUntil, end);
});

test('window size does not change a byte', async () => {
  const ch = history();
  const base = boardFileText((await run(ch, { windowBlocks: 10_000 })).board);
  for (const w of [4_999, 777]) {
    assert.equal(boardFileText((await run(ch, { windowBlocks: w })).board), base, `window ${w}`);
  }
});

test('activity after a closed epoch does not change that epoch', async () => {
  const early = (await run(history())).board;
  const later = (await run(history({ extra: true }))).board;
  assert.equal(later.contentSha256, early.contentSha256);
});

test('the next epoch sees the later activity', async () => {
  const { board } = await run(history({ extra: true }), { epochNumber: 1 });
  const rows = Object.fromEntries(board.chains[0].rows.map((r) => [r.address, r]));
  // A holds 50 USDC through day 8, then 75 USDC to day 14; B holds 50 USDC to day 9 (epoch 1 starts day 7).
  assert.equal(rows[A].usdcDays, String(50 * 1 + 75 * 6) + '.000000');
  assert.equal(rows[B].usdcDays, '100.000000');
});

test('before the settling delay an epoch is provisional and integrates only up to the head', async () => {
  const ch = history();
  const justAfterEnd = ANCHOR + EPOCH_SECONDS + 1000;
  const { board } = await run(ch, { nowSec: justAfterEnd });
  assert.equal(board.epoch.status, 'provisional');
  // head is at day 8, so the epoch is integrated to its end (day 7), not past it
  assert.equal(board.chains[0].integratedUntil, ANCHOR + EPOCH_SECONDS);
  // Mid-epoch: the head is on day 4, so the epoch is integrated to the head and not to its end.
  const mid = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  mid.deposit(A, 100n * USDC, ANCHOR + DAY);
  mid.advanceTo(ANCHOR + 4 * DAY);
  const { board: p } = await run(mid, { nowSec: ANCHOR + 4 * DAY });
  assert.equal(p.epoch.status, 'provisional');
  assert.equal(p.chains[0].integratedUntil, ANCHOR + 4 * DAY);
  assert.equal(p.chains[0].rows[0].usdcDays, '300.000000');
});

test('the head-state check aborts the run when the chain disagrees with the ledger', async () => {
  for (const field of ['sharesOf', 'costBasisUsdc']) {
    const ch = history();
    ch.lie = (fn, m, v) => (fn === field && m === A ? v + 1n : v);
    await assert.rejects(run(ch), (e) => e instanceof ConsistencyError && e.message.includes(A));
  }
});

test('a read that starts between the deposit and the exit of one member fails in the reducer, because the exit has nothing to burn', async () => {
  const ch = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  const bA = ch.deposit(A, 100n * USDC, ANCHOR + DAY);
  ch.exit(A, 100n * USDC * 10n ** 12n / 2n, ANCHOR + 2 * DAY);
  ch.advanceTo(ANCHOR + 8 * DAY);
  await assert.rejects(run(ch, { vaults: [{ address: VAULT, fromBlock: bA + 1 }] }), /burns 5[0-9]+ of 0 shares; a log is missing/);
});

/** A holds 100 USDC from day 1 and never acts again; B deposits 50 USDC on day 2. Returns B's block. */
function memberWithNoLaterActivity() {
  const ch = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  ch.deposit(A, 100n * USDC, ANCHOR + DAY);
  const bB = ch.deposit(B, 50n * USDC, ANCHOR + 2 * DAY);
  ch.advanceTo(ANCHOR + 8 * DAY);
  return { ch, bB };
}

test('a member who still holds shares and whose logs were all missed is caught by the share total (the read starts after their only deposit)', async () => {
  const { ch, bB } = memberWithNoLaterActivity();
  // The whole history read is sound.
  const ok = (await run(ch)).board.chains[0].rows.map((r) => r.address).sort();
  assert.deepEqual(ok, [A, B].sort());
  // Starting at B's block leaves A out of the ledger entirely; A's shares are still in totalShares.
  await assert.rejects(run(ch, { vaults: [{ address: VAULT, fromBlock: bB }] }), (e) => e instanceof ConsistencyError && /totalShares/.test(e.message) && /missed/.test(e.message));
});

test('an endpoint that answers every log query with an empty list is caught by the share total while any member still holds shares', async () => {
  const { ch } = memberWithNoLaterActivity();
  ch.client.getLogs = async () => [];
  await assert.rejects(run(ch), (e) => e instanceof ConsistencyError && /totalShares/.test(e.message));
});

// The residual the README states: an address that entered and fully left leaves nothing at the head, so
// missed logs for it are not seen. This pins the documented limit; if a later check closes it, update the README with it.
test('residual: an address that fully exited before the read starts is silently absent, and an all-empty endpoint with every member exited gives an empty board', async () => {
  const ch = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  ch.deposit(A, 100n * USDC, ANCHOR + DAY);
  ch.exit(A, 100n * USDC * 10n ** 12n, ANCHOR + 3 * DAY);
  const bB = ch.deposit(B, 50n * USDC, ANCHOR + 4 * DAY);
  ch.advanceTo(ANCHOR + 8 * DAY);
  assert.deepEqual((await run(ch)).board.chains[0].rows.map((r) => r.address).sort(), [A, B].sort());
  const late = (await run(ch, { vaults: [{ address: VAULT, fromBlock: bB }] })).board.chains[0].rows.map((r) => r.address);
  assert.deepEqual(late, [B]);
  const gone = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  gone.deposit(A, 100n * USDC, ANCHOR + DAY);
  gone.exit(A, 100n * USDC * 10n ** 12n, ANCHOR + 3 * DAY);
  gone.advanceTo(ANCHOR + 8 * DAY);
  gone.client.getLogs = async () => [];
  assert.deepEqual((await run(gone)).board.chains[0].rows, []);
});

test('a second endpoint that agrees is recorded in the diagnostics', async () => {
  const ch = history();
  const { diagnostics } = await run(ch, { crossClient: ch.client });
  assert.equal(diagnostics[0].secondEndpointChecked, true);
  assert.equal(diagnostics[0].vaultsChecked, 1);
  assert.equal((await run(ch)).diagnostics[0].secondEndpointChecked, false);
});

test('a second endpoint that disagrees on the head hash, on a vault total, or is behind aborts the run', async () => {
  const ch = history();
  const other = (patch) => ({ ...ch.client, ...patch });
  const getBlock = async (a) => ({ ...(await ch.client.getBlock(a)), hash: `0x${'ab'.repeat(32)}` });
  await assert.rejects(run(ch, { crossClient: other({ getBlock }) }), (e) => e instanceof ConsistencyError && /hash/.test(e.message));
  const readContract = async (q) => { const v = await ch.client.readContract(q); return q.functionName === 'totalShares' ? v + 1n : v; };
  await assert.rejects(run(ch, { crossClient: other({ readContract }) }), (e) => e instanceof ConsistencyError && /totalShares/.test(e.message));
  const behind = async () => { throw new Error('block not found'); };
  await assert.rejects(run(ch, { crossClient: other({ getBlock: behind }) }), /block not found/);
  await assert.rejects(run(ch, { crossClient: other({ getChainId: async () => 1 }) }), /WRONG CHAIN/);
});

test('refuses the wrong chain, an empty vault list, and an endpoint that is behind', async () => {
  const wrong = fakeChain({ chainId: 1 });
  wrong.advanceTo(2_000_000);
  await assert.rejects(run(wrong), /WRONG CHAIN/);
  await assert.rejects(run(history(), { vaults: [] }), /no vaults configured/);
  const ch = fakeChain({ startTs: ANCHOR, creator: CREATOR });
  ch.deposit(A, USDC, ANCHOR + DAY);
  // clock says epoch 0 is long closed, but the endpoint's head is still inside it
  await assert.rejects(run(ch, { nowSec: ANCHOR + 30 * DAY }), /endpoint is behind/);
});

test('a vault log from some other address is refused', async () => {
  const ch = history();
  const bad = ch.client.getLogs;
  ch.client.getLogs = async (q) => (await bad(q)).map((l) => ({ ...l, address: addr(0xbad) }));
  await assert.rejects(run(ch), /returned for/);
});
