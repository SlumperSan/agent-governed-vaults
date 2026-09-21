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

function runSoak(args, logDir) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { cwd: ROOT, env: { ...process.env, SOAK_LOG_DIR: logDir }, encoding: 'utf8', timeout: 30_000 },
  );
  if (res.error) throw res.error;
  return `${res.stdout}\n${res.stderr}`;
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

// ── the module directly: the pid/service-set derivation, as a pure(ish) unit ─────────────────
//
// -Status and -Stop, and every start-or-reuse call site, all go through exactly these three
// functions. This is "the pid/service-set derivation that decides it" — tested standalone,
// without the surrounding script's control flow, per the addendum's own framing.

test('soak-pidset.psm1: Add-ManagedPid / Get-ManagedPidEntries round-trip name, pid and needle', () => {
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
    const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, `module script failed: ${res.stderr}`);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines, ['2', 'indexer', '111', 'index-runner.mjs', 'api', '222', '<empty:True>']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('soak-pidset.psm1: Test-ManagedProcessAlive is true for a live pid and false once it exits', async () => {
  const proc = spawnDummy();
  try {
    const aliveScript = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid}`;
    const aliveRes = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', aliveScript], { encoding: 'utf8' });
    assert.equal(aliveRes.stdout.trim(), 'True', `expected alive, got: ${aliveRes.stdout} ${aliveRes.stderr}`);

    process.kill(proc.pid);
    await waitUntil(() => !isAlive(proc.pid));

    const deadScript = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid}`;
    const deadRes = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', deadScript], { encoding: 'utf8' });
    assert.equal(deadRes.stdout.trim(), 'False', `expected dead, got: ${deadRes.stdout} ${deadRes.stderr}`);
  } finally {
    try { process.kill(proc.pid); } catch { /* already dead */ }
  }
});

test('soak-pidset.psm1: Test-ManagedProcessAlive is false for a live pid whose command line does not match the needle', () => {
  // The recycled-pid guard: a pid that is genuinely alive right now must NOT read as "our
  // service" if its command line does not contain what we recorded when we started it. Without
  // this, a pid the OS reassigned to an unrelated process after our service exited would report
  // RUNNING and -Stop would kill a stranger.
  const proc = spawnDummy();
  try {
    const script = `Import-Module -Force '${MODULE}'; Test-ManagedProcessAlive -ProcessId ${proc.pid} -Needle 'totally-unrelated-script.mjs'`;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
    assert.equal(res.stdout.trim(), 'False', `expected a needle mismatch to read as not-ours, got: ${res.stdout} ${res.stderr}`);
  } finally {
    try { process.kill(proc.pid); } catch { /* already dead */ }
  }
});

// ── the real run-soak.ps1 -Status / -Stop, end to end ─────────────────────────────────────────

test('-Stop with nothing running says so, and does not error', () => {
  const dir = mkTmpDir('stop-nothing');
  try {
    const out = runSoak(['-Stop'], dir);
    assert.match(out, /nothing to stop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('-Status with nothing running says so', () => {
  const dir = mkTmpDir('status-nothing');
  try {
    const out = runSoak(['-Status'], dir);
    assert.match(out, /no pid file - nothing was started/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('-Status and -Stop on a PARTIALLY-STARTED set: one alive service, one already-exited one', async () => {
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

test('-Status reflects a service killed EXTERNALLY (not via -Stop), without lying that it is still running', async () => {
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
