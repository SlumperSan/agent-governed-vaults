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
 * actual current state, `contracts/config/deployments/arc-mainnet.json` present since the Arc
 * mainnet deploy on 2026-09-24 — this row is green today, the opposite of the state this file
 * documented before that deploy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/** `eth_getBlockByNumber` resolver returning a chain timestamp — `checkStaleProposal` reads THIS,
 * never `Date.now()`, for "is a proposal past its reveal deadline". */
const blockHeaderResolver = (ts) => () => ({ timestamp: '0x' + BigInt(ts).toString(16) });

/**
 * `eth_call` resolver for the whole `checkStaleProposal` scan: dispatches on the selector rather
 * than the method (both `proposalCount()` and every `proposals(i)` are `eth_call`). Any pid not
 * named in `proposals` answers with a settled (Executed) tuple, so a test only has to say what is
 * DIFFERENT from "everything else is resolved and boring".
 * @param {{count:number, proposals?:Record<number, object|'ERROR'|'MALFORMED'>}} spec
 */
function governanceResolver({ count, proposals = {} }) {
  return (params) => {
    const data = params[0].data;
    if (data.startsWith('0xda35c664')) return '0x' + uintWord(count); // proposalCount()
    if (data.startsWith('0x013cf08b')) { // proposals(uint256)
      const pid = Number(BigInt('0x' + data.slice(10)));
      const spec = proposals[pid];
      if (spec === 'ERROR') return { __error: { message: `execution reverted (pid ${pid})` } };
      if (spec === 'MALFORMED') return '0x1234';
      return proposalTuple(spec ?? { status: 4 }); // default: Executed — settled, never stuck
    }
    throw new Error(`unexpected eth_call selector: ${data.slice(0, 10)}`);
  };
}

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
//
// PR #366's REJECT, and the point of every test below: the old version hardcoded `proposals(11)`
// and only cross-checked `activeProposalOf` inside the RED branch, so once #11 resolved, a NEW
// stuck proposal rendered green. `checkStaleProposal` now derives the pid range from
// `proposalCount()` and scans ALL of it, so there is no hardcoded id left to go stale.

test('Stale proposal: prior proposal resolved, a NEW proposal is Active past its reveal deadline — red, names the REAL stuck pid (the exact incident #366 was rejected over)', async () => {
  // Live numbers from the incident: proposal 11 Defeated, proposal 12 Active, revealDeadline
  // 1790042522, chain now 1790046852 (4,330s past deadline), zero reveals.
  const chainNow = 1790046852;
  const revealDeadline = 1790042522;
  const stuckVault = '0x3333333333333333333333333333333333333333';
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(chainNow),
    eth_call: governanceResolver({
      count: 12,
      proposals: {
        11: { status: 3 }, // Defeated — resolved, the OLD check's hardcoded id
        12: { status: 1, revealDeadline, vault: stuckVault }, // the actual stuck proposal
      },
    }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'red', 'a hardcoded-pid-11 check would have read proposal 11 (Defeated) and reported green here');
  assert.match(r.detail, /#12/);
  assert.match(r.detail, new RegExp(stuckVault, 'i'));
  assert.equal(r.remedy, `cast send ${GOVERNANCE_ADDR} "finalize(uint256)" 12 --rpc-url https://sepolia.base.org --account <account>`,
    'the remedy must name the pid that is ACTUALLY stuck, not 11');
});

test('Stale proposal: every proposal resolved — green', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: governanceResolver({ count: 3, proposals: { 1: { status: 2 }, 2: { status: 3 }, 3: { status: 5 } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'green');
  assert.equal(r.remedy, null);
});

test('Stale proposal: a healthy proposal — Active but still within its reveal window — does NOT trip the check: green, no remedy', async () => {
  const chainNow = 5000;
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(chainNow),
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline: chainNow + 3600 } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'green');
  assert.equal(r.remedy, null, 'offering finalize before the deadline would send the owner into a WrongPhase revert');
  assert.match(r.detail, /within its\/their reveal window/);
});

test('Stale proposal: Active exactly AT the reveal deadline (>=, matching finalize\'s own require) — red', async () => {
  const chainNow = 5000;
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(chainNow),
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline: chainNow } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'red');
});

test('Stale proposal: reads the CHAIN\'s clock, not this machine\'s wall clock', async () => {
  // revealDeadline is in the future by wall-clock time (Date.now()), so a Date.now()-based
  // predicate would call this "still within window" and report green. The chain's own block
  // timestamp is already past it, and Governance.finalize gates on block.timestamp, not wall time.
  const wallNow = Math.floor(Date.now() / 1000);
  const revealDeadline = wallNow + 100_000;
  const chainNow = revealDeadline + 500;
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(chainNow),
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'red', 'must judge the deadline against the chain\'s block.timestamp, not Date.now()');
});

test('Stale proposal: two DIFFERENT vaults each have a stuck proposal — red, both named, remedy names the lowest pid', async () => {
  const chainNow = 10_000;
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(chainNow),
    eth_call: governanceResolver({
      count: 5,
      proposals: {
        2: { status: 1, revealDeadline: chainNow - 10, vault: '0xaaaa000000000000000000000000000000aaaa' },
        4: { status: 1, revealDeadline: chainNow - 5, vault: '0xbbbb000000000000000000000000000000bbbb' },
      },
    }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'red');
  assert.match(r.detail, /#2/);
  assert.match(r.detail, /#4/);
  assert.match(r.remedy, /"finalize\(uint256\)" 2 /);
});

test('Stale proposal: proposalCount() is 0 — green, and no proposals(i) read is attempted', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: (params) => {
      if (params[0].data.startsWith('0xda35c664')) return '0x' + uintWord(0);
      throw new Error('must not read any proposals(i) when proposalCount() is 0');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'green');
});

test('Stale proposal: proposalCount() exceeds the scan cap — unknown, loudly, never a silent partial scan', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: (params) => {
      if (params[0].data.startsWith('0xda35c664')) return '0x' + uintWord(501);
      throw new Error('must not scan any proposal when proposalCount() is over the cap');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /501/);
});

