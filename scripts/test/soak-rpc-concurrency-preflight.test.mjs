// @ts-check
/**
 * Tests for `measureRpcConcurrency` (scripts/soak/preflight-rpc-concurrency.mjs) — the
 * concurrent-burst RPC rate-limit check, with the actual `cast` invocation injected via `run` so
 * these never touch the network. Real chain behavior is exercised separately by hand (see the PR
 * description for a live transcript against the actual endpoint this was measured on).
 *
 * Measured shape being guarded against: `over rate limit` from `https://sepolia.base.org` on
 * `eth_getLogs`, under the concurrency run-soak.ps1 itself creates (indexer + canary + sampler +
 * 2 drill tracks = 5 concurrent pollers). A single sequential positive-control read (what
 * `assertLogsServed` in lib.mjs already does) cannot see this — these tests pin that a burst of
 * failures IS caught, that an all-clear burst is NOT flagged, and that a burst that fails for
 * unrelated reasons is reported as "could not measure" rather than silently read as healthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureRpcConcurrency, SOAK_RPC_CONCURRENCY, formatOkMessage } from '../soak/preflight-rpc-concurrency.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SOAK_PS1 = path.join(HERE, '..', 'soak', 'run-soak.ps1');

const ARGS = { rpc: 'https://example.invalid', address: '0x' + '1'.repeat(40), fromBlock: 100, toBlock: 2100 };

/** A `run` stub whose i-th call resolves or rejects per `outcomes[i]`. */
function fakeRun(outcomes) {
  let i = 0;
  return async () => {
    const outcome = outcomes[i++];
    if (outcome.ok) return { stdout: outcome.stdout ?? '[]' };
    const err = new Error(outcome.message);
    // @ts-ignore - mirrors what execFile's promisified rejection carries
    err.stderr = outcome.message;
    throw err;
  };
}

test('SOAK_RPC_CONCURRENCY matches what run-soak.ps1 itself starts (indexer, canary, sampler, 2 tracks)', () => {
  assert.equal(SOAK_RPC_CONCURRENCY, 5);
});

test('all calls clean — ok, no reason', async () => {
  const run = fakeRun(Array.from({ length: 5 }, () => ({ ok: true })));
  const r = await measureRpcConcurrency({ ...ARGS, concurrency: 5, run });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.deepEqual(r.rateLimited, []);
});

test('a rate-limit-shaped failure on SOME calls refuses, and is distinguished from other failures', async () => {
  const run = fakeRun([
    { ok: true },
    { ok: false, message: 'server returned an error response: error code -32016: over rate limit' },
    { ok: true },
    { ok: false, message: 'error code 429: Too Many Requests' },
    { ok: true },
  ]);
  const r = await measureRpcConcurrency({ ...ARGS, concurrency: 5, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate-limited');
  assert.equal(r.rateLimited.length, 2);
  assert.equal(r.otherFailures.length, 0);
});

test('every call failing, but none in a rate-limit shape, is UNMEASURABLE — not silently ok', async () => {
  // The RPC could be completely unreachable (DNS, timeout, refused). That is not evidence it
  // WOULD sustain the soak's concurrency once reachable, so this must not read as a pass.
  const run = fakeRun(Array.from({ length: 5 }, () => ({ ok: false, message: 'getaddrinfo ENOTFOUND example.invalid' })));
  const r = await measureRpcConcurrency({ ...ARGS, concurrency: 5, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unmeasurable');
  assert.equal(r.rateLimited.length, 0);
  assert.equal(r.otherFailures.length, 5);
});

test('a MIX of rate-limit and unrelated failures still reads as rate-limited (the more actionable, more specific cause)', async () => {
  const run = fakeRun([
    { ok: false, message: 'over rate limit' },
    { ok: false, message: 'ETIMEDOUT' },
    { ok: true },
    { ok: true },
    { ok: true },
  ]);
  const r = await measureRpcConcurrency({ ...ARGS, concurrency: 5, run });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate-limited');
});

test('a minority of unrelated failures alongside an otherwise-clean burst does not block (not every non-rate-limit hiccup is fatal)', async () => {
  const run = fakeRun([
    { ok: true }, { ok: true }, { ok: true }, { ok: true },
    { ok: false, message: 'ECONNRESET' },
  ]);
  const r = await measureRpcConcurrency({ ...ARGS, concurrency: 5, run });
  assert.equal(r.ok, true, 'a single unrelated blip among four clean calls is not "all failed" and not rate-limiting');
  assert.equal(r.reason, null);
});

test('fires exactly `concurrency` calls, not more and not fewer', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return { stdout: '[]' }; };
  await measureRpcConcurrency({ ...ARGS, concurrency: 7, run });
  assert.equal(calls, 7);
});

// ── operator-facing wording: REJECTED once (PR #364) for claiming sustained-load safety from a
// ~1.2s startup burst. These pin the honest wording so a future edit cannot quietly re-inflate it.
// Mutation-tested by hand: reverting formatOkMessage's body to the old
// `` `OK — ${concurrency} concurrent eth_getLogs calls all returned cleanly` `` and run-soak.ps1's
// announcement to `"checking the RPC endpoint sustains this run's concurrency..."` turns both
// assertions below RED; restoring the current wording turns them GREEN.

test('formatOkMessage: names what N calls over the measured window ruled out', () => {
  const msg = formatOkMessage({ concurrency: 5, elapsedMs: 1193 });
  assert.match(msg, /\b5\b/, 'must report the actual concurrency measured');
  assert.match(msg, /1\.2s/, 'must report the actual elapsed wall-clock time, not a hardcoded estimate');
  assert.match(msg, /startup tripwire/i, 'must name itself as a startup tripwire');
});

test('formatOkMessage: does NOT claim sustained-load safety', () => {
  const msg = formatOkMessage({ concurrency: 5, elapsedMs: 1193 });
  // The exact defect Security rejected PR #364 for: a startup burst reported in the language of
  // "sustains"/"survives" the run. A pass here proves the endpoint is not ALREADY struggling; it
  // proves nothing about the next 14 hours, and the message must say so, not just avoid claiming
  // the opposite.
  assert.doesNotMatch(msg, /\bsustains?\b/i, 'must not claim the endpoint "sustains" the run — that is the rejected wording');
  assert.doesNotMatch(msg, /\bsurvives?\b/i, 'must not claim the endpoint "survives" the run');
  assert.match(msg, /not evidence/i, 'must explicitly disclaim sustained-load evidence, not merely omit the claim');
});

test('run-soak.ps1: the RPC preflight announcement names it a startup tripwire, not a sustained-load claim', () => {
  const src = fs.readFileSync(RUN_SOAK_PS1, 'utf8');
  const announcementLine = src.split('\n').find((l) => /Write-Host/.test(l) && /RPC endpoint/.test(l));
  assert.ok(announcementLine, 'expected to find the RPC concurrency preflight announcement in run-soak.ps1');
  assert.doesNotMatch(announcementLine, /sustains this run's concurrency/,
    'REJECTED wording (PR #364): claims sustained-load safety from a one-time startup burst');
  assert.match(announcementLine, /startup tripwire|not a sustained-load/i,
    'announcement must carry the honest scope, not just the check name');
});
