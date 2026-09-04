// @ts-check
/**
 * Signal (d) — the H-1 exit-liveness sentinel.
 *
 * This is the signal that can ship looking green and be worthless, so it gets the most adversarial
 * coverage in the package. The three cases that prove the sentinel is REAL rather than vacuous:
 *   1. a non-gate revert (Reentrancy) ALERTS
 *   2. EMPTY returndata — the actual H-1 out-of-gas / returndata-bomb signature — ALERTS
 *   3. no member holding shares is SKIPPED, never OK
 * If those three hold, the sentinel cannot silently pass while exits are bricked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { checkExitLiveness, pickProbeMember, encodeRequestExit } from '../src/signals/exit-liveness.mjs';
import { createChainReader } from '../src/reader.mjs';
import { mockReader, VAULT, MEMBER, CREATOR } from './helpers.mjs';

const REENTRANCY = '0xab143c06';
const STALE_ORACLE = '0xa2671f4b';
const INSUFFICIENT_SHARES = '0x39996567';
const CREATOR_GATE = '0xa428ab2d';

const book = new Map([[MEMBER, 400n], [CREATOR, 100n]]);

/** @param {{ok:boolean,data?:string|null}} outcome */
function readerReturning(outcome) {
  return mockReader({ contracts: {}, onStaticCall: () => outcome });
}

test('encodes requestExit(uint256) with the right selector and a padded argument', () => {
  assert.equal(encodeRequestExit(1n), `0x721c6513${'0'.repeat(63)}1`);
  assert.equal(encodeRequestExit(255n).slice(0, 10), '0x721c6513');
  assert.ok(encodeRequestExit(255n).endsWith('ff'));
  assert.equal(encodeRequestExit(255n).length, 10 + 64);
});

test('probe member: prefers a non-creator holder, largest balance first', () => {
  const picked = pickProbeMember(book, CREATOR);
  assert.equal(picked.member, MEMBER);
  assert.equal(picked.shares, 400n);
});

test('probe member: falls back to the creator when they are the only holder', () => {
  const picked = pickProbeMember(new Map([[CREATOR, 100n]]), CREATOR);
  assert.equal(picked.member, CREATOR);
});

test('probe member: ignores zero balances, returns null when nobody holds shares', () => {
  assert.equal(pickProbeMember(new Map([[MEMBER, 0n]]), CREATOR), null);
  assert.equal(pickProbeMember(new Map(), CREATOR), null);
  assert.equal(pickProbeMember(undefined, CREATOR), null);
});

// ── HEALTHY ──────────────────────────────────────────────────────────────────

test('OK when the static call succeeds — exits are live', async () => {
  const reader = readerReturning({ ok: true, data: '0x' });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  assert.equal(r.status, 'ok');
  assert.match(r.message, /exits live/);
});

test('OK on a gate revert — InsufficientShares is the caller position, not a fault', async () => {
  const reader = readerReturning({ ok: false, data: INSUFFICIENT_SHARES });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.revertName, 'InsufficientShares');
});

test('OK on the creator stake gate (CM-1) — a gate, not a liveness fault', async () => {
  const reader = readerReturning({ ok: false, data: CREATOR_GATE });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: new Map([[CREATOR, 100n]]), creator: CREATOR });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.revertName, 'CreatorStakeGate');
});

test('probes as a real member, with a nonzero share amount, against the vault', async () => {
  const reader = readerReturning({ ok: true, data: '0x' });
  await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  const call = reader.calls.find((c) => c.kind === 'staticCall');
  assert.equal(call.to, VAULT);
  assert.equal(call.from, MEMBER, 'must impersonate a holder, or every probe hits InsufficientShares');
  assert.notEqual(call.data, `0x721c6513${'0'.repeat(64)}`, 'must not probe with 0 shares — that always reverts ZeroAmount');
});

// ── THE THREE CASES THAT PROVE THE SENTINEL IS REAL ──────────────────────────

test('ALERTS on a non-gate revert (Reentrancy) — H-1 regression', async () => {
  const reader = readerReturning({ ok: false, data: REENTRANCY });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.revertName, 'Reentrancy');
  assert.match(r.message, /EXIT LIVENESS BROKEN/);
  assert.match(r.message, /H-1 regression/);
  assert.ok(r.message.includes(VAULT.slice(0, 6)), 'alert line must name the vault');
  assert.ok(r.measured && r.threshold, 'alert line must carry measured vs threshold');
});

test('ALERTS on EMPTY returndata — the out-of-gas / returndata-bomb H-1 signature', async () => {
  for (const data of [null, '0x', '0x00']) {
    const reader = readerReturning({ ok: false, data });
    const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
    assert.equal(r.status, 'alert', `empty returndata ${JSON.stringify(data)} must alert, never pass`);
    assert.match(r.message, /EMPTY returndata/);
  }
});

test('SKIPPED — not ok — when no member holds shares, so the probe cannot run', async () => {
  const reader = readerReturning({ ok: true, data: '0x' });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: new Map(), creator: CREATOR });
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok', 'a check that cannot run has NOT passed');
  assert.match(r.message, /CANNOT RUN/);
  assert.equal(r.detail.reason, 'no-eligible-member');
  assert.equal(reader.calls.filter((c) => c.kind === 'staticCall').length, 0, 'must not call at all');
});

