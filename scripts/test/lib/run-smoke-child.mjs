/**
 * Spawns the REAL, unmodified scripts/smoke-test.mjs as a genuine child `node` process — this is
 * the one legitimate use of the real, unintercepted `node:child_process` in this harness: the
 * OUTER test process starting an ordinary `node` subprocess. Everything INSIDE that subprocess
 * (its own `cast`/`forge` calls) is intercepted, from the moment it starts, by
 * cast-fixture-preload.mjs / cast-fixture-hooks.mjs / cast-fixture-stub.mjs.
 *
 * `CAST` is pointed at a path nothing provides (`castPath` below — nothing ever creates it; it is
 * not a sentinel file to check for, it is a binary that cannot run). If the loader hook ever
 * failed to redirect `node:child_process` (the interception itself broken), smoke-test.mjs's own
 * `cast()` would shell out to that path for real and fail with ENOENT on the very first call
 * (preflight's `chain-id`) — the caller's `status === 0` and `callLog.length > 0` assertions are
 * what actually catch that: a failed redirect means a nonzero exit AND an empty log (nothing ever
 * reached the stub to log), so both would fail together rather than either passing vacuously.
 * `BASE_SEPOLIA_RPC` is likewise pointed at an address nothing answers, in case any future code
 * path in smoke-test.mjs ever reaches the network directly instead of through `cast`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCallLog } from './fixture-assertions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');
const SMOKE_TEST = path.join(ROOT, 'scripts', 'smoke-test.mjs');
const PRELOAD = path.join(HERE, 'cast-fixture-preload.mjs');
export const FIXTURES = path.join(ROOT, 'scripts', 'test', 'fixtures');
export const REAL_CONFIG = path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
export const HAPPY_DEPLOY_JSON = path.join(FIXTURES, 'deploy-run-latest.json');
/**
 * The DEPLOYMENT RECORD the runner validates its signer against — a fixture, not the real one.
 *
 * `SMOKE_DEPLOYMENT` was unset here, so the runner fell back to the committed
 * `contracts/config/deployments/base-sepolia.json`, which declares the real deployer EOA as
 * `intendedCreator` while this harness signs as the fake chain's own `SIGNER_ADDR`.
 * `requireIntendedCreator` refuses that disagreement — correctly. The two landed on separate
 * branches (the harness in #342, the creator check in #329) and nothing reconciled them until they
 * were merged, at which point the happy path and four negative controls all refused before reaching
 * what they were testing.
 */
export const HAPPY_DEPLOYMENT = path.join(FIXTURES, 'deployment-happy.json');

/**
 * @param {object} opts
 * @param {string} [opts.deployJson]  DEPLOY_JSON path; defaults to the happy-path fixture
 * @param {string} [opts.config]      SMOKE_CONFIG path; defaults to the real base-sepolia config
 * @param {string} [opts.deployment]  SMOKE_DEPLOYMENT path; defaults to the happy-path fixture record
 * @param {string} [opts.scenario]    fixture scenario name (see cast-fixture-chain.mjs)
 * @param {object} [opts.env]         extra/overriding env vars, applied last
 */
export function runSmokeChild(opts = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-harness-v2-'));
  const logPath = path.join(runDir, 'fixture-call-log.jsonl');
  const statePath = path.join(runDir, 'smoke-state.json');
  const noSuchCast = path.join(runDir, 'no-such-cast-binary');

  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: 'http://127.0.0.1:1',
    CAST: noSuchCast,
    SMOKE_SIGNER_ARGS: '--account smoketest-fixture',
    DEPLOY_JSON: opts.deployJson ?? HAPPY_DEPLOY_JSON,
    SMOKE_CONFIG: opts.config ?? REAL_CONFIG,
    SMOKE_DEPLOYMENT: opts.deployment ?? HAPPY_DEPLOYMENT,
    SMOKE_STATE: statePath,
    SMOKE_RESET: '1',
    SMOKE_FIXTURE_LOG: logPath,
    SMOKE_FIXTURE_SCENARIO: opts.scenario ?? 'happy',
    ...(opts.env ?? {}),
  };

  // `--import` resolves its argument like an ESM specifier, so a raw Windows path ("C:\...") is
  // read as URL scheme "c:" and rejected (ERR_UNSUPPORTED_ESM_URL_SCHEME) — it must be a file URL.
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(PRELOAD).href, SMOKE_TEST], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  const callLog = fs.existsSync(logPath) ? readCallLog(logPath) : [];
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
    callLog,
    castPath: noSuchCast,
    runDir,
  };
}
