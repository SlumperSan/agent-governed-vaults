#!/usr/bin/env node
// @ts-check
/**
 * Command center, in a browser.
 *
 *     npm run cc:web              # serve on http://127.0.0.1:4270
 *     npm run cc:web -- --port 8080
 *     npm run cc:web -- --no-gh   # skip GitHub lookups (offline, or when gh is slow)
 *
 * Same data as `npm run cc`, from the same collector in scripts/lib/project-status.mjs. Two
 * renderers over one source: a dashboard that could drift from the terminal board would be worse
 * than having only one of them, because you would have to remember which one is lying.
 *
 * Deliberately zero-dependency and bound to 127.0.0.1. It reports repository state, some of it not
 * public, so it must not be reachable off the machine. There is no auth here because there is no
 * remote listener -- do not "helpfully" change the bind address.
 */
import { createServer } from 'node:http';
import { collect } from './lib/project-status.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return dflt;
  return argv[i].includes('=') ? argv[i].split('=')[1] : (argv[i + 1] ?? dflt);
};
const PORT = Number(flag('port', 4270));
const NO_GH = argv.includes('--no-gh');
const HOST = '127.0.0.1';

// Collecting shells out to git and gh, so a page that gathered on every request would hammer both
// and make a refresh feel slow. Cache briefly and let the client poll freely.
let cache = { at: 0, data: null };
const TTL_MS = 4000;

function snapshot(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL_MS) return cache.data;
  cache = { at: now, data: collect({ gh: !NO_GH }) };
  return cache.data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Command Center</title>
