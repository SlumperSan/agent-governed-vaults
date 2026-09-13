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
 *      IT MATCHES ONLY WHAT EACH FILE EXECUTES, never the prose around it, because both files
 *      are heavily commented and every one of those comments names the scripts it is explaining.
 *      In ci.yml the corpus is the value of each `run:` key and nothing else, with YAML and shell
 *      comments removed; in gate.mjs it is the source with line and block comments removed, and
 *      the match is anchored to the `args:` array literal rather than floating over the step.
 *      Without both halves a deleted step whose `name:`, `title:` or explanatory comment survived
 *      would still read as wired -- which is precisely the state ci.yml was in when this file
 *      first landed. See `invokedIn` and `executableText` below.
 *
 * WHAT LEG 2 STILL CANNOT PROVE, stated because the first version of this header claimed a
 * property the code did not have. It is a text match over two files. It does not prove either
 * pipeline ran, nor that the step it found is reachable: an `if:` condition, `continue-on-error`,
 * a job outside the required set, a `quickSkip` dropped by `npm run gate -- --quick`, or an
 * `args:` literal sitting in a STEPS entry no filter selects would all satisfy it. `scripts/
 * gate.mjs` proves its own half the only way that can be proven, by running.
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
 * Cut a line at the comment that opens on it, quote-aware.
 *
 * `#` opens a comment in YAML and in POSIX shell under the same condition -- it has to open a
 * word, so it is either the first character or preceded by whitespace -- and in neither language
 * does it open one inside a quoted scalar or a quoted shell word. That single rule serves both
 * halves of `ciRunCommands` below.
 */
const stripHashComment = (line) => {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

/** `|`, `>`, `|-`, `>+2`: a block scalar header, so the value is on the lines below it. */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/**
 * THE SHELL THE WORKFLOW ACTUALLY RUNS: the value of every `run:` key, and nothing else.
 *
 * THIS IS THE HOLE THIS FILE SHIPPED WITH, and it is recorded here rather than in a commit
 * message because the next person to widen leg 2 needs it. Leg 2 matched `npm run <name>` against
 * the whole text of ci.yml, and ci.yml explains itself at length: `npm run test:backend` occurs
 * there four times, three of them inside comments. Deleting the real step stops all 79 of the 81
 * test files that script runs -- THIS FILE AMONG THEM, since it lives under `scripts/test/` --
 * leaving CI with the one file under `test:app` and the one under `apps/site-next`. All three
 * legs stayed green, and `npm run gate` stayed green with them, because leg 2 requires BOTH
 * files and gate.mjs's own step was untouched. The header claimed that could not happen. Reading
 * only `run:` values closes it, and closes the neighbouring case of a `name:` that quotes the
 * script it is naming.
 */
const ciRunCommands = (yaml) => {
  const lines = yaml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:-\s+)?run:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[1].trim();
    if (value !== '' && !BLOCK_SCALAR.test(value)) {
      out.push(stripHashComment(value));
      continue;
    }
    // A block scalar (`run: |`) and a plain scalar wrapped onto the next line (`run:`, then the
    // command indented under it) both continue below, over every line indented deeper than the
    // key. The one bare `run:` GitHub Actions defines for itself is `defaults.run`, whose
    // children are `shell:` and `working-directory:` and cannot hold an npm invocation -- so
    // reading those two lines costs nothing, while SKIPPING a bare `run:` would make a legal
    // reflow of a real step read as a deleted one.
    const keyIndent = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].search(/\S/) <= keyIndent) break;
      out.push(stripHashComment(lines[j]));
    }
  }
  return out.join('\n');
};

/**
 * `scripts/gate.mjs` with its comments removed, so an `args:` vector quoted inside one cannot
 * stand in for the step it describes. That is not hypothetical either: it is how the ci.yml hole
 * above was found, by writing exactly such a comment and watching this file stay green.
 *
 * LINE-ORIENTED ON PURPOSE. A scanner run over the whole file has to tell a regex literal from a
 * division to know whether a quote inside it opens a string, and gate.mjs contains
 * `/[&|<>^()"%!]/`. Get that wrong once and the rest of the file is swallowed as a string, and
 * this guard goes red for a reason that has nothing to do with wiring. Per line, the worst case
 * is one line left uncut, and every `args:` vector in gate.mjs is written on one line.
 */
const stripJsComments = (src) => {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let kept = '';
    let quote = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inBlock) {
        if (c === '*' && raw[i + 1] === '/') {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (quote) {
        kept += c;
        if (c === '\\') kept += raw[++i] ?? '';
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '/' && raw[i + 1] === '/') break;
      else if (c === '/' && raw[i + 1] === '*') {
        inBlock = true;
        i++;
        continue;
      }
      kept += c;
    }
    out.push(kept);
  }
  return out.join('\n');
};

