// @ts-check
/**
 * The single collector behind both `npm run cc` (terminal) and `npm run cc:web` (dashboard).
 *
 * DESIGN RULE, inherited from scripts/status.mjs: report FACTS WE COMPUTE and POINT AT the prose we
 * cannot. Everything here is derived from git, the last gate run, the deployment address book, the
 * go/no-go table and the GitHub API. Nothing is stored, so nothing can go stale on its own -- if a
 * value is wrong, its SOURCE is wrong, which is the bug you actually want to find.
 *
 * One collector, two renderers. A dashboard that drifts from the terminal board is worse than
 * having only one of them, because you then have to remember which is lying.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Run a command for stdout. Empty string on any failure -- this never throws and never hangs. */
function sh(cmd, args, timeout = 10_000) {
  // shell:false deliberately: git and gh are real executables Node resolves from PATH itself, and
  // cmd.exe would reinterpret arguments (see the shell policy in scripts/gate.mjs).
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

const jsonOr = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- tree

function tree() {
  return {
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || '?',
    head: sh('git', ['rev-parse', '--short', 'HEAD']) || '?',
    headFull: sh('git', ['rev-parse', 'HEAD']),
    subject: sh('git', ['log', '-1', '--format=%s']),
    // Named, never merely counted: this is a SHARED worktree, so an unexpected path is probably
    // another session's work and must never be swept into a commit.
    // NOT `l.slice(3)`: sh() trims the whole stdout, which eats the leading space of a
    // " M path" line, so a fixed offset silently truncated the FIRST filename by one character.
    // Strip the status field by pattern instead, which is correct however the line arrives.
    dirty: sh('git', ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim())
      .filter(Boolean),
  };
}

// ---------------------------------------------------------------- gate

function gate() {
  const p = path.join(REPO, '.gate-state.json');
  if (!existsSync(p)) return null;
  const g = jsonOr(readFileSync(p, 'utf8'), null);
  if (!g) return null;
  const headFull = sh('git', ['rev-parse', 'HEAD']);
  // The two ways a green gate lies. A board that omits these is the failure mode it exists to stop.
  g.sameCommit = Boolean(g.commit && headFull && g.commit === headFull);
  g.caveats = [
    !g.sameCommit && 'ran on a DIFFERENT commit',
    g.treeDirty && 'ran against a dirty tree',
    g.mode?.quick && 'was --quick (no gas snapshot)',
    g.mode?.only && `was --only ${g.mode.only.join(',')}`,
  ].filter(Boolean);
  return g;
}

// ---------------------------------------------------------------- launch gates

function launchGates() {
  const p = path.join(REPO, 'docs/LAUNCH-READINESS.md');
  if (!existsSync(p)) return { verdict: null, rows: [] };
  const text = readFileSync(p, 'utf8');
  const verdict = /\*\*VERDICT:\s*([A-Z-]+)/.exec(text)?.[1] ?? null;
  const clean = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|([^|]+)\|([^|]+)\|/.exec(line);
    if (m) rows.push({ n: Number(m[1]), name: clean(m[2]), status: clean(m[3]) });
  }
  // The document holds SEVERAL numbered tables (the gates 0..8, the residual register 1..11). Take
  // the first contiguous run from 0 and STOP at the break -- accepting any row whose number happens
  // to match the next index let residual rows masquerade as launch gates.
  const gateRows = [];
  for (const r of rows) {
    if (r.n === gateRows.length) gateRows.push(r);
    else if (gateRows.length) break;
  }
  return { verdict, rows: gateRows };
}

export function gateClass(status) {
  const u = (status || '').toUpperCase();
  if (u.startsWith('GO')) return 'go';
  if (u.includes('NO-GO')) return 'nogo';
  if (u.includes('STALE') || u.includes('CONDITIONAL')) return 'warn';
  return 'idle';
}

// ---------------------------------------------------------------- deployments

