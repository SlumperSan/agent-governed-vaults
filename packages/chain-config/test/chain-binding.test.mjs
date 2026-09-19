// @ts-check
/**
 * #204 — a component that resolves an RPC by chain and never asks the RPC which chain it is.
 *
 * Two layers, and the second is the one that matters. The pure decision table is easy to get right
 * and easy to test; what this issue actually costs is the WIRING — whether the refusal reaches the
 * process, or is swallowed by a daemon whose read path is deliberately fault-tolerant.
 *
 * So the runner tests below stand up a real HTTP server answering `eth_chainId` with the WRONG id
 * and drive the real viem client through the real `buildIndexer` / `buildCanary` / `createChainReader`
 * path. No stubbing of the thing under test. A test that asserted "a warning was logged" would pass
 * with the defect present, because the defect IS that a warning is all you get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainBindingVerdict, assertChainBinding, ChainBindingError } from '../src/chain-binding.mjs';

// --- #293: enumerate createChainReader callers from the filesystem, never from a list ---------
//
// The hand-maintained version of this guard said "the three production call sites" in prose and
// checked exactly one of them (`run.mjs`) at the source level. PR 271 added a fourth —
// `scripts/soak/drill5-agent-execute.mjs` builds a `createChainReader` and never calls
// `assertBoundToDeclaredChain` on it — and CI stayed green, because nothing walked the filesystem
// to notice a caller the list did not name. A human caught it; no guard could.
//
// So this walks every `.mjs` source file (never a list) for a call to `createChainReader`, and for
// each one requires the SAME file to `await <thatVariable>.assertBoundToDeclaredChain(...)`
// somewhere after it. Test fixtures are excluded on purpose — they inject a `client` and close no
// gap (see the "an injected client is exempt" test below); it is the RPC-resolving production
// callers that must reach the assertion.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'lib', 'out', 'dist', 'dist-ssr', 'cache', 'broadcast',
  'coverage', 'artifacts',
]);

const relPath = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/** Strip comments so a mention of `createChainReader(` in prose cannot be mistaken for a call. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEFINITION_LINE = /^\s*(export\s+)?(async\s+)?function\s+createChainReader\b/;
const CALL_ASSIGN = /(?:^|[^.\w])(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*createChainReader\s*\(/;
const BARE_CALL = /(?:^|[^.\w])createChainReader\s*\(/;

/**
 * Every non-test `.mjs` file that CALLS `createChainReader`, enumerated by walking the repository
 * -- never read from `packages/chain-config/test/chain-binding.test.mjs`'s own former list, and
 * never read from this function's own past output, so a call site added today is covered today.
 * @returns {{file: string, varName: string|null}[]}
 */
function findChainReaderCallSites() {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mjs')) continue;
      if (entry.name.endsWith('.test.mjs')) continue; // test fixtures inject a client; see header
      if (relPath(full).split('/').includes('test')) continue; // e.g. packages/*/test/helpers.mjs
      const src = stripComments(readFileSync(full, 'utf8'));
      for (const line of src.split(/\r?\n/)) {
        if (DEFINITION_LINE.test(line)) continue; // the export itself, not a caller
        if (!BARE_CALL.test(line)) continue;
        const m = CALL_ASSIGN.exec(line);
        found.push({ file: relPath(full), varName: m ? m[1] : null });
      }
    }
  })(REPO_ROOT);
  return found;
}

