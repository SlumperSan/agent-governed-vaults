// @ts-check
/**
 * A DOCUMENT MAY NOT POINT AN OPERATOR AT A DEPLOYMENT RECORD THIS REPOSITORY DELETED.
 *
 * `docs/INCIDENTS.md` opens "read the first section before any incident", and its §0 banner linked
 * `contracts/config/deployments/robinhood-mainnet.json` for thirteen paragraphs after that file left
 * the tree in `60f33a95`. `SECURITY.md` sent external researchers to the same path. Someone reading
 * either under pressure follows a link into nothing, having just been told there is capital to
 * protect on a chain nobody monitors.
 *
 * TWO DISTINCTIONS, BOTH MECHANICAL, because a missing record is not automatically an error.
 *
 * FIRST, deleted versus never written. `docs/evidence/arc-deploy-runbook.md` names
 * `contracts/config/deployments/arc-mainnet.json` as the file a future deploy must WRITE, which is
 * an instruction rather than a citation. Telling those apart by wording ("write", "create") would be
 * a guard anyone can walk around by rephrasing, so history tells them apart instead: a path this
 * repository has NEVER contained is forward-looking; a path it once contained and no longer does is a
 * dead citation. `git log --diff-filter=A` answers that, and nothing in the prose can change it.
 *
 * SECOND, and this is what keeps the guard from banning the remediation itself: a deleted record may
 * be NAMED, as long as the naming carries its retrieval route. "The record was X, removed in
 * `60f33a95`, read it with `git show 60f33a95^:X`" is the correct sentence and must stay legal; "see
 * X" and "[X](../X)" are the defect, because both assert the file is there. So a mention must share
 * its line with a backticked commit-ish or a `git show`, and a markdown LINK to a deleted record is
 * an offender unconditionally — a link is an assertion of presence that no adjacent sha repairs.
 * Requiring the route is not a wording rule that rephrasing defeats: satisfying it means actually
 * telling the reader where the file went.
 *
 * SCOPE, STATED RATHER THAN SILENT. Published documentation: every `*.md` at the repository root and
 * everything under `docs/`. NOT `skills/`: `skills/rwally-claims-contract/SKILL.md` carries the same
 * dead reference, and that file is the claims CONTRACT for public copy — it is pinned in lockstep
 * with `apps/site/test/site.test.mjs`, so changing what it permits is a copy-policy decision that
 * belongs to Marketing rather than a citation fix. It is routed there, not excluded because it was
 * inconvenient. When that lands, widen `PROSE_ROOTS` here rather than adding an exception.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const RECORD_DIR = 'contracts/config/deployments';

/** Every reference to a deployment record, however it is written: a link, or inline code. */
const REFERENCE = new RegExp(`(?:\\.\\./)*${RECORD_DIR}/([A-Za-z0-9._-]+\\.json)`, 'g');

/**
 * The retrieval route a mention of a deleted record must carry: a backticked commit-ish, or a
 * `git show`. Lowercase hex inside backticks does not match an address — those are `0x`-prefixed and
 * mixed case — so naming `VaultFactory 0xc44B853F…` on the line does not satisfy this.
 */
const ROUTE = /`[0-9a-f]{7,40}`|git show/;

/** A markdown link whose href is this record: an assertion that the file is present. */
const linkTo = (line, file) =>
  new RegExp(`\\]\\([^)]*${RECORD_DIR.replace(/\//g, '\\/')}/${file.replace(/\./g, '\\.')}[^)]*\\)`).test(line);

/** Published documentation. See SCOPE above before widening or narrowing this. */
const PROSE_ROOTS = ['.', 'docs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-ssr', 'out', 'cache', 'lib', 'broadcast', '.wrangler']);

function proseFiles() {
  const out = [];
  const walk = (rel, recurse) => {
    const abs = path.join(REPO, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs)) {
      if (SKIP_DIRS.has(e)) continue;
      const childRel = rel === '.' ? e : `${rel}/${e}`;
      if (statSync(path.join(REPO, childRel)).isDirectory()) {
        if (recurse) walk(childRel, true);
      } else if (e.endsWith('.md')) out.push(childRel);
    }
  };
  walk('.', false);
  for (const r of PROSE_ROOTS.filter((r) => r !== '.')) walk(r, true);
  return out.sort();
}

