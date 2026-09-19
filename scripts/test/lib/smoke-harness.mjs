// @ts-check
/**
 * Run scripts/smoke-test.mjs END TO END, unmodified, with no chain and no key — and hand the test
 * back every `cast` invocation it made.
 *
 * HOW, in one paragraph. The runner is spawned in a child process with `--import` pointing at
 * `cast-stub-hooks.mjs`, which substitutes `node:child_process` for that one module; every
 * `execFileSync(CAST, …)` is then answered from `cast-stub.mjs`'s table and appended to a JSONL log.
 * `DEPLOY_JSON`, `SMOKE_CONFIG`, `SMOKE_DEPLOYMENT` and `SMOKE_STATE` point at fixtures written to a
 * fresh temp directory OUTSIDE the repository — several guards here walk the working tree looking for
 * prose in `.json` files, and a fixture deployment record committed under `contracts/config/` would
 * be read as a claim about the real deployment.
 *
 * A CHILD PROCESS RATHER THAN `await import()`, and it is not a style choice: the runner's `fail()`
 * calls `process.exit(1)`, so an in-process import would kill `node --test` itself on the first
 * refusal — the exact path every test here is about. In a child, the refusal is an exit code, a
 * stderr string, and a log that ends without a `cast send`.
 *
 * WHAT `sends` PROVES. "Nothing was broadcast" is the absence of a `send` entry in a log the stub
 * appends to per call, before answering. It is a recorded fact about what the runner did, not an
 * inference from what it printed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOKS = path.join(REPO, 'scripts', 'test', 'lib', 'cast-stub-hooks.mjs');
const RUNNER = path.join(REPO, 'scripts', 'smoke-test.mjs');
const CONFIG = path.join(REPO, 'contracts', 'config', 'base-sepolia.json');

/** The address the fixtures declare as `intendedCreator` unless a scenario says otherwise. */
export const DECLARED_CREATOR = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
/** A different, well-formed address — the 4663 shape: a signer nobody declared. */
export const OTHER_SIGNER = '0xC73Bd58725afF051109b97B7Be40a8E31C6CAD4c';

const DEPLOYED = {
  OperatorRegistry: '0x00000000000000000000000000000000000000a1',
  SubVaultRegistry: '0x00000000000000000000000000000000000000a2',
  FeeEngine: '0x00000000000000000000000000000000000000a3',
  Governance: '0x00000000000000000000000000000000000000a4',
  VaultFactory: '0x00000000000000000000000000000000000000a5',
  ChainlinkOracle: '0x00000000000000000000000000000000000000a6',
  AggregationRouterAdapter: '0x00000000000000000000000000000000000000a7',
};

/** A forge broadcast artifact of the shape `loadDeployment()` reads: CREATE rows with a name. */
const broadcastArtifact = () => ({
  transactions: Object.entries(DEPLOYED).map(([contractName, contractAddress]) => ({
    hash: `0x${'1'.repeat(64)}`,
    transactionType: 'CREATE',
    contractName,
    contractAddress,
  })),
});

/**
 * @typedef {object} SmokeRun
 * @property {number|null} code           the runner's exit code (0 = the lifecycle completed)
 * @property {string} stdout
 * @property {string} stderr
 * @property {object[]} invocations       every `cast` call, in order, as the stub recorded it
 * @property {object[]} sends             the `cast send` subset — a broadcast is an entry here
 * @property {object[]} calls             the `cast call` subset
 * @property {object|null} state          the state file the runner left behind, if any
 * @property {string} target              the file that was executed
 */

/**
 * Execute the runner (or a mutated copy of it) against a scripted chain.
 *
 * @param {object} [opts]
 * @param {Record<string, unknown>} [opts.scenario]   stub answers: `signer`, `eventCreator`,
 *   `onChainCreator`, `wireError`, `chainId`, …
 * @param {Record<string, unknown>} [opts.record]     the deployment record `SMOKE_DEPLOYMENT` reads
 * @param {Record<string, string>} [opts.env]         extra environment for the child
 * @param {string} [opts.target]                      absolute path of the file to execute
 * @returns {SmokeRun}
 */
