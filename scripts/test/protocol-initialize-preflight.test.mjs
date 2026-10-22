/**
 * The factory-initialisation preflight (`scripts/lib/protocol-initialize-preflight.mjs`) against a fake
 * chain: an in-memory JSON-RPC node that answers `eth_chainId`, `eth_getCode`, `eth_call` and
 * `eth_getLogs` the way a real `VaultFactory` would, and can be put into each of the states a bad
 * initialisation leaves behind. The CLI is then driven end to end against two real local HTTP
 * endpoints speaking the same fake chain.
 *
 * Fixtures share nothing with the code under test except the ABI: selectors and the event topic are
 * written out here as literals, not imported, so a wrong selector in the library cannot also be wrong
 * in the fixture.
 *
 * Each negative case below is a defect the preflight exists to refuse. Mutation probes (delete the
 * check, confirm the named test goes red) are recorded in the findings note for the PR that added this.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters } from 'viem';
import { checkChain, checkPlan, parseAddressWord, parseBool } from '../lib/protocol-initialize-preflight.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Written out, not imported (see the header).
const SEL_INITIALIZED = '0x158ef93e';
const SEL_ENFORCED = '0x1330525a';
const SEL_IS_ALLOWED = '0x785d97a8';
const SEL_AGENT_PATH = '0x45e06dfc';
const SEL_AGENT_REGISTRY = '0x0d1cfcae';
const SEL_AGENT_DEPLOYER = '0x79bb13e4';
const TOPIC = '0xe58d4b3592c74e580b584cc31679cad3eefea91577f47aabd1764352d4b4901b';

const FACTORY = '0xab00000000000000000000000000000000000001';
const ORACLE_A = '0x1100000000000000000000000000000000000001';
const ORACLE_B = '0x2200000000000000000000000000000000000002';
const FAKE_ORACLE = '0x6666000000000000000000000000000000000666';
const AGENT_REGISTRY = '0x3300000000000000000000000000000000000003';
const OTHER_REGISTRY = '0x4400000000000000000000000000000000000004';
const AGENT_DEPLOYER = '0x5500000000000000000000000000000000000005';
const MANIFEST = { contracts: { VaultFactory: { address: FACTORY }, AgentVaultDeployer: { address: AGENT_DEPLOYER } } };

const word = (b) => `0x${'0'.repeat(63)}${b ? 1 : 0}`;
const listData = (addrs) => encodeAbiParameters([{ type: 'address[]' }], [addrs]);
const addrWord = (a) => `0x${'0'.repeat(24)}${a.toLowerCase().replace(/^0x/, '')}`;

/** A healthy chain: factory deployed and initialised with [ORACLE_A, ORACLE_B], both with code, and the agent path pinned. */
function healthy(over = {}) {
  return {
    chainId: 8453,
    code: new Set([FACTORY.toLowerCase(), ORACLE_A, ORACLE_B, AGENT_REGISTRY, AGENT_DEPLOYER]),
    initialized: true,
    agentPath: true,
    agentRegistry: AGENT_REGISTRY,
    agentDeployer: AGENT_DEPLOYER,
    enforced: true,
    allowed: new Set([ORACLE_A, ORACLE_B]),
    logs: [{ data: listData([ORACLE_A, ORACLE_B]) }],
    broken: new Set(), // RPC methods that answer with an error
    ...over,
  };
}

/** @param {ReturnType<typeof healthy>} s the JSON-RPC handler for one chain state */
function rpc(s, method, params) {
  if (s.broken.has(method)) return { error: { message: `${method} unavailable` } };
  switch (method) {
    case 'eth_chainId':
      return { result: `0x${s.chainId.toString(16)}` };
    case 'eth_getCode':
      return { result: s.code.has(params[0].toLowerCase()) ? '0x6001' : '0x' };
    case 'eth_getLogs':
      assert.equal(params[0].address.toLowerCase(), FACTORY.toLowerCase());
      assert.deepEqual(params[0].topics, [TOPIC]);
      return { result: s.logs };
    case 'eth_call': {
      const { to, data } = params[0];
      assert.equal(to.toLowerCase(), FACTORY.toLowerCase(), 'every call must go to the manifest factory');
      if (data === SEL_INITIALIZED) return { result: word(s.initialized) };
      if (data === SEL_ENFORCED) return { result: word(s.enforced) };
      if (data === SEL_AGENT_PATH) return { result: word(s.agentPath) };
      if (data === SEL_AGENT_REGISTRY) return { result: addrWord(s.agentRegistry) };
      if (data === SEL_AGENT_DEPLOYER) return { result: addrWord(s.agentDeployer) };
      if (data.startsWith(SEL_IS_ALLOWED)) {
        const arg = `0x${data.slice(SEL_IS_ALLOWED.length + 24)}`.toLowerCase();
        return { result: word(s.allowed.has(arg)) };
      }
      return { error: { message: `unexpected selector ${data}` } };
    }
    default:
      return { error: { message: `unexpected method ${method}` } };
  }
}

