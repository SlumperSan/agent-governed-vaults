#!/usr/bin/env node
// @ts-check
/**
 * Local pre-merge gate: run everything `.github/workflows/ci.yml` gates on, in one command,
 * on this machine.
 *
 *     npm run gate            # full mirror of CI, fail-fast
 *     npm run gate -- --quick # skip the gas snapshot (the expensive duplicate test run)
 *     npm run gate -- --all   # run every step even after one fails (full damage report)
 *     npm run gate -- --only fmt,backend
 *     npm run gate -- --list
 *
 * WHY THIS EXISTS. A CI round trip costs 6-7 minutes, and GitHub Actions minutes ran out on
 * 2026-08-29 (~72h outage), which made "push and see" impossible. But the gate is not a stopgap:
 * even with CI healthy, finding a `forge fmt` violation locally in 3 seconds beats finding it
 * remotely in 7 minutes.
 *
 * THE CONTRACT: this file must mirror ci.yml, not a summary of it. A gate that checks a SUBSET of
 * CI is worse than no gate, because it green-lights a PR that CI then fails -- the exact round trip
 * it was built to remove. When you edit ci.yml, edit this file in the same commit.
 *
 * Deliberate divergences from CI, all of them noted at runtime by `--list`:
 *   - `npm ci` is NOT run. It would delete and reinstall node_modules on every gate run (minutes,
 *     every time) to catch a class of failure that only appears when package-lock.json changes.
 *     Run `npm ci` by hand when you touch the lockfile; that is the one case where a green gate
 *     can still meet a red CI.
 *   - Slither is advisory here exactly as it is in CI (`continue-on-error: true`), and is SKIPPED
 *     with a notice when it is not installed. A gate that turns red because an optional Python
 *     tool is missing teaches people to ignore red, which costs more than the check is worth.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = path.join(REPO, 'contracts');
const WIN = process.platform === 'win32';

// The six entrypoints CI syntax-checks. They have no unit tests -- they are exercised by hand
// against a live chain -- so parsing them is the only thing standing between a typo and a
// 6-hour smoke run or a production boot that dies on load.
const ENTRYPOINTS = [
  'scripts/smoke-test.mjs',
  'scripts/verify-chainlink-oracle.mjs',
  'apps/api/src/serve.mjs',
  'packages/indexer/src/index-runner.mjs',
  'packages/canary/src/canary-runner.mjs',
  'packages/oplog/src/ops-check.mjs',
];

/**
 * @typedef {object} Step
 * @property {string} id            short name for --only
 * @property {string} title         what shows in the log
 * @property {string} cmd
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {number} [expectExit]  a step whose CONTRACT is a non-zero exit code
 * @property {boolean} [advisory]   failure warns, never fails the gate (mirrors continue-on-error)
 * @property {boolean} [quickSkip]  dropped by --quick
 * @property {string} [why]         printed by --list
 */

