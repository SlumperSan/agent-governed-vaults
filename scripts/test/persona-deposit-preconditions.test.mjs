// @ts-check
/**
 * Card 210 (owner pivot 2026-09-23): the server-side preconditions for the persona-deposit Sign-
 * queue items (`scripts/lib/sign-queue-preconditions.mjs`'s persona-deposit section). Every RPC
 * call is a stub — no network — and `seededPersonaRefusal`'s filesystem reads either use the real
 * checkout (to prove the "PR #391 not merged yet" refusal is real, not assumed) or a throwaway temp
 * directory (to prove the positive/negative disclosure cases), never anything under the repo the
 * task's owner might be editing concurrently.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  personaActivatePreconditionRefusal, personaDepositPreconditionRefusal,
  personaOrderingGateRefusal, seededPersonaRefusal,
} from '../lib/sign-queue-preconditions.mjs';

const VAULT = '0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6';
const USDC = '0x3600000000000000000000000000000000000000';
const FROM = '0x1111111111111111111111111111111111111111';
const FROM2 = '0x2222222222222222222222222222222222222222';
const MIN_DEPOSIT = 100_000_000n; // 100 USDC
const AMOUNT = 100_000_000n;

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// ─────────────────────────── personaDepositPreconditionRefusal ───────────────────────────

/** Stub Arc RPC for the deposit preconditions: minDepositUsdc, USDC.balanceOf, navWad, and
 * (optionally) USDC.allowance — every knob independently overridable so each test varies ONE thing.
 * Default `balance` is `amount` PLUS the gas headroom, so a test that does not care about the
 * headroom check specifically (frozen-vault, positive control) is funded well enough to clear it;
 * the headroom tests below override `balance` explicitly to exactly `AMOUNT`. */
function depositStub({ minDeposit = MIN_DEPOSIT, balance = AMOUNT + 1_000_000n, navOk = true, allowance = AMOUNT } = {}) {
  return async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method !== 'eth_call') throw new Error(`unstubbed method ${method}`);
    const { to, data } = params[0];
    const sel = data.slice(0, 10);
    if (to.toLowerCase() === VAULT.toLowerCase()) {
      if (sel === '0xd98656fd') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(minDeposit)}` }) };
      if (sel === '0xd09074c0') {
        if (!navOk) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { message: 'execution reverted: StaleOracle' } }) };
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(1_000_000_000_000_000_000_000n)}` }) };
      }
      throw new Error(`unstubbed vault selector ${sel}`);
    }
    if (to.toLowerCase() === USDC.toLowerCase()) {
      if (sel === '0x70a08231') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(balance)}` }) };
      if (sel === '0xdd62ed3e') return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(allowance)}` }) };
      throw new Error(`unstubbed usdc selector ${sel}`);
    }
    throw new Error(`unstubbed target ${to}`);
  };
}

test('personaDepositPreconditionRefusal: positive control — balance/min/nav all fine, no allowance check on the approve item', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub(), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: false,
  });
  assert.equal(r, null);
});

test('personaDepositPreconditionRefusal: amount below vault.minDepositUsdc() refuses', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ minDeposit: AMOUNT + 1n }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: false,
  });
  assert.match(String(r), /below vault\.minDepositUsdc/);
});

test('personaDepositPreconditionRefusal: the APPROVE item needs GAS HEADROOM above amount (Arc pays gas in USDC) — exactly `amount` funded refuses', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ balance: AMOUNT }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: false,
  });
  assert.match(String(r), /headroom for this item's own gas/);
});

test('personaDepositPreconditionRefusal: the DEPOSIT item does NOT need the gas headroom — exactly `amount` funded passes (its own gas is already spent by the time this runs)', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ balance: AMOUNT, allowance: AMOUNT }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: true,
  });
  assert.equal(r, null);
});

test('personaDepositPreconditionRefusal: insufficient USDC balance refuses', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ balance: AMOUNT - 1n }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: false,
  });
  assert.match(String(r), /USDC balance is/);
});

test('personaDepositPreconditionRefusal: a reverting navWad() (frozen/stale-oracle vault) refuses', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ navOk: false }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: false,
  });
  assert.match(String(r), /navWad\(\) reverted/);
});

test('personaDepositPreconditionRefusal: the deposit item additionally requires allowance — insufficient allowance refuses', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ allowance: AMOUNT - 1n }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: true,
  });
  assert.match(String(r), /allowance/);
});

test('personaDepositPreconditionRefusal: sufficient allowance on the deposit item passes (positive control for the allowance branch)', async () => {
  const r = await personaDepositPreconditionRefusal(depositStub({ allowance: AMOUNT }), {
    vault: VAULT, usdc: USDC, from: FROM, amountUsdcRaw: AMOUNT, checkAllowance: true,
  });
  assert.equal(r, null);
});

// ─────────────────────────── personaActivatePreconditionRefusal ───────────────────────────

