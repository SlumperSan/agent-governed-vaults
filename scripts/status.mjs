#!/usr/bin/env node
// @ts-check
/**
 * Command center: one screen answering "where does this project stand right now?"
 *
 *     npm run cc              # the board
 *     npm run cc -- --md      # same content as markdown (paste into Obsidian / a PR / a handoff)
 *     npm run cc -- --no-gh   # skip the GitHub lookups (offline, or when gh is slow)
 *     npm run cc:web          # the same data as a live dashboard in the browser
 *
 * This file is only the TERMINAL RENDERER. Every value comes from `collect()` in
 * scripts/lib/project-status.mjs, which the web dashboard also uses -- two renderers over one
 * source, so the board in your terminal and the board in your browser cannot disagree. When they
 * were separate, one of them silently truncated a filename for a week.
 *
 * DESIGN RULE (lives with the collector, restated here because it governs what belongs in this
 * file): report FACTS WE COMPUTE and POINT AT the prose we cannot. Nothing is stored, so nothing
 * can go stale on its own -- if a value is wrong, its SOURCE is wrong, which is the bug you want.
 */
import { collect, gateClass } from './lib/project-status.mjs';

const argv = process.argv.slice(2);
const MD = argv.includes('--md');
const NO_GH = argv.includes('--no-gh');

const TTY = process.stdout.isTTY && !MD;
const C = TTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', c: '', d: '', b: '', x: '' };

const COLOR = { go: C.g, warn: C.y, nogo: C.r, idle: C.d };

const out = [];
const say = (s = '') => out.push(s);
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

const d = collect({ gh: !NO_GH });
const stamp = d.at.slice(0, 16).replace('T', ' ');

if (MD) say(`# Command center — ${stamp}Z\n`);
else say(`\n${C.b}${C.c}AGENT-GOVERNED VAULTS${C.x} ${C.d}command center · ${stamp}Z${C.x}\n`);

// ---------------------------------------------------------------- tree

if (MD) {
  say(`## Tree\n`);
  say(`\`${d.tree.branch}\` @ \`${d.tree.head}\` — ${d.tree.subject}`);
  say(d.tree.dirty.length ? `\nDirty (${d.tree.dirty.length}): ${d.tree.dirty.map((f) => `\`${f}\``).join(', ')}` : `\nClean.`);
  say('');
} else {
  say(`${C.b}TREE${C.x}      ${d.tree.branch} @ ${d.tree.head}  ${C.d}${(d.tree.subject || '').slice(0, 56)}${C.x}`);
  if (d.tree.dirty.length) {
    say(`          ${C.y}${d.tree.dirty.length} uncommitted${C.x}: ${d.tree.dirty.slice(0, 6).join(', ')}${d.tree.dirty.length > 6 ? ` +${d.tree.dirty.length - 6}` : ''}`);
    say(`          ${C.d}shared worktree — commit named paths only, never \`git add -A\`${C.x}`);
  } else {
    say(`          ${C.g}clean${C.x}`);
  }
}

// ---------------------------------------------------------------- gate

if (!d.gate) {
  const line = 'never run on this machine — `npm run gate`';
  MD ? say(`## Gate\n\n${line}\n`) : say(`\n${C.b}GATE${C.x}      ${C.y}${line}${C.x}`);
} else {
  const verdict = d.gate.passed ? 'PASSED' : 'FAILED';
  const when = ago(Date.now() - Date.parse(d.gate.at));
  const secs = `${(d.gate.totalMs / 1000).toFixed(1)}s`;
  const steps = (d.gate.steps ?? []).map((s) => `${s.id}:${s.state}`).join(' ');
  if (MD) {
    say(`## Gate\n`);
    say(`**${verdict}** in ${secs}, ${when}.`);
    if (d.gate.caveats.length) say(`\n> Does not certify this tree: ${d.gate.caveats.join('; ')}.`);
    say(`\n\`${steps}\`\n`);
  } else {
    say(`\n${C.b}GATE${C.x}      ${d.gate.passed ? C.g : C.r}${verdict}${C.x} ${C.d}${secs} · ${when}${C.x}`);
    // The two ways a green gate lies. Stating them is the whole point of the row.
    if (d.gate.caveats.length) say(`          ${C.y}does NOT certify this tree: ${d.gate.caveats.join('; ')}${C.x}`);
    else say(`          ${C.g}certifies this exact commit, clean tree${C.x}`);
    say(`          ${C.d}${steps}${C.x}`);
  }
}

// ---------------------------------------------------------------- launch gates