export function runSmokeTest({ scenario = {}, record, env = {}, target = RUNNER } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'smoke-harness-'));
  try {
    const signer = String(scenario.signer ?? DECLARED_CREATOR);
    const deployJson = path.join(tmp, 'run-latest.json');
    const recordPath = path.join(tmp, 'deployment-record.json');
    const statePath = path.join(tmp, 'smoke-state.json');
    const scenarioPath = path.join(tmp, 'scenario.json');
    const logPath = path.join(tmp, 'cast-invocations.jsonl');
    const configPath = path.join(tmp, 'chain-config.json');

    // The REAL chain config, copied rather than hand-built: the runner reads `assets`, `usdc` and
    // the whole `smoke` block out of it, and a hand-written stand-in would let the fixtures and the
    // shipped configuration drift apart without a test noticing.
    copyFileSync(CONFIG, configPath);
    writeFileSync(deployJson, JSON.stringify(broadcastArtifact(), null, 2));
    writeFileSync(recordPath, JSON.stringify(record ?? { chainId: 84532, intendedCreator: DECLARED_CREATOR }, null, 2));
    writeFileSync(scenarioPath, JSON.stringify({ signer, ...scenario }, null, 2));
    writeFileSync(logPath, '');

    const res = spawnSync(process.execPath, ['--import', pathToFileURL(HOOKS).href, target], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        // No key and no network: the signer args are a string the stub answers, `cast` is never run,
        // and the RPC url is unroutable on purpose so a leaked real invocation cannot reach a chain.
        SMOKE_SIGNER_ARGS: String(env.SMOKE_SIGNER_ARGS ?? '--account harness-stub'),
        BASE_SEPOLIA_RPC: 'http://smoke-harness.invalid',
        CAST: 'cast-never-executed',
        DEPLOY_JSON: deployJson,
        SMOKE_CONFIG: configPath,
        SMOKE_DEPLOYMENT: recordPath,
        SMOKE_STATE: statePath,
        SMOKE_RESET: '1',
        SMOKE_STUB_LOG: logPath,
        SMOKE_STUB_SCENARIO: scenarioPath,
        SMOKE_STUB_TARGET: pathToFileURL(target).href,
        ...env,
      },
    });

    const invocations = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((e) => e.args !== undefined); // the paired "result" line is bookkeeping, not a call

    return {
      code: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      invocations,
      sends: invocations.filter((e) => e.sub === 'send'),
      calls: invocations.filter((e) => e.sub === 'call'),
      state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null,
      target,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Run a MUTATED COPY of the runner. The copy lives in `scripts/` so that `ROOT`, every relative
 * import and every default path resolve exactly as they do for the original; the original is never
 * touched, which is the point of the whole exercise.
 *
 * Each replacement must actually apply. A mutation whose anchor has moved would otherwise run the
 * pristine file and report the mutation "killed" while testing nothing — the same class of vacuous
 * pass this harness exists to close.
 *
 * @param {[string|RegExp, string][]} edits
 * @param {(target: string) => SmokeRun} run
 */
export function withMutatedRunner(edits, run) {
  const src = readFileSync(RUNNER, 'utf8');
  let mutated = src;
  for (const [from, to] of edits) {
    const next = mutated.replace(from, to);
    if (next === mutated) {
      throw new Error(`mutation anchor not found in smoke-test.mjs: ${String(from)} — the mutation would have tested nothing`);
    }
    mutated = next;
  }
  const copy = path.join(REPO, 'scripts', `.smoke-harness-mutant-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(copy, mutated);
  try {
    return run(copy);
  } finally {
    unlinkSync(copy);
  }
}
