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
 * FIRST, deleted versus never written. `contracts/config/deployments/arc-mainnet.json` WAS the
 * never-written example here — `docs/evidence/arc-deploy-runbook.md` named it as the file a future
 * deploy must WRITE, an instruction rather than a citation — until the Arc mainnet deploy wrote it
 * on 2026-09-24; the probe test below now uses `contracts/config/deployments/base-mainnet.json`
 * instead, for the same reason. Telling a forward-looking mention apart from a dead citation by
 * wording ("write", "create") would be a guard anyone can walk around by rephrasing, so history
 * tells them apart instead: a path this repository has NEVER contained is forward-looking; a path
 * it once contained and no longer does is a dead citation. `git log --diff-filter=A` answers that,
 * and nothing in the prose can change it.
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
 * SCOPE: every `*.md` at the repository root and everything under `docs/` and `skills/`.
 *
 * THE ONE EXCEPTION IS ENFORCED BY THIS FILE, NOT DESCRIBED BESIDE IT, and that distinction is the
 * point. `skills/rwally-claims-contract/SKILL.md` carries the same dead reference, and it is the
 * claims CONTRACT for public copy — pinned in lockstep with the "every deployed" test in
 * `apps/site/test/site.test.mjs` — so what it permits is a copy-policy decision that belongs to
 * Marketing rather than a citation fix. Leaving `skills/` OUT OF THE WALK would have expressed that
 * in a comment, and the next person to widen the corpus would have silently re-included it while
 * believing they had changed nothing. Instead the directory is walked and the file is named in
 * `ROUTED_ELSEWHERE`, with an owner and a reason.
 *
 * AND THE EXCEPTION EXPIRES BY ITSELF. A second test asserts every entry is STILL an offender, so
 * the moment Marketing fixes that file the suite goes red and names the entry to delete. An
 * allowlist that outlives its reason is the shape that turns a guard into decoration; this one
 * cannot.
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
const PROSE_ROOTS = ['.', 'docs', 'skills'];

/**
 * Files whose dead citation is another department's decision to make. Each entry must name the owner
 * and the reason, and each is asserted below to be STILL an offender — an entry that has become
 * unnecessary fails the suite rather than sitting here.
 */
const ROUTED_ELSEWHERE = Object.freeze([
  {
    file: 'skills/rwally-claims-contract/SKILL.md',
    owner: 'Marketing',
    why: 'the claims contract for public copy: it licenses positive "deployed" sentences on the premise '
      + 'that the protocol IS deployed on chain 4663, and cites the deleted record as the checkable '
      + 'evidence. Retiring that premise is a copy-policy change, and the bullet is pinned in lockstep '
      + 'with the "every deployed" test in apps/site/test/site.test.mjs, so the site copy has to move in '
      + 'the same change.',
  },
]);
const ROUTED_FILES = new Set(ROUTED_ELSEWHERE.map((r) => r.file));
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

/** Every dead-record citation in the corpus, keyed by file. Shared by both tests below. */
function deadCitations() {
  const byFile = new Map();
  for (const rel of proseFiles()) {
    const text = readFileSync(path.join(REPO, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REFERENCE)) {
        const repoPath = `${RECORD_DIR}/${m[1]}`;
        if (existsSync(path.join(REPO, repoPath))) continue;
        // A path this repository never held is a target to be written, not a citation.
        if (!everExisted(repoPath)) continue;
        const found = linkTo(line, m[1])
          ? `${rel}:${i + 1}  LINK to ${repoPath}`
          : !ROUTE.test(line)
            ? `${rel}:${i + 1}  ${repoPath} named with no retrieval route`
            : null;
        if (found) byFile.set(rel, [...(byFile.get(rel) ?? []), found]);
      }
    });
  }
  return byFile;
}

test('no published document cites a deployment record that was deleted', () => {
  const byFile = deadCitations();
  const offenders = [...byFile].filter(([rel]) => !ROUTED_FILES.has(rel)).flatMap(([, v]) => v);
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
  // arc-mainnet.json was this fixture until the Arc mainnet deploy wrote it on 2026-09-24;
  // base-mainnet.json is the next real never-written target (contracts/config/base-mainnet.json,
  // the launch-parameter config, already exists — this is the deployment record, a different file).
  const future = `${RECORD_DIR}/base-mainnet.json`;

  assert.ok(!existsSync(path.join(REPO, dead)), 'fixture assumption: the 4663 record is deleted');
  assert.ok(everExisted(dead), 'the deleted record must be findable in history, or the guard cannot fire');

  assert.ok(!existsSync(path.join(REPO, future)), 'fixture assumption: the Base mainnet record is not written yet');
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

test('every ROUTED_ELSEWHERE entry is still needed — a spent exception must be deleted, not kept', () => {
  // This is what makes the exception expire by itself. When Marketing retires the premise in that
  // SKILL.md, the file stops being an offender and this test names the entry to remove. Without it,
  // the allowlist would outlive its reason and quietly shrink the guard's corpus for good.
  const byFile = deadCitations();
  const spent = ROUTED_ELSEWHERE.filter((r) => !byFile.has(r.file));
  assert.deepEqual(
    spent.map((r) => r.file),
    [],
    'these no longer cite a deleted deployment record, so their ROUTED_ELSEWHERE entries are spent. '
      + 'Delete the entry — the file is now covered by the guard like everything else:\n  '
      + spent.map((r) => `${r.file} (routed to ${r.owner})`).join('\n  '),
  );

  // And the walk must actually reach them, or "still an offender" would be answered by a corpus that
  // never looks: a routed file outside PROSE_ROOTS would pass the assertion above for the wrong reason.
  const walked = new Set(proseFiles());
  for (const r of ROUTED_ELSEWHERE) {
    assert.ok(walked.has(r.file), `${r.file} is routed but not walked; widen PROSE_ROOTS`);
  }
});

test('the record that DOES exist is cited by name across the documentation, so this is not vacuous', () => {
  // An absence check over a corpus that mentions no deployment record at all would be green and
  // meaningless. At least one live citation of the surviving record must be present.
  const live = `${RECORD_DIR}/base-sepolia.json`;
  assert.ok(existsSync(path.join(REPO, live)), 'the Base Sepolia record must exist');
  const citing = proseFiles().filter((rel) => readFileSync(path.join(REPO, rel), 'utf8').includes(live));
  assert.ok(citing.length >= 3, `only ${citing.length} document(s) cite ${live}; the corpus walk is probably wrong`);
});