test('#293: createChainReader callers are enumerated from the filesystem and every one reaches assertBoundToDeclaredChain', () => {
  const callSites = findChainReaderCallSites();

  // Refuse rather than pass over nothing: an enumeration that finds zero call sites means the walk
  // is broken (wrong root, wrong extension, an exclusion swallowing real files), not that the
  // codebase has no callers -- and a guard that reports green either way is the exact defect #293
  // is about. This repo has already shipped four guards shaped like that in one day.
  assert.ok(
    callSites.length > 0,
    'findChainReaderCallSites() found zero createChainReader call sites -- checked nothing. ' +
      'This is a broken guard, not a passing one: fix the walk before trusting this test again.',
  );

  const violations = [];
  for (const { file, varName } of callSites) {
    if (!varName) {
      // A call whose target this walk cannot name (e.g. chained off the return value with no
      // assignment) is unverifiable by this guard's method -- treated as a violation rather than
      // silently skipped, per the same rule: an unanalyzable call site must not pass by default.
      violations.push(`${file}: createChainReader(...) is called without a variable this guard can trace`);
      continue;
    }
    const src = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const boundRe = new RegExp(`await\\s+${esc(varName)}\\.assertBoundToDeclaredChain\\s*\\(`);
    if (!boundRe.test(src)) {
      violations.push(`${file}: builds "${varName}" via createChainReader(...) but never awaits ${varName}.assertBoundToDeclaredChain()`);
    }
  }

  assert.equal(
    violations.length,
    0,
    `chain binding is unenforceable at ${violations.length} call site(s):\n${violations.join('\n')}`,
  );
});

// --- the pure decision -----------------------------------------------------

