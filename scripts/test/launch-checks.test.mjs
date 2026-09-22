// @ts-check
/**
 * Tests for `scripts/lib/launch-checks.mjs`, the dashboard's read-only "Launch checks" panel.
 *
 * THE CENTRAL RULE UNDER TEST, repeated because it is the reason this file exists: a check whose
 * RPC errors, times out, or returns something malformed must render 'unknown', NEVER 'green' and
 * never silently fall through to a stale prior state. Every RPC-backed row gets its own
 * error/timeout/malformed case below, alongside its happy-path green case, so a future edit that
 * adds a fall-through cannot pass this file by accident.
 *
 * `fetch` is stubbed per test — nothing here makes a real network call. `checkArcDeployment` reads
 * real files from the checked-out repo (no network, no injection point): it asserts against the
 * actual current state, `contracts/config/deployments/arc-mainnet.json` absent, which is itself
 * the fact issue this row exists to surface — see `contracts/config/arc-mainnet.json`'s own
 * `status` field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCreatorSafe, checkStaleProposal, checkDeployerBalance, checkArcDeployment, checkMemberSurface,
  runLaunchChecks,
} from '../lib/launch-checks.mjs';

const SAFE_ADDR = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
const GOVERNANCE_ADDR = '0xD963f553e3eCd1872aF1622b3e4664f133A51805';

const addrWord = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const bytes32Word = (b) => (b ?? '').replace('0x', '').padEnd(64, '0').slice(0, 64);

/** Build a `proposals(uint256)` return blob in the exact field order `P` expects. */
function proposalTuple({
  vault = '0x1111111111111111111111111111111111111111',
  ptype = 0, proposer = '0x2222222222222222222222222222222222222222',
  createdAt = 1000, commitDeadline = 2000, revealDeadline = 3000, executableAt = 3001, expiresAt = 90000,
  status = 1, // Active
  actionHash = '0x' + 'ab'.repeat(32),
  snapshotTotal = 1000, memberCount = 3, forWeight = 0, againstWeight = 0, revealedWeight = 0, revealedVoterCount = 0,
} = {}) {
  return '0x' + [
    addrWord(vault), uintWord(ptype), addrWord(proposer), uintWord(createdAt), uintWord(commitDeadline),
    uintWord(revealDeadline), uintWord(executableAt), uintWord(expiresAt), uintWord(status),
    bytes32Word(actionHash), uintWord(snapshotTotal), uintWord(memberCount), uintWord(forWeight),
    uintWord(againstWeight), uintWord(revealedWeight), uintWord(revealedVoterCount),
  ].join('');
}

/**
 * A `fetch` stub keyed on JSON-RPC `method`. `resolvers[method]` returns a JSON-RPC `result`
 * value, or `{__error:{message}}` for an RPC-level error object, or throws to simulate a network
 * failure/timeout, or returns `{__httpError:502}` for a non-2xx response. Handles both single
 * requests and batch (array) requests the way a real endpoint would.
 * @param {Record<string, (params:any[])=>any>} resolvers
 */
function stubFetch(resolvers, { httpBody = null } = {}) {
  const answerOne = (req) => {
    if (!(req.method in resolvers)) {
      return { jsonrpc: '2.0', id: req.id, error: { message: `stub has no resolver for ${req.method}` } };
    }
    const out = resolvers[req.method](req.params);
    if (out && out.__error) return { jsonrpc: '2.0', id: req.id, error: out.__error };
    return { jsonrpc: '2.0', id: req.id, result: out };
  };
  return async (_url, init) => {
    const parsed = JSON.parse(init.body);
    const body = Array.isArray(parsed) ? parsed.map(answerOne) : answerOne(parsed);
    return {
      ok: httpBody?.status ? false : true,
      status: httpBody?.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const throwingFetch = async () => { throw new Error('ECONNREFUSED (simulated)'); };
const httpErrorFetch = (status) => async () => ({ ok: false, status, json: async () => ({}), text: async () => '' });
const malformedJsonFetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); }, text: async () => 'not json' });

// ───────────────────────────────────── row 1 — Creator Safe ──────────────────────────────────

test('Creator Safe: code present, matching chain id, threshold decoded — green', async () => {
  const fetchImpl = stubFetch({
    eth_getCode: () => '0x6080604052',
    eth_chainId: () => '0x13b2',
    eth_call: () => '0x' + uintWord(2), // threshold 2-of-N
  });
  const r = await checkCreatorSafe(fetchImpl);
  assert.equal(r.state, 'green');
  assert.match(r.detail, /2-of-N/);
});

test('Creator Safe: threshold 1-of-1 is informational, still green, not red', async () => {
  const fetchImpl = stubFetch({
    eth_getCode: () => '0x6080604052',
    eth_chainId: () => '0x13b2',
    eth_call: () => '0x' + uintWord(1),
  });
  const r = await checkCreatorSafe(fetchImpl);
  assert.equal(r.state, 'green');
  assert.match(r.detail, /1-of-1 \(informational, not a failure\)/);
});