<style>
  /* Light palette on bare :root so it is the definition, not an override. */
  :root{
    --bg:#f6f7f9; --panel:#fff; --ink:#14161a; --dim:#6b7280; --line:#e3e6ea;
    --go:#0f7b3f; --warn:#9a6400; --nogo:#b3261e; --idle:#6b7280; --accent:#2354c7;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  :root:not([data-theme="light"]){ }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --bg:#0e1013; --panel:#161a1f; --ink:#e8eaed; --dim:#9aa3ae; --line:#262c34;
      --go:#4ade80; --warn:#fbbf24; --nogo:#f87171; --idle:#9aa3ae; --accent:#7aa2ff;
    }
  }
  :root[data-theme="dark"]{
    --bg:#0e1013; --panel:#161a1f; --ink:#e8eaed; --dim:#9aa3ae; --line:#262c34;
    --go:#4ade80; --warn:#fbbf24; --nogo:#f87171; --idle:#9aa3ae; --accent:#7aa2ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;
         padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);
         position:sticky;top:0;z-index:5}
  h1{font-size:15px;margin:0;letter-spacing:.02em}
  .meta{color:var(--dim);font-size:12px;font-family:var(--mono)}
  main{display:grid;gap:14px;padding:16px 20px 40px;
       grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));max-width:1600px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
  section.wide{grid-column:1/-1}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);
     margin:0 0 10px;font-weight:600}
  .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;
       border-bottom:1px solid var(--line);min-width:0}
  .row:last-child{border-bottom:0}
  .row .k{color:var(--dim);white-space:nowrap}
  .row .v{font-family:var(--mono);font-size:12.5px;text-align:right;
          overflow-wrap:anywhere;min-width:0}
  .go{color:var(--go)} .warn{color:var(--warn)} .nogo{color:var(--nogo)} .idle{color:var(--idle)}
  .big{font-size:22px;font-weight:650;letter-spacing:-.01em}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid currentColor;
        font-size:11px;font-family:var(--mono);white-space:nowrap}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{padding:5px 8px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  td.mono,th.mono{font-family:var(--mono);font-size:12px}
  .note{color:var(--dim);font-size:12px;margin-top:8px}
  .caveat{color:var(--warn);font-size:12px;margin-top:6px}
  ul{margin:0;padding-left:18px} li{margin:3px 0}
  a{color:var(--accent)}
  .muted{color:var(--dim)}
  @media (prefers-reduced-motion:no-preference){ .tick{transition:opacity .2s} }

  /* --- board. One row of columns per department, so "who is on what" is answered by position. */
  .dept{margin:0 0 18px}
  .dept:last-child{margin-bottom:0}
  .dh{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;
      padding:0 0 7px;border-bottom:1px solid var(--line);margin-bottom:9px;
      display:flex;align-items:center;gap:10px}
  .dh .muted{font-weight:400;text-transform:none;letter-spacing:0;font-size:11.5px}
  .dh .cnt{font-family:var(--mono);font-weight:400;font-size:11.5px;color:var(--dim);
           text-transform:none;letter-spacing:0}
  .bar{flex:1;max-width:190px;height:4px;background:var(--line);border-radius:999px;overflow:hidden}
  .bar i{display:block;height:100%;background:var(--go);border-radius:999px}
  /* In the section heading, where h2 is uppercase and letter-spaced. */
  .bar.hd{display:inline-block;vertical-align:middle;width:120px;max-width:120px;margin-left:8px}

  /* --- checklist. Struck-through when done, so progress reads without counting. */
  .list{margin-bottom:8px}
  .li{display:flex;align-items:baseline;gap:8px;padding:3.5px 0;font-size:13px;min-width:0}
  .mk{font-family:var(--mono);width:1em;flex:none;text-align:center}
  .lt{min-width:0;overflow-wrap:anywhere}
  .s-done{color:var(--dim)}
  .s-done .lt{text-decoration:line-through}
  .s-done .mk{color:var(--go)}
  .s-doing .mk{color:var(--accent)}
  .s-doing .lt{font-weight:600}
  .s-review .mk{color:var(--warn)}
  .s-blocked .mk{color:var(--nogo)}
  .s-blocked .lt{color:var(--nogo)}
  .s-backlog .mk{color:var(--dim)}
  .li[data-id],.card[data-id]{cursor:pointer;border-radius:5px}
  .li[data-id]:hover,.card[data-id]:hover{background:var(--bg);outline:1px solid var(--line)}
  .card[data-id]:hover{background:var(--panel);outline-color:var(--accent)}
  .li[data-id]:focus-visible,.card[data-id]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .lb{font-size:10px;padding:1px 7px;border-radius:999px;background:var(--bg);
      border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .lb.p{border-color:currentColor;color:var(--warn)}
  .ck,.due{font-family:var(--mono);font-size:10.5px;color:var(--dim);white-space:nowrap}
  .due.late{color:var(--nogo)}
  .more{margin-top:2px}

  /* --- task drawer */
  #scrim{position:fixed;inset:0;background:#0009;z-index:9}
  #drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);z-index:10;
          background:var(--panel);border-left:1px solid var(--line);
          padding:18px 20px 40px;overflow-y:auto}
  #dclose{position:absolute;top:12px;right:14px;background:none;border:0;color:var(--dim);
          font-size:15px;cursor:pointer;padding:4px 8px;border-radius:5px}
  #dclose:hover{background:var(--bg);color:var(--ink)}
  .dstate{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:650}
  .dstate.s-doing{color:var(--accent)} .dstate.s-blocked{color:var(--nogo)}
  .dstate.s-review{color:var(--warn)} .dstate.s-done{color:var(--go)}
  .dstate.s-backlog{color:var(--dim)}
  .dtitle{font-size:18px;margin:6px 40px 10px 0;line-height:1.3;font-weight:650}
  .dchips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px}
  .drow{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .dk{color:var(--dim);width:92px;flex:none}
  .dv{min-width:0;overflow-wrap:anywhere}
  .dsec{margin-top:18px}
  .dh2{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
       margin-bottom:8px;display:flex;align-items:center;gap:9px}
  .ddesc{font-size:12.5px;line-height:1.55;white-space:pre-wrap;color:var(--ink)}
  .dfile{font-family:var(--mono);font-size:11px;color:var(--dim);overflow-wrap:anywhere}
  .more summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;
                letter-spacing:.07em;padding:3px 0}
  .more[open] summary{margin-bottom:7px}
  .cols{display:grid;gap:9px;grid-template-columns:repeat(5,1fr)}
  @media(max-width:1100px){ .cols{grid-template-columns:repeat(2,1fr)} }
  @media(max-width:620px){ .cols{grid-template-columns:1fr} }
  .col{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}
  .clh{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
       margin-bottom:7px;display:flex;justify-content:space-between;gap:6px}
  .clh .n{font-family:var(--mono)}
  /* The column carries the state colour, so a full Blocked column is visible without reading it. */
  .c-doing .clh{color:var(--accent)}
  .c-blocked .clh{color:var(--nogo)}
  .c-review .clh{color:var(--warn)}
  .c-done .clh{color:var(--go)}
  .card{background:var(--panel);border:1px solid var(--line);border-left-width:3px;
        border-radius:6px;padding:7px 9px;margin-bottom:7px}
  .card:last-child{margin-bottom:0}
  .p-high{border-left-color:var(--nogo)}
  .p-med{border-left-color:var(--warn)}
  .p-low{border-left-color:var(--line)}
  .p-none{border-left-color:var(--line)}
  .ct{font-size:12.5px;line-height:1.35}
  .cm{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
  .who{font-family:var(--mono);font-size:10.5px;padding:1px 6px;border-radius:999px;
       background:var(--bg);border:1px solid var(--line);color:var(--ink)}
  .who.none{color:var(--dim);font-style:italic}
  .blk{font-family:var(--mono);font-size:10.5px;padding:1px 6px;border-radius:999px;
       border:1px solid currentColor;color:var(--nogo)}
  .cn{color:var(--dim);font-size:11.5px;margin-top:5px;line-height:1.4}
  .empty{color:var(--dim);text-align:center;font-size:12px;padding:5px 0}
</style>
</head><body>
<header>
  <h1>Agent-Governed Vaults — Command Center</h1>
  <span class="meta" id="stamp">loading…</span>
  <span class="meta" id="err" class="nogo"></span>
</header>
<main id="main"></main>
<div id="scrim" hidden></div>
<aside id="drawer" hidden aria-label="Task detail">
  <button id="dclose" aria-label="Close">✕</button>
  <div id="dbody"></div>
</aside>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cls = s => { const u=(s||'').toUpperCase();
  if(u.startsWith('GO')) return 'go'; if(u.includes('NO-GO')) return 'nogo';
  if(u.includes('STALE')||u.includes('CONDITIONAL')) return 'warn'; return 'idle'; };
const ago = ms => { const s=Math.round(ms/1000); if(s<90) return s+'s ago';
  const m=Math.round(s/60); if(m<90) return m+'m ago'; const h=Math.round(m/60);
  return h<48 ? h+'h ago' : Math.round(h/24)+'d ago'; };
const short = a => a.slice(0,6)+'…'+a.slice(-4);

function render(d){
  const S=[];

  // --- tree
  S.push(sec('Tree', [
    row('branch', esc(d.tree.branch)),
    row('head', esc(d.tree.head)+' <span class="muted">'+esc((d.tree.subject||'').slice(0,52))+'</span>'),
    row('working copy', d.tree.dirty.length
      ? '<span class="warn">'+d.tree.dirty.length+' uncommitted</span>'
      : '<span class="go">clean</span>'),
  ].join('') + (d.tree.dirty.length
      ? '<div class="caveat">'+d.tree.dirty.map(esc).join(', ')+'</div>'
        +'<div class="note">Shared worktree — commit named paths only, never <code>git add -A</code>.</div>'
      : '')));

  // --- gate
  if(!d.gate){
    S.push(sec('Gate', '<div class="big warn">never run</div><div class="note">Run <code>npm run gate</code>.</div>'));
  } else {
    const ok=d.gate.passed;
    S.push(sec('Gate',
      '<div class="big '+(ok?'go':'nogo')+'">'+(ok?'PASSED':'FAILED')+'</div>'
      +'<div class="note">'+(d.gate.totalMs/1000).toFixed(1)+'s · '+ago(Date.now()-Date.parse(d.gate.at))+'</div>'
      +(d.gate.caveats.length
        ? '<div class="caveat">Does NOT certify this tree: '+d.gate.caveats.map(esc).join('; ')+'</div>'
        : '<div class="note go">Certifies this exact commit, clean tree.</div>')
      +'<div class="scroll"><table><tbody>'
      + (d.gate.steps||[]).map(s=>'<tr><td class="mono">'+esc(s.id)+'</td><td class="mono '
          +(s.state==='pass'?'go':s.state==='fail'?'nogo':s.state==='warn'?'warn':'idle')+'">'
          +esc(s.state)+'</td><td class="mono muted">'+(s.ms?(s.ms/1000).toFixed(1)+'s':'')+'</td></tr>').join('')
      +'</tbody></table></div>'));
  }

  // --- launch gates
  if(d.launch.rows.length){
    S.push(sec('Launch gates — <span class="'+cls(d.launch.verdict)+'">'+esc(d.launch.verdict||'?')+'</span>',
      '<div class="scroll"><table><tbody>'
      + d.launch.rows.map(r=>'<tr><td class="mono muted">'+r.n+'</td><td>'+esc(r.name)
          +'</td><td class="'+cls(r.status)+'">'+esc(r.status)+'</td></tr>').join('')
      +'</tbody></table></div><div class="note">Reasoning lives in <code>docs/LAUNCH-READINESS.md</code>.</div>'));
  }

  // --- sprints
  const byTeam={};
  for(const s of d.sprints){ (byTeam[s.team] ||= []).push(s); }
  S.push(sec('Sprints in flight — '+d.sprints.length+' branch(es) not yet in main',
    d.sprints.length
      ? '<div class="scroll"><table><thead><tr><th>Team</th><th>Branch</th><th>State</th><th>PR</th><th>Last commit</th></tr></thead><tbody>'
        + d.sprints.map(s=>'<tr><td>'+esc(s.team)+'</td><td class="mono">'+esc(s.branch)
            +'</td><td><span class="pill '+(s.state==='conflict'?'nogo':s.state==='review'?'warn':'idle')+'">'
            +esc(s.state)+'</span></td><td class="mono">'+(s.pr?'#'+s.pr:'—')
            +'</td><td class="mono muted">'+esc(s.age)+'</td></tr>').join('')
        +'</tbody></table></div>'
        +'<div class="note">Derived from remote branches not merged into <code>protocol/main</code>, cross-referenced with open PRs. Nothing to keep up to date.</div>'
      : '<div class="note go">Everything is merged.</div>', 'wide'));

  // --- the board
  if(d.board){
    const COLS=[['doing','In progress'],['review','In review'],['blocked','Blocked'],['backlog','Backlog'],['done','Done']];
    const DEPTS=[...new Set(d.board.tasks.map(t=>t.department))].sort();
    const card = t => '<div class="card p-'+esc(t.priority||'none')+'" data-id="'+esc(t.id)+'" role="button" tabindex="0">'
      + '<div class="ct">'+esc(t.title)+'</div>'
      + '<div class="cm">'
        + (t.owner?'<span class="who">'+esc(t.owner)+'</span>':'<span class="who none">unassigned</span>')
        + (t.blockedBy.length?'<span class="blk">blocked by '+esc(t.blockedBy.join(', '))+'</span>':'')
      + '</div>'
      + (t.note?'<div class="cn">'+esc(t.note)+'</div>':'')
      + '</div>';

    // Checklist ordering: what is moving, then what is stuck, then what is queued, then what is
    // finished. Done sinks because a tracker is for the work that is left.
    const ORDER={doing:0,review:1,blocked:2,backlog:3,done:4};
    const MARK={done:'✓',doing:'◐',review:'◐',blocked:'✕',backlog:'○'};
    const chip = t => { const d=t.checklist.filter(c=>c.done).length;
      return t.checklist.length? '<span class="ck">☑ '+d+'/'+t.checklist.length+'</span>' : ''; };
    const dueChip = t => { if(!t.due) return '';
      const late = Date.parse(t.due) < Date.now();
      return '<span class="due'+(late?' late':'')+'">◷ '+esc(t.due)+'</span>'; };
    const labels = t => t.labels.map(l=>'<span class="lb">'+esc(l)+'</span>').join('');

    const line = t => '<div class="li s-'+esc(t.status)+'" data-id="'+esc(t.id)+'" role="button" tabindex="0">'
      + '<span class="mk">'+MARK[t.status]+'</span>'
      + '<span class="lt">'+esc(t.title)+'</span>'
      + labels(t) + chip(t) + dueChip(t)
      + (t.status!=='done' && t.owner?'<span class="who">'+esc(t.owner)+'</span>':'')
      + (t.blockedBy.length?'<span class="blk">needs '+esc(t.blockedBy.join(', '))+'</span>':'')
      + '</div>';

    let body='';
    if(d.board.problem) body+='<div class="caveat">'+esc(d.board.problem)+'</div>';
    if(!d.board.tasks.length){
      body+='<div class="note">No task files. Add one to <code>Tasks/</code> in the vault.</div>';
    }
    for(const dep of DEPTS){
      const mine=d.board.tasks.filter(t=>t.department===dep);
      const done=mine.filter(t=>t.status==='done').length;
      const pct=mine.length? Math.round(done/mine.length*100) : 0;
      body+='<div class="dept"><div class="dh">'+esc(dep)
        +' <span class="cnt">'+done+' of '+mine.length+'</span>'
        +'<span class="bar"><i style="width:'+pct+'%"></i></span></div>';

      // Columns first and always visible — this is the view he asked for.
      body+='<div class="cols">';
      for(const [key,label] of COLS){
        const inCol=mine.filter(t=>t.status===key);
        body+='<div class="col c-'+key+'"><div class="clh">'+label+' <span class="n">'+inCol.length+'</span></div>'
          + (inCol.length? inCol.map(card).join('') : '<div class="empty">—</div>')
          +'</div>';
      }
      body+='</div>';

      // The flat checklist stays, folded away, for reading the whole department in one column.
      body+='<details class="more"><summary>as a checklist</summary><div class="list">'
        + mine.slice().sort((a,b)=>(ORDER[a.status]-ORDER[b.status])||a.title.localeCompare(b.title))
              .map(line).join('')
        +'</div></details></div>';
    }
    const allDone=d.board.tasks.filter(t=>t.status==='done').length;
    const allPct=d.board.tasks.length? Math.round(allDone/d.board.tasks.length*100):0;
    // FIRST on the page, not buried under the repo panels. It is the thing he opens this for; the
    // tree, gate and launch tables are reference and belong below it.
    S.unshift(sec('Board · '+allDone+' of '+d.board.tasks.length
      +' <span class="bar hd"><i style="width:'+allPct+'%"></i></span>', body, 'wide'));
  }

  // --- departments
  if(d.departments.length){
    S.push(sec('Department output (Obsidian vault)',
      '<div class="scroll"><table><thead><tr><th>Department</th><th>Notes</th><th>Latest</th></tr></thead><tbody>'
      + d.departments.map(t=>'<tr><td>'+esc(t.name)+'</td><td class="mono">'+t.notes.length
          +'</td><td class="muted">'+esc(t.notes[0].name)+' <span class="mono">'+ago(Date.now()-t.updated)+'</span></td></tr>').join('')
      +'</tbody></table></div>', 'wide'));
  }

  // --- github
  S.push(sec('GitHub', d.github.up
    ? row('open PRs', d.github.prs.length? d.github.prs.map(p=>'#'+p.number).join(' ') : '<span class="go">none</span>')
      + row('open issues', d.github.issues.length? d.github.issues.map(i=>'#'+i.number).join(' ') : '<span class="go">none</span>')
    : '<div class="note warn">gh unavailable (not installed, not authenticated, or offline).</div>'));

  // --- deployments
  if(d.deployments.length){
    S.push(sec('Deployed', d.deployments.map(n=>
      '<h2 style="margin-top:10px">'+esc(n.network)+'</h2>'
      + Object.entries(n.addresses).slice(0,10).map(([k,v])=>row(esc(k),
          '<span title="'+esc(v)+'">'+esc(short(v))+'</span>')).join('')
    ).join('')));
  }

  // --- now
  if(d.now){
    const md = t => '<ul>'+String(t||'').split('\\n').filter(l=>l.trim().startsWith('-'))
      .map(l=>'<li>'+esc(l.replace(/^\\s*-\\s*/,'').replace(/\\*\\*/g,'').replace(/\`/g,''))+'</li>').join('')+'</ul>';
    if(d.now.now)     S.push(sec('Right now', md(d.now.now), 'wide'));
    if(d.now.blocked) S.push(sec('Blocked on a human', md(d.now.blocked)));
    if(d.now.traps)   S.push(sec('Traps not visible in the code', md(d.now.traps)));
  }

  document.getElementById('main').innerHTML = S.join('');
  document.getElementById('stamp').textContent = new Date(d.at).toISOString().slice(0,19).replace('T',' ')+'Z';

  // The board refreshes every 5s. Re-render an open drawer from the new data rather than closing
  // it, or the card you are reading vanishes mid-read every time the poll lands.
  TASKS = Object.fromEntries((d.board?.tasks||[]).map(t=>[t.id,t]));
  if(openId){ TASKS[openId] ? drawTask(openId) : closeDrawer(); }
}

// ---- task drawer -------------------------------------------------------------------------
let TASKS = {};
let openId = null;
const STATE_LABEL = {doing:'In progress',review:'In review',blocked:'Blocked',backlog:'Backlog',done:'Done'};

function drawTask(id){
  const t = TASKS[id]; if(!t) return;
  const done = t.checklist.filter(c=>c.done).length;
  const pct = t.checklist.length ? Math.round(done/t.checklist.length*100) : 0;
  const meta = (k,v) => v ? '<div class="drow"><span class="dk">'+k+'</span><span class="dv">'+v+'</span></div>' : '';
  const late = t.due && Date.parse(t.due) < Date.now();

  document.getElementById('dbody').innerHTML =
    '<div class="dstate s-'+esc(t.status)+'">'+esc(STATE_LABEL[t.status]||t.status)+'</div>'
    + '<h3 class="dtitle">'+esc(t.title)+'</h3>'
    + '<div class="dchips">'
      + t.labels.map(l=>'<span class="lb">'+esc(l)+'</span>').join('')
      + (t.priority&&t.priority!=='none'?'<span class="lb p">'+esc(t.priority)+' priority</span>':'')
    + '</div>'
    + meta('Department', esc(t.department))
    + meta('Members', t.members.length ? t.members.map(m=>'<span class="who">'+esc(m)+'</span>').join(' ') : '<span class="muted">unassigned</span>')
    + meta('Due', t.due ? '<span class="'+(late?'nogo':'')+'">'+esc(t.due)+(late?' — overdue':'')+'</span>' : '')
    + meta('Created', esc(t.created))
    + meta('Updated', esc(t.updated))
    + meta('Blocked by', t.blockedBy.length ? t.blockedBy.map(b=>'<span class="blk">'+esc(b)+'</span>').join(' ') : '')
    + (t.checklist.length
        ? '<div class="dsec"><div class="dh2">Checklist <span class="cnt">'+done+' of '+t.checklist.length+'</span>'
          + '<span class="bar"><i style="width:'+pct+'%"></i></span></div>'
          + t.checklist.map(c=>'<div class="li s-'+(c.done?'done':'backlog')+'"><span class="mk">'
              +(c.done?'✓':'○')+'</span><span class="lt">'+esc(c.text)+'</span></div>').join('')
          + '</div>'
        : '')
    + (t.description
        ? '<div class="dsec"><div class="dh2">Description</div><div class="ddesc">'+esc(t.description)+'</div></div>'
        : '')
    + '<div class="dsec"><div class="dh2">Source</div><div class="dfile">'+esc(t.file)+'</div>'
      + '<div class="note">This board only reads. Edit the file — in Obsidian or by an agent — and the change '
      + 'appears here within 5s.</div></div>';

  document.getElementById('drawer').hidden = false;
  document.getElementById('scrim').hidden = false;
  openId = id;
}
function closeDrawer(){
  openId = null;
  document.getElementById('drawer').hidden = true;
  document.getElementById('scrim').hidden = true;
}
document.addEventListener('click', e => {
  const hit = e.target.closest('[data-id]');
  if(hit){ drawTask(hit.dataset.id); return; }
  if(e.target.id==='scrim' || e.target.id==='dclose') closeDrawer();
});
document.addEventListener('keydown', e => {
  if(e.key==='Escape') closeDrawer();
  if((e.key==='Enter'||e.key===' ') && document.activeElement?.dataset?.id){
    e.preventDefault(); drawTask(document.activeElement.dataset.id);
  }
});

function sec(title, body, klass){ return '<section class="'+(klass||'')+'"><h2>'+title+'</h2>'+body+'</section>'; }
function row(k,v){ return '<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>'; }

async function tick(){
  try{
    const r = await fetch('/api/status');
    if(!r.ok) throw new Error('HTTP '+r.status);
    render(await r.json());
    document.getElementById('err').textContent='';
  }catch(e){
    // Say so rather than silently showing stale numbers -- a board you cannot trust is worse
    // than no board.
    document.getElementById('err').innerHTML='<span class="nogo">stale — '+esc(e.message)+'</span>';
  }
}
tick(); setInterval(tick, 5000);
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/api/status') {
    const body = JSON.stringify(snapshot(url.searchParams.has('force')));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.on('error', (e) => {
  if (/** @type {any} */ (e).code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. It may already be running: http://${HOST}:${PORT}\nOr pick another: npm run cc:web -- --port 4271\n`);
    process.exit(2);
  }
  console.error(e);
  process.exit(2);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Command center  ->  http://${HOST}:${PORT}`);
  console.log(`  refreshes every 5s · Ctrl+C to stop${NO_GH ? ' · --no-gh' : ''}\n`);
  // Warm the cache so the first page load is instant rather than waiting on git and gh.
  snapshot(true);
});
