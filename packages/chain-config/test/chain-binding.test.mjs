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
import { chainBindingVerdict, assertChainBinding, ChainBindingError } from '../src/chain-binding.mjs';

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

// The FOUR production call sites. `buildIndexer` and `buildCanary` are proven above by being
// driven; `run.mjs` and the x402 edge route are asserted at the source level instead -- the first
// is a CLI whose rpcUrl branch cannot be entered without standing up the whole agent, the second
// resolves its RPC inside a Cloudflare Worker handler. A method nothing calls is the same defect
// one level up -- which is the lesson `scripts/test/test-wiring-truth.test.mjs` exists for.
//
// This census was THREE until the x402 live-read route was reviewed, and that is exactly how the
// fourth site shipped unbound: the list was the invariant, and a list nobody extends is a list that
// silently narrows every time the codebase grows. Adding a `createChainReader({rpcUrl: ...})` call
// site without adding it here is the defect, not the oversight. Note this census is still a hand-
// maintained enumeration -- nothing walks the tree for `createChainReader` callers, so a fifth site
// added tomorrow is invisible to it until someone edits this comment.
test('reference-agent run.mjs actually CALLS the binding in its --rpc branch', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../reference-agent/src/run.mjs', import.meta.url), 'utf8')
    // Strip comments so a mention of the call in prose cannot satisfy this.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    src,
    /await\s+chainReader\.assertBoundToDeclaredChain\(\)/,
    'run.mjs must await the binding before reading addresses through --rpc',
  );
});

test('the x402 edge route actually CALLS the binding before it reads any vault', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../../../apps/site-next/functions/api/vaults.js', import.meta.url),
    'utf8',
  )
    // Strip comments so a mention of the call in prose cannot satisfy this. That file argues at
    // length about WHY it binds; the argument is not the call.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    src,
    /await\s+reader\.assertBoundToDeclaredChain\(\)/,
    'vaults.js must await the binding — it resolves DATA_RPC_URL by chain id and then sells what it reads',
  );
  // ORDER, not just presence: a binding that runs after `readVaultsAtHead` has proven nothing about
  // the addresses already read. Asserted on source position because the route's own behavioural
  // proof lives in `apps/site-next/test/x402-edge.test.mjs`, which this package does not run.
  assert.ok(
    src.indexOf('assertBoundToDeclaredChain') < src.indexOf('readVaultsAtHead(reader'),
    'the binding must precede the vault read, not follow it',
  );
});

test('an injected client is exempt — it closes no declared-versus-actual gap, and tests rely on it', async () => {
  const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
  // No rpcUrl, no getChainId: nothing here resolved an RPC by chain, so there is nothing to bind.
  const reader = createChainReader({ client: { readContract: async () => 0n }, chainId: 84532 });
  const r = await reader.assertBoundToDeclaredChain();
  assert.equal(r.ok, true);
  assert.match(r.message, /client injected/);
});