/** A fetch that serves several fake chains by URL. @param {Record<string, ReturnType<typeof healthy>>} byUrl */
const fakeFetch = (byUrl) => async (url, init) => {
  const state = byUrl[url];
  if (!state) throw new Error(`ECONNREFUSED ${url}`);
  const { method, params } = JSON.parse(init.body);
  const out = rpc(state, method, params);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, ...out }) };
};

const URL_1 = 'http://rpc-one.test';
const URL_2 = 'http://rpc-two.test';
const PLAN = (over = {}) => ({ chainId: 8453, rpcs: [URL_1, URL_2], oracles: [ORACLE_A, ORACLE_B], agentRegistry: AGENT_REGISTRY, ...over });
const run = (states, planOver) =>
  checkChain({ fetchImpl: fakeFetch({ [URL_1]: states[0], [URL_2]: states[1] ?? states[0] }), name: 'base', plan: PLAN(planOver), factory: FACTORY, agentVaultDeployer: AGENT_DEPLOYER });

test('a factory initialised exactly as planned passes on every endpoint', async () => {
  assert.deepEqual(await run([healthy()]), []);
});

test('an uninitialised factory fails, even with the allowlist flag and mapping set', async () => {
  const p = await run([healthy({ initialized: false })]);
  assert.ok(p.some((m) => /initialized\(\) is false, expected true/.test(m)), p.join('\n'));
});

test('an initialisation with an EMPTY list (C-6 off for good) fails on enforcement, on the oracle and on the event', async () => {
  const empty = healthy({ enforced: false, allowed: new Set(), logs: [{ data: listData([]) }] });
  const p = await run([empty]);
  assert.ok(p.some((m) => /oracleAllowlistEnforced\(\) is false/.test(m)), p.join('\n'));
  assert.ok(p.some((m) => /isAllowedOracle\(.*\) is false/.test(m)), p.join('\n'));
  assert.ok(p.some((m) => /missing from the Initialized event/.test(m)), p.join('\n'));
});

test('a planned oracle that is not allowed fails, naming it', async () => {
  const p = await run([healthy({ allowed: new Set([ORACLE_A]) })]);
  assert.ok(p.some((m) => m.includes(`isAllowedOracle(${ORACLE_B}) is false`)), p.join('\n'));
});

