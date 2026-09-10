/**
 * Every test file in this repository is actually executed by CI and by `npm run gate`.
 *
 * WHY THIS EXISTS. `apps/app/test/claims.test.mjs` was written, reviewed and merged, and then
 * ran in no pipeline for weeks. `npm run test:backend` enumerates its directories by hand --
 * `packages/oplog/test/*.test.mjs packages/indexer/test/*.test.mjs ...` -- and `apps/app` was
 * simply not among them. Nothing was red. A claims guard that never runs is worse than an absent
 * one, because the discipline it is supposed to enforce is assumed to be enforced.
 *
 * That is the second inert guard this repository has shipped. The first was the soak's
 * freeze-safety leg, which read a `SOAK_VAULTS` environment variable nothing ever set, so it
 * mapped over an empty array and reported all clear. Both have the same shape: a check whose
 * INPUT is empty, reporting a pass over nothing that reads exactly like a pass over everything.
 *
 * SO THIS FILE CHECKS THE WIRING, NOT THE CODE. Two independent legs:
 *
 *   1. COVERAGE. Enumerate every `*.test.mjs` from the filesystem, then enumerate the files the
 *      wired npm scripts actually run, and assert the first set is a subset of the second.
 *   2. INVOCATION. Assert every wired script is invoked by BOTH `.github/workflows/ci.yml` and
 *      `scripts/gate.mjs`. A script that exists but nothing calls is the same defect one level up.
 *      It matches the INVOCATION and not the script's name: searching gate.mjs for the string
 *      `test:app` is satisfied by the step's own `title`, and by the comment explaining why the
 *      step exists, so the step could be deleted and the prose alone would read as wired. See
 *      `invokedIn` below.
 *
 * THE COVERED SET IS DERIVED, NEVER RESTATED. It is read out of the `scripts` block of
 * package.json and of each workspace package.json. Hardcoding the nine directories here would
 * rebuild, in a guard, exactly the hand-maintained list the guard exists to police.
 *
 * NON-VACUITY IS ASSERTED, because that is the failure mode being guarded against. A walk that
 * finds nothing and a glob that matches nothing both produce an empty difference, and an empty
 * difference is green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Directories this walk does not enter. `.claude` is the load-bearing one: around ten agent
 * sessions keep worktrees under `.claude/worktrees/`, each a full copy of this repository, and a
 * walk that descended into them would find every test file several times over and blame the
 * change under test. `claims-lede-truth.test.mjs` and `config-doc-truth.test.mjs` carry the same
 * entry for the same reason.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'lib',
  'out',
  'dist',
  'dist-ssr',
  'cache',
  'broadcast',
  'coverage',
  'artifacts',
]);

/** A repo-relative, slash-separated path, so comparisons do not depend on the platform. */
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

/** Every `*.test.mjs` in the repository, enumerated from the filesystem -- never from a list. */
const discoverTestFiles = () => {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.test.mjs')) {
        found.push(rel(path.join(dir, entry.name)));
      }
    }
  })(REPO);
  return found.sort();
};

/** Escape a literal for embedding in a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The npm scripts that run `node --test`, each with the directory its paths are relative to and
 * the shape its invocation takes in each pipeline.
 *
 * Root scripts are matched on their COMMAND (`node --test`), not on their name, so a new
 * `test:whatever` is picked up the day it is written rather than the day someone remembers this
 * file. Workspace scripts are the `test` script of any workspace package.json -- that is how
 * `apps/site-next` runs, as its own CI and gate step.
 *
 * THE CONTRACT THAT SELECTOR CREATES, stated rather than left as a trap: a root script that runs
 * `node --test` MUST be a step of both pipelines. There is no third category here, no "manual
 * runner that happens to use the test runner". If you want one, do not give it a root `test:*`
 * script; call the file directly, as `scripts/smoke-test.mjs` and the soak drills do.
 *
 * `invokedIn` IS A SHAPE, NOT A NAME, and that distinction is the whole value of leg 2. A
 * `.includes('test:app')` over gate.mjs is satisfied by the step's own `title`, and by the comment
 * that explains why the step exists -- so deleting the step and leaving the prose behind would read
 * as wired. Matching the argument vector (`'run', 'test:app'`) and the shell line
 * (`npm run test:app`) means the thing being matched is the invocation itself. It is still a text
 * match over a file and cannot prove execution; `scripts/gate.mjs` proves that by running.
 */