function deployments() {
  const out = [];
  // Address books live in two places across generations -- read both rather than assuming one.
  for (const dir of [path.join(REPO, 'contracts/config/deployments'), path.join(REPO, 'contracts/config')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = jsonOr(readFileSync(path.join(dir, f), 'utf8'), null);
      if (!j) continue;
      const flat = {};
      const walk = (o) => {
        for (const [k, v] of Object.entries(o ?? {})) {
          if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) flat[k] = v;
          else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
        }
      };
      walk(j);
      const network = f.replace(/\.json$/, '');
      if (Object.keys(flat).length && !out.some((d) => d.network === network)) {
        out.push({ network, addresses: flat });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- sprints

/**
 * The sprint board, derived rather than maintained.
 *
 * A hand-kept list of sprints would go stale the moment one finished, so instead: every remote
 * branch NOT yet merged into protocol/main is work in flight. Cross-referencing open PRs tells us
 * whether it is still being written or waiting on review. No registry, nothing to update, and it
 * cannot disagree with the repository.
 */
function sprints(prs) {
  const unmerged = sh('git', ['branch', '-r', '--no-merged', 'origin/protocol/main'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('->') && s !== 'origin/protocol/main')
    .map((s) => s.replace(/^origin\//, ''));

  const ages = {};
  for (const line of sh('git', ['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)|%(committerdate:relative)', 'refs/remotes/origin']).split('\n')) {
    const [ref, iso, rel] = line.split('|');
    if (ref) ages[ref.replace(/^origin\//, '')] = { iso, rel };
  }

  const byBranch = new Map(prs.map((p) => [p.headRefName, p]));

  return unmerged
    .map((b) => {
      const pr = byBranch.get(b);
      return {
        branch: b,
        team: teamOf(b),
        pr: pr ? pr.number : null,
        prTitle: pr ? pr.title : null,
        // A conflicting PR is the state most likely to stall silently, so surface it as its own
        // status rather than folding it into "open".
        state: pr ? (pr.mergeable === 'CONFLICTING' ? 'conflict' : 'review') : 'building',
        age: ages[b]?.rel ?? '',
        iso: ages[b]?.iso ?? '',
      };
    })
    // Newest first: an old unmerged branch is usually abandoned, not urgent.
    .sort((a, b) => (b.iso || '').localeCompare(a.iso || ''));
}

/** Map a branch prefix to the department that owns it. Cosmetic grouping, not a source of truth. */
function teamOf(branch) {
  if (branch.startsWith('design/')) return 'Design';
  if (branch.startsWith('ops/')) return 'Ops';
  if (branch.startsWith('docs/')) return 'Docs';
  if (branch.startsWith('security/')) return 'Security';
  if (/^(fix|feat|perf|test|chore)\//.test(branch)) return 'Dev';
  return 'Other';
}

// ---------------------------------------------------------------- departments (the vault)

/**
 * Department output, read from the Obsidian vault. This is the only part of the board that looks
 * OUTSIDE the repo, because department deliverables are notes, not code.
 */
function departments(vaultRoot) {
  const base = path.join(vaultRoot, 'Business');
  if (!existsSync(base)) return [];
  const out = [];
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let notes = [];
    try {
      notes = readdirSync(full)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const s = statSync(path.join(full, f));
          return { name: f.replace(/\.md$/, ''), mtime: s.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      /* unreadable dir is not fatal to the board */
    }
    if (notes.length) out.push({ name: entry, notes, updated: notes[0].mtime });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------------------------------------------------------------- now

function rightNow() {
  const p = path.join(REPO, 'docs/NOW.md');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  // Echo the section verbatim rather than summarizing it -- see the design rule at the top.
  const pick = (h) => new RegExp(`##\\s*${h}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i').exec(text)?.[1]?.trim() ?? null;
  return { now: pick('Right now'), blocked: pick('Blocked on a human'), traps: pick('Traps that are not visible in the code') };
}

// ---------------------------------------------------------------- collect

/**
 * @param {{ gh?: boolean, vault?: string }} [opts]
 */
export function collect(opts = {}) {
  const useGh = opts.gh !== false;
  const vaultRoot = opts.vault ?? 'C:/Users/Micha/desktop/Obsidian Vault/Agent-Governed Vaults';

  let prs = [];
  let issues = [];
  let ghUp = false;
  if (useGh) {
    // mergeable is computed asynchronously by GitHub, so it can legitimately come back UNKNOWN.
    const p = sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,mergeable', '--limit', '40'], 20_000);
    const i = sh('gh', ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '40'], 20_000);
    if (p || i) {
      prs = jsonOr(p, []);
      issues = jsonOr(i, []);
      ghUp = true;
    }
  }

  return {
    at: new Date().toISOString(),
    tree: tree(),
    gate: gate(),
    launch: launchGates(),
    deployments: deployments(),
    sprints: sprints(prs),
    departments: departments(vaultRoot),
    now: rightNow(),
    github: { up: ghUp, prs, issues },
  };
}