test('matching ids bind', () => {
  const r = chainBindingVerdict({ declaredChainId: 8453, rpcChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, true);
  assert.match(r.message, /is chain 8453/);
});

test('a mismatch refuses and names BOTH numbers', () => {
  const r = chainBindingVerdict({ declaredChainId: 84532, rpcChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, false);
  assert.match(r.message, /WRONG CHAIN/);
  assert.match(r.message, /8453/);
  assert.match(r.message, /84532/);
});

test('an UNREADABLE chain id refuses exactly like a mismatch — "I could not tell" is not "they match"', () => {
  const r = chainBindingVerdict({ declaredChainId: 8453, rpcChainId: null, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, false, 'a read that did not answer must never satisfy the binding');
  assert.match(r.message, /UNPROVEN/);
});

test('a missing or nonsense declared id refuses rather than binding to nothing', () => {
  for (const declaredChainId of [undefined, 0, -1, 'base', NaN]) {
    const r = chainBindingVerdict({
      declaredChainId: /** @type {any} */ (declaredChainId),
      rpcChainId: 8453,
      rpc: 'http://x',
      declaredBy: 'CHAIN_ID',
    });
    assert.equal(r.ok, false, `declaredChainId ${JSON.stringify(declaredChainId)} must not bind`);
  }
});

test('assertChainBinding throws ChainBindingError, and a THROWING getChainId is unreadable not agreement', async () => {
  const boom = { getChainId: async () => { throw new Error('429 rate limited'); } };
  await assert.rejects(
    () => assertChainBinding({ client: boom, declaredChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' }),
    (err) => {
      assert.ok(err instanceof ChainBindingError, 'must be the distinct class daemons re-throw');
      assert.match(err.message, /UNPROVEN/);
      return true;
    },
  );
});

test('assertChainBinding resolves on a match', async () => {
  const ok = { getChainId: async () => 4663 };
  const r = await assertChainBinding({ client: ok, declaredChainId: 4663, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, true);
});

// --- the wiring, through real viem against a real socket -------------------

/**
 * A JSON-RPC endpoint that reports `chainId` and nothing else. Enough for `getChainId()`; any other
 * method returns an error, which is itself the assertion that nothing was read before the binding.
 * @param {number} chainId
 */
async function rpcServerReporting(chainId) {
  /** @type {string[]} */
  const methodsSeen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let id = 1;
      let method = '';
      try {
        const parsed = JSON.parse(body);
        id = parsed.id;
        method = parsed.method;
      } catch {
        /* fall through to the error response */
      }
      methodsSeen.push(method);
      res.setHeader('content-type', 'application/json');
      if (method === 'eth_chainId') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + chainId.toString(16) }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    methodsSeen,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test('the indexer REFUSES TO BUILD when the RPC answers for another chain', async () => {
  const rpc = await rpcServerReporting(8453); // Base mainnet
  try {
    const { buildIndexer } = await import('../../indexer/src/index-runner.mjs');
    await assert.rejects(
      () =>
        buildIndexer(
          {
            rpcUrl: rpc.url,
            chainId: 84532, // declared Base Sepolia — the whole defect in one line
            chainName: 'base-sepolia',
            addresses: {},
            configuredAdapters: [],
            startBlock: 0,
            statePath: 'no-such-state.json',
            confirmations: 5,
            batchBlocks: 2000,
            pollIntervalMs: 12_000,
          },
          { logger: { text: () => () => {}, warn: () => {}, info: () => {}, error: () => {} } },
        ),
      (err) => {
        assert.equal(err.name, 'ChainBindingError', `expected a ChainBindingError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /WRONG CHAIN/);
        return true;
      },
      'buildIndexer must reject — a warning that leaves the daemon polling the wrong chain is the bug, not the fix',
    );
    assert.ok(
      !rpc.methodsSeen.some((m) => m.startsWith('eth_getLogs')),
      'no logs may be fetched before the binding answers',
    );
  } finally {
    await rpc.close();
  }
});

test('the canary REFUSES TO BUILD when the RPC answers for another chain', async () => {
  const rpc = await rpcServerReporting(1); // Ethereum mainnet
  try {
    const { buildCanary } = await import('../../canary/src/canary-runner.mjs');
    await assert.rejects(
      () =>
        buildCanary(
          {
            rpcUrl: rpc.url,
            chainId: 8453,
            chainName: 'base',
            vaults: [],
            statePath: 'no-such-state.json',
            canaryStatePath: 'no-such-canary-state.json',
            pollIntervalMs: 30_000,
          },
          { log: () => {}, error: () => {}, logger: { text: () => () => {}, warn: () => {}, info: () => {}, error: () => {} } },
        ),
      (err) => {
        assert.equal(err.name, 'ChainBindingError', `expected a ChainBindingError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /WRONG CHAIN/);
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});

test('the reference agent REFUSES when --rpc answers for a chain other than --chain-id', async () => {
  const rpc = await rpcServerReporting(8453);
  try {
    const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
    const reader = createChainReader({ rpcUrl: rpc.url, chainId: 84532, chainName: 'base-sepolia' });
    await assert.rejects(
      () => reader.assertBoundToDeclaredChain(),
      (err) => {
        assert.equal(err.name, 'ChainBindingError');
        // The exact production trap: --rpc at one chain, --chain-id left at its 84532 default.
        assert.match(err.message, /reports chain id 8453/);
        assert.match(err.message, /declares chain 84532/);
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});

test('a MATCHING rpc binds and the reader keeps working — the refusal is not indiscriminate', async () => {
  const rpc = await rpcServerReporting(84532);
  try {
    const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
    const reader = createChainReader({ rpcUrl: rpc.url, chainId: 84532, chainName: 'base-sepolia' });
    const bound = await reader.assertBoundToDeclaredChain();
    assert.equal(bound.ok, true);
    assert.match(bound.message, /is chain 84532/);
  } finally {
    await rpc.close();
  }
});

// `buildIndexer` and `buildCanary` are proven above by being driven through a real socket; every
// `createChainReader` caller specifically (including `run.mjs`, whose --rpc branch cannot be
// entered without standing up the whole agent) is proven at the source level, but by the
// filesystem-enumerated guard above (#293) rather than a hardcoded file list here -- a method
// nothing calls is the same defect one level up, which is the lesson
// `scripts/test/test-wiring-truth.test.mjs` exists for, and a hand-maintained count of callers is
// the defect this file shipped with.

test('an injected client is exempt — it closes no declared-versus-actual gap, and tests rely on it', async () => {
  const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
  // No rpcUrl, no getChainId: nothing here resolved an RPC by chain, so there is nothing to bind.
  const reader = createChainReader({ client: { readContract: async () => 0n }, chainId: 84532 });
  const r = await reader.assertBoundToDeclaredChain();
  assert.equal(r.ok, true);
  assert.match(r.message, /client injected/);
});
