// @ts-check
/**
 * `scripts/verify-arc-usdc-domain.mjs` accepts a domain only when it is proven.
 *
 * Driven with a stub `fetch` standing in for the two Arc RPCs, so every refusal is exercised with
 * no network. The positive control uses the real separator of the real pair, so "accepts" is not a
 * claim about the stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters } from 'viem';
import { verifyUsdcDomain, separatorOf, ARC_RPCS, ARC_USDC } from '../verify-arc-usdc-domain.mjs';

const GOOD = { name: 'USDC', version: '2', chainId: 5042, verifyingContract: ARC_USDC };
const GOOD_SEP = separatorOf(GOOD);
const SEL = { name: '0x06fdde03', version: '0x54fd4d50', sep: '0x3644e515' };

/**
 * A stub chain. `byRpc[url]` overrides any of chainId / name / version / separator / failCall.
 * @param {Record<string, {chainId?:number, name?:string, version?:string, separator?:string, failCall?:string}>} [byRpc]
 */
const stub = (byRpc = {}) => async (url, init) => {
  const o = byRpc[String(url)] ?? {};
  const { method, params, id } = JSON.parse(init.body);
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
  if (method === 'eth_chainId') return reply('0x' + (o.chainId ?? 5042).toString(16));
  const data = params[0].data;
  if (o.failCall && data.startsWith(SEL[o.failCall])) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, error: { message: 'execution reverted' } }) };
  }
  if (data.startsWith(SEL.name)) return reply(encodeAbiParameters([{ type: 'string' }], [o.name ?? GOOD.name]));
  if (data.startsWith(SEL.version)) return reply(encodeAbiParameters([{ type: 'string' }], [o.version ?? GOOD.version]));
  if (data.startsWith(SEL.sep)) return reply(o.separator ?? GOOD_SEP);
  throw new Error(`unexpected call ${data}`);
};

test('the genuine pair is accepted when both RPCs answer for 5042 and agree', async () => {
  const r = await verifyUsdcDomain({ fetchImpl: stub() });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.domain, { ...GOOD, separator: GOOD_SEP });
});

test('a version that does not reproduce the separator is refused, and nothing is returned to write', async () => {
  const r = await verifyUsdcDomain({ fetchImpl: stub(Object.fromEntries(ARC_RPCS.map((u) => [u, { version: '1' }]))) });
  assert.equal(r.ok, false);
  assert.equal(r.domain, null);
  assert.match(r.problems.join('\n'), /hashes to 0x[0-9a-f]{64}, not the token's DOMAIN_SEPARATOR\(\)/);
});

test('the two RPCs disagreeing is refused', async () => {
  const r = await verifyUsdcDomain({ fetchImpl: stub({ [ARC_RPCS[1]]: { name: 'USD Coin' } }) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /disagree on name/);
});

test('an endpoint answering for another chain is refused before any token read', async () => {
  const r = await verifyUsdcDomain({ fetchImpl: stub({ [ARC_RPCS[0]]: { chainId: 8453 } }) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /WRONG CHAIN/);
});

test('a token that does not expose name(), version() or DOMAIN_SEPARATOR() is refused', async () => {
  for (const failCall of ['name', 'version', 'sep']) {
    const r = await verifyUsdcDomain({ fetchImpl: stub({ [ARC_RPCS[0]]: { failCall } }) });
    assert.equal(r.ok, false, failCall);
    assert.equal(r.domain, null, failCall);
  }
});

test('one endpoint is not enough: the two-provider rule needs both', async () => {
  const r = await verifyUsdcDomain({ fetchImpl: stub(), rpcUrls: [ARC_RPCS[0]] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /two RPC endpoints/);
});
