// @ts-check
/**
 * The run-directly guard in fixtures/seed-snapshot.mjs.
 *
 * The failure this catches is a SILENT one: the guard decides whether `node
 * packages/reference-agent/fixtures/seed-snapshot.mjs <path>` seeds anything at all. When it does
 * not fire, the process exits 0 having written no snapshot and printed nothing, so the demo in
 * docs/REFERENCE-AGENT.md:28 goes on to serve an empty snapshot rather than reporting an error.
 *
 * It used to be decided by `import.meta.url === `file://${argv[1].replace(/\\/g, '/')}`` — a
 * hand-rolled path-to-URL translation. `import.meta.url` percent-encodes, argv[1] does not, so
 * from a checkout under `.../sp ace/` the two sides read `sp%20ace` and `sp ace` and never match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * seed-snapshot.mjs and its complete static-import closure. Static imports resolve at load, so a
 * missing one kills the child before the guard is reached; the `../../indexer/...` specifiers also
 * mean the copies have to keep their directory layout. Everything else these five reach for is a
 * node builtin (verified by reading each file's import list).
 */
const CLOSURE = [
  ['packages', 'reference-agent', 'fixtures', 'seed-snapshot.mjs'],
  ['packages', 'reference-agent', 'fixtures', 'demo-chain.mjs'],
  ['packages', 'indexer', 'src', 'projections.mjs'],
  ['packages', 'indexer', 'src', 'store.mjs'],
  ['packages', 'oplog', 'src', 'durable.mjs'],
];

test('seed-snapshot.mjs seeds when run as a script from a path containing a space', () => {
  // Reproduced the way the docs invoke it — as the main module, so the child's argv[1] is the
  // copied file itself — from a tree whose path contains a space. os.tmpdir() rather than a fixed
  // directory so this runs on the CI runner as well as here; mkdtemp so concurrent runs cannot
  // collide.
  //
  // realpath because the guard is not symlink-transparent: node realpaths the main module's
  // import.meta.url but leaves process.argv[1] as given, so a scratch root reached through a
  // symlink (os.tmpdir() is /var/folders/... → /private/var/... on macOS) would fail this test for
  // that reason instead of the percent-encoding one it exists to pin.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-snapshot-space-')));
  const root = path.join(scratch, 'sp ace');
  try {
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    for (const rel of CLOSURE) {
      fs.mkdirSync(path.join(root, ...rel.slice(0, -1)), { recursive: true });
      fs.copyFileSync(path.join(repo, ...rel), path.join(root, ...rel));
    }

    const script = path.join(root, ...CLOSURE[0]);
    const out = path.join(root, 'data', 'demo-snapshot.json');
    assert.ok(script.includes(' '), 'the script path under test must contain a space');

    const stdout = execFileSync(process.execPath, [script, out], { encoding: 'utf8' });

    // The guard firing is observable two ways, and both are asserted: the branch's own console.log
    // and the snapshot it writes. Asserting only the exit code would pass on a guard that never
    // fired, because not seeding also exits 0.
    assert.match(stdout, /^seeded /m,
      'the run-directly branch must fire — no output means the guard did not match argv[1]');
    assert.equal(fs.existsSync(out), true, 'the branch must write the snapshot it reports seeding');

    const snapshot = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(snapshot.lastBlock, 1010, 'the snapshot must be the one seed() builds');
    assert.ok(Object.keys(snapshot.vaults ?? {}).length > 0, 'the seeded snapshot must carry vaults');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