/** @type {Step[]} */
const STEPS = [
  {
    id: 'fmt',
    title: 'forge fmt --check',
    cmd: 'forge',
    args: ['fmt', '--check'],
    cwd: CONTRACTS,
    why: 'Seconds to run and the single most common CI failure. Always first.',
  },
  {
    id: 'syntax',
    title: 'node --check (entrypoints)',
    // `node --check` takes exactly one file, so this step fans out over ENTRYPOINTS in
    // runSyntaxStep() rather than being a single spawn. cmd/args are unused for it.
    cmd: process.execPath,
    args: [],
    why: 'Untested-by-design operational scripts. A parse error here reaches a live chain.',
  },
  {
    id: 'build',
    title: 'forge build',
    cmd: 'forge',
    args: ['build'],
    cwd: CONTRACTS,
    // ORDERING IS LOad-BEARING: abis.test.mjs cross-checks the indexer's embedded event fragments
    // against compiled artifacts, and SKIPS ITSELF when contracts/out is absent. Build before
    // `backend` or the ABI drift guard goes quiet and the backend suite reports a false green.
    why: 'Must precede `backend`: abis.test.mjs silently skips without contracts/out.',
  },
  {
    id: 'opscheck',
    title: 'ops-check exits 1 on absent heartbeats',
    cmd: process.execPath,
    args: [path.join(REPO, 'packages/oplog/src/ops-check.mjs'), '--dir=./no-such-dir'],
    expectExit: 1,
    // ops-check is a cron job and a compose healthcheck, so its exit CODE is the whole contract.
    // It must FAIL (1) on missing heartbeats -- not crash (2), which would look like an outage,
    // and not pass (0), which would silently disarm the alerting.
    why: 'Its exit code IS the contract: must be 1, not 0 (disarmed alerting) and not 2 (crash).',
  },
  {
    id: 'backend',
    title: 'npm run test:backend',
    cmd: WIN ? 'npm.cmd' : 'npm',
    args: ['run', 'test:backend'],
    cwd: REPO,
    why: 'Backend + frontend logic suite. Needs `build` first (see above).',
  },
  {
    id: 'test',
    title: 'forge test',
    cmd: 'forge',
    args: ['test'],
    cwd: CONTRACTS,
    // Unseeded on purpose, matching CI: every run draws a fresh fuzz/invariant corpus so the suite
    // keeps hunting for new counterexamples instead of replaying one fixture. The consequence is
    // that a fuzz failure here can be a GENUINE new counterexample rather than a broken gate --
    // read the output before assuming the gate is at fault.
    why: 'Fuzz corpus is unseeded (as in CI), so a red run may be a real new counterexample.',
  },
  {
    id: 'snapshot',
    title: 'forge snapshot --check (gas, no regressions)',
    cmd: 'forge',
    args: ['snapshot', '--check', '--nmt', 'testFuzz|c4EndToEnd'],
    cwd: CONTRACTS,
    quickSkip: true,
    // The --nmt filter is not optional and not arbitrary; ci.yml carries the full reasoning.
    // Short version: fuzz gas is a mean over a non-reproducible corpus, and the two c4EndToEnd
    // tests probe storage via stdStorage whose trial SSTORE/SLOAD gas differs by a few units
    // between Windows and Linux. Gating either measures noise.
    // Regenerate deliberately with: cd contracts && forge snapshot --nmt "testFuzz"
    why: 'Re-runs the suite, so it roughly doubles gate time -- this is what --quick drops.',
  },
  {
    id: 'sizes',
    title: 'forge build --sizes (EIP-170)',
    cmd: 'forge',
    args: ['build', '--sizes'],
    cwd: CONTRACTS,
    // Stays last, as in CI. This gate used to be RED on purpose (issue #10, VaultFactory over the
    // EIP-170 cap) -- a real undeployability defect kept visible rather than suppressed. Never add
    // `code_size_limit` to foundry.toml and never drop --sizes to make it green: that turns
    // undeployability back into a passing check.
    why: 'Undeployability is a real defect. Never silence it with foundry.toml code_size_limit.',
  },
  {
    id: 'slither',
    title: 'slither (advisory)',
    cmd: 'slither',
    args: ['.', '--filter-paths', '^lib/|^test/|^script/'],
    cwd: CONTRACTS,
    advisory: true,
    // Anchored filter paths, matching ci.yml. The old unanchored "lib|test|script" also matched
    // src/lib/, silently excluding SafeTransferLib, BoundedCall and Checkpoints -- ~150 LoC of
    // Medium-risk primitives carrying the H-1 and H-2 fixes -- from every Slither run this project
    // ever did. Keep the anchors.
    why: 'Advisory in CI too. Skipped with a notice when slither is not installed.',
  },
];

// node --check accepts exactly one file, so the syntax step is a fan-out rather than one spawn.
const SYNTAX_STEP = 'syntax';

