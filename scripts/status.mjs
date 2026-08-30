#!/usr/bin/env node
// @ts-check
/**
 * Command center: one screen answering "where does this project stand right now?"
 *
 *     npm run cc              # the board
 *     npm run cc -- --md      # same content as markdown (paste into Obsidian / a PR / a handoff)
 *     npm run cc -- --no-gh   # skip the GitHub lookups (offline, or when gh is slow)
 *
 * DESIGN RULE: this file reports FACTS IT COMPUTES and POINTS AT the prose it cannot.
 * It reads git, the last gate run, the deployment address book, and the go/no-go table -- all of
 * which have an unambiguous machine-readable answer. It deliberately does NOT try to summarize the
 * narrative documents, because a status board that paraphrases prose drifts from it silently, and
 * a board you cannot trust is worse than no board. For the reasoning behind any row, it gives you
 * the path to the document that argues it.
 *
 * Corollary: everything here is derived. There is no status stored in this script, so it cannot go
 * stale on its own -- if a row is wrong, the source it reads is wrong, which is the bug you want.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MD = argv.includes('--md');
const NO_GH = argv.includes('--no-gh');

const TTY = process.stdout.isTTY && !MD;
const C = TTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', c: '', d: '', b: '', x: '' };

const out = [];
const say = (s = '') => out.push(s);

/** Run a command for its stdout; empty string on any failure. Never throws, never blocks forever. */
function sh(cmd, args, opts = {}) {
  // shell:false deliberately. Everything this file shells out to (git, gh) is a real .exe that
  // Node resolves from PATH on its own, and running through cmd.exe would both reinterpret
  // arguments and emit Node's shell-args deprecation warning into the board's output.
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 10_000, ...opts });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

// ---------------------------------------------------------------- tree

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
const head = sh('git', ['rev-parse', '--short', 'HEAD']) || '?';
const headFull = sh('git', ['rev-parse', 'HEAD']);
const subject = sh('git', ['log', '-1', '--format=%s']);
// Named, never counted-and-forgotten: this is a SHARED worktree, so an unexpected path here is
// probably another session's work and must never be swept into a commit (`git add -A` is banned).
const dirty = sh('git', ['status', '--porcelain'])
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3));

// ---------------------------------------------------------------- gate

/** @type {any} */
let gate = null;
const gatePath = path.join(REPO, '.gate-state.json');
if (existsSync(gatePath)) {
  try {
    gate = JSON.parse(readFileSync(gatePath, 'utf8'));
  } catch {
    gate = null;
  }
}

// ---------------------------------------------------------------- launch gates

/**
 * Parse the go/no-go table in docs/LAUNCH-READINESS.md: `| N | name | status | notes |`.
 * Only the first three columns are read -- the notes column is prose and belongs in the document.
 */
function launchGates() {
  const p = path.join(REPO, 'docs/LAUNCH-READINESS.md');
  if (!existsSync(p)) return { verdict: null, rows: [] };
  const text = readFileSync(p, 'utf8');
  const verdict = /\*\*VERDICT:\s*([A-Z-]+)/.exec(text)?.[1] ?? null;
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|([^|]+)\|([^|]+)\|/.exec(line);
    if (!m) continue;
    const clean = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    rows.push({ n: Number(m[1]), name: clean(m[2]), status: clean(m[3]) });
  }
  // The document contains SEVERAL numbered tables -- the go/no-go gates (0..8) and the
  // residual-risk register (1..11) among them. Take only the first contiguous run starting at 0
  // and STOP at the first break, rather than accepting any row whose number happens to match the
  // next index: that let residual rows 9/10/11 masquerade as launch gates 9/10/11.
  const gateRows = [];
  for (const r of rows) {
    if (r.n === gateRows.length) gateRows.push(r);
    else if (gateRows.length) break;
  }
  return { verdict, rows: gateRows };
}

const launch = launchGates();

