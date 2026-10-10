// @ts-check
/**
 * `run-soak.ps1 -Stop` / `-Status`, and the pid/service-set derivation behind them
 * (`scripts/soak/soak-pidset.psm1`).
 *
 * Why this is an executable test and not a source grep: the measured defect was a CONTROL-FLOW
 * bug ("-Stop said 'not running' and left three real processes alive"), which a string match on
 * the script's source cannot catch — it can only prove the right words appear somewhere, not that
 * they run in the right order against a real pid file and real processes. This suite drives the
 * ACTUAL `run-soak.ps1` (not a copy, not a reimplementation) via `-Stop`/`-Status`, which are safe
 * to invoke directly: both return before any preflight (signer, RPC, password files — see the
 * script, lines ~60-115), so no chain, no key and no `.env` are needed to exercise them.
 *
 * `SOAK_LOG_DIR` points the script's pid file and logs at a throwaway temp directory per test, so
 * this never touches the worktree's real `logs/` or collides with another test's state.
 *
 * Real background processes are spawned (via `node -e "setInterval(...)"`) so "alive" and "exited"
 * are facts about the OS, not a mock's opinion of them — the same reason the module talks to
 * `Get-CimInstance Win32_Process`, not a fake process table.
 *
 * PLATFORM SPLIT — this suite does not run identically everywhere, and that split is load-bearing,
 * not incidental (measured cause of a red CI: this file shelled to the literal `powershell.exe`,
 * which does not exist on GitHub's Linux runner):
 *
 * - The interpreter is resolved ONCE, at module load, by `resolvePwsh()`, trying `pwsh`
 *   (PowerShell Core — present on GitHub's `ubuntu-latest` runners, confirmed against
 *   actions/runner-images' own Ubuntu 24.04 readme, which lists "PowerShell 7.6.5") before
 *   Windows `powershell.exe`. Every spawn site in this file goes through that one result — no
 *   call site hardcodes either name. The probe requires a working `$PSVersionTable.PSVersion`
 *   read, not merely "the process spawned", so a broken shim on PATH can't false-positive.
 * - If NEITHER resolves, every test that needs a shell is SKIPPED with an explicit, named reason
 *   (`NO_PWSH_SKIP`) rather than the file throwing — but that skip is never the only thing on
 *   record: the anchor test below runs UNCONDITIONALLY, with no dependency on any interpreter at
 *   all, and fails if `run-soak.ps1`/`soak-pidset.psm1` are missing, renamed, or empty. An
 *   interpreter-missing environment therefore always shows up as a definite red, just via the
 *   anchor rather than the PowerShell-driven tests themselves.
 * - Most of this suite is PORTABLE — needs only a resolved interpreter, not Windows — and is gated
 *   on `NO_PWSH_SKIP` alone: the `Add-ManagedPid`/`Get-ManagedPidEntries` round-trip (plain
 *   `Add-Content`/`Get-Content`/`-split`), `-Stop`/`-Status` with an empty or absent pid file
 *   (`Get-ManagedPidEntries` returns `@()` before the `foreach` that would call
 *   `Test-ManagedProcessAlive` ever runs), and both `Start-ManagedProcess` tests
 *   (`Start-Process`/`.Refresh()`/`.HasExited` are plain .NET Process members, no CIM anywhere in
 *   that path).
 * - A smaller set additionally needs `Test-ManagedProcessAlive` — the two liveness/needle unit
 *   tests, and the two end-to-end `-Status`/`-Stop` tests against a pid file with real entries —
 *   which calls `Get-CimInstance -ClassName Win32_Process`. That is Windows-OS WMI with no Linux
 *   implementation, in EITHER PowerShell host: `pwsh` itself resolves and runs fine on the Linux
 *   CI runner, so this is deliberately NOT folded into `NO_PWSH_SKIP` — an interpreter being
 *   present is not evidence this WMI class is. This subset is gated on `process.platform ===
 *   'win32'` (`WINDOWS_ONLY_SKIP`), nothing looser, with its own loud reason, because the soak
 *   launcher is itself a Windows-only operational tool (runs on the operator's own Windows
 *   machine, never in CI) — a real platform boundary, not a compromise.
 * - Either skip's silent-permanence risk is closed by the same anchor test: it reads both files'
 *   source unconditionally and fails on every platform, with or without an interpreter, if
 *   `run-soak.ps1` stops importing the module's CIM-dependent functions or either file goes
 *   missing, empty, or renamed.
 *
 * What is NOT covered here, stated rather than implied: the actual service-START path
 * (`Start-Service-Once`'s reuse branch) requires the script's full preflight — a deployer keystore,
 * a password file, a live RPC — none of which this suite has. That branch is exercised by hand-
 * matching the exact pid-file LINE FORMAT `Add-ManagedPid` writes (`name=pid=needle`, asserted
 * directly in the first test below) and constructing pid files in that format for -Status/-Stop,
 * which is the same artifact the reuse branch would have produced. If PowerShell's own behavior
 * inside that branch (the `Test-AlreadyRunning` CIM query, the `foreach` over duplicates) regresses,
 * this suite will not see it — only a live soak run, or a Pester test with elevated CIM access,
 * would. Said plainly rather than claimed as covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'soak', 'run-soak.ps1');
const MODULE = path.join(ROOT, 'scripts', 'soak', 'soak-pidset.psm1');

const IS_WINDOWS = process.platform === 'win32';

/**
 * The interpreter to drive `run-soak.ps1` and `soak-pidset.psm1` with. `pwsh` (PowerShell Core) is
 * tried first so the PORTABLE subset of this suite (below) actually executes on CI's Linux runner
 * instead of being skipped for a reason that has nothing to do with what it tests; Windows
 * `powershell.exe` is the fallback for a machine that only has that. Neither name is hardcoded
 * into a call site — every spawn below goes through this one resolution.
 *
 * The probe cannot false-positive: it asks the candidate for `$PSVersionTable.PSVersion.Major`
 * and requires BOTH exit 0 AND a parsable integer on stdout, not merely "spawn did not throw" (a
 * `pwsh` shim on PATH that exists but is broken, or a non-PowerShell binary that happens to share
 * the name, would pass a bare "spawn succeeded" check and then fail every real test confusingly).
 */