// ---------------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const QUICK = has('--quick');
const RUN_ALL = has('--all') || has('--no-fail-fast');
const ONLY = (() => {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i === -1) return null;
  const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();

if (has('--help') || has('-h') || has('--list')) {
  console.log('\nLocal pre-merge gate -- mirrors .github/workflows/ci.yml.\n');
  for (const s of STEPS) {
    const tags = [s.advisory && 'advisory', s.quickSkip && 'dropped by --quick', s.expectExit !== undefined && `expects exit ${s.expectExit}`]
      .filter(Boolean)
      .join(', ');
    console.log(`  ${s.id.padEnd(10)} ${s.title}${tags ? `  [${tags}]` : ''}`);
    if (s.why) console.log(`  ${''.padEnd(10)}   ${s.why}`);
  }
  console.log('\nDeliberate divergences from CI:');
  console.log('  - `npm ci` is not run here. Run it by hand when package-lock.json changes;');
  console.log('    that is the one case where a green gate can still meet a red CI.');
  console.log('  - Slither is advisory (as in CI) and skipped when not installed.\n');
  console.log('Flags: --quick  --all/--no-fail-fast  --only a,b  --list\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------- runners

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * SHELL POLICY -- read before changing any spawn in this file.
 *
 * Running through cmd.exe (`shell: true`) corrupts arguments in two ways this gate hit for real:
 *   1. An absolute path containing a space is split. `process.execPath` is
 *      "C:\Program Files\nodejs\node.exe", which cmd.exe runs as the command `C:\Program`.
 *   2. Shell metacharacters inside a quoted argument are still interpreted. The gas gate's
 *      `--nmt "testFuzz|c4EndToEnd"` became a PIPE into a command named `c4EndToEnd`.
 * Both failed loudly here, but the dangerous version is silent: a mangled `--nmt` that happens to
 * still exit 0 would mean the gate is checking something other than what it claims.
 *
 * So: resolve bare names to a real path ONCE via `where`/`which`, then spawn with `shell: false`.
 * The single exception is a Windows `.cmd`/`.bat` wrapper (npm): Node refuses to spawn those
 * without a shell (CVE-2024-27980), so those go through cmd.exe -- and we assert their arguments
 * are metacharacter-free rather than trusting quoting.
 */
const UNSAFE_IN_CMD = /[&|<>^()"%!]/;
/** @type {Map<string, string|null>} */
const binCache = new Map();

/** Resolve a bare command name to an absolute path, or null when it is not installed. */
function resolveBin(name) {
  if (path.isAbsolute(name)) return name;
  if (binCache.has(name)) return binCache.get(name) ?? null;
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
  const lines = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // `where npm` lists both the extensionless shell script and npm.cmd; only the latter is
  // runnable here, so prefer a real executable extension over the first line.
  const pick = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
  binCache.set(name, pick);
  return pick;
}

/** Spawn a command, streaming output through, and resolve its exit code (127 when not found). */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const bin = resolveBin(cmd);
    if (!bin) return resolve(127);
    const needsShell = WIN && /\.(cmd|bat)$/i.test(bin);
    if (needsShell) {
      const bad = args.filter((a) => UNSAFE_IN_CMD.test(a));
      if (bad.length) {
        // Refuse rather than run a silently different command than the one printed.
        console.error(
          `${C.r}refusing to run ${cmd} through cmd.exe with shell-unsafe args:${C.x} ${bad.join(' ')}\n` +
            `  A .cmd wrapper cannot be spawned without a shell, and cmd.exe would reinterpret these.\n` +
            `  Invoke the underlying executable directly in scripts/gate.mjs instead.`,
        );
        return resolve(1);
      }
    }
    // With shell:true, Node concatenates rather than escaping, so the binary path has to carry its
    // own quotes -- npm.cmd lives at "C:\Program Files\nodejs\npm.cmd" and cmd.exe would otherwise
    // split it at the space and try to run `C:\Program`. Args are metacharacter-free by the check
    // above, so plain concatenation of the rest is safe.
    const p = spawn(needsShell ? `"${bin}"` : bin, args, { cwd, stdio: 'inherit', shell: needsShell });
    p.on('error', (e) => resolve(/** @type {any} */ (e).code === 'ENOENT' ? 127 : 1));
    p.on('close', (code) => resolve(code ?? 1));
  });
}

/** Is a binary reachable? Used for preflight and for the slither skip. */
function present(bin) {
  return resolveBin(bin) !== null;
}

async function runSyntaxStep() {
  for (const f of ENTRYPOINTS) {
    const abs = path.join(REPO, f);
    if (!existsSync(abs)) {
      // A renamed or deleted entrypoint means this gate has silently stopped covering it.
      console.error(`${C.r}missing entrypoint: ${f}${C.x} -- update ENTRYPOINTS in scripts/gate.mjs`);
      return 1;
    }
    const code = await run(process.execPath, ['--check', abs], REPO);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * Persist the run for `npm run cc`. Untracked (see .gitignore) -- it describes THIS machine's last
 * run, not a property of the branch, so committing it would just create merge conflicts.
 */
function writeGateState(results, totalMs) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
  const state = {
    at: new Date().toISOString(),
    commit: (head.stdout || '').trim() || null,
    // A gate run against a dirty tree does not certify the commit; the board must not imply it did.
    treeDirty: Boolean((dirty.stdout || '').trim()),
    totalMs,
    mode: { quick: QUICK, runAll: RUN_ALL, only: ONLY ? [...ONLY] : null },
    passed: !results.some((r) => r.state === 'fail'),
    steps: results.map((r) => ({ id: r.s.id, state: r.state, ms: r.ms })),
  };
  try {
    writeFileSync(path.join(REPO, '.gate-state.json'), JSON.stringify(state, null, 2) + '\n');
  } catch {
    // Never let bookkeeping fail the gate -- the verdict on the console is the real product.
  }
}

// ---------------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();

  // PREFLIGHT. A gate that passes because its tools are missing is worse than no gate at all.
  if (!present('forge')) {
    console.error(
      `\n${C.r}forge is not on PATH.${C.x} Every contract step would be skipped and the gate would ` +
        `report a meaningless pass.\nInstall Foundry v1.7.1 (the version CI pins) and re-run.\n`,
    );
    process.exit(2);
  }
  const hasSlither = present('slither');

  let steps = STEPS.filter((s) => (ONLY ? ONLY.has(s.id) : true)).filter((s) => !(QUICK && s.quickSkip));
  if (ONLY) {
    const unknown = [...ONLY].filter((id) => !STEPS.some((s) => s.id === id));
    if (unknown.length) {
      console.error(`${C.r}unknown step(s): ${unknown.join(', ')}${C.x}  (see --list)`);
      process.exit(2);
    }
  }

  const mode = [QUICK && 'quick', RUN_ALL && 'run-all', ONLY && `only=${[...ONLY].join(',')}`].filter(Boolean).join(' ');
  console.log(`\n${C.b}pre-merge gate${C.x} ${C.d}(mirrors ci.yml)${C.x}${mode ? ` ${C.d}[${mode}]${C.x}` : ''}`);
  console.log(`${C.d}${steps.length} steps${QUICK ? ' -- gas snapshot dropped by --quick' : ''}${C.x}\n`);

  const results = [];
  let failed = false;

  for (const [i, s] of steps.entries()) {
    const label = `[${i + 1}/${steps.length}] ${s.title}`;

    if (s.id === 'slither' && !hasSlither) {
      console.log(`${C.y}SKIP${C.x} ${label} ${C.d}-- slither not installed (advisory in CI too)${C.x}\n`);
      results.push({ s, state: 'skip', ms: 0 });
      continue;
    }

    console.log(`${C.b}${label}${C.x}`);
    const st = Date.now();
    const code = s.id === SYNTAX_STEP ? await runSyntaxStep() : await run(s.cmd, s.args, s.cwd ?? REPO);
    const ms = Date.now() - st;

    const expected = s.expectExit ?? 0;
    let ok = code === expected;
    let note = '';
    if (!ok && s.expectExit !== undefined) note = ` (expected exit ${expected}, got ${code})`;
    if (code === 127) note = ` (command not found: ${s.cmd})`;

    if (ok) {
      console.log(`${C.g}PASS${C.x} ${s.title} ${C.d}${secs(ms)}${C.x}\n`);
      results.push({ s, state: 'pass', ms });
    } else if (s.advisory) {
      console.log(`${C.y}WARN${C.x} ${s.title}${note} ${C.d}${secs(ms)} -- advisory, does not fail the gate${C.x}\n`);
      results.push({ s, state: 'warn', ms });
    } else {
      console.log(`${C.r}FAIL${C.x} ${s.title}${note} ${C.d}${secs(ms)}${C.x}\n`);
      results.push({ s, state: 'fail', ms, code });
      failed = true;
      if (!RUN_ALL) {
        results.push(...steps.slice(i + 1).map((rest) => ({ s: rest, state: 'notrun', ms: 0 })));
        break;
      }
    }
  }

  // Record the run so `npm run cc` can report gate health WITHOUT re-running it -- and, more
  // importantly, can report the COMMIT the gate last passed on. A green gate from three commits
  // ago is not evidence about the working tree, and the status board has to be able to say so.
  writeGateState(results, Date.now() - t0);

  // ------------------------------------------------------------------ summary
  console.log(`${C.b}${'-'.repeat(64)}${C.x}`);
  for (const r of results) {
    const tag =
      { pass: `${C.g}pass${C.x}`, fail: `${C.r}FAIL${C.x}`, warn: `${C.y}warn${C.x}`, skip: `${C.d}skip${C.x}`, notrun: `${C.d}not run${C.x}` }[
        r.state
      ] ?? r.state;
    console.log(`  ${tag.padEnd(16)} ${r.s.id.padEnd(10)} ${r.ms ? C.d + secs(r.ms) + C.x : ''}`);
  }
  const total = secs(Date.now() - t0);
  console.log(`${C.b}${'-'.repeat(64)}${C.x}`);

  if (failed) {
    const first = results.find((r) => r.state === 'fail');
    console.log(`\n${C.r}${C.b}GATE FAILED${C.x} on ${C.b}${first?.s.id}${C.x} ${C.d}(${total})${C.x}`);
    console.log(`${C.d}Re-run just that step: npm run gate -- --only ${first?.s.id}${C.x}`);
    if (first?.s.id === 'test' || first?.s.id === 'snapshot') {
      // Do not let a genuine finding get filed as "the gate is flaky".
      console.log(
        `${C.d}Note: the fuzz corpus is unseeded, so this may be a REAL new counterexample rather than\n` +
          `      a broken gate. Read the failing case before dismissing it.${C.x}`,
      );
    }
    console.log('');
    process.exit(1);
  }

  const warned = results.filter((r) => r.state === 'warn').length;
  console.log(`\n${C.g}${C.b}GATE PASSED${C.x} ${C.d}(${total})${C.x}${warned ? ` ${C.y}${warned} advisory warning(s)${C.x}` : ''}`);
  if (QUICK) console.log(`${C.y}--quick: the gas snapshot did NOT run. Run the full gate before merging.${C.x}`);
  console.log(`${C.d}Reminder: package-lock.json changes are not covered -- run \`npm ci\` by hand if you touched it.${C.x}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