/** What each pipeline file EXECUTES, which is the only text leg 2 is allowed to look at. */
const executableText = () => ({
  'scripts/gate.mjs': stripJsComments(readFileSync(path.join(REPO, 'scripts', 'gate.mjs'), 'utf8')),
  '.github/workflows/ci.yml': ciRunCommands(readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')),
});

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
 * `invokedIn` IS A SHAPE MATCHED AGAINST A NARROWED CORPUS, and it needs both halves to be worth
 * anything. The shape: the argument vector under its `args:` key (`args: ['run', 'test:app']`),
 * and the shell line (`npm run test:app`), rather than the script's name, which the `title:`, the
 * `name:` and the surrounding prose all repeat. The corpus: `executableText()` above, which is
 * gate.mjs without its comments and ONLY the `run:` values of ci.yml. Either half alone is
 * defeated by a comment -- the shape by quoting an `args:` line inside one, the corpus by a
 * `title:` string that happens to contain the invocation.
 *
 * WHAT IT STILL DOES NOT ESTABLISH: that anything ran. It is a text match. A step behind an `if:`,
 * a job outside the required set, `continue-on-error: true`, or a STEPS entry that `--quick` or
 * `--only` filters out all satisfy it. `scripts/gate.mjs` establishes its own half by running,
 * which is why a green gate and a green CI are the merge bar and this file is only the tripwire.
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
          // `args:` anchors the match to the vector the step is BUILT from. Without it a `why:`
          // or a `title:` string carrying the same two tokens would answer for the step.
          'scripts/gate.mjs': new RegExp(`args:\\s*\\[\\s*'run'\\s*,\\s*'${esc(name)}'\\s*\\]`),
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
          // would satisfy this, and the test step could be deleted with nothing going red. Both
          // steps exist here, so this is the pair the mutation table has to discriminate.
          'scripts/gate.mjs': new RegExp(`args:\\s*\\[\\s*'test'\\s*,\\s*'--workspace'\\s*,\\s*'${esc(ws)}'\\s*\\]`),
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

/**
 * 81 test files today. Deliberately loose, and deliberately NOT sold as more than it is.
 *
 * WHAT A COUNT FLOOR PROVES: that the walk did not collapse -- that `discoverTestFiles` returned
 * a real set rather than the empty one that would make the subset check above pass over nothing.
 * That is the failure this repository actually shipped twice, and it is the only thing this
 * number is here for.
 *
 * WHAT IT DOES NOT PROVE, at 70 or at any number a deletion would not trip: that no directory
 * went missing. A `SKIP_DIRS` entry that swallowed one package's tests would take 81 to 75 and
 * this assertion would not notice. The check that DOES notice is `dead` below -- a swallowed
 * directory that a wired script still globs makes that glob match zero files, and that is
 * reported. The residual gap is a directory that is both swallowed and unwired, which is
 * invisible to every leg here; nothing short of comparing against `git ls-files` would see it.
 *
 * The floor is loose on purpose: tightening it to 79 or 80 would turn every legitimate test
 * deletion into an unrelated red in an unrelated PR, and buy no property the paragraph above
 * does not already say it lacks.
 */
const FILE_FLOOR = 70;

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
  const text = executableText();

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
      'WHAT WAS SEARCHED, so a false red here is diagnosable: not the two files, but what they\n' +
      'execute. For ci.yml that is the value of every `run:` key with YAML and shell comments cut;\n' +
      'for gate.mjs it is the source with comments cut, and the match is anchored to `args:`. A step\n' +
      "deleted while its `name:`, its `title:` or its explanatory comment survives is therefore\n" +
      'reported here rather than read as still wired. If you believe the step IS present, check that\n' +
      'it sits under a `run:` (ci.yml) or in an `args:` array literal (gate.mjs) -- prose naming the\n' +
      'script deliberately does not count.\n\n' +
      `${missing.join('\n')}`,
  );
});

test('the enumeration and the globs are non-empty, so neither check above is vacuous', () => {
  const files = discoverTestFiles();
  const scripts = wiredScripts();

  assert.ok(
    files.length >= FILE_FLOOR,
    `Walked ${files.length} test files, expected at least ${FILE_FLOOR}. A subset check over an empty\n` +
      'set passes and proves nothing, so this asserts the walk still returns a real set -- and that is\n' +
      'ALL it asserts. It is a collapse detector, not a census: with 81 files today it cannot tell you\n' +
      'that one directory stopped being walked. Reaching this line means the walk broke outright, or\n' +
      'SKIP_DIRS grew an entry that swallows most of the repository.',
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
