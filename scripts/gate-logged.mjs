// @ts-check
/**
 * `npm run gate`, with every byte it prints kept in a file.
 *
 * WHY THIS EXISTS, and it is a specific failure rather than a nicety. On 2026-09-19 the gate reported
 * `GATE FAILED on backend` on a head under review, and the six runs after it were clean. **The
 * failing test's name was never captured**, because the only record of a gate run is what happens to
 * be on screen, and the reviewer had read the tail. So the red could not be attributed and could not
 * be dismissed: a gate that reds at random is this repository's own stated reason not to trust red,
 * and at that point a red here was untrustworthy in BOTH directions. One unreproducible failure with
 * no artefact costs more than the whole suite's runtime.
 *
 * `.gate-state.json` records the VERDICT per step. It has never recorded the OUTPUT, which is the
 * half you need when a step fails once.
 *
 * WHY A WRAPPER RATHER THAN A CHANGE TO gate.mjs. The gate spawns forge, npm and node with
 * `stdio: 'inherit'`, which is what makes their progress appear live and unbuffered. Capturing inside
 * gate.mjs means piping those children, which changes what every developer sees on every run and how
 * those tools buffer — a behaviour change to the thing everyone runs, in order to fix a diagnostic
 * gap. This wrapper leaves `npm run gate` byte-for-byte as it was and adds a second way to invoke it.
 *
 * WHAT IT DOES NOT DO. It does not interpret, filter or summarise. A filter is how the line you
 * needed gets dropped: the reviewer above lost the failing test name to a `grep` over the tail. The
 * log is the raw stream, in order, and the exit code is the gate's own.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(REPO, 'scripts', 'gate.mjs');

/**
 * OUTSIDE THE REPOSITORY, AND THAT IS THE WHOLE DESIGN RATHER THAN TIDINESS.
 *
 * The first version wrote `.gate-logs/` at the repo root, gitignored. The very next gate run went
 * RED: `claims-key-custody-truth.test.mjs` walks the filesystem for prose, found the log, and read a
 * PASSING TEST'S OWN NAME — `no unqualified "no RPC client" claim about the API` — as a surface
 * making that claim. A log of the guards tripping the guards.
 *
 * The obvious repair is to add `.gate-logs` to that file's `SKIP_DIRS`. There are seven independent
 * `SKIP_DIRS` sets in this repository and nothing keeps them in step, so that repair is seven edits
 * and a trap for the eighth guard somebody writes tomorrow. `.gitignore` does not help either: these
 * walks read the filesystem, not the index.
 *
 * So the logs live under the OS temp directory, in a per-checkout folder. A file that is not in the
 * tree cannot be found by anything that walks the tree, for any guard, including ones not yet
 * written. The absolute path is printed at the end of every run, and `GATE_LOG_DIR` overrides it for
 * anyone who wants them somewhere specific — pointing that INSIDE the repo re-opens exactly the
 * failure described above.
 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = process.env.GATE_LOG_DIR
  ? path.resolve(process.env.GATE_LOG_DIR)
  : path.join(os.tmpdir(), 'agv-gate-logs', path.basename(REPO));
mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, `gate-${stamp}.log`);
const log = createWriteStream(logPath, { flags: 'a' });

const args = process.argv.slice(2);
log.write(`# npm run gate ${args.join(' ')}\n# started ${new Date().toISOString()}\n\n`);

// NO_COLOR so the file holds text rather than escape sequences. The child's own `isTTY` check is
// already false through a pipe, so this is belt and braces for any step that colours regardless.
const child = spawn(process.execPath, [GATE, ...args], {
  cwd: REPO,
  env: { ...process.env, NO_COLOR: '1' },
  stdio: ['inherit', 'pipe', 'pipe'],
});

/** Tee one stream to our own and to the log, unchanged and in order. */
const tee = (from, to) => {
  from.on('data', (chunk) => {
    to.write(chunk);
    log.write(chunk);
  });
};
tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on('error', (e) => {
  const msg = `\ngate-logged: could not start the gate: ${e.message}\n`;
  process.stderr.write(msg);
  log.write(msg);
  // Exit 2, matching gate.mjs's own code for "the gate could not run" rather than for a defect.
  log.end(() => process.exit(2));
});

child.on('close', (code) => {
  // The absolute path, because the file is deliberately not under the repo and a relative path from
  // here would be a string of `../`.
  const tail = `\nfull output: ${logPath}\n`;
  process.stdout.write(tail);
  log.write(`\n# exit ${code ?? 1} at ${new Date().toISOString()}\n`);
  // Exit only once the file is flushed, or a failing run loses the bytes that explain it.
  log.end(() => process.exit(code ?? 1));
});