const gateColor = (s) => {
  const u = s.toUpperCase();
  if (u.startsWith('GO')) return C.g;
  if (u.includes('STALE') || u.includes('CONDITIONAL')) return C.y;
  if (u.includes('NO-GO')) return C.r;
  return C.d;
};

// ---------------------------------------------------------------- deployments

function deployments() {
  const dir = path.join(REPO, 'contracts/config/deployments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        const flat = {};
        // The address book has nested shapes across generations; walk it rather than assuming one.
        const walk = (o, prefix = '') => {
          for (const [k, v] of Object.entries(o ?? {})) {
            if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) flat[prefix + k] = v;
            else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, '');
          }
        };
        walk(j);
        return { network: f.replace(/\.json$/, ''), addresses: flat };
      } catch {
        return { network: f.replace(/\.json$/, ''), addresses: {} };
      }
    });
}

// ---------------------------------------------------------------- github

let gh = null;
if (!NO_GH) {
  const prs = sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title', '--limit', '20']);
  const issues = sh('gh', ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '20']);
  if (prs || issues) {
    try {
      gh = { prs: JSON.parse(prs || '[]'), issues: JSON.parse(issues || '[]') };
    } catch {
      gh = null;
    }
  }
}

// ---------------------------------------------------------------- render

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

if (MD) say(`# Command center — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z\n`);
else say(`\n${C.b}${C.c}AGENT-GOVERNED VAULTS${C.x} ${C.d}command center · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z${C.x}\n`);

// --- tree
if (MD) {
  say(`## Tree\n`);
  say(`\`${branch}\` @ \`${head}\` — ${subject}`);
  say(dirty.length ? `\nDirty (${dirty.length}): ${dirty.map((f) => `\`${f}\``).join(', ')}` : `\nClean.`);
  say('');
} else {
  say(`${C.b}TREE${C.x}      ${branch} @ ${head}  ${C.d}${subject.slice(0, 60)}${C.x}`);
  if (dirty.length) {
    say(`          ${C.y}${dirty.length} uncommitted${C.x}: ${dirty.slice(0, 6).join(', ')}${dirty.length > 6 ? ` +${dirty.length - 6}` : ''}`);
    say(`          ${C.d}shared worktree — commit named paths only, never \`git add -A\`${C.x}`);
  } else {
    say(`          ${C.g}clean${C.x}`);
  }
}

// --- gate
if (!gate) {
  const line = 'never run on this machine — `npm run gate`';
  MD ? say(`## Gate\n\n${line}\n`) : say(`\n${C.b}GATE${C.x}      ${C.y}${line}${C.x}`);
} else {
  const sameCommit = gate.commit && headFull && gate.commit === headFull;
  const verdictTxt = gate.passed ? 'PASSED' : 'FAILED';
  const when = ago(Date.now() - Date.parse(gate.at));
  const secs = `${(gate.totalMs / 1000).toFixed(1)}s`;
  // The two ways a green gate lies: it ran on a different commit, or it ran on a dirty tree.
  // Both are stated, because "gate passed" without them is the failure mode this board exists for.
  const caveats = [
    !sameCommit && 'ran on a DIFFERENT commit',
    gate.treeDirty && 'ran against a dirty tree',
    gate.mode?.quick && 'was --quick (no gas snapshot)',
    gate.mode?.only && `was --only ${gate.mode.only.join(',')}`,
  ].filter(Boolean);
  const steps = (gate.steps ?? []).map((s) => `${s.id}:${s.state}`).join(' ');
  if (MD) {
    say(`## Gate\n`);
    say(`**${verdictTxt}** in ${secs}, ${when}.`);
    if (caveats.length) say(`\n> Does not certify this tree: ${caveats.join('; ')}.`);
    say(`\n\`${steps}\`\n`);
  } else {
    say(`\n${C.b}GATE${C.x}      ${gate.passed ? C.g : C.r}${verdictTxt}${C.x} ${C.d}${secs} · ${when}${C.x}`);
    if (caveats.length) say(`          ${C.y}does NOT certify this tree: ${caveats.join('; ')}${C.x}`);
    else say(`          ${C.g}certifies this exact commit, clean tree${C.x}`);
    say(`          ${C.d}${steps}${C.x}`);
  }
}