function activateStub({ pendingAmount = AMOUNT, availableAt, now } = {}) {
  return async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method === 'eth_getBlockByNumber') {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { timestamp: `0x${now.toString(16)}` } }) };
    }
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      if (sel === '0x3a64b492') {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(pendingAmount)}${word(availableAt)}` }) };
      }
      throw new Error(`unstubbed selector ${sel}`);
    }
    throw new Error(`unstubbed method ${method}`);
  };
}

test('personaActivatePreconditionRefusal: positive control — pending amount > 0 and window elapsed', async () => {
  const r = await personaActivatePreconditionRefusal(activateStub({ availableAt: 1000n, now: 1000n }), { vault: VAULT, from: FROM });
  assert.equal(r, null);
});

test('personaActivatePreconditionRefusal: no pending deposit (amount 0) refuses', async () => {
  const r = await personaActivatePreconditionRefusal(activateStub({ pendingAmount: 0n, availableAt: 1000n, now: 2000n }), { vault: VAULT, from: FROM });
  assert.match(String(r), /no pending deposit/);
});

test('personaActivatePreconditionRefusal: still inside the observation window refuses', async () => {
  const r = await personaActivatePreconditionRefusal(activateStub({ availableAt: 5000n, now: 100n }), { vault: VAULT, from: FROM });
  assert.match(String(r), /not yet activatable/);
});

// ─────────────────────────────── seededPersonaRefusal ───────────────────────────────

function withSeededAddressesFixture(entries) {
  const root = mkdtempSync(path.join(tmpdir(), 'seeded-fixture-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'seeded-addresses.json'), JSON.stringify({ readme: 'x', addresses: entries }));
  return root;
}
const fixtureRoots = [];
after(() => { for (const r of fixtureRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

test('seededPersonaRefusal: docs/seeded-addresses.json absent (a checkout without PR #391) refuses with a clear message', () => {
  // A throwaway root with NO docs/ directory at all — not the real repo root, so this test's
  // outcome does not depend on whether PR #391 has merged by the time it runs.
  const root = mkdtempSync(path.join(tmpdir(), 'seeded-absent-'));
  fixtureRoots.push(root);
  const r = seededPersonaRefusal(FROM, 'Ballast', root);
  assert.match(String(r), /docs\/seeded-addresses\.json not found/);
});

test('seededPersonaRefusal: address listed under the matching persona passes', () => {
  const root = withSeededAddressesFixture([{ address: FROM, persona: 'Ballast', model: 'x', fundedBy: 'x', addedAt: 'x', note: 'x' }]);
  fixtureRoots.push(root);
  assert.equal(seededPersonaRefusal(FROM, 'Ballast', root), null);
});

test('seededPersonaRefusal: address listed under a DIFFERENT persona refuses', () => {
  const root = withSeededAddressesFixture([{ address: FROM, persona: 'Momentum', model: 'x', fundedBy: 'x', addedAt: 'x', note: 'x' }]);
  fixtureRoots.push(root);
  const r = seededPersonaRefusal(FROM, 'Ballast', root);
  assert.match(String(r), /under persona "Momentum", not "Ballast"/);
});

test('seededPersonaRefusal: address not listed at all refuses', () => {
  const root = withSeededAddressesFixture([{ address: FROM2, persona: 'Ballast', model: 'x', fundedBy: 'x', addedAt: 'x', note: 'x' }]);
  fixtureRoots.push(root);
  const r = seededPersonaRefusal(FROM, 'Ballast', root);
  assert.match(String(r), /is not listed/);
});

// ─────────────────────────────── personaOrderingGateRefusal ───────────────────────────────

function orderingStub({ shares = 1n, navOk = true, sharesOk = true } = {}) {
  return async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    if (method !== 'eth_call') throw new Error(`unstubbed method ${method}`);
    const sel = params[0].data.slice(0, 10);
    if (sel === '0xf5eb42dc') {
      if (!sharesOk) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { message: 'timeout' } }) };
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(shares)}` }) };
    }
    if (sel === '0xd09074c0') {
      if (!navOk) return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { message: 'reverted' } }) };
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: `0x${word(1n)}` }) };
    }
    throw new Error(`unstubbed selector ${sel}`);
  };
}

const DONE_POST_CHECK = { sharesOfHolder: '42', navWad: '5000' };

test('personaOrderingGateRefusal: first persona has not activated yet refuses without even reading the chain', async () => {
  const r = await personaOrderingGateRefusal(orderingStub(), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: false, firstActivatePostCheck: null,
  });
  assert.match(String(r), /waiting on the first persona/);
});

test('personaOrderingGateRefusal: activate item done but its postCheck has not been recorded yet refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub(), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true, firstActivatePostCheck: undefined,
  });
  assert.match(String(r), /no recorded post-check yet/);
});

test('personaOrderingGateRefusal: recorded postCheck shows sharesOf 0 refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub(), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true,
    firstActivatePostCheck: { sharesOfHolder: '0', navWad: '5000' },
  });
  assert.match(String(r), /recorded post-check shows sharesOf 0/);
});

test('personaOrderingGateRefusal: recorded postCheck has shares but no navWad reading refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub(), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true,
    firstActivatePostCheck: { sharesOfHolder: '42', navWad: null },
  });
  assert.match(String(r), /no navWad reading/);
});

test('personaOrderingGateRefusal: positive control — recorded postCheck good, AND the live shares/navWad reads pass', async () => {
  const r = await personaOrderingGateRefusal(orderingStub({ shares: 42n }), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true, firstActivatePostCheck: DONE_POST_CHECK,
  });
  assert.equal(r, null);
});

test('personaOrderingGateRefusal: recorded postCheck good, but the LIVE sharesOf reads 0 right now (shares since exited) refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub({ shares: 0n }), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true, firstActivatePostCheck: DONE_POST_CHECK,
  });
  assert.match(String(r), /reads 0 right now/);
});

test('personaOrderingGateRefusal: recorded postCheck good, but navWad unreadable RIGHT NOW refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub({ shares: 42n, navOk: false }), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true, firstActivatePostCheck: DONE_POST_CHECK,
  });
  assert.match(String(r), /not readable right now/);
});

test('personaOrderingGateRefusal: recorded postCheck good, but the LIVE sharesOf read itself fails refuses', async () => {
  const r = await personaOrderingGateRefusal(orderingStub({ sharesOk: false }), {
    vault: VAULT, firstPersonaFrom: FROM, firstActivateDone: true, firstActivatePostCheck: DONE_POST_CHECK,
  });
  assert.match(String(r), /could not read vault\.sharesOf/);
});
