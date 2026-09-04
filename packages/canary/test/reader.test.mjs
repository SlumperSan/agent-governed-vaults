// @ts-check
/**
 * The chain adapter. Two things are worth testing here without a live RPC:
 *
 * 1. extractRevertData — the whole exit-liveness classification rests on it. viem nests the raw
 *    returndata several `cause` levels deep and the shape differs by transport, so a miss here
 *    would turn a real H-1 fault into "no data". That still ALERTS (empty returndata is a fault),
 *    so the failure is loud rather than silent — but it would lose the diagnosis. The reverse
 *    miss is the one that was actually shipped: hex that IS in viem's text but is the canary's
 *    own request, reported as returndata. The LIVE block at the bottom runs the real adapter over
 *    a real viem client against a local node, because only the real client writes that text.
 * 2. The read-only guarantee: the reader exposes no way to send a transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicClient, http as httpTransport } from 'viem';
import { extractRevertData, structuredRevertData, createChainReader } from '../src/reader.mjs';
import { classifyCallError } from '../src/call-error.mjs';

test('pulls returndata off a flat error', () => {
  assert.equal(extractRevertData({ data: '0xAB143C06' }), '0xab143c06');
});

test('walks the cause chain viem builds (ContractFunctionExecutionError → … → RpcRequestError)', () => {
  const err = { message: 'reverted', cause: { shortMessage: 'x', cause: { data: '0xa2671f4b' } } };
  assert.equal(extractRevertData(err), '0xa2671f4b');
});

test('handles the nested { data: { data } } shape', () => {
  assert.equal(extractRevertData({ cause: { data: { data: '0x08c379a0' } } }), '0x08c379a0');
});

test('scrapes returndata out of the node\'s own words (`details`) only — never out of viem\'s message', () => {
  // A node that writes the returndata into its JSON-RPC error message reaches us as `details`,
  // which viem carries up the cause chain unchanged and never quotes the request in.
  assert.equal(extractRevertData({ details: 'execution reverted: 0xab143c06' }), '0xab143c06');
  // `message` and `shortMessage` are viem's composition. For a failed call the message quotes the
  // request the canary sent (proven against the real client in the LIVE block below), so hex found
  // there is not returndata — even when the prose around it looks like a revert.
  assert.equal(extractRevertData({ message: 'execution reverted, data: 0xab143c06 (Reentrancy)' }), null);
  assert.equal(extractRevertData({ shortMessage: 'reverted 0xab143c06' }), null);
});

test('returns null when there is genuinely no returndata — callers treat that as a FAULT', () => {
  assert.equal(extractRevertData({ message: 'execution reverted' }), null);
  assert.equal(extractRevertData(new Error('out of gas')), null);
  assert.equal(extractRevertData(null), null);
});

test('does not loop forever on a self-referential cause chain', () => {
  const a = { message: 'a' };
  a.cause = a;
  assert.equal(extractRevertData(a), null);
});

test('ignores a too-short hex value that cannot be a selector', () => {
  assert.equal(extractRevertData({ data: '0x00' }), null);
});

test('the reader exposes reads only — there is no send/sign/write surface', () => {
  const reader = createChainReader({ client: {} });
  assert.deepEqual(Object.keys(reader).sort(), ['chainNow', 'getLogs', 'headBlock', 'read', 'staticCall', 'tryRead']);
  for (const forbidden of ['sendTransaction', 'writeContract', 'signMessage', 'account', 'wallet']) {
    assert.equal(reader[forbidden], undefined, `the canary must expose no ${forbidden}`);
  }
});

test('refuses to build a client with neither an injection nor an rpcUrl', async () => {
  await assert.rejects(() => createChainReader({}).headBlock(), /no client injected and no rpcUrl/);
});

test('getLogs short-circuits an empty address set instead of asking for every log on chain', async () => {
  let called = false;
  const reader = createChainReader({ client: { getLogs: async () => { called = true; return []; } } });
  assert.deepEqual(await reader.getLogs({ address: [], event: {}, fromBlock: 0, toBlock: 1 }), []);
  assert.equal(called, false);
});

test('passes a pinned block through to readContract, and omits it when unpinned', async () => {
  const seen = [];
  const reader = createChainReader({ client: { readContract: async (args) => { seen.push(args); return 1n; } } });
  await reader.read('0xabc', [], 'totalShares', [], { blockNumber: 995 });
  await reader.read('0xabc', [], 'totalShares', []);
  assert.equal(seen[0].blockNumber, 995n);
  assert.equal('blockNumber' in seen[1], false);
});

test('staticCall reports a revert as data rather than throwing', async () => {
  const reader = createChainReader({
    client: { call: async () => { throw { data: '0xab143c06' }; } },
  });
  const res = await reader.staticCall({ to: '0x1', from: '0x2', data: '0x3' });
  assert.equal(res.ok, false);
  assert.equal(res.data, '0xab143c06');
});

test('staticCall passes no explicit gas — a low cap would manufacture failures the chain never has', async () => {
  const seen = [];
  const reader = createChainReader({ client: { call: async (args) => { seen.push(args); return { data: '0x' }; } } });
  await reader.staticCall({ to: '0x1', from: '0x2', data: '0x3' });
  assert.equal('gas' in seen[0], false, 'VaultCore gas-caps its own module calls; the probe must not add a second cap');
});

// ── `kind`: was a failed read evidence about the contract, or did it never get there? ──

test('classifyCallError: a revert whose text also carries a transport-ish token is still a revert', () => {
  assert.equal(classifyCallError('execution reverted, data: "0x429" timeout'), 'revert');
  assert.equal(classifyCallError('reverted: DeadlineTimeout()'), 'revert');
  // The wording viem 2.x actually produces for a revert with no decodable reason.
  assert.equal(classifyCallError('Execution reverted for an unknown reason.'), 'revert');
});

test('classifyCallError: transport wording is never a contract verdict, and neither is an unknown string', () => {
  // The wordings measured out of viem 2.x for an HTTP 429 and a JSON-RPC rate limit respectively.
  assert.equal(classifyCallError('HTTP request failed.'), 'transport');
  assert.equal(classifyCallError('Request exceeds defined limit.'), 'transport');
  assert.equal(classifyCallError('ECONNRESET'), 'transport');
  // Fail-safe: an unrecognised failure is missing evidence, not a finding.
  assert.equal(classifyCallError('something nobody has seen before'), 'transport');
});

test('a transport failure carries kind:transport and NO returndata — the scrape would return our OWN calldata', async () => {
  // Measured shape: viem quotes the failing request back in the message, so `extractRevertData`'s
  // hex fallback recovers the calldata the canary just sent. Its first four bytes then read as an
  // unrecognized revert selector, which is how a 429 used to page "EXIT LIVENESS BROKEN".
  const calldata = `0x721c6513${'0'.repeat(63)}1`;
  const client = {
    call: async () => {
      const e = new Error(`HTTP request failed.\n\nRaw Call Arguments:\n  data: ${calldata}`);
      // @ts-ignore — viem sets this
      e.shortMessage = 'HTTP request failed.';
      throw e;
    },
  };
  const res = await createChainReader({ client }).staticCall({ to: '0x1', from: '0x2', data: calldata });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'transport');
  assert.equal(res.data, null, 'a call that never reached the chain produced no returndata');
});

test('tryRead tags a transport failure the same way, and drops the scraped returndata with it', async () => {
  const client = {
    readContract: async () => {
      const e = new Error('The request took too long to respond. Raw Call Arguments: data: 0xa2671f4b');
      // @ts-ignore — viem sets this
      e.shortMessage = 'The request took too long to respond.';
      throw e;
    },
  };
  const res = await createChainReader({ client }).tryRead('0x1', [], 'navWad', []);
  assert.equal(res.kind, 'transport');
  assert.equal(res.revertData, null,
    'scraping StaleOracle out of a timeout would attribute a network fault to the oracle breaker');
});

test('structured returndata outranks the wording: a revert no pattern recognises is still a revert', () => {
  // `structuredRevertData` only answers for returndata viem handed over in a FIELD, which cannot
  // exist unless the EVM executed and reverted. It is what keeps an odd-worded provider's genuine
  // revert out of the blind channel.
  assert.equal(structuredRevertData({ data: '0xab143c06' }), '0xab143c06');
  assert.equal(structuredRevertData({ message: 'reverted 0xab143c06' }), null,
    'hex found in prose is not structured returndata and must not decide kind');
});

test('a revert reported only in a field, with wording that matches nothing, is classified revert', async () => {
  const client = { call: async () => { throw { data: '0xab143c06', shortMessage: 'provider said something new' }; } };
  const res = await createChainReader({ client }).staticCall({ to: '0x1', from: '0x2', data: '0x3' });
  assert.equal(res.kind, 'revert');
  assert.equal(res.data, '0xab143c06');
});

// ── LIVE: the real adapter over a real viem client against a local node ──────
//
// The defect these pin lives in viem's error TEXT, so no stub that hands the reader a pre-shaped
// error can see it: viem quotes the request it just sent in the message of every failed call, and
// a scrape over that message returned the canary's own addresses whenever the node returned
// nothing. Only the real client writes that text, so only the real client can prove it is ignored.

const TO = `0x${'a1'.repeat(18)}cafe`;
const FROM = `0x${'22'.repeat(20)}`;
const ORACLE = `0x${'11'.repeat(20)}`;
const ASSET = `0x${'33'.repeat(20)}`;
const REQUEST_EXIT_1 = `0x721c6513${'0'.repeat(63)}1`;
const PRICE_WAD_ABI = [{
  type: 'function', name: 'priceWad', stateMutability: 'view',
  inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }],
}];
const EMPTY_REVERT = { code: 3, message: 'execution reverted' };

/** A node that answers every JSON-RPC request with `error`, or with an HTTP 429 when it is null. */
async function rpcNode(error) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!error) { res.writeHead(429); res.end('Too Many Requests'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(raw).id ?? 1, error }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return {
    client: createPublicClient({ transport: httpTransport(url, { retryCount: 0 }) }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run a call that is expected to throw and hand back what it threw. */
const caught = (p) => p.then(() => null, (e) => e);

test('LIVE staticCall: an EMPTY-returndata revert is kind:revert with data:null — not the probe\'s own from address', async () => {
  const node = await rpcNode(EMPTY_REVERT);
  try {
    // The vector, proven present before it is proven bypassed: viem's message quotes the request
    // with `from` first, while the node's own words carry no hex at all.
    const raw = await caught(node.client.call({ to: TO, account: FROM, data: REQUEST_EXIT_1 }));
    assert.ok(raw, 'the node answered code 3, so call() must throw');
    assert.ok(raw.message.includes(FROM), 'viem quotes the from address in message — the scrape used to read it from here');
    assert.equal(raw.details, 'execution reverted');
    assert.equal(structuredRevertData(raw), null, 'no field carries returndata: the node sent none');
    assert.equal(extractRevertData(raw), null, 'hex in viem\'s message is the request, not returndata');

    const res = await createChainReader({ client: node.client }).staticCall({ to: TO, from: FROM, data: REQUEST_EXIT_1 });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'revert');
    assert.equal(res.data, null, `the node returned no returndata; this used to be ${FROM}`);
  } finally { await node.close(); }
});

test('LIVE tryRead: the same EMPTY-returndata revert is kind:revert with revertData:null — readContract\'s wording alone reads as transport', async () => {
  const node = await rpcNode(EMPTY_REVERT);
  try {
    const raw = await caught(node.client.readContract({ address: ORACLE, abi: PRICE_WAD_ABI, functionName: 'priceWad', args: [ASSET] }));
    assert.equal(raw.shortMessage, 'The contract function "priceWad" reverted.');
    // Why `details` is consulted: this wording matches neither pattern in call-error.mjs, so on
    // shortMessage alone a genuine revert was filed 'transport' — missing evidence, not a revert.
    assert.equal(classifyCallError(raw.shortMessage), 'transport');
    assert.equal(raw.details, 'execution reverted');
    assert.ok(raw.message.includes(ORACLE), 'readContract quotes the contract address under "Contract Call"');
    assert.equal(extractRevertData(raw), null, 'the contract address in message is not returndata');

    const res = await createChainReader({ client: node.client }).tryRead(ORACLE, PRICE_WAD_ABI, 'priceWad', [ASSET]);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'revert', 'the node said "execution reverted": that is evidence about the contract, not a blind detector');
    assert.equal(res.revertData, null);
  } finally { await node.close(); }
});

test('LIVE tryRead: a revert WITH returndata still surfaces it, structured, on the readContract chain', async () => {
  const node = await rpcNode({ code: 3, message: 'execution reverted', data: '0xa2671f4b' });
  try {
    const res = await createChainReader({ client: node.client }).tryRead(ORACLE, PRICE_WAD_ABI, 'priceWad', [ASSET]);
    assert.equal(res.kind, 'revert');
    assert.equal(res.revertData, '0xa2671f4b', 'viem parks undecodable returndata in ContractFunctionRevertedError.raw');
  } finally { await node.close(); }
});

test('LIVE tryRead: an HTTP 429 is still kind:transport with no returndata — consulting details did not widen revert', async () => {
  const node = await rpcNode(null);
  try {
    const res = await createChainReader({ client: node.client }).tryRead(ORACLE, PRICE_WAD_ABI, 'priceWad', [ASSET]);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'transport');
    assert.equal(res.revertData, null);
  } finally { await node.close(); }
});