test('Creator Safe: right code but WRONG chain id — red, never green, names the mismatch', async () => {
  const fetchImpl = stubFetch({
    eth_getCode: () => '0x6080604052',
    eth_chainId: () => '0x2105', // some other chain
    eth_call: () => '0x' + uintWord(1),
  });
  const r = await checkCreatorSafe(fetchImpl);
  assert.equal(r.state, 'red');
  assert.match(r.detail, /0x2105/);
  assert.match(r.detail, /wrong chain|not Arc mainnet/i);
});

test('Creator Safe: no code at the address — red', async () => {
  const fetchImpl = stubFetch({
    eth_getCode: () => '0x',
    eth_chainId: () => '0x13b2',
    eth_call: () => '0x' + uintWord(1),
  });
  const r = await checkCreatorSafe(fetchImpl);
  assert.equal(r.state, 'red');
  assert.match(r.detail, /no code/);
});

test('Creator Safe: RPC unreachable — unknown, not red and not green', async () => {
  const r = await checkCreatorSafe(throwingFetch);
  assert.equal(r.state, 'unknown');
});

test('Creator Safe: RPC times out (rejects like AbortError) — unknown', async () => {
  const timeoutFetch = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  const r = await checkCreatorSafe(timeoutFetch);
  assert.equal(r.state, 'unknown');
});

test('Creator Safe: HTTP 500 — unknown', async () => {
  const r = await checkCreatorSafe(httpErrorFetch(500));
  assert.equal(r.state, 'unknown');
});

test('Creator Safe: malformed (non-JSON) response body — unknown', async () => {
  const r = await checkCreatorSafe(malformedJsonFetch);
  assert.equal(r.state, 'unknown');
});

test('Creator Safe: JSON-RPC error object on eth_getCode — unknown', async () => {
  const fetchImpl = stubFetch({
    eth_getCode: () => ({ __error: { message: 'header not found' } }),
    eth_chainId: () => '0x13b2',
    eth_call: () => '0x' + uintWord(1),
  });
  const r = await checkCreatorSafe(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Creator Safe reads eth_getCode against SAFE_ADDR and eth_chainId on the same call set', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const reqs = JSON.parse(init.body);
    for (const r of Array.isArray(reqs) ? reqs : [reqs]) seen.push(r.method);
    return stubFetch({ eth_getCode: () => '0x6080', eth_chainId: () => '0x13b2', eth_call: () => '0x' + uintWord(1) })(url, init);
  };
  await checkCreatorSafe(fetchImpl);
  assert.ok(seen.includes('eth_getCode') && seen.includes('eth_chainId'), 'both reads must be sent, on one connection');
});

// ───────────────────────── row 2 — stale governance proposal ─────────────────────────────────