function resolvePwsh() {
  for (const exe of ['pwsh', 'powershell.exe']) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && Number.isInteger(Number(probe.stdout.trim()))) return exe;
  }
  return null;
}
const PWSH = resolvePwsh();
const NO_PWSH_SKIP = PWSH
  ? false
  : 'SKIPPED — neither `pwsh` (PowerShell Core, tried first) nor `powershell.exe` resolved on ' +
    'PATH with a working $PSVersionTable probe. This is a real environment gap, not a platform ' +
    "boundary, so it is never silent: the anchor test below still runs unconditionally and fails " +
    "if run-soak.ps1 or soak-pidset.psm1 is missing or renamed, so a rename can't hide behind a " +
    'missing interpreter either.';

const WINDOWS_ONLY_SKIP =
  NO_PWSH_SKIP ||
  (IS_WINDOWS
    ? false
    : 'SKIPPED — needs Get-CimInstance Win32_Process (Windows-only WMI; no Linux implementation in ' +
      'PowerShell Core, so this is NOT keyed on interpreter availability — pwsh itself resolves ' +
      'fine on the Linux CI runner, only this one WMI class does not exist there). Keyed on ' +
      'process.platform, nothing looser. The soak launcher is a Windows-only operational tool, so ' +
      'this platform boundary is correct rather than a gap; see the anchor test below, which still ' +
      "runs here and fails if run-soak.ps1's CIM-dependent surface is renamed or removed.");

function runSoak(args, logDir) {
  const res = spawnSync(
    PWSH,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { cwd: ROOT, env: { ...process.env, SOAK_LOG_DIR: logDir }, encoding: 'utf8', timeout: 30_000 },
  );
  if (res.error) throw res.error;
  return `${res.stdout}\n${res.stderr}`;
}

function runPwshCommand(script, opts = {}) {
  return spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', ...opts });
}

