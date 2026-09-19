/**
 * Deploy-runbook / Pages-project guard.
 *
 * DEPLOYMENTS.md is "the real deploy commands for each surface" (its own header), and twice now
 * the command it gives for the Cloudflare Pages surface has been wrong in a way that would have
 * destroyed the live site if a reviewer had not caught it by hand:
 *
 *   - Issue #268 / PR #267: the runbook told the deployer to run
 *     `wrangler pages deploy . --project-name rwally` from `apps/site`, when `apps/site` was the
 *     RETIRED build. `.` is the SOURCE TREE, not the build output, so even run from the directory
 *     that actually serves `rwally.com` this command ships TypeScript and templates instead of the
 *     rendered site.
 *   - PR #304 then deleted `apps/site-next` (the directory that used to be canonical) and
 *     `apps/site` was rebuilt to take its place. Every runbook line that named `apps/site-next` as
 *     the directory to `cd` into or deploy from went stale in the same commit — caught only by
 *     PR #310's manual doc pass, not by any guard.
 *
 * So there are TWO independent ways this can invert, and this file checks both, because checking
 * only one goes quiet on the other:
 *
 *   1. THE DIRECTORY: whatever directory DEPLOYMENTS.md tells you to `cd` into for a given Pages
 *      project must be the directory that actually carries that project's `wrangler.toml`
 *      (`name = "<project>"`). This is the half PR #304/#310 inverted — it did NOT invert the
 *      argument half below, which is exactly why a guard scoped to the directory alone would have
 *      gone quiet on the #267/#268 shape re-appearing under the new directory.
 *   2. THE ARGUMENT: the `wrangler pages deploy <arg>` command must deploy the project's BUILT
 *      OUTPUT (`wrangler.toml`'s own `pages_build_output_dir`, `dist` today), never `.`. This is
 *      wrong in ANY directory, canonical or not, and is the half #267/#268 was actually about.
 *
 * Both `wrangler.toml` and the runbook prose are read fresh, from the filesystem, every run —
 * nothing here is a hardcoded directory name. Per CLAUDE.md's "guard that can skip is a guard that
 * will": every enumeration below throws if it finds zero, rather than passing over an empty result.
 *
 * ## Positive vs. negative scope — why the argument half is NOT limited to DEPLOYMENTS.md
 *
 * The directory/argument checks above are POSITIVE requirements on one named file
 * (`DEPLOYMENTS.md` must state the right command) — safe to scope by filename, because requiring
 * too little from a hand-kept list never lets a false claim through (see
 * `config-doc-truth.test.mjs`'s header for the same distinction, in more depth).
 *
 * But "never write `wrangler pages deploy .`" is a NEGATIVE guard, and a negative guard scoped to
 * one file is exactly the shape that goes quiet on the file nobody added to the list. Proof from
 * this repository's own history: the #267/#268 near-miss this file is named for was **not** in
 * DEPLOYMENTS.md — it was in a feature-specific runbook shipped alongside a PR. `docs/REVENUE.md`
 * §5.3 carries its own independent `wrangler ... pages deploy dist` block today; a guard that only
 * read `DEPLOYMENTS.md` would stay green if `deploy .` reappeared there, or in any future doc,
 * completely unrelated to whether `DEPLOYMENTS.md` itself is still correct.
 *
 * So the "never deploy `.`" rule below is enumerated over every tracked Markdown file
 * (`git ls-files '*.md'`), not just the runbook — and, like `wranglerTomlPaths()`, throws if that
 * enumeration is empty rather than passing over it. It matches only inside fenced ``` code blocks:
 * DEPLOYMENTS.md and REVENUE.md both *quote* `wrangler pages deploy .` in inline backticks, in
 * prose, specifically to warn against it — a plain substring scan would redden the very files that
 * carry the warning (the shape CLAUDE.md's claims-guard rule 6 calls out by name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');

const RUNBOOK_PATH = 'DEPLOYMENTS.md';
const runbook = read(RUNBOOK_PATH);

/**
 * Every wrangler.toml in the repository, enumerated from git's own file list — never from a
 * hand-kept path. `git ls-files` (not a filesystem walk) so build output, node_modules and other
 * sessions' worktrees can never contribute one.
 */