test('Stale proposal: proposalCount() RPC error — unknown, not green', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: (params) => {
      if (params[0].data.startsWith('0xda35c664')) return { __error: { message: 'execution reverted' } };
      throw new Error('should not read proposals before proposalCount() succeeds');
    },
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Stale proposal: chain clock (eth_getBlockByNumber) RPC error — unknown, never falls back to wall clock', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: () => ({ __error: { message: 'block not found' } }),
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline: 1 } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Stale proposal: eth_getBlockByNumber returns no usable timestamp — unknown', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: () => ({ number: '0x1' }), // no timestamp field
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline: 1 } } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
});

test('Stale proposal: one proposals(i) read fails mid-scan — unknown, never a partial green that could be hiding a stuck one', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: governanceResolver({ count: 3, proposals: { 2: 'ERROR' } }),
  });
  const r = await checkStaleProposal(fetchImpl);
  assert.equal(r.state, 'unknown');
  assert.match(r.detail, /#2/);
});

test('Stale proposal: one proposals(i) tuple is short/malformed — unknown', async () => {
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: governanceResolver({ count: 1, proposals: { 1: 'MALFORMED' } }),
  });
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

test('Arc deployment: green — the deployment record exists', () => {
  const r = checkArcDeployment();
  assert.equal(r.state, 'green');
  assert.match(r.detail, /arc-mainnet\.json exists/);
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
  // (green, since the deployment record now exists) verdict even while every RPC-backed row is
  // unknown — the point this test makes is independence from the broken RPC, not a particular
  // state, so 'arc-deploy' is exempted from the blanket "no green" check below rather than the
  // check being dropped.
  assert.equal(byId['arc-deploy'].state, 'green');
  for (const r of rows) {
    if (r.id === 'arc-deploy') continue;
    assert.notEqual(r.state, 'green', 'no RPC-backed row may read green when every RPC call fails');
  }
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

test('runLaunchChecks: a row that THROWS (escapes its own try/catch) is reported under its REAL id, never the array index — PR #366 Product REJECT, reproduced with the live BigInt("0xzz") case', async () => {
  // A block header whose timestamp is a syntactically-string-but-malformed hex value passes
  // checkStaleProposal's `typeof !== 'string'` guard, then `BigInt('0xzz')` throws uncaught —
  // this is the exact live reproduction from the Product review, not a synthetic one.
  const fetchImpl = stubFetch({
    eth_getBlockByNumber: () => ({ timestamp: '0xzz' }),
    eth_call: governanceResolver({ count: 1, proposals: { 1: { status: 1, revealDeadline: 1 } } }),
  });
  const rows = await runLaunchChecks(fetchImpl);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId['proposal'], 'the thrown row must be reachable by its real id "proposal" — the client keys off this exact id');
  assert.equal(byId['proposal'].state, 'unknown');
  assert.match(byId['proposal'].detail, /check threw/);
  // The rejected shape used the array index (checkStaleProposal is settled index 1) as a fallback
  // id — assert that never happens, under any stringified index.
  for (let i = 0; i < rows.length; i++) assert.notEqual(byId[String(i)], rows[i], `row must not be reachable only by index ${i}`);
  assert.equal(byId['1'], undefined, 'must never fall back to the array index "1" as this row\'s id');
});

test('the fix is present in the shipped source — the fallback keys off the row\'s own descriptor, never the array index', () => {
  const src = readFileSync(new URL('../lib/launch-checks.mjs', import.meta.url), 'utf8');
  assert.match(src, /row\(CHECKS\[i\]\.id, CHECKS\[i\]\.name/,
    'the fallback must derive its id/name from CHECKS[i] (one descriptor, id+name+run bound together), not from the array index');
  assert.doesNotMatch(src, /row\(String\(i\)/, 'must not regress to the rejected String(i) fallback id');
  // Three separate parallel arrays (a call list, an ids list, a names list) is the same defect
  // one layer out: nothing stops them drifting apart under a reorder. Assert there is exactly one
  // ids-bearing array construct feeding runLaunchChecks, not three.
  assert.doesNotMatch(src, /const ids = \[/, 'must not reintroduce a separate ids array parallel to a separate names array');
});

test('runLaunchChecks: every fulfilled row\'s own id matches its CHECKS descriptor\'s id — a reorder of CHECKS cannot surface one row under a different row\'s name', async () => {
  const { checkArcDeployment } = await import('../lib/launch-checks.mjs');
  const fetchImpl = stubFetch({
    eth_getCode: () => '0x00',
    eth_chainId: () => '0x13b2',
    eth_getBlockByNumber: blockHeaderResolver(5000),
    eth_call: governanceResolver({ count: 0 }),
    eth_getBalance: () => '0x0',
  });
  const rows = await runLaunchChecks(fetchImpl);
  const expectedOrder = ['safe', 'proposal', 'balance', 'arc-deploy', 'member-surface'];
  assert.deepEqual(rows.map((r) => r.id), expectedOrder,
    'each settled row must report the id matching its position\'s own check, not a neighbour\'s');
});
