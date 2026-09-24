// @ts-check
/**
 * Pure computation for `scripts/chairman-scorecard.mjs` (card 188, Chairman directive 10).
 *
 * TWO OF THE SEVEN REQUESTED NUMBERS ARE NOT HERE, ON PURPOSE, AND SAY SO AT THE CALL SITE.
 * Directive 10 asks for "weekly plan %, hours to reset, projected exhaustion" and "messages per
 * live session". Both come from `get_usage` and `list_sessions` -- tools that belong to a live
 * Claude session's own harness, not to anything a standalone `node` process run from a terminal
 * can reach. There is no file on disk and no network endpoint this script can call for either one.
 * "Every number computed, none passed in" (the card's own words) rules out accepting them as a
 * CLI flag too -- a passed-in figure is exactly what that line forbids, and a script that quietly
 * dropped the two it cannot reach would be worse than one that says so. `scripts/chairman-scorecard.mjs`
 * prints an explicit "NOT COMPUTABLE FROM A STANDALONE SCRIPT" line for both, every run, rather
 * than omitting them or accepting an unverifiable input.
 *
 * The five that ARE reachable from disk and `gh` are here, each a pure function over data the
 * caller fetched, so this file is testable without a network call.
 */

/** PR age in whole hours, bucketed. Boundaries chosen to match how a stale PR actually gets
 *  discussed: same-day, this week, and "zombie" (directive 3's own seven-day line). */
export function ageBucket(createdAt, now) {
  const hours = (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (hours < 0) throw new Error(`createdAt ${createdAt} is in the future relative to now`);
  if (hours <= 24) return '0-1d';
  if (hours <= 24 * 3) return '1-3d';
  if (hours <= 24 * 7) return '3-7d';
  return '7d+ (zombie candidate)';
}

/**
 * @param {{number: number, createdAt: string}[]} prs
 * @param {Date} now
 * @returns {Record<string, number[]>} bucket label -> PR numbers
 */
export function bucketOpenPrs(prs, now) {
  /** @type {Record<string, number[]>} */
  const out = {};
  for (const pr of prs) {
    const b = ageBucket(pr.createdAt, now);
    (out[b] ??= []).push(pr.number);
  }
  return out;
}

/**
 * Verdict tokens across a set of PRs, filtered to the last `windowHours`, flagging any reviewer
 * named `CEO` -- directive 2 barred the CEO from posting verdict tokens at all, so ANY hit here
 * is the specific regression that directive exists to catch, not a rare edge case to soften.
 *
 * @param {{pr: number, verdicts: {reviewer: string, verdict: string, at: string}[]}[]} perPr
 * @param {Date} now
 * @param {number} windowHours
 */
export function verdictsInWindow(perPr, now, windowHours = 24) {
  const cutoff = now.getTime() - windowHours * 60 * 60 * 1000;
  const rows = [];
  let ceoFlags = 0;
  for (const { pr, verdicts } of perPr) {
    for (const v of verdicts) {
      const at = new Date(v.at).getTime();
      if (at < cutoff) continue;
      rows.push({ pr, ...v });
      if (v.reviewer === 'CEO') ceoFlags += 1;
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { rows, ceoFlags };
}

/**
 * `[[name]]` wikilinks resolve by exact match against a `Rules/*.md` basename (no extension). A
 * rule file whose basename never appears as a wikilink ANYWHERE in the index text is unindexed --
 * this repo's own convention (`RULES.md`: "Read this index, not the folder").
 *
 * @param {string[]} ruleBasenames e.g. ['a-merge-probe-expires-in-pushes', ...]
 * @param {string} indexText the full content of RULES.md
 */
export function rulesMissingFromIndex(ruleBasenames, indexText) {
  const linked = new Set([...indexText.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()));
  return ruleBasenames.filter((name) => !linked.has(name)).sort();
}

/**
 * `git worktree list` porcelain output, one worktree per line. Counts lines rather than trusting
 * a caller-supplied number, because a stale count is exactly what this scorecard exists to catch
 * ("the whole point is that it contradicts the digest when the digest is wrong").
 */
export function worktreeCount(gitWorktreeListOutput) {
  return gitWorktreeListOutput.split('\n').filter((l) => l.trim().length > 0).length;
}

/**
 * A card whose body or `note` field cites a PR number now MERGED or CLOSED, but whose own
 * `status` is not `done` -- the board saying "still in flight" about work that already landed or
 * was abandoned. Directive 3's zombie-PR problem, read from the other direction: not "PRs nobody
 * closed" but "cards nobody updated once their PR resolved".
 *
 * @param {{file: string, status: string, text: string}[]} cards raw card text (frontmatter + body)
 * @param {Map<number, 'merged'|'closed'>} resolvedPrs
 */
export function staleCardsAgainstResolvedPrs(cards, resolvedPrs) {
  const out = [];
  for (const card of cards) {
    if (card.status === 'done') continue;
    const cited = new Set([...card.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
    for (const n of cited) {
      const state = resolvedPrs.get(n);
      if (state) {
        out.push({ file: card.file, pr: n, state, status: card.status });
        break; // one hit per card is enough to flag it
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