const wranglerTomlPaths = () => {
  const out = execFileSync('git', ['ls-files', '*wrangler.toml'], { cwd: REPO, encoding: 'utf8' });
  const paths = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  assert.ok(
    paths.length > 0,
    'git ls-files found zero wrangler.toml anywhere in the repository. That means either the ' +
      'Pages project config was deleted/renamed, or this check is looking in the wrong place — ' +
      'either way, a guard that silently passed with nothing to check would be worthless. Fix the ' +
      'enumeration or restore the file; do not let this assertion go away.',
  );
  return paths;
};

/** Parse the `name = "..."` and `pages_build_output_dir = "..."` keys out of a wrangler.toml body. */
function parseWranglerToml(text, tomlPath) {
  const nameMatch = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  const outDirMatch = text.match(/^\s*pages_build_output_dir\s*=\s*"([^"]+)"/m);
  assert.ok(nameMatch, `${tomlPath} has no top-level \`name = "..."\` — cannot identify its Pages project.`);
  assert.ok(
    outDirMatch,
    `${tomlPath} has no \`pages_build_output_dir = "..."\` — cannot know what the runbook is supposed to deploy.`,
  );
  return { name: nameMatch[1], outDir: outDirMatch[1] };
}

/**
 * Every fenced ```-code block in the runbook that mentions this Pages project by name
 * (`--project-name <name>` or `--project-name=<name>`, wrangler accepts both forms). Matched by
 * the project name rather than by section heading, so this does not depend on any particular
 * prose structure ("Marketing site", "Vault explorer", ...) surviving unchanged.
 */