test('Stale proposal: Active and past its reveal deadline — red, offers the exact finalize command', async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const fetchImpl = stubFetch({
    eth_call: (params) => {
      const data = params[0].data;
      if (data.startsWith('0x013cf08b')) return proposalTuple({ status: 1, revealDeadline: past });
      if (data.startsWith('0xdce22376')) return '0x' + uintWord(11);
      throw new Error('unexpected selector');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'red');
  assert.ok(r.remedy, 'a red past-deadline row must carry a remedy');
  assert.equal(r.remedy, `cast send ${GOVERNANCE_ADDR} "finalize(uint256)" 11 --rpc-url https://sepolia.base.org --account <account>`);
});

test('Stale proposal: Active but still within its reveal window — green, NO remedy offered (would revert WrongPhase)', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const fetchImpl = stubFetch({
    eth_call: (params) => {
      const data = params[0].data;
      if (data.startsWith('0x013cf08b')) return proposalTuple({ status: 1, revealDeadline: future });
      throw new Error('unexpected selector — activeProposalOf should not be read before a deadline verdict');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'green');
  assert.equal(r.remedy, null, 'offering finalize before the deadline would send the owner into a WrongPhase revert');
});

test('Stale proposal: status Passed (not Active) — green', async () => {
  const fetchImpl = stubFetch({
    eth_call: (params) => {
      if (params[0].data.startsWith('0x013cf08b')) return proposalTuple({ status: 2 });
      throw new Error('unexpected call');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'green');
  assert.equal(r.remedy, null);
});

test('Stale proposal: RPC error on proposals() — unknown, not green', async () => {
  const fetchImpl = stubFetch({ eth_call: () => ({ __error: { message: 'execution reverted' } }) });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Stale proposal: short/malformed tuple — unknown', async () => {
  const fetchImpl = stubFetch({ eth_call: () => '0x1234' });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Stale proposal: RPC unreachable — unknown', async () => {
  const r = await checkStaleProposal(throwingFetch);
  assert.equal(r.state, 'unknown');
});

// ───────────────────────────── row 3 — deployer balance margin ───────────────────────────────

test('Deployer balance: comfortable margin (>= ~2 USDC over the plan minimum) — green', async () => {
  const fetchImpl = stubFetch({
    eth_call: () => '0x' + uintWord(20_000_000), // 20.00 USDC, well above the 13 USDC plan
    eth_getBalance: () => '0x' + (500000000000000000n).toString(16), // 0.5 ETH
  });
  const r = await checkDeployerBalance(fetchImpl);
  assert.equal(r.state, 'green');
});

test('Deployer balance: thin margin (< ~2 USDC over minimum) — amber, not green', async () => {
  const fetchImpl = stubFetch({
    eth_call: () => '0x' + uintWord(13_500_000), // 13.50 USDC, 0.50 over a 13.00 minimum
    eth_getBalance: () => '0x' + (500000000000000000n).toString(16),
  });
  const r = await checkDeployerBalance(fetchImpl);
  assert.equal(r.state, 'amber');
});

test('Deployer balance: below the plan minimum — red', async () => {
  const fetchImpl = stubFetch({
    eth_call: () => '0x' + uintWord(5_000_000), // 5.00 USDC, below the 13 USDC plan
    eth_getBalance: () => '0x' + (500000000000000000n).toString(16),
  });
  const r = await checkDeployerBalance(fetchImpl);
  assert.equal(r.state, 'red');
});

test('Deployer balance: RPC unreachable — unknown, never green', async () => {
  const r = await checkDeployerBalance(throwingFetch);
  assert.equal(r.state, 'unknown');
});

test('Deployer balance: RPC error object on balanceOf — unknown', async () => {
  const fetchImpl = stubFetch({ eth_call: () => ({ __error: { message: 'revert' } }) });
  const r = await checkDeployerBalance(fetchImpl);
  assert.equal(r.state, 'unknown');
});

// ─────────────────────────────────── row 4 — Arc deployment ──────────────────────────────────

test('Arc deployment: red today — the deployment record does not exist, and the config status is quoted', () => {
  const r = checkArcDeployment();
  assert.equal(r.state, 'red');
  assert.match(r.detail, /arc-mainnet\.json does not exist/);
  assert.match(r.detail, /Nothing from this repository exists on chain 5042/, 'must quote the real status field verbatim');
});

// ────────────────────────────── row 5 — member surface in production ─────────────────────────

test('Member surface: app.rwally.com serving vaults-ui — green', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('app.rwally.com')) return { ok: true, text: async () => '<title>Vault Atlas</title>' };
    return { ok: true, text: async () => '<title>RWAlly</title>' };
  };
  const r = await checkMemberSurface(fetchImpl);
  assert.equal(r.state, 'green');
});

test('Member surface: app.rwally.com still serving the retiring apps/app — amber, not red', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('app.rwally.com')) return { ok: true, text: async () => '<title>App | RWAlly</title>' };
    return { ok: true, text: async () => '<title>RWAlly</title>' };
  };
  const r = await checkMemberSurface(fetchImpl);
  assert.equal(r.state, 'amber');
});

test('Member surface: app.rwally.com unreachable — unknown, never green', async () => {
  const r = await checkMemberSurface(throwingFetch);
  assert.equal(r.state, 'unknown');
});

test('Member surface: HTTP error fetching app.rwally.com — unknown', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('app.rwally.com')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, text: async () => '' };
  };
  const r = await checkMemberSurface(fetchImpl);
  assert.equal(r.state, 'unknown');
});

// ──────────────────────────────────────── the panel as a whole ───────────────────────────────

test('runLaunchChecks: an unreachable RPC yields unknown rows, never a false green, across the whole panel', async () => {
  const rows = await runLaunchChecks(throwingFetch);
  assert.equal(rows.length, 5);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['safe'].state, 'unknown');
  assert.equal(byId['proposal'].state, 'unknown');
  assert.equal(byId['balance'].state, 'unknown');
  assert.equal(byId['member-surface'].state, 'unknown');
  // Arc deployment is a file read with no network dependency, so it still resolves to its real
  // (red) verdict even while every RPC-backed row is unknown.
  assert.equal(byId['arc-deploy'].state, 'red');
  for (const r of rows) assert.notEqual(r.state, 'green', 'no row may read green when every RPC call fails');
});

test('every row is a well-formed object regardless of outcome', async () => {
  const rows = await runLaunchChecks(throwingFetch);
  for (const r of rows) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.name, 'string');
    assert.ok(['green', 'amber', 'red', 'unknown'].includes(r.state));
    assert.equal(typeof r.detail, 'string');
    assert.ok(r.remedy === null || typeof r.remedy === 'string');
  }
});