/** Has this path EVER existed in this repository? A `git log` over every ref, not over the tree. */
function everExisted(repoPath) {
  const r = spawnSync('git', ['log', '--all', '--diff-filter=A', '--format=%h', '--', repoPath], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return (r.stdout || '').trim().length > 0;
}

test('no published document cites a deployment record that was deleted', () => {
  const offenders = [];
  for (const rel of proseFiles()) {
    const text = readFileSync(path.join(REPO, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REFERENCE)) {
        const repoPath = `${RECORD_DIR}/${m[1]}`;
        if (existsSync(path.join(REPO, repoPath))) continue;
        // A path this repository never held is a target to be written, not a citation.
        if (!everExisted(repoPath)) continue;
        if (linkTo(line, m[1])) {
          offenders.push(`${rel}:${i + 1}  LINK to ${repoPath}`);
        } else if (!ROUTE.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${repoPath} named with no retrieval route`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'these point a reader at a deployment record this repository deleted. A LINK asserts the file is '
      + 'there: remove it. A mention must carry where the file went, on its own line — the removing '
      + 'commit in backticks, or `git show <sha>^:<path>`:\n  '
      + offenders.join('\n  '),
  );
});

test('probe: the guard sees a dead citation, and lets a never-written target through', () => {
  // Without this, the test above is green over a broken matcher and proves nothing. Both legs are
  // asserted because the two cases are the whole point of the guard.
  const dead = `${RECORD_DIR}/robinhood-mainnet.json`;
  const future = `${RECORD_DIR}/arc-mainnet.json`;

  assert.ok(!existsSync(path.join(REPO, dead)), 'fixture assumption: the 4663 record is deleted');
  assert.ok(everExisted(dead), 'the deleted record must be findable in history, or the guard cannot fire');

  assert.ok(!existsSync(path.join(REPO, future)), 'fixture assumption: the Arc record is not written yet');
  assert.equal(everExisted(future), false, 'a never-written target must not look like a dead citation');

  // The matcher reaches both spellings the offending documents actually used: a markdown link with a
  // `../` prefix, and a bare inline-code path.
  const link = `[\`${RECORD_DIR}/robinhood-mainnet.json\`](../${RECORD_DIR}/robinhood-mainnet.json)`;
  const inline = `see \`${RECORD_DIR}/robinhood-mainnet.json\` for the addresses`;
  for (const sample of [link, inline]) {
    const hits = [...sample.matchAll(REFERENCE)].map((m) => m[1]);
    assert.ok(hits.includes('robinhood-mainnet.json'), `matcher missed: ${sample}`);
  }

  // The route rule, both directions. These are the exact shapes the fix and the defect take.
  assert.ok(linkTo(link, 'robinhood-mainnet.json'), 'a link to a deleted record must be seen as a link');
  assert.ok(!linkTo(inline, 'robinhood-mainnet.json'), 'an inline-code mention is not a link');
  assert.ok(!ROUTE.test(inline), '"see X" carries no retrieval route and must be an offender');
  assert.ok(
    ROUTE.test(`its record left this repository in \`60f33a95\``),
    'a backticked commit-ish is a retrieval route',
  );
  assert.ok(
    ROUTE.test(`git show 60f33a95^:${RECORD_DIR}/robinhood-mainnet.json`),
    'a git show command is a retrieval route',
  );
  assert.ok(
    !ROUTE.test('`VaultFactory` `0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1`, settlement token USDG'),
    'an address must NOT read as a commit-ish, or naming the factory would excuse the dead citation',
  );
});

test('the record that DOES exist is cited by name across the documentation, so this is not vacuous', () => {
  // An absence check over a corpus that mentions no deployment record at all would be green and
  // meaningless. At least one live citation of the surviving record must be present.
  const live = `${RECORD_DIR}/base-sepolia.json`;
  assert.ok(existsSync(path.join(REPO, live)), 'the Base Sepolia record must exist');
  const citing = proseFiles().filter((rel) => readFileSync(path.join(REPO, rel), 'utf8').includes(live));
  assert.ok(citing.length >= 3, `only ${citing.length} document(s) cite ${live}; the corpus walk is probably wrong`);
});