if (d.launch.rows.length) {
  if (MD) {
    say(`## Launch gates — verdict ${d.launch.verdict ?? '?'}\n`);
    say('| # | Gate | Status |');
    say('|---|------|--------|');
    for (const r of d.launch.rows) say(`| ${r.n} | ${r.name} | ${r.status} |`);
    say('');
  } else {
    say(`\n${C.b}LAUNCH${C.x}    ${d.launch.verdict === 'GO' ? C.g : C.r}${d.launch.verdict ?? '?'}${C.x} ${C.d}docs/LAUNCH-READINESS.md${C.x}`);
    for (const r of d.launch.rows) {
      say(`          ${C.d}${r.n}${C.x} ${pad(r.name.slice(0, 44), 45)} ${COLOR[gateClass(r.status)]}${r.status.slice(0, 42)}${C.x}`);
    }
  }
}

// ---------------------------------------------------------------- sprints

if (d.sprints.length) {
  if (MD) {
    say(`## Sprints in flight\n`);
    say('| Team | Branch | State | PR | Last commit |');
    say('|------|--------|-------|----|-------------|');
    for (const s of d.sprints) say(`| ${s.team} | \`${s.branch}\` | ${s.state} | ${s.pr ? `#${s.pr}` : '—'} | ${s.age} |`);
    say('');
  } else {
    say(`\n${C.b}SPRINTS${C.x}   ${d.sprints.length} branch(es) not yet in protocol/main`);
    for (const s of d.sprints.slice(0, 12)) {
      const col = s.state === 'conflict' ? C.r : s.state === 'review' ? C.y : C.d;
      say(`          ${pad(s.team, 9)} ${pad(s.branch.slice(0, 38), 39)} ${col}${pad(s.state, 9)}${C.x} ${C.d}${s.pr ? `#${s.pr}` : '   '} ${s.age}${C.x}`);
    }
    if (d.sprints.length > 12) say(`          ${C.d}+${d.sprints.length - 12} more${C.x}`);
  }
}

// ---------------------------------------------------------------- departments

if (d.departments.length) {
  if (MD) {
    say(`## Department output\n`);
    for (const t of d.departments) say(`- **${t.name}** — ${t.notes.length} note(s), latest: ${t.notes[0].name}`);
    say('');
  } else {
    say(`\n${C.b}DEPTS${C.x}     ${C.d}Obsidian vault · Business/${C.x}`);
    for (const t of d.departments) {
      say(`          ${pad(t.name.slice(0, 16), 17)} ${C.d}${pad(String(t.notes.length), 3)} note(s) · latest ${t.notes[0].name.slice(0, 34)} ${ago(Date.now() - t.updated)}${C.x}`);
    }
  }
}

// ---------------------------------------------------------------- deployments

if (d.deployments.length) {
  if (MD) {
    say(`## Deployed\n`);
    for (const n of d.deployments) {
      say(`**${n.network}** — ` + Object.entries(n.addresses).map(([k, v]) => `${k} \`${v}\``).join(', '));
    }
    say('');
  } else {
    say(`\n${C.b}DEPLOYED${C.x}`);
    for (const n of d.deployments) {
      say(`          ${C.c}${n.network}${C.x}`);
      const es = Object.entries(n.addresses);
      for (const [k, v] of es.slice(0, 8)) say(`            ${pad(k.slice(0, 22), 23)} ${C.d}${short(v)}${C.x}`);
      if (es.length > 8) say(`            ${C.d}+${es.length - 8} more in contracts/config/${n.network}.json${C.x}`);
    }
  }
}

// ---------------------------------------------------------------- github

if (d.github.up) {
  const p = d.github.prs.length ? d.github.prs.map((x) => `#${x.number}`).join(' ') : 'none';
  const i = d.github.issues.length ? d.github.issues.map((x) => `#${x.number}`).join(' ') : 'none';
  if (MD) say(`## GitHub\n\n- Open PRs: ${p}\n- Open issues: ${i}\n`);
  else {
    say(`\n${C.b}GITHUB${C.x}    ${d.github.prs.length} open PR(s): ${C.d}${p}${C.x}`);
    say(`          ${d.github.issues.length} open issue(s): ${C.d}${i}${C.x}`);
  }
} else if (!NO_GH && !MD) {
  say(`\n${C.b}GITHUB${C.x}    ${C.d}unavailable (gh not installed / not authenticated / offline)${C.x}`);
}

// ---------------------------------------------------------------- right now

if (d.now?.now) {
  // Echoed verbatim rather than summarized -- see the design rule at the top.
  if (MD) say(`## Right now\n\n${d.now.now}\n`);
  else {
    say(`\n${C.b}RIGHT NOW${C.x} ${C.d}docs/NOW.md${C.x}`);
    for (const l of d.now.now.split('\n').slice(0, 14)) say(`          ${l.replace(/\*\*/g, '').replace(/`/g, '')}`);
  }
}

if (!MD) {
  say(`\n${C.d}          live dashboard: npm run cc:web   ·   map: docs/NOW.md · Obsidian › Agent-Governed Vaults${C.x}`);
  say('');
}

console.log(out.join('\n'));