const wiredScripts = () => {
  const out = [];
  const rootPkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  for (const [name, cmd] of Object.entries(rootPkg.scripts ?? {})) {
    if (typeof cmd === 'string' && cmd.includes('node --test')) {
      out.push({
        id: name,
        kind: 'root',
        cmd,
        base: REPO,
        invokedAs: `npm run ${name}`,
        invokedIn: {
          'scripts/gate.mjs': new RegExp(`'run'\\s*,\\s*'${esc(name)}'`),
          '.github/workflows/ci.yml': new RegExp(`npm[ \\t]+run[ \\t]+${esc(name)}(?![\\w:.-])`),
        },
      });
    }
  }

  // The workspace globs are `packages/*` and `apps/*`; expand them off the filesystem so a new
  // workspace is covered without editing this file.
  for (const glob of rootPkg.workspaces ?? []) {
    const parent = path.join(REPO, glob.replace(/\/\*$/, ''));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parent, entry.name);
      const pkgFile = path.join(dir, 'package.json');
      if (!existsSync(pkgFile)) continue; // apps/app and apps/site carry none, by design
      const cmd = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts?.test;
      if (typeof cmd !== 'string' || !cmd.includes('node --test')) continue;
      const ws = rel(dir);
      out.push({
        id: `${ws}#test`,
        kind: 'workspace',
        cmd,
        base: dir,
        invokedAs: `npm test --workspace ${ws}`,
        invokedIn: {
          // The `'test',` prefix matters: without it a `build --workspace apps/site-next` step
          // would satisfy this, and the test step could be deleted with nothing going red.
          'scripts/gate.mjs': new RegExp(`'test'\\s*,\\s*'--workspace'\\s*,\\s*'${esc(ws)}'`),
          '.github/workflows/ci.yml': new RegExp(`npm[ \\t]+test[ \\t]+--workspace[ \\t]+${esc(ws)}(?![\\w/.-])`),
        },
      });
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * The path arguments of a `node --test` command: every token that ends in `.test.mjs`. Flags
 * (`--test-reporter=tap`) do not, and neither does `node`, so no allowlist of flags is needed --
 * one that existed would go stale the first time Node grew an option.
 */
const globTokens = (cmd) => cmd.split(/\s+/).filter((t) => t.endsWith('.test.mjs'));

/** `apps/*/test/*.test.mjs` semantics: `*` matches within one path segment and nothing else. */
const globToRegExp = (glob) =>
  new RegExp(`^${glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

const expand = (script, files) => {
  const prefix = script.base === REPO ? '' : `${rel(script.base)}/`;
  const matched = new Map();
  for (const token of globTokens(script.cmd)) {
    const re = globToRegExp(prefix + token);
    matched.set(token, files.filter((f) => re.test(f)));
  }
  return matched;
};

const FILE_FLOOR = 70; // 79 today. A floor, not a count: adding tests must not red this file.

test('every test file in the repository is run by a wired npm script', () => {
  const files = discoverTestFiles();
  const scripts = wiredScripts();

  const covered = new Set();
  for (const s of scripts) for (const hits of expand(s, files).values()) for (const f of hits) covered.add(f);

  const orphans = files.filter((f) => !covered.has(f));
  assert.deepEqual(
    orphans,
    [],
    'These test files are executed by nothing. They are not failing -- they are not running, which\n' +
      'is the state `apps/app/test/claims.test.mjs` was in for weeks while the repository treated its\n' +
      'assertions as enforced.\n\n' +
      `Not run anywhere:\n  ${orphans.join('\n  ')}\n\n` +
      'Fix by adding the directory to `test:backend` in the root package.json, or -- when the file\n' +
      'must not share a `node --test` batch with the repository-wide walks, as apps/app must not --\n' +
      'by giving it its own root script plus the matching step in BOTH scripts/gate.mjs and\n' +
      '.github/workflows/ci.yml. The next test in this file checks that second half.',
  );
});

test('every wired script is invoked by both scripts/gate.mjs and .github/workflows/ci.yml', () => {
  const text = {
    'scripts/gate.mjs': readFileSync(path.join(REPO, 'scripts', 'gate.mjs'), 'utf8'),
    '.github/workflows/ci.yml': readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'),
  };

  const missing = [];
  for (const s of wiredScripts()) {
    for (const [file, re] of Object.entries(s.invokedIn)) {
      if (!re.test(text[file])) missing.push(`  ${file} does not invoke \`${s.invokedAs}\` (${s.id}); looked for ${re}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    'A script that runs tests but that no pipeline calls is the same defect as an unwired test file,\n' +
      'one level up. gate.mjs states its own contract: it must mirror ci.yml, not a subset of it.\n\n' +
      'What is matched is the INVOCATION and not the script name, so a step deleted while its title\n' +
      'or its explanatory comment stays behind is caught rather than read as still wired.\n\n' +
      `${missing.join('\n')}`,
  );
});

test('the enumeration and the globs are non-empty, so neither check above is vacuous', () => {
  const files = discoverTestFiles();
  const scripts = wiredScripts();

  assert.ok(
    files.length >= FILE_FLOOR,
    `Walked ${files.length} test files, expected at least ${FILE_FLOOR}. A subset check over an empty\n` +
      'set passes and proves nothing. Either the walk broke, or SKIP_DIRS grew an entry that swallows\n' +
      'real test directories.',
  );

  assert.ok(scripts.length >= 3, `Found ${scripts.length} wired script(s), expected at least 3 (test:app, test:backend, apps/site-next#test).`);

  const dead = [];
  for (const s of scripts) {
    for (const [token, hits] of expand(s, files)) {
      if (hits.length === 0) dead.push(`  ${s.id}: "${token}" matches no file`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    'A glob that matches nothing is the drift the first test guards, running the other way: a\n' +
      'workspace was renamed or removed and the script kept pointing at where it used to be. It costs\n' +
      'no CI time and reports no error, so nothing else would ever say so.\n\n' +
      `${dead.join('\n')}`,
  );
});