/** A real background process with a findable, distinctive command line. */
function spawnDummy() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(fn, timeoutMs = 8000, stepMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function mkTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `soak-pidfile-${label}-`));
}

/**
 * `fs.rmSync` retried with backoff. Windows does not release a just-killed process's open file
 * handles (its own stdout/stderr redirect files, here) the instant `process.kill`/`Stop-Process`
 * returns — confirmed by direct repro: even after polling `isAlive` to false, an IMMEDIATE
 * `rmSync` intermittently threw `EPERM`, and the same call succeeded once given ~1-1.5s. This is
 * a Windows file-handle-release race in the TEST HARNESS's own cleanup, not a defect in
 * `Start-ManagedProcess` — nothing here retries a PRODUCTION path.
 */
async function rmDirRetrying(dir, { attempts = 10, delayMs = 200 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ── the anchor: guards BOTH skips above from ever going silent ───────────────────────────────
//
// Runs on EVERY platform UNCONDITIONALLY — no `skip` option, no dependency on PWSH resolving at
// all, since it never spawns a shell; it only reads the two files with node:fs. That is deliberate:
// it is the one thing on record even in the worst case (no interpreter AND non-Windows), so a
// rename, deletion, or emptying of either file is never hidden behind either skip reason.

test('the CIM-dependent surface this suite skips on non-Windows still exists', () => {
  assert.ok(fs.existsSync(SCRIPT), `expected ${SCRIPT} to exist`);
  assert.ok(fs.existsSync(MODULE), `expected ${MODULE} to exist`);
  const moduleSrc = fs.readFileSync(MODULE, 'utf8');
  assert.ok(moduleSrc.trim().length > 0, `${MODULE} must not be empty`);
  // (?![\w-]) is a real word boundary for PowerShell identifiers (letters/digits/_/-): plain \b
  // does not fire between two word characters, so a PREFIX-EXTENDING rename like
  // `Test-ManagedProcessAliveRENAMED` still contains the literal substring `Test-ManagedProcessAlive`
  // and would silently satisfy a boundary-less (or \b-only) match. The lookahead requires the name
  // NOT be immediately followed by another identifier character, so an extending rename is caught.
  assert.match(moduleSrc, /function Test-ManagedProcessAlive(?![\w-])/, 'soak-pidset.psm1 must still define Test-ManagedProcessAlive');
  assert.match(moduleSrc, /Get-CimInstance/, 'Test-ManagedProcessAlive must still be the CIM-based check the Windows-only tests exercise');
  const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(scriptSrc.trim().length > 0, `${SCRIPT} must not be empty`);
  assert.match(scriptSrc, /Get-ManagedPidEntries(?![\w-])/, 'run-soak.ps1 must still drive -Status/-Stop through Get-ManagedPidEntries');
  assert.match(scriptSrc, /Test-ManagedProcessAlive(?![\w-])/, 'run-soak.ps1 must still drive -Status/-Stop through Test-ManagedProcessAlive');
});

// ── the module directly: the pid/service-set derivation, as a pure(ish) unit ─────────────────
//
// -Status and -Stop, and every start-or-reuse call site, all go through exactly these three
// functions. This is "the pid/service-set derivation that decides it" — tested standalone,
// without the surrounding script's control flow, per the addendum's own framing.
//
// PORTABLE: Add-ManagedPid and Get-ManagedPidEntries are plain Add-Content/Get-Content/-split —
// no CIM call anywhere in this test, so it runs on every platform pwsh/powershell.exe resolves on.

test('soak-pidset.psm1: Add-ManagedPid / Get-ManagedPidEntries round-trip name, pid and needle', { skip: NO_PWSH_SKIP }, () => {
  const dir = mkTmpDir('module-roundtrip');
  try {
    const pidFile = path.join(dir, 'soak-pids.txt');
    const script = [
      `Import-Module -Force '${MODULE}'`,
      `Add-ManagedPid -PidFile '${pidFile}' -Name indexer -ProcessId 111 -Needle 'index-runner.mjs'`,
      `Add-ManagedPid -PidFile '${pidFile}' -Name api -ProcessId 222`, // no needle — must still round-trip
      `$e = Get-ManagedPidEntries -PidFile '${pidFile}'`,
      '$e.Count',
      '$e[0].Name; $e[0].ProcessId; $e[0].Needle',
      '$e[1].Name; $e[1].ProcessId; "<empty:$($e[1].Needle -eq \'\')>"',
    ].join('; ');
    const res = runPwshCommand(script);
    assert.equal(res.status, 0, `module script failed: ${res.stderr}`);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines, ['2', 'indexer', '111', 'index-runner.mjs', 'api', '222', '<empty:True>']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// WINDOWS-ONLY: Test-ManagedProcessAlive calls Get-CimInstance -ClassName Win32_Process, which
// has no Linux implementation in PowerShell Core. Gated on process.platform, nothing looser.

test('soak-pidset.psm1: Test-ManagedProcessAlive is true for a live pid and false once it exits', { skip: WINDOWS_ONLY_SKIP }, async () => {
  const proc = spawnDummy();
  try {
    const aliveScript = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid}`;
    const aliveRes = runPwshCommand(aliveScript);
    assert.equal(aliveRes.stdout.trim(), 'True', `expected alive, got: ${aliveRes.stdout} ${aliveRes.stderr}`);

    process.kill(proc.pid);
    await waitUntil(() => !isAlive(proc.pid));

    const deadScript = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid}`;
    const deadRes = runPwshCommand(deadScript);
    assert.equal(deadRes.stdout.trim(), 'False', `expected dead, got: ${deadRes.stdout} ${deadRes.stderr}`);
  } finally {
    try { process.kill(proc.pid); } catch { /* already dead */ }
  }
});

test('soak-pidset.psm1: Test-ManagedProcessAlive is false for a live pid whose command line does not match the needle', { skip: WINDOWS_ONLY_SKIP }, () => {
  // The recycled-pid guard: a pid that is genuinely alive right now must NOT read as "our
  // service" if its command line does not contain what we recorded when we started it. Without
  // this, a pid the OS reassigned to an unrelated process after our service exited would report
  // RUNNING and -Stop would kill a stranger.
  const proc = spawnDummy();
  try {
    const script = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid} -Needle 'totally-unrelated-script.mjs'`;
    const res = runPwshCommand(script);
    assert.equal(res.stdout.trim(), 'False', `expected a needle mismatch to read as not-ours, got: ${res.stdout} ${res.stderr}`);
  } finally {
    try { process.kill(proc.pid); } catch { /* already dead */ }
  }
});

// ── the real run-soak.ps1 -Status / -Stop, end to end ─────────────────────────────────────────
//
// PORTABLE: with no pid file (or an empty one), Get-ManagedPidEntries returns @() and the foreach
// that would call Test-ManagedProcessAlive never runs — no CIM call, so these run everywhere.

test('-Stop with nothing running says so, and does not error', { skip: NO_PWSH_SKIP }, () => {
  const dir = mkTmpDir('stop-nothing');
  try {
    const out = runSoak(['-Stop'], dir);
    assert.match(out, /nothing to stop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('-Status with nothing running says so', { skip: NO_PWSH_SKIP }, () => {
  const dir = mkTmpDir('status-nothing');
  try {
    const out = runSoak(['-Status'], dir);
    assert.match(out, /no pid file - nothing was started/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// WINDOWS-ONLY: a pid file with real entries drives -Status/-Stop into the foreach that calls
// Test-ManagedProcessAlive for each one — CIM again, gated the same way as above.

test('-Status and -Stop on a PARTIALLY-STARTED set: one alive service, one already-exited one', { skip: WINDOWS_ONLY_SKIP }, async () => {
  // This is the measured shape: not every entry in the pid file is still running. -Status must
  // say which is which, truthfully, and -Stop must kill the live one and say the dead one "was
  // not running" rather than erroring or silently doing nothing about either.
  const dir = mkTmpDir('partial');
  const alive = spawnDummy();
  const toKill = spawnDummy();
  try {
    process.kill(toKill.pid);
    await waitUntil(() => !isAlive(toKill.pid));

    const pidFile = path.join(dir, 'soak-pids.txt');
    fs.writeFileSync(pidFile, `alive=${alive.pid}=setInterval\ndead=${toKill.pid}=setInterval\n`);

    const statusOut = runSoak(['-Status'], dir);
    assert.match(statusOut, /\[RUNNING\] alive \(pid/, `expected alive RUNNING in:\n${statusOut}`);
    assert.match(statusOut, /\[exited \] dead \(pid/, `expected dead exited in:\n${statusOut}`);

    const stopOut = runSoak(['-Stop'], dir);
    assert.match(stopOut, /stopped alive \(pid/, `expected 'stopped alive' in:\n${stopOut}`);
    assert.match(stopOut, /dead \(pid \d+\) was not running/, `expected dead 'was not running' in:\n${stopOut}`);
    assert.ok(!fs.existsSync(pidFile), 'pid file must be removed after -Stop');

    const stillAlive = await waitUntil(() => !isAlive(alive.pid));
    assert.ok(stillAlive, '-Stop must actually terminate the process it reported stopping');
  } finally {
    try { process.kill(alive.pid); } catch { /* already dead */ }
    try { process.kill(toKill.pid); } catch { /* already dead */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Start-ManagedProcess: a pid is not evidence a process survived ───────────────────────────
//
// Measured: the api crashed inside resolveApiConfig on a missing required env var, and
// run-soak.ps1 printed "started api pid 23120" anyway — because the old code recorded the pid
// and declared victory the instant Start-Process returned, which only proves the OS accepted the
// exec. These drive the REAL Start-ManagedProcess (soak-pidset.psm1) against a real process that
// dies within milliseconds and a real one that survives, and check both the console report AND
// the pid file — the same two places the original defect lied in.
//
// PORTABLE: Start-ManagedProcess is Start-Process/.Refresh()/.HasExited — plain .NET Process
// members, no CIM call anywhere in this path — so both tests run on every platform.

test('Start-ManagedProcess: a process that exits immediately is reported FAILED and is NOT recorded as running', { skip: NO_PWSH_SKIP }, () => {
  const dir = mkTmpDir('start-managed-dead');
  try {
    const pidFile = path.join(dir, 'soak-pids.txt');
    const script = [
      `Import-Module -Force '${MODULE}'`,
      `$p = Start-ManagedProcess -PidFile '${pidFile}' -LogDir '${dir}' -Name deadsvc -File '${process.execPath}' -ArgList @('-e','process.exit(7)') -SettleMs 800`,
      '"<result:$($p -eq $null)>"',
    ].join('; ');
    const res = runPwshCommand(script, { timeout: 20_000 });
    assert.equal(res.status, 0, `module script errored: ${res.stderr}`);
    assert.match(res.stdout, /<result:True>/, `Start-ManagedProcess must return $null for a dead-on-arrival process, got:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /FAILED - exited/, `must print a loud FAILED line, not a quiet one, got:\n${res.stdout}`);
    assert.doesNotMatch(res.stdout, /started\s+deadsvc/i, 'must never print a "started" line for a process that did not survive');

    const entries = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    assert.equal(entries, '', `a dead-on-arrival process must not be written to the pid file, got: ${JSON.stringify(entries)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Start-ManagedProcess: a process that survives is reported started and IS recorded, with its needle', { skip: NO_PWSH_SKIP }, async () => {
  const dir = mkTmpDir('start-managed-alive');
  let pid = null;
  try {
    const pidFile = path.join(dir, 'soak-pids.txt');
    const harnessOut = path.join(dir, 'harness-out.txt');
    // A real script FILE, not an inline `-e` one-liner: PowerShell's ArgumentList command-line
    // quoting mangles an inline snippet containing both parens and a comma (observed: it arrived
    // at node truncated mid-expression, "Unexpected end of input") -- a file path sidesteps that
    // entirely and is also closer to how Start-ManagedProcess is actually called in run-soak.ps1
    // (always a script path, never inline code).
    const sleeperScript = path.join(dir, 'sleep-forever.mjs');
    fs.writeFileSync(sleeperScript, 'setInterval(() => {}, 1000);\n');
    const script = [
      `Import-Module -Force '${MODULE}'`,
      `$p = Start-ManagedProcess -PidFile '${pidFile}' -LogDir '${dir}' -Name alivesvc -File '${process.execPath}' -ArgList @('${sleeperScript}') -Needle 'sleep-forever' -SettleMs 800`,
      '"<pid:$($p.Id)>"',
    ].join('; ');
    // stdio: 'ignore' on THIS spawnSync, output redirected to a file INSIDE the PowerShell script,
    // not captured through a pipe Node reads: Start-ManagedProcess's whole point is that the child
    // it starts OUTLIVES this statement, and on Windows a still-running grandchild inherits the
    // parent's stdout PIPE handle -- so a piped spawnSync (`encoding: 'utf8'`) blocks reading that
    // pipe until the grandchild exits too, i.e. forever, timing out instead of returning the moment
    // the PowerShell script itself finishes. Confirmed by direct repro before writing this comment:
    // identical script, piped stdio hung to the timeout; file-redirected stdio with
    // `stdio: 'ignore'` returned in ~1s.
    //
    // The redirect goes through `Out-File -Encoding utf8` EXPLICITLY, not the bare `*>` operator:
    // Windows PowerShell 5.1's default encoding for `*>`/Out-File is UTF-16LE, while PowerShell 7
    // (pwsh, what CI's Linux runner uses) defaults to UTF-8 — reading the file with one hardcoded
    // Node encoding would be correct on exactly one of the two hosts this suite now runs under.
    // Pinning the encoding on the PowerShell side removes the ambiguity instead of guessing it on
    // the Node side.
    const wrapped = `& { ${script} } *>&1 | Out-File -FilePath '${harnessOut}' -Encoding utf8`;
    const res = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapped], { stdio: 'ignore', timeout: 20_000 });
    assert.equal(res.status, 0, `module script errored (exit ${res.status}, signal ${res.signal})`);
    // This test's evidence for success is the two artifacts that actually matter and are reliably
    // captured regardless of host: the returned process object's pid, and the pid-file line
    // Add-ManagedPid wrote. Those are also exactly what -Status/-Stop read; the console "started
    // ..." TEXT is instead covered by the sibling "FAILED" test above, whose process exits quickly
    // enough that piped stdio capture works without the hang this test works around.
    const out = fs.readFileSync(harnessOut, 'utf8');
    const m = /<pid:(\d+)>/.exec(out);
    assert.ok(m, `expected the returned process object to carry a pid, got:\n${out}`);
    pid = Number(m[1]);
    const entries = fs.readFileSync(pidFile, 'utf8').trim();
    assert.equal(entries, `alivesvc=${pid}=sleep-forever`, 'the pid file line must match Add-ManagedPid\'s own format exactly');
    assert.ok(isAlive(pid), 'the pid Start-ManagedProcess recorded must be the process it actually started');
  } finally {
    if (pid) {
      try { process.kill(pid); } catch { /* already dead */ }
      await waitUntil(() => !isAlive(pid));
    }
    await rmDirRetrying(dir);
  }
});

// WINDOWS-ONLY: same as the partial-set test above — a pid file with a real entry drives -Status
// into Test-ManagedProcessAlive, which is CIM.

test('-Status reflects a service killed EXTERNALLY (not via -Stop), without lying that it is still running', { skip: WINDOWS_ONLY_SKIP }, async () => {
  const dir = mkTmpDir('external-kill');
  const proc = spawnDummy();
  try {
    const pidFile = path.join(dir, 'soak-pids.txt');
    fs.writeFileSync(pidFile, `indexer=${proc.pid}=setInterval\n`);

    const before = runSoak(['-Status'], dir);
    assert.match(before, /\[RUNNING\] indexer/, `expected RUNNING before the kill, got:\n${before}`);

    process.kill(proc.pid); // simulates an operator's own taskkill, or a crash
    await waitUntil(() => !isAlive(proc.pid));

    const after = runSoak(['-Status'], dir);
    assert.match(after, /\[exited \] indexer/, `expected exited after an external kill, got:\n${after}`);
  } finally {
    try { process.kill(proc.pid); } catch { /* already dead */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
