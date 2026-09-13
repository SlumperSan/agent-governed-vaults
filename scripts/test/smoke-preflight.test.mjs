// @ts-check
/**
 * The regression this file exists for. smoke-test.mjs's wiring-immutability check was
 *
 *   let rewired = false;
 *   try { call(dep.registry, 'wire(address,address)', …); rewired = true; } catch { (expected revert) }
 *   assert(!rewired, 'registry.wire() did NOT revert — deployment is not wired/locked correctly');
 *
 * so ANY failed call — a 429, a timeout, a DNS miss, a missing `cast` binary — was read as the
 * expected revert and the assertion PASSED, reporting the deployment wired and locked without
 * having tested it. That is the quiet direction of the bug PR #173 fixed in the soak harness and
 * PR #179 in the canary: a false PASS on a security assertion rather than a false alarm.
 *
 * Fixtures are cast's real wording — the set scripts/test/soak-drills.test.mjs measures
 * `classifyCallError` against — plus two failures specific to this runner: `spawnSync cast ENOENT`
 * (cast not on PATH, which execFileSync reports with no stderr) and the local-decode spelling of
 * the two reverts OperatorRegistry.wire() can produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { wiringImmutabilityFailure, oracleProbeWarning } from '../smoke-preflight.mjs';

const REVERTS = [
  'Error: server returned an error response: error code 3: execution reverted, data: "0x88cce429"',
  'Error: execution reverted',
  'reverted: AlreadyWired()',
  'reverted: OnlyDeployer()',
];
const NOT_A_VERDICT = [
  'error sending request: 429 Too Many Requests',
  'Error: operation timed out',
  'ECONNRESET',
  'getaddrinfo ENOTFOUND base-sepolia-rpc.publicnode.com',
  'max retries exceeded',
  'error sending request: 503 Service Unavailable',
  'spawnSync cast ENOENT',
  'wording nobody has seen before',
];

test('wiring: a transport failure can no longer satisfy the immutability assertion', () => {
  for (const error of NOT_A_VERDICT) {
    const f = wiringImmutabilityFailure({ ok: false, error });
    assert.notEqual(f, null, `must FAIL loudly, not pass as the expected revert: ${error}`);
    assert.match(String(f), /could not be confirmed to revert/);
    assert.match(String(f), /UNVERIFIED, not broken/);
    assert.doesNotMatch(String(f), /did NOT revert|not wired/, 'an unmade call is not a finding about the lock');
    assert.ok(String(f).includes(error), "carries cast's own words so the operator sees what actually failed");
  }
});

test('wiring: a genuine revert still satisfies it', () => {
  for (const error of REVERTS) {
    assert.equal(wiringImmutabilityFailure({ ok: false, error }), null, `a confirmed revert is the lock holding: ${error}`);
  }
});

test('wiring: a call the registry ACCEPTS is the original finding, unchanged', () => {
  assert.equal(
    wiringImmutabilityFailure({ ok: true, value: [] }),
    'registry.wire() did NOT revert — deployment is not wired/locked correctly',
  );
});

test('wiring: a revert whose text also carries a transport-looking token is still the lock holding', () => {
  // The same guard soak-drills pins for classifyCallError: a 429-like number inside revert data
  // must not demote the revert to missing evidence, or a held lock reads as an RPC outage.
  assert.equal(wiringImmutabilityFailure({ ok: false, error: 'execution reverted, data: "0x429" timeout' }), null);
});

test('oracle: a transport failure is no longer attributed to a stale feed or a working breaker', () => {
  for (const error of NOT_A_VERDICT) {
    const w = oracleProbeWarning('WETH', error);
    assert.equal(w.kind, 'transport');
    assert.ok(w.message.startsWith('WARN oracle WETH: priceWad could not be read ('), w.message);
    assert.doesNotMatch(w.message, /stale|breaker|reverted \(/i, 'says nothing about the feed either way');
    assert.ok(w.message.includes(error));
  }
});

test('oracle: a confirmed revert is reported as the contract refusing to price, and is still a WARN', () => {
  for (const error of REVERTS) {
    const w = oracleProbeWarning('LINK', error);
    assert.equal(w.kind, 'revert');
    assert.ok(w.message.startsWith('WARN oracle LINK: priceWad reverted ('), w.message);
    assert.match(w.message, /StaleOracle/);
    assert.match(w.message, /the run continues$/);
  }
});

test('oracle: only the first line of a multi-line cast error reaches the log', () => {
  const w = oracleProbeWarning('WETH', 'Error: execution reverted\n\nContext:\n- request …');
  assert.ok(w.message.includes('(Error: execution reverted)'), w.message);
  assert.ok(!w.message.includes('Context'), 'the rest of cast\'s stderr is noise on a WARN line');
});

// The runner cannot be imported (it drives cast on load), so the wiring of the two verdicts into
// it is pinned at the source level: the bare catch that produced the false PASS must not come
// back, and both verdicts must be the ones the runner actually consults.
test('smoke-test.mjs consults both verdicts and has no bare catch left to swallow a failed call', () => {
  const src = readFileSync(path.join(import.meta.dirname, '..', 'smoke-test.mjs'), 'utf8');
  assert.match(src, /import \{ wiringImmutabilityFailure, oracleProbeWarning \} from '\.\/smoke-preflight\.mjs'/);
  assert.match(src, /wiringImmutabilityFailure\(attempt\(/);
  assert.match(src, /oracleProbeWarning\(a\.symbol, r\.error\)/);
  assert.doesNotMatch(src, /\}\s*catch\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/, 'a bare catch reads a transport failure as whatever the try expected');
});
