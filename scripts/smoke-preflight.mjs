// @ts-check
/**
 * Pure verdicts for the two preflight probes in smoke-test.mjs, extracted the way
 * proposal-recovery.mjs was so they can be tested without executing the runner (which drives
 * `cast` and reads a deployment on import).
 *
 * Both probes EXPECT a revert, and that is the trap: `cast` fails the same way for a contract
 * revert and for a 429, a timeout or a DNS miss, and smoke-test.mjs used to swallow every failure
 * with a bare catch whose only content was the comment "expected revert". Only a CONFIRMED revert
 * is evidence about the contract.
 * Anything else is a call that reached no verdict, and has to be reported as exactly that — never
 * as the revert the probe was waiting for. The classifier is the one the soak harness and the
 * canary already share, `classifyCallError` in packages/canary/src/call-error.mjs, so the three
 * harnesses cannot disagree about which failures count.
 */
import { classifyCallError } from '../packages/canary/src/call-error.mjs';

/**
 * What a probe did. On failure `error` is `cast`'s own stderr, which is the text
 * `classifyCallError` is measured against (smoke-test.mjs's `cast()` carries it on the thrown
 * Error as `detail`, without the "cast call … failed:" prefix).
 * @typedef {{ ok: true, value?: unknown } | { ok: false, error: string }} ProbeOutcome
 */

const firstLine = (s) => String(s).split('\n')[0];

/**
 * Wiring is one-shot: an eth_call of `OperatorRegistry.wire(factory, feeEngine)` against a
 * deployed registry MUST revert — `OnlyDeployer()` for any other caller, `AlreadyWired()` for the
 * deployer (contracts/src/OperatorRegistry.sol:74-76).
 *
 * Returns null when the lock is CONFIRMED, otherwise the FAIL message. smoke-test.mjs exits the
 * process on a non-null result, so there is no third state.
 *
 *   ok:true                          the registry accepted a re-wire. The original finding.
 *   ok:false, a recognised revert    null — the one outcome that proves the lock.
 *   ok:false, anything else          nothing was learned. This case used to PASS.
 *
 * @param {ProbeOutcome} outcome
 * @returns {string | null}
 */
export function wiringImmutabilityFailure(outcome) {
  if (outcome.ok) return 'registry.wire() did NOT revert — deployment is not wired/locked correctly';
  if (classifyCallError(outcome.error) === 'revert') return null;
  return `registry.wire() could not be confirmed to revert (${firstLine(outcome.error)}) — the wiring lock is UNVERIFIED, not broken: this failure is not a contract revert (rate limit, timeout, DNS, cast itself, or wording the classifier does not recognise); preflight runs from the top on every start, so re-run the same command once the RPC answers`;
}

/**
 * The oracle probe reads `priceWad(asset)` through the deployed ChainlinkOracle. A confirmed
 * revert is the contract refusing to price the asset: `priceWad` reverts `StaleOracle(asset)` for
 * an unlisted asset, a downed sequencer, an idle feed past its heartbeat, an out-of-band price or
 * a feed that itself reverts (contracts/src/oracle/ChainlinkOracle.sol:279-305). A call that
 * produced no revert says nothing about the feed in either direction.
 *
 * Both are a WARN, not a FAIL, for the reason smoke-test.mjs already gives: the no-op lifecycle
 * never prices a non-zero basket balance, so neither can change the run's outcome. What this
 * function changes is only that the two are no longer reported with one sentence — the old line
 * attributed every failure to a stale feed and a working breaker.
 *
 * @param {string} symbol   the asset, for the log line
 * @param {string} error    cast's stderr for the failed call
 * @returns {{ kind: 'revert' | 'transport', message: string }}
 */
export function oracleProbeWarning(symbol, error) {
  const kind = classifyCallError(error);
  const why = firstLine(error);
  if (kind === 'revert') {
    return {
      kind,
      message: `WARN oracle ${symbol}: priceWad reverted (${why}) — the oracle refused to price ${symbol} (ChainlinkOracle reverts StaleOracle for an idle feed, an unlisted asset, a downed sequencer or an out-of-band price; docs/TESTNET-CHECKLIST.md §6); the no-op lifecycle never prices a basket balance, so the run continues`,
    };
  }
  return {
    kind,
    message: `WARN oracle ${symbol}: priceWad could not be read (${why}) — this failure is not a contract revert, so it says nothing about the feed either way; the run continues`,
  };
}