// --- launch
if (launch.rows.length) {
  if (MD) {
    say(`## Launch gates — verdict ${launch.verdict ?? '?'}\n`);
    say('| # | Gate | Status |');
    say('|---|------|--------|');
    for (const r of launch.rows) say(`| ${r.n} | ${r.name} | ${r.status} |`);
    say('');
  } else {
    say(`\n${C.b}LAUNCH${C.x}    ${launch.verdict === 'GO' ? C.g : C.r}${launch.verdict ?? '?'}${C.x} ${C.d}docs/LAUNCH-READINESS.md${C.x}`);
    for (const r of launch.rows) {
      say(`          ${C.d}${r.n}${C.x} ${pad(r.name.slice(0, 44), 45)} ${gateColor(r.status)}${r.status.slice(0, 42)}${C.x}`);
    }
  }
}

// --- deployments
const deps = deployments();
if (deps.length) {
  if (MD) {
    say(`## Deployed\n`);
    for (const d of deps) {
      say(`**${d.network}** — ` + Object.entries(d.addresses).map(([k, v]) => `${k} \`${v}\``).join(', '));
    }
    say('');
  } else {
    say(`\n${C.b}DEPLOYED${C.x}`);
    for (const d of deps) {
      say(`          ${C.c}${d.network}${C.x}`);
      const es = Object.entries(d.addresses);
      for (const [k, v] of es.slice(0, 8)) say(`            ${pad(k.slice(0, 22), 23)} ${C.d}${short(v)}${C.x}`);
      if (es.length > 8) say(`            ${C.d}+${es.length - 8} more in contracts/config/deployments/${d.network}.json${C.x}`);
    }
  }
}

// --- github
if (gh) {
  const p = gh.prs.length ? gh.prs.map((x) => `#${x.number}`).join(' ') : 'none';
  const i = gh.issues.length ? gh.issues.map((x) => `#${x.number}`).join(' ') : 'none';
  if (MD) say(`## GitHub\n\n- Open PRs: ${p}\n- Open issues: ${i}\n`);
  else {
    say(`\n${C.b}GITHUB${C.x}    ${gh.prs.length} open PR(s): ${C.d}${p}${C.x}`);
    say(`          ${gh.issues.length} open issue(s): ${C.d}${i}${C.x}`);
  }
} else if (!NO_GH) {
  if (!MD) say(`\n${C.b}GITHUB${C.x}    ${C.d}unavailable (gh not installed / not authenticated / offline)${C.x}`);
}

// --- the map
const NOW = path.join(REPO, 'docs/NOW.md');
if (existsSync(NOW)) {
  // NOW.md is the cold-start file: short, current, and the first thing to read. Echo its
  // "Right now" section verbatim rather than summarizing it -- see the design rule at the top.
  const text = readFileSync(NOW, 'utf8');
  const sec = /##\s*Right now\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i.exec(text)?.[1]?.trim();
  if (sec) {
    if (MD) say(`## Right now\n\n${sec}\n`);
    else {
      say(`\n${C.b}RIGHT NOW${C.x} ${C.d}docs/NOW.md${C.x}`);
      for (const l of sec.split('\n').slice(0, 14)) say(`          ${l.replace(/\*\*/g, '').replace(/`/g, '')}`);
    }
  }
}

if (!MD) {
  say(`\n${C.d}          full map: docs/NOW.md · docs/LAUNCH-READINESS.md · Obsidian › Agent-Governed Vaults${C.x}`);
  say('');
}

console.log(out.join('\n'));
