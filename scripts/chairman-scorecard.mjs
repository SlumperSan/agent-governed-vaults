#!/usr/bin/env node
// @ts-check
/**
 * `node scripts/chairman-scorecard.mjs [--file]`
 *
 * Card 188, Chairman directive 10. One command, printing what a digest claims so the digest can
 * be checked against it rather than trusted. **Every number here is computed from `gh`, `git` or
 * the filesystem, none passed in** -- see `scripts/lib/chairman-scorecard.mjs`'s header for the
 * two directive-10 numbers that structurally cannot be (weekly plan %, messages per session) and
 * why this script says so explicitly instead of omitting or faking them.
 *
 * `--file` writes the report to `Findings/<date>-chairman-scorecard.md` in the vault, in addition
 * to stdout -- the card's own closes-when condition.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerdicts } from './lib/verdicts.mjs';
import {
  bucketOpenPrs, verdictsInWindow, rulesMissingFromIndex, worktreeCount, staleCardsAgainstResolvedPrs,
} from './lib/chairman-scorecard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VAULT = 'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults';

/** @returns {{ok: true, data: any} | {ok: false, err: string}} */
function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', shell: process.platform === 'win32', cwd: REPO });
  if (r.error) return { ok: false, err: `could not run gh: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || '').trim() };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, err: `gh returned unparseable JSON: ${String(e)}` };
  }
}

function section(title, lines) {
  return [`## ${title}`, '', ...(lines.length ? lines : ['(nothing to report)']), ''].join('\n');
}

function main() {
  const now = new Date();
  const out = [];

  out.push(`# Chairman scorecard — ${now.toISOString()}`, '');

  // ── The two directive-10 numbers this script cannot reach. Stated every run, not omitted. ──
  out.push(section('Weekly plan % / hours to reset / projected exhaustion', [
    'NOT COMPUTABLE FROM A STANDALONE SCRIPT — `get_usage` is a live Claude session tool with no',
    'file or network path a `node` process can reach. Run `get_usage` in a live session for this.',
  ]));
  out.push(section('Messages per live session', [
    'NOT COMPUTABLE FROM A STANDALONE SCRIPT — `list_sessions` is a live Claude session tool.',
    'Run `list_sessions` in a live session for this.',
  ]));

  // ── Open PRs by age bucket ──
  const prList = gh(['pr', 'list', '--state', 'open', '--json', 'number,createdAt,title']);
  if (!prList.ok) {
    out.push(section('Open PRs by age bucket', [`gh pr list failed: ${prList.err}`]));
  } else {
    const buckets = bucketOpenPrs(prList.data, now);
    const lines = Object.entries(buckets)
      .sort()
      .map(([b, nums]) => `- **${b}**: ${nums.length} — ${nums.map((n) => `#${n}`).join(', ')}`);
    out.push(section(`Open PRs by age bucket (${prList.data.length} open)`, lines));
  }

  // ── Verdict tokens by reviewer over the last 24h, flagging CEO ──
  if (prList.ok) {
    const perPr = [];
    for (const pr of prList.data) {
      const comments = gh(['pr', 'view', String(pr.number), '--json', 'comments']);
      if (!comments.ok) continue;
      perPr.push({ pr: pr.number, verdicts: parseVerdicts(comments.data.comments ?? []) });
    }
    const { rows, ceoFlags } = verdictsInWindow(perPr, now, 24);
    const lines = rows.map((r) => `- #${r.pr} — \`${r.reviewer}\` → ${r.verdict} at ${r.at}${r.reviewer === 'CEO' ? '  **← DIRECTIVE 2 VIOLATION**' : ''}`);
    out.push(section(`Verdict tokens, last 24h (${ceoFlags} CEO flag${ceoFlags === 1 ? '' : 's'})`, lines));
  }

  // ── Cards whose PR is merged or closed but the card is not marked done ──
  if (prList.ok) {
    // `gh pr list --state` takes exactly one of open|closed|merged|all -- no comma-joined form.
    // `all` includes open PRs too, so the map below is filtered client-side to resolved ones only.
    const resolved = gh(['pr', 'list', '--state', 'all', '--json', 'number,state', '--limit', '500']);
    const tasksDir = path.join(VAULT, 'Tasks');
    if (resolved.ok && existsSync(tasksDir)) {
      const resolvedMap = new Map(
        resolved.data
          .filter((/** @type {any} */ p) => p.state === 'MERGED' || p.state === 'CLOSED')
          .map((/** @type {any} */ p) => [p.number, p.state === 'MERGED' ? 'merged' : 'closed']),
      );
      const cards = readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const text = readFileSync(path.join(tasksDir, f), 'utf8');
          const status = (/^status:\s*(.*)$/m.exec(text)?.[1] ?? '').trim();
          return { file: f, status, text };
        });
      const stale = staleCardsAgainstResolvedPrs(cards, resolvedMap);
      out.push(section('Cards whose PR resolved but the card is not `done`', stale.map((s) => `- ${s.file}: cites #${s.pr} (${s.state}), card status is \`${s.status}\``)));
    } else {
      out.push(section('Cards whose PR resolved but the card is not `done`', [resolved.ok ? `no Tasks folder at ${tasksDir}` : `gh pr list (merged/closed) failed: ${resolved.err}`]));
    }
  }

  // ── Rules missing from the index ──
  const rulesDir = path.join(VAULT, 'Rules');
  const rulesIndex = path.join(VAULT, 'RULES.md');
  if (existsSync(rulesDir) && existsSync(rulesIndex)) {
    const basenames = readdirSync(rulesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    const missing = rulesMissingFromIndex(basenames, readFileSync(rulesIndex, 'utf8'));
    out.push(section(`Rules missing from RULES.md (${basenames.length} rule files)`, missing.map((m) => `- ${m}`)));
  } else {
    out.push(section('Rules missing from RULES.md', [`vault Rules/ or RULES.md not found at ${VAULT} in this environment`]));
  }

  // ── Worktree count ──
  const wt = spawnSync('git', ['worktree', 'list'], { encoding: 'utf8', cwd: REPO });
  const count = wt.status === 0 ? worktreeCount(wt.stdout) : null;
  out.push(section('Worktree count', [count === null ? `git worktree list failed: ${wt.stderr}` : `${count} worktrees`]));

  const report = out.join('\n');
  console.log(report);

  if (process.argv.includes('--file')) {
    const dateStr = now.toISOString().slice(0, 10);
    const findingsDir = path.join(VAULT, 'Findings');
    if (!existsSync(findingsDir)) {
      console.error(`--file requested but no Findings/ folder at ${findingsDir}`);
      process.exit(2);
    }
    const filePath = path.join(findingsDir, `${dateStr}-chairman-scorecard.md`);
    const frontmatter = [
      '---',
      'type: finding',
      `date: ${dateStr}`,
      'summary: Chairman scorecard output — machine-computed counts, not narrative.',
      '---',
      '',
    ].join('\n');
    writeFileSync(filePath, frontmatter + report);
    console.log(`\nWritten to ${filePath}`);
  }
}

main();
