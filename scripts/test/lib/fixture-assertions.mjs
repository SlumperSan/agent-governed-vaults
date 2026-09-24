/**
 * Small pure helpers the harness's assertions are built on. Kept separate from
 * run-smoke-child.mjs, and each has a direct unit test in smoke-test-harness.test.mjs, so that a
 * neutered comparison (e.g. `addressEq = () => true`) or a swallowed read error is caught by a
 * unit test that exercises its FAILING case — not only by the happy path, which would stay green
 * either way. This is deliberately the mutation-(c)/(a) target the harness's own brief asks for.
 */
import fs from 'node:fs';

/** Case-insensitive address equality. NOT the same as `a === b`: an address logged in a
 * different case than it was generated in is still the same address, but `undefined === undefined`
 * (two unset addresses) must NOT read as a match, so both sides are required to be non-empty. */
export function addressEq(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 &&
    a.toLowerCase() === b.toLowerCase();
}

/** Read the JSON-lines call log the fixture chain writes on every intercepted `cast` invocation.
 * Throws loudly on a missing or corrupt log — a swallowed failure here (`catch { return [] }`)
 * would make "the log has 0 broadcasts" indistinguishable from "the log could not be read", which
 * is exactly the false-pass shape smoke-preflight.mjs's own docstring warns about. */
export function readCallLog(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Entries the fixture tagged as a state-changing `cast send` — the ones that would broadcast on
 * a real chain. */
export function broadcastEntries(log) {
  return log.filter((e) => e.kind === 'send' && e.broadcast === true);
}

/** No argv logged by the fixture may carry a raw private key flag — the harness's fixture
 * (SMOKE_SIGNER_ARGS) is keystore-shaped by construction, and this is the check that would catch
 * a regression toward a raw key even though nothing here ever dials out. */
export function noPrivateKeyLogged(log) {
  return log.every((e) => !JSON.stringify(e.argv ?? '').includes('--private-key'));
}
