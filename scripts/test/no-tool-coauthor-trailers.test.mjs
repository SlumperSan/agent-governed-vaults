// @ts-check
/**
 * Commits authored by a human carry no tool as a co-author.
 *
 * WHY THIS IS A TEST AND NOT A HABIT. The rule has existed in the working agreement the whole time
 * ("no Co-Authored-By trailers for Claude or any tool; commits are authored by the human"), and on
 * 2026-09-19 it was broken twice in one session and SHIPPED both times: `64d8eeb4` and `f269009b` on
 * `protocol/main` each carry `Co-Authored-By: Claude Opus 5`. Five more branches were one merge away
 * from the same thing and were only caught because someone checked the log rather than assuming the
 * squash dropped it.
 *
 * That is the whole argument for a guard over a habit: the habit was in force, was known, and failed
 * silently — because the trailer is invisible in a diff, invisible in a PR's file list, and lands via
 * GitHub's squash composer (PR title + commit bodies), which nothing in this repo controls.
 *
 * WHAT IT CHECKS, and where it stops. The commits on THIS branch above `protocol/main` — which is
 * exactly the set GitHub concatenates into a squash body. It deliberately does NOT scan history:
 * `64d8eeb4` and `f269009b` are already on `protocol/main`, and rewriting published history to remove
 * a wart in the log would rewrite every SHA after it, break every clone and worktree on the machine,
 * and invalidate every verdict, deployment record and Findings note that cites a commit by id. The
 * cost of that fix is larger than the defect. So those two stay, and this guard stops the next one
 * rather than pretending to undo them — recorded here so a later reader does not read their existence
 * as evidence the check is broken.
 *
 * WHERE IT STILL CANNOT SEE: a trailer typed directly into the PR BODY on GitHub. The body is also
 * part of the squash message and no guard in this repository walks it (see the "a PR body is not a
 * file" rule). Named rather than papered over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Any `Co-Authored-By` naming a tool rather than a person. Matched on the AUTHOR, not on one product
 * name: `grep -i claude` would pass a `Co-Authored-By: Copilot` or a future tool, and the rule is
 * about tools, not about this one.
 */
const TOOL_COAUTHOR =
  /^\s*co-authored-by:\s*(claude|copilot|cursor|codeium|chatgpt|gpt-[\w.-]+|devin|aider|gemini|openai|anthropic|bot\b|[^<\n]*\bbot\b|[^<\n]*<[^@\n]*@(?:anthropic|openai|users\.noreply\.github)\.com>)/im;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

/** The base this branch will be squashed onto. Missing base = broken check, never a pass. */
function baseRef(candidates = ['origin/protocol/main', 'protocol/main']) {
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    'neither origin/protocol/main nor protocol/main is resolvable, so the set of commits this branch '
      + 'would contribute to a squash cannot be computed. That is a broken check, not a passing one: '
      + 'fetch the base ref (CI does `git fetch origin protocol/main`) before trusting this test.',
  );
}

test('no commit on this branch names a tool as co-author', () => {
  const base = baseRef();
  const range = `${base}..HEAD`;
  // NUL-delimited so a message containing blank lines or the delimiter text cannot split a commit.
  const raw = git(['log', range, '-z', '--format=%H%n%B']);
  const commits = raw.split('\0').filter((c) => c.trim().length > 0);

  const offenders = [];
  for (const c of commits) {
    const nl = c.indexOf('\n');
    const sha = (nl === -1 ? c : c.slice(0, nl)).trim();
    const body = nl === -1 ? '' : c.slice(nl + 1);
    const hit = TOOL_COAUTHOR.exec(body);
    if (hit) offenders.push(`${sha.slice(0, 8)}: ${hit[0].trim()}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `these commits name a tool as co-author, and GitHub's squash composer puts every one of them into `
      + `the message that lands on ${base}:\n  ${offenders.join('\n  ')}\n\n`
      + 'Commits are authored by the human. Strip the trailer with a message-only rewrite -- '
      + '`git filter-branch --msg-filter` over the range keeps the tree byte-identical, which is what '
      + 'lets the in-flight reviews stand. Do it BEFORE a verdict binds to a head: afterwards it costs '
      + 'a full round of invalidation that later readers cannot tell apart from a real re-read.',
  );
});

test('the matcher sees the trailers it exists for, and leaves human co-authors alone', () => {
  // NON-VACUITY, and this guard needs it badly: on a clean branch the range above is empty and the
  // test would pass identically with a matcher that matches nothing. On `protocol/main` itself the
  // range is ALWAYS empty. These fixtures are the only thing separating "no commit has the trailer"
  // from "nothing was examined".
  const banned = [
    'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    'co-authored-by: claude <noreply@anthropic.com>',
    '  Co-Authored-By:   Claude Sonnet 4.5 <noreply@anthropic.com>',
    'Co-Authored-By: Copilot <copilot@users.noreply.github.com>',
    'Co-Authored-By: Cursor Agent <agent@cursor.sh>',
    'Co-Authored-By: ChatGPT <noreply@openai.com>',
    'Co-Authored-By: some-ci-bot <ci@example.com>',
    'Co-Authored-By: Someone <someone@anthropic.com>',
  ];
  for (const line of banned) {
    assert.match(`fix: a thing\n\n${line}\n`, TOOL_COAUTHOR, `must be refused: ${line}`);
  }

  // And it must NOT fire on a real person, or the guard gets deleted the first time two humans pair.
  //
  // BOTH ADDRESSES BELOW ARE INVENTED, and must stay invented. This fixture carried a real
  // maintainer's personal Gmail until 2026-09-21 — no key and no access, just a private address
  // sitting permanently in a public repository, inside a file nobody re-reads because it passes.
  // What the fixture has to prove is that a HUMAN-shaped name is allowed where a tool-shaped one is
  // not; the discriminator is the name, not the domain (`ci@example.com` is in the banned list
  // above, on the same domain as the first entry here), so a real address buys the test nothing.
  const allowed = [
    'Co-Authored-By: Dana Okonkwo <dana@example.com>',
    'Co-Authored-By: A Reviewer <reviewer@example.org>',
    // Prose mentioning the rule is not a trailer: it is not at the start of a line as a trailer.
    'fix: stop adding a Co-Authored-By: Claude trailer, per the working agreement',
  ];
  for (const line of allowed) {
    assert.doesNotMatch(`fix: a thing\n\n${line}\n`, TOOL_COAUTHOR, `must be allowed: ${line}`);
  }
});

test('a missing base ref THROWS rather than reporting a pass over zero commits', () => {
  // The failure mode this repo keeps shipping: a guard whose anchor is absent returns green. Proven
  // by CALLING it with an unresolvable base, not by grepping this file's own source for the word
  // `throw` -- a source-grep is satisfied by the string appearing anywhere, including in a comment
  // about how important it is.
  assert.throws(
    () => baseRef(['refs/heads/there-is-no-such-branch-0f80606a']),
    (err) => {
      assert.match(err.message, /broken check, not a passing one/);
      return true;
    },
    'an unresolvable base must throw, so the empty range it would produce can never read as a pass',
  );
  // Both halves: a check that can only throw is as useless as one that can only pass.
  assert.ok(baseRef().length > 0, 'the real base must resolve, or every run of this is a false red');
});