// ── FROZEN: attributed to the oracle, never reported healthy ─────────────────

test('SKIPPED and attributed to the oracle on StaleOracle — never OK during a capital freeze', async () => {
  const reader = readerReturning({ ok: false, data: STALE_ORACLE });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok');
  assert.equal(r.detail.attributedTo, 'oracle-freshness');
  assert.match(r.message, /StaleOracle/);
});

test('ALERTS on an unrecognized selector rather than assuming it is benign', async () => {
  const reader = readerReturning({ ok: false, data: '0xdeadbeef' });
  const [r] = await checkExitLiveness({ reader, vault: VAULT, shareBook: book, creator: CREATOR });
  assert.equal(r.status, 'alert');
  assert.match(r.message, /unrecognized revert 0xdeadbeef/);
});

test('probe amount is clamped to the member balance so it never self-inflicts InsufficientShares', async () => {
  const reader = readerReturning({ ok: true, data: '0x' });
  await checkExitLiveness({
    reader, vault: VAULT, shareBook: new Map([[MEMBER, 1n]]), creator: CREATOR, probeShares: 10n,
  });
  const call = reader.calls.find((c) => c.kind === 'staticCall');
  assert.equal(BigInt(`0x${call.data.slice(10)}`), 1n);
});

// ── transport is not a verdict ───────────────────────────────────────────────
//
// These two run the REAL adapter over a REAL viem client against a local node, because the defect
// they pin lives in the wiring and not in any one function: `ok:false` alone cannot tell a 429
// from a revert, and every stub in this file that hands the signal a pre-made `{ok:false}` would
// keep passing while the deployed canary paged on a rate limit.

/** A node that answers every JSON-RPC request the same way. */
async function rpcServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The real reader over a real viem client — nothing stubbed between the socket and the signal. */
const liveReader = (url) => createChainReader({
  client: createPublicClient({ transport: httpTransport(url, { retryCount: 0 }) }),
});

test('WIRING: a real HTTP 429 reaches the sentinel as BLIND, never as the H-1 breach', async () => {
  const node = await rpcServer((_req, res) => { res.writeHead(429); res.end('Too Many Requests'); });
  try {
    const [r] = await checkExitLiveness({
      reader: liveReader(node.url), vault: VAULT, shareBook: book, creator: CREATOR,
    });
    assert.equal(r.status, 'skipped', 'a rate limit is not a verdict about requestExit');
    assert.doesNotMatch(r.message, /EXIT LIVENESS BROKEN/);
    assert.match(r.message, /BLIND/);
    // Visible, not merely quiet: detectorBroken is re-asserted on a backoff by transitions.mjs,
    // where a plain `skipped` would be reported once and then fall silent.
    assert.equal(r.detail.detectorBroken, true);
    assert.equal(r.detail.kind, 'transport');
    assert.equal(r.detail.revertData, null,
      'viem quotes the request in a transport error, so the scrape recovers this probe\'s own calldata');
  } finally { await node.close(); }
});

test('WIRING: a genuine revert over the same live path still ALERTS — the sentinel was not disabled', async () => {
  const node = await rpcServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: REENTRANCY } }));
  });
  try {
    const [r] = await checkExitLiveness({
      reader: liveReader(node.url), vault: VAULT, shareBook: book, creator: CREATOR,
    });
    assert.equal(r.status, 'alert');
    assert.match(r.message, /EXIT LIVENESS BROKEN/);
    assert.equal(r.detail.revertName, 'Reentrancy');
  } finally { await node.close(); }
});

test('WIRING: a genuine EMPTY-returndata revert over the live path ALERTS as EMPTY returndata, not as the probe member\'s own address', async () => {
  // The H-1 signature itself: the node says code 3 and returns no `data`. viem's message then
  // quotes the request under "Raw Call Arguments" with `from` first, and the reader's scrape used
  // to read that back as returndata — so this exact line said "unrecognized revert 0x66666666",
  // MEMBER's first four bytes. The verdict was already right (both branches ALERT); what this pins
  // is the diagnosis, because docs/CANARY.md §3(d) names empty returndata as the thing an
  // operator is meant to recognise.
  const node = await rpcServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }));
  });
  try {
    const [r] = await checkExitLiveness({
      reader: liveReader(node.url), vault: VAULT, shareBook: book, creator: CREATOR,
    });
    assert.equal(r.status, 'alert');
    assert.match(r.message, /EXIT LIVENESS BROKEN/);
    assert.match(r.message, /EMPTY returndata \(out-of-gas or returndata bomb\)/);
    assert.doesNotMatch(r.message, /unrecognized revert/);
    assert.doesNotMatch(r.message, new RegExp(MEMBER.slice(0, 10)), 'the probe member\'s address is the request, not the revert');
    assert.equal(r.detail.revertName, 'EMPTY returndata (out-of-gas or returndata bomb)');
    assert.equal(r.detail.revertData, null);
  } finally { await node.close(); }
});