function codeBlocksNamingProject(projectName) {
  const blocks = [...runbook.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  // `(?![\w-])` rather than `\b`: project names contain hyphens (`rwally-app`), and `\b` treats
  // the boundary between "y" and "-" as a word boundary, so `--project-name rwally\b` would
  // wrongly match `--project-name=rwally-app`. Require nothing word-or-hyphen right after the
  // name instead, so "rwally" never matches "rwally-app".
  const projectNameRe = new RegExp(`--project-name[=\\s]+"?${escapeRegExp(projectName)}"?(?![\\w-])`);
  return blocks.filter((b) => projectNameRe.test(b));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const tomlPath of wranglerTomlPaths()) {
  const projectDir = path.dirname(tomlPath); // e.g. "apps/site"
  const { name, outDir } = parseWranglerToml(read(tomlPath), tomlPath);

  test(`${RUNBOOK_PATH}: the "${name}" Pages project's deploy command names its own directory and its built output`, () => {
    const blocks = codeBlocksNamingProject(name);
    assert.ok(
      blocks.length > 0,
      `${RUNBOOK_PATH} contains no \`--project-name ${name}\` deploy command at all. ${tomlPath} ` +
        `declares this Pages project; the runbook is supposed to be "the real deploy commands for ` +
        `each surface" and currently says nothing about how to deploy it. Either the runbook is ` +
        `missing this surface, or the command was reworded in a way this guard no longer ` +
        `recognizes — either way this must not pass silently.`,
    );

    for (const block of blocks) {
      // --- Half 1: THE DIRECTORY -------------------------------------------------------------
      // The block must `cd` into the exact directory that carries this project's wrangler.toml.
      // This is the half that inverted when apps/site-next was deleted and apps/site took its
      // place: the deploy command still worked, but it would have run from (or described) a
      // directory that no longer matched the project it claimed to deploy.
      const cdMatch = block.match(/\bcd\s+([^\s&|;]+)/);
      assert.ok(
        cdMatch,
        `A code block in ${RUNBOOK_PATH} deploys Pages project "${name}" but contains no \`cd\` ` +
          `into a directory. Without an explicit \`cd\`, wrangler resolves \`./functions\` (and ` +
          `pages_build_output_dir) relative to whatever directory the reader happens to be in, ` +
          `which is exactly how the wrong directory gets used silently.\n\nBlock:\n${block}`,
      );
      const citedDir = cdMatch[1].replace(/\/+$/, '');
      assert.equal(
        citedDir,
        projectDir,
        `${RUNBOOK_PATH} tells the reader to \`cd ${citedDir}\` before deploying Pages project ` +
          `"${name}", but ${tomlPath} — the file that actually declares \`name = "${name}"\` — ` +
          `lives in "${projectDir}". The runbook's directory and the wrangler.toml that owns this ` +
          `project have drifted apart. (This is the #304/#310 shape: the canonical directory ` +
          `changed and the runbook did not follow it.)\n\nBlock:\n${block}`,
      );

      // --- Half 2: THE ARGUMENT ---------------------------------------------------------------
      // The block must deploy the project's BUILT OUTPUT, never the source tree. Wrong in any
      // directory — this is the #267/#268 near-miss, and it does not depend on the directory
      // above being right or wrong.
      const deployMatch = block.match(/wrangler(?:@\S+)?\s+pages\s+deploy\s+(\S+)/);
      assert.ok(
        deployMatch,
        `A code block in ${RUNBOOK_PATH} names Pages project "${name}" (--project-name) but has ` +
          `no \`wrangler ... pages deploy <path>\` invocation for this guard to check the ` +
          `argument of.\n\nBlock:\n${block}`,
      );
      const deployArg = deployMatch[1];
      assert.notEqual(
        deployArg,
        '.',
        `${RUNBOOK_PATH} tells the reader to run \`wrangler pages deploy .\` for project "${name}" ` +
          `— that publishes the SOURCE TREE, not the built output, in ANY directory. This is the ` +
          `exact command a reviewer caught by hand in PR #267/issue #268; it must never reappear. ` +
          `Deploy ${tomlPath}'s own \`pages_build_output_dir\` ("${outDir}") instead.\n\nBlock:\n${block}`,
      );
      assert.equal(
        deployArg,
        outDir,
        `${RUNBOOK_PATH} deploys Pages project "${name}" with \`wrangler pages deploy ${deployArg}\`, ` +
          `but ${tomlPath} declares \`pages_build_output_dir = "${outDir}"\`. The runbook must ` +
          `deploy exactly the directory the project itself says is its build output.\n\nBlock:\n${block}`,
      );
    }
  });
}

/**
 * Every tracked Markdown file in the repository — enumerated from `git ls-files`, never a
 * hand-kept list, for the reason explained in the header comment above.
 */
const markdownPaths = () => {
  const out = execFileSync('git', ['ls-files', '*.md'], { cwd: REPO, encoding: 'utf8' });
  const paths = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  assert.ok(
    paths.length > 0,
    'git ls-files found zero tracked Markdown files. That is not plausible for this repository — ' +
      'fix the enumeration rather than let the "never deploy `.`" guard below run over nothing.',
  );
  return paths;
};

test('no tracked Markdown file instructs `wrangler pages deploy .` (or `./`) in a runnable code block', () => {
  const deployDotRe = /wrangler(?:@\S+)?\s+pages\s+deploy\s+(\.\/?)(?:\s|$)/g;
  const offenders = [];

  for (const mdPath of markdownPaths()) {
    const text = read(mdPath);
    for (const fenceMatch of text.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)) {
      const block = fenceMatch[1];
      for (const hit of block.matchAll(deployDotRe)) {
        offenders.push({ file: mdPath, arg: hit[1], block });
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Found ${offenders.length} fenced code block(s) instructing \`wrangler pages deploy .\`, which ` +
      `publishes the SOURCE TREE instead of a project's built output — wrong in ANY directory, and ` +
      `the exact command PR #267/issue #268 caught by hand before it published:\n\n` +
      offenders.map((o) => `- ${o.file}: \`wrangler pages deploy ${o.arg}\`\n  Block:\n${o.block}`).join('\n'),
  );
});