test('an extra, unplanned oracle blessed at initialisation fails, though every planned one reads allowed', async () => {
  const bad = healthy({
    allowed: new Set([ORACLE_A, ORACLE_B, FAKE_ORACLE]),
    logs: [{ data: listData([ORACLE_A, ORACLE_B, FAKE_ORACLE]) }],
  });
  const p = await run([bad]);
  assert.ok(p.some((m) => m.includes(`blessing ${FAKE_ORACLE}`)), p.join('\n'));
  assert.ok(p.every((m) => !/isAllowedOracle\(/.test(m)), 'the per-oracle reads alone would have passed; only the event catches this');
});

test('a planned oracle with no code on the chain fails', async () => {
  const s = healthy();
  s.code.delete(ORACLE_B);
  const p = await run([s]);
  assert.ok(p.some((m) => m.includes(`oracle ${ORACLE_B} carries no code`)), p.join('\n'));
});

test('nothing at the manifest factory address fails: an address with no code behind it is not an initialised factory', async () => {
  const s = healthy();
  s.code.delete(FACTORY.toLowerCase());
  const p = await run([s]);
  assert.ok(p.some((m) => /no code at the manifest's VaultFactory/.test(m)), p.join('\n'));
});

test('an endpoint on the wrong chain fails', async () => {
  const p = await run([healthy(), healthy({ chainId: 1 })]);
  assert.ok(p.some((m) => m.includes(URL_2) && /eth_chainId is 0x1/.test(m)), p.join('\n'));
});

test('one endpoint that disagrees fails the chain even though the other is clean', async () => {
  const p = await run([healthy(), healthy({ enforced: false })]);
  assert.equal(p.filter((m) => m.includes(URL_1)).length, 0);
  assert.ok(p.some((m) => m.includes(URL_2) && /oracleAllowlistEnforced/.test(m)), p.join('\n'));
});

test('a read that fails is a failure, never a skip', async () => {
  for (const method of ['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getLogs']) {
    const p = await run([healthy({ broken: new Set([method]) })]);
    assert.ok(p.length > 0, `${method} unavailable must not pass`);
  }
  // an endpoint that is simply unreachable
  const p = await checkChain({ fetchImpl: fakeFetch({ [URL_1]: healthy() }), name: 'base', plan: PLAN(), factory: FACTORY, agentVaultDeployer: AGENT_DEPLOYER });
  assert.ok(p.some((m) => m.includes(URL_2) && /could not read eth_chainId/.test(m)), p.join('\n'));
});

test('zero or two Initialized events fail', async () => {
  const none = await run([healthy({ logs: [] })]);
  assert.ok(none.some((m) => /exactly one Initialized event/.test(m)), none.join('\n'));
  const two = await run([healthy({ logs: [{ data: listData([ORACLE_A, ORACLE_B]) }, { data: listData([ORACLE_A, ORACLE_B]) }] })]);
  assert.ok(two.some((m) => /exactly one Initialized event/.test(m)), two.join('\n'));
});

test('a malformed bool is not read as true', async () => {
  assert.equal(parseBool(word(true)), true);
  assert.equal(parseBool(word(false)), false);
  for (const bad of ['0x', '0x01', `0x${'0'.repeat(62)}02`, `0x${'f'.repeat(64)}`, undefined, 1]) {
    assert.equal(parseBool(bad), null, String(bad));
  }
});

test('plan shape: an empty oracle list, one endpoint, a bad or duplicate oracle are all refused before any call', async () => {
  const never = async () => assert.fail('no network call may happen for a bad plan');
  for (const [over, re] of [
    [{ oracles: [] }, /oracles is empty/],
    [{ rpcs: [URL_1] }, /at least two distinct endpoints/],
    [{ rpcs: [URL_1, URL_1] }, /at least two distinct endpoints/],
    [{ oracles: ['0x1234'] }, /is not an address/],
    [{ oracles: [ORACLE_A, ORACLE_A.toUpperCase().replace('0X', '0x')] }, /listed twice/],
    [{ oracles: ['0x0000000000000000000000000000000000000000'] }, /zero address/],
    [{ chainId: 0 }, /chainId/],
    [{ agentRegistry: undefined }, /agentRegistry must be/],
    [{ agentRegistry: '0x1234' }, /agentRegistry must be/],
    [{ agentRegistry: '0x0000000000000000000000000000000000000000' }, /zero address is not an agent registry/],
  ]) {
    const p = await checkChain({ fetchImpl: never, name: 'x', plan: PLAN(over), factory: FACTORY, agentVaultDeployer: AGENT_DEPLOYER });
    assert.ok(p.some((m) => re.test(m)), `${JSON.stringify(over)} -> ${p.join('|')}`);
  }
});

test('an agent path that was never initialised fails', async () => {
  const p = await run([healthy({ agentPath: false })]);
  assert.ok(p.some((m) => /agentPathInitialized\(\) is false, expected true/.test(m)), p.join('\n'));
});

test('a factory that pinned a different agent registry than the plan fails, even though it carries code', async () => {
  const s = healthy({ agentRegistry: OTHER_REGISTRY });
  s.code.add(OTHER_REGISTRY);
  const p = await run([s]);
  assert.ok(p.some((m) => m.includes(`agentRegistry() is ${OTHER_REGISTRY}, expected ${AGENT_REGISTRY}`)), p.join('\n'));
});

test('a factory that pinned a different agent deployer than the manifest names fails', async () => {
  const other = '0x6600000000000000000000000000000000000006';
  const s = healthy({ agentDeployer: other });
  s.code.add(other);
  const p = await run([s]);
  assert.ok(p.some((m) => m.includes(`agentVaultDeployer() is ${other}, expected ${AGENT_DEPLOYER}`)), p.join('\n'));
});

test('a pinned agent registry or deployer with no code on the chain fails', async () => {
  const noReg = healthy();
  noReg.code.delete(AGENT_REGISTRY);
  assert.ok((await run([noReg])).some((m) => m.includes(`${AGENT_REGISTRY} carries no code`)));
  const noDep = healthy();
  noDep.code.delete(AGENT_DEPLOYER);
  assert.ok((await run([noDep])).some((m) => m.includes(`${AGENT_DEPLOYER} carries no code`)));
});

test('an agent registry word that is not a clean address is not read as one', () => {
  assert.equal(parseAddressWord(addrWord(AGENT_REGISTRY)), AGENT_REGISTRY);
  for (const bad of ['0x', `0x${'1'.repeat(64)}`, `0x${'0'.repeat(63)}`, undefined, 7]) {
    assert.equal(parseAddressWord(bad), null, String(bad));
  }
});

test('checkPlan: no chain, an unknown --chain and a manifest without a factory all fail', async () => {
  const f = fakeFetch({});
  assert.equal((await checkPlan({ fetchImpl: f, plan: { chains: {} }, manifest: MANIFEST })).ok, false);
  // A healthy chain is reachable, so a pass here could only come from checking a different chain than asked for.
  const live = fakeFetch({ [URL_1]: healthy(), [URL_2]: healthy() });
  assert.equal((await checkPlan({ fetchImpl: live, plan: { chains: { base: PLAN() } }, manifest: MANIFEST })).ok, true);
  const unknown = await checkPlan({ fetchImpl: live, plan: { chains: { base: PLAN() } }, manifest: MANIFEST, only: 'nope' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.problems.join(' | '), /nope: no plan entry/);
  assert.equal((await checkPlan({ fetchImpl: f, plan: { chains: { base: PLAN() } }, manifest: {} })).ok, false);
  // A manifest that names the factory but not the agent deployer cannot judge the agent path: a refusal, not a skip.
  const noAgent = await checkPlan({ fetchImpl: live, plan: { chains: { base: PLAN() } }, manifest: { contracts: { VaultFactory: { address: FACTORY } } } });
  assert.equal(noAgent.ok, false);
  assert.match(noAgent.problems.join(' | '), /no AgentVaultDeployer address/);
});

test('checkPlan: every chain is judged, one bad chain fails the plan', async () => {
  const f = fakeFetch({ [URL_1]: healthy(), [URL_2]: healthy(), 'http://op-1.test': healthy({ chainId: 10, enforced: false }), 'http://op-2.test': healthy({ chainId: 10, enforced: false }) });
  const plan = { chains: { base: PLAN(), op: PLAN({ chainId: 10, rpcs: ['http://op-1.test', 'http://op-2.test'] }) } };
  const res = await checkPlan({ fetchImpl: f, plan, manifest: MANIFEST });
  assert.equal(res.ok, false);
  assert.ok(res.problems.every((m) => m.startsWith('op @')), res.problems.join('\n'));
  const only = await checkPlan({ fetchImpl: f, plan, manifest: MANIFEST, only: 'base' });
  assert.equal(only.ok, true);
});

// ---- the CLI, against two real local endpoints ------------------------------------------------

const serve = (state) =>
  new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { method, params } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...rpc(state, method, params) }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

const cli = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'scripts', 'protocol-initialize-preflight.mjs'), ...args], { timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });

test('CLI: exit 0 on a healthy fake chain, exit 1 on a wrongly initialised one, exit 1 with no plan', async () => {
  const good = await serve(healthy());
  const bad = await serve(healthy({ enforced: false }));
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'init-preflight-'));
    const manifest = path.join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify(MANIFEST));
    const u = (s) => `http://127.0.0.1:${s.address().port}`;
    const planFile = (name, rpcs) => {
      const f = path.join(dir, name);
      writeFileSync(f, JSON.stringify({ chains: { base: PLAN({ rpcs }) } }));
      return f;
    };
    const ok = await cli(['--plan', planFile('ok.json', [u(good), `${u(good)}/`]), '--manifest', manifest]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /preflight ok: 1 chain\(s\)/);
    const ko = await cli(['--plan', planFile('ko.json', [u(good), u(bad)]), '--manifest', manifest]);
    assert.equal(ko.code, 1);
    assert.match(ko.stderr, /oracleAllowlistEnforced\(\) is false/);
    assert.match(ko.stderr, /new salt/);
    const none = await cli([]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /--plan/);
  } finally {
    good.close();
    bad.close();
  }
});

test('the real manifest names a VaultFactory and an AgentVaultDeployer the preflight will query', () => {
  const m = JSON.parse(readFileSync(path.join(REPO, 'contracts', 'config', 'create2-manifest.json'), 'utf8'));
  assert.match(m.contracts.VaultFactory.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(m.contracts.AgentVaultDeployer.address, /^0x[0-9a-fA-F]{40}$/);
});
