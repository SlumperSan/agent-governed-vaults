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
</style>
</head><body>
<header>
  <h1>Agent-Governed Vaults — Command Center</h1>
  <span class="meta" id="stamp">loading…</span>
  <span class="meta" id="err" class="nogo"></span>
</header>
<main id="main"></main>
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
}

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