test('LIVE: a pruned node\'s "missing trie node <hash>" is transport, and the hash in its own words is NOT returndata', async () => {
  // `details` here IS the node's own text and it carries 64 hex characters, so the narrowed scrape
  // still finds them. The reader's `kind === 'transport'` nulling is what keeps that hash out of
  // `revertData` — this is why the nulling stays load-bearing after the scrape was narrowed.
  const hash = `0x${'ab'.repeat(32)}`;
  const node = await rpcNode({ code: -32000, message: `missing trie node ${hash} (path ) state ${hash} is not available` });
  try {
    const raw = await caught(node.client.readContract({ address: ORACLE, abi: PRICE_WAD_ABI, functionName: 'priceWad', args: [ASSET] }));
    assert.equal(extractRevertData(raw), hash, 'the scrape alone WOULD report the hash');

    const reader = createChainReader({ client: node.client });
    const read = await reader.tryRead(ORACLE, PRICE_WAD_ABI, 'priceWad', [ASSET], { blockNumber: 1 });
    assert.equal(read.kind, 'transport');
    assert.equal(read.revertData, null);
    const call = await reader.staticCall({ to: TO, from: FROM, data: REQUEST_EXIT_1 });
    assert.equal(call.kind, 'transport');
    assert.equal(call.data, null);
  } finally { await node.close(); }
});
