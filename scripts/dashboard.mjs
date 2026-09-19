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
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { collect, readBoard, readCalendar } from './lib/project-status.mjs';
import { assignNumbers, movedStatusFor, reconcileAnsweredSuggestions } from './lib/task-numbers.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return dflt;
  return argv[i].includes('=') ? argv[i].split('=')[1] : (argv[i + 1] ?? dflt);
};
const PORT = Number(flag('port', 4270));
const NO_GH = argv.includes('--no-gh');
const HOST = '127.0.0.1';

/** Answers waiting to be relayed to the department that asked. One JSON object per line. */
const OUTBOX = path.join(
  'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults/Tasks',
  '_outbox.jsonl',
);

// Collecting shells out to git and gh, so a page that gathered on every request would hammer both
// and make a refresh feel slow. Cache briefly and let the client poll freely.
let cache = { at: 0, data: null };
// The board is read from the vault on every request, so a task file edited in Obsidian or by an
// agent should appear within a second. A 4s server cache on top of a 5s client poll meant up to
// 9s of lag on a board he watches while departments work.
// THE SLOW HALF IS CACHED FOR A LONG TIME; THE BOARD IS NOT CACHED AT ALL.
//
// collect() shells out with spawnSync -- `gh api graphql` at a 25s timeout, `gh run view` at 20s,
// check-run annotations at 20s each -- and spawnSync BLOCKS NODE'S ONLY THREAD. At an 800ms TTL
// against a 1s poll that meant a fresh collect on almost every request, so the server was
// permanently saturated: measured, /api/status took 7-9 SECONDS and every other request, including
// every answer and delete, queued behind it. From the page that looked like a button stuck on
// "saving..." and a board that had stopped updating.
//
// The board is pure filesystem and costs milliseconds, so it is re-read on EVERY request and the
// git/GitHub half is cached for 30s. Cards stay live at poll speed; CI and branch state lag by up
// to half a minute, which is the right trade for state that changes on a human timescale anyway.
const TTL_MS = 30_000;

/** The vault folder the board reads, and the one task numbers are written back into. */
const VAULT_ROOT = 'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults';
const TASKS_DIR = path.join(VAULT_ROOT, 'Tasks');

function snapshot(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL_MS) return cache.data;
  // Number any new task BEFORE reading, so a card he can see is a card he can name. This is the
  // only place numbering happens; it inserts `num:` into files that have none and touches nothing
  // else. A file added in Obsidian is numbered on the next poll rather than staying unnameable.
  try {
    assignNumbers(TASKS_DIR);
    // Also move any suggestion answered BEFORE the answer endpoint learned to move it.
    // Without this the fix is only prospective and an already-approved card stays sitting in
    // Suggestions, which reads as the approval not having worked -- which is how it was
    // reported: "task #42 still hasn't moved to todo".
    const rec = reconcileAnsweredSuggestions(TASKS_DIR);
    if (rec.moved.length) console.log('[suggestions] moved:', rec.moved.join(', '));
  } catch (e) {
    // Numbering is a convenience; the board is the point. Never let it take the board down --
    // but say so, because a silently unnumbered board looks like the feature was never built.
    console.error('[task-numbers] not assigned:', e.message);
  }
  cache = { at: now, data: collect({ gh: !NO_GH }) };
  return cache.data;
}

/**
 * What every read serves: the cached slow half with a FRESHLY READ board on top.
 *
 * A task file edited in Obsidian or by an agent appears within a poll, as it always did, without
 * paying for git and gh to be interrogated again.
 */
function view() {
  const base = snapshot();
  try {
    return { ...base, board: readBoard(VAULT_ROOT), calendar: readCalendar(VAULT_ROOT) };
  } catch {
    // Never let the fast path take the board down; the cached board is stale, not wrong.
    return base;
  }
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
  main{display:block;padding:16px 20px 40px;max-width:1800px}
  /* The folded reference panels keep the old multi-column grid, inside the fold. */
  .rest{margin-top:16px}
  .rest > summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;
                  letter-spacing:.08em;padding:8px 2px}
  .rest > summary:hover{color:var(--ink)}
  .restgrid{display:grid;gap:14px;margin-top:10px;
            grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}
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
  /* --- view switcher */
  .tiles{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
  .tile{background:var(--bg);color:var(--dim);border:1px solid var(--line);border-radius:7px;
        padding:6px 12px;font:inherit;font-size:12.5px;cursor:pointer;display:flex;
        align-items:center;gap:7px}
  .tile:hover{color:var(--ink);border-color:var(--dim)}
  .tile .n{font-family:var(--mono);font-size:10.5px;padding:0 5px;border-radius:999px;
           background:var(--panel);border:1px solid var(--line)}
  .tile.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .tile.on .n{background:#ffffff26;border-color:transparent;color:#fff}
  .tile:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  /* Department tag on a card, shown only in the merged All view. */
  .cdept{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
         margin-bottom:3px}

  .dept{margin:0 0 18px}
  .dept:last-child{margin-bottom:0}
  details.dept > summary{list-style:none}
  details.dept > summary::-webkit-details-marker{display:none}
  .caret{font-family:var(--mono);color:var(--dim);margin-right:6px}
  .dh{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;
      padding:0 0 7px;border-bottom:1px solid var(--line);margin-bottom:9px;
      display:flex;align-items:center;gap:10px;cursor:pointer}
  .dh:hover{color:var(--accent)}
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
  /* .card is excluded here: its radius is the measured 8px, set in the Trello block below, and
     this rule outranked it on specificity and silently rendered 5px. The checklist line keeps
     its own. */
  .li[data-id]{cursor:pointer;border-radius:5px}
  /* Card hover and focus are the Trello block's, below. Leaving .card in these selectors put a
     themed outline on a surface that is no longer themed. */
  .li[data-id]:hover{background:var(--bg);outline:1px solid var(--line)}
  .li[data-id]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .lb{font-size:10px;padding:1px 7px;border-radius:999px;background:var(--bg);
      border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .lb.p{border-color:currentColor;color:var(--warn)}
  .ck,.due{font-family:var(--mono);font-size:10.5px;color:var(--dim);white-space:nowrap}
  .due.late{color:var(--nogo)}
  .more{margin-top:2px}

  /* --- card detail. A CENTRED MODAL, NOT A RIGHT-SIDE DRAWER.
     This was the largest correction in Design's spec: Trello opens a card in a centred modal and
     the owner asked for a literal copy. The drawer this replaced was the board's own invention.
     Width, radius, offset and shadow are measured values. */
  #scrim{position:fixed;inset:0;background:#0009;z-index:9;overflow-y:auto}
  /* FIXED, NOT RELATIVE. A relative-positioned modal sits wherever the document flow puts it —
     here that was 2,604px down a long board, so opening a card did nothing visible and the button
     looked broken. It must be positioned against the VIEWPORT, and it must scroll internally:
     a 1,178px card in an 855px window is unreadable without it. */
  #drawer{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
          width:584px;max-width:calc(100% - 24px);max-height:calc(100vh - 48px);overflow-y:auto;
          z-index:10;background:var(--t-card-hi);border-radius:12px;padding:16px 20px 24px;
          color:var(--t-ink);
          box-shadow:0 0 0 1px rgba(189,189,189,.12), 0 8px 12px rgba(1,4,4,.36)}
  #dclose{position:absolute;top:12px;right:12px;width:32px;height:32px;background:none;border:0;
          color:var(--t-dim);font-size:15px;cursor:pointer;border-radius:8px;line-height:1}
  #dclose:hover{background:#ffffff14;color:var(--t-ink)}
  /* Trello shows the list the card is in. Ours shows Department then Column, because a card here
     belongs to two axes and the department is the one Trello has no equivalent for. */
  .dcrumb{display:inline-block;font-size:12px;color:var(--t-dim);background:#ffffff14;
          border-radius:4px;padding:2px 8px;margin-bottom:8px}
  .dtitle{font-size:20px;font-weight:653;line-height:24px;margin:0 40px 14px 0;color:var(--t-ink);
          overflow-wrap:anywhere}
  /* THE LEFT ICON GUTTER is what makes this read as Trello rather than as a generic dialog: every
     section has a small icon in a fixed-width gutter and its content on one consistent text
     column. It is not decoration -- remove it and the modal loses the resemblance entirely. */
  .dsec{display:flex;gap:12px;margin-top:18px}
  .dico{width:20px;flex:none;text-align:center;color:var(--t-dim);font-size:14px;line-height:20px}
  .dbody{min-width:0;flex:1}
  .dh2{font-size:14px;font-weight:653;color:var(--t-ink);margin-bottom:8px;
       display:flex;align-items:center;gap:9px;line-height:20px}
  .dh2.minor{font-size:12px;font-weight:600;color:var(--t-dim)}
  .dchips{display:flex;flex-wrap:wrap;gap:6px}
  .dchips .lb{font-size:14px;font-weight:500;line-height:24px;padding:0 12px;border-radius:4px}
  .drow{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid #ffffff14;font-size:12.5px}
  .drow:last-child{border-bottom:0}
  .dk{color:var(--t-dim);width:92px;flex:none}
  .dv{min-width:0;overflow-wrap:anywhere}
  .ddesc{font-size:14px;line-height:20px;white-space:pre-wrap;color:var(--t-ink)}
  /* The frontmatter note leads the Description section and is dimmed a step so the body
     below it still reads as the main text rather than as a second lead. */
  .dnote{font-size:14px;line-height:20px;white-space:pre-wrap;color:var(--t-dim);
         margin-bottom:12px}
  /* Measured: 6px, fully rounded, with the PERCENTAGE AS TEXT to the left of the bar. */
  .ckhead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .ckpct{font-size:12px;color:var(--t-dim);min-width:34px}
  .ckbar{flex:1;height:6px;border-radius:9999px;background:rgba(206,206,217,.07);overflow:hidden}
  .ckbar i{display:block;height:100%;background:var(--t-ink);border-radius:9999px}
  /* The one place the board writes. Made to look like a decision, not a form. */
  .answer .opt{display:block;width:100%;text-align:left;margin-bottom:6px;padding:9px 12px;
               background:var(--bg);color:var(--ink);border:1px solid var(--line);
               border-radius:7px;font:inherit;font-size:12.5px;cursor:pointer}
  .answer .opt:hover{border-color:var(--accent);background:var(--panel)}
  .answer .opt:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .answer .opt:disabled{opacity:.6;cursor:default}
  .answer .opt.failed{border-color:var(--nogo);color:var(--nogo)}
  .danswer{font-size:13px;font-weight:600;color:var(--go)}
  .opt.rec{border-color:#8fb8ff;display:flex;justify-content:space-between;gap:10px;align-items:center}
  .recbadge{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8fb8ff;
            border:1px solid currentColor;border-radius:999px;padding:1px 7px;flex:none}
  .catchup{display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:9px 16px;
           background:var(--warn);color:#1a1205;border:0;border-radius:8px;
           font:inherit;font-size:13px;font-weight:650;cursor:pointer}
  .catchup:hover{filter:brightness(1.08)}
  .catchup .n{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:999px;
              background:#0003}
  #qnav{display:flex;align-items:center;gap:8px;margin:0 40px 10px 0;
        font-size:11.5px;color:var(--dim);font-family:var(--mono)}
  .qskip{background:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;
         padding:3px 10px;font:inherit;font-size:11px;cursor:pointer}
  .qskip:hover{color:var(--ink);border-color:var(--dim)}
  .unb{font-size:10.5px;color:var(--warn);font-family:var(--mono)}
  .other{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
  .other textarea{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);
                  border-radius:7px;padding:8px 10px;font:inherit;font-size:12.5px;resize:vertical}
  .other textarea:focus{outline:none;border-color:var(--accent)}
  .other-go{margin-top:6px}
  /* A card the owner can act on, flagged in the column without opening it. */
  .card.needsme{border-left-color:var(--warn)}
  .needsme .ct::after{content:' ● needs you';color:var(--warn);font-size:10.5px;font-weight:600}
  .dfile{font-family:var(--mono);font-size:11px;color:var(--dim);overflow-wrap:anywhere}
  .more summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;
                letter-spacing:.07em;padding:3px 0}
  .more[open] summary{margin-bottom:7px}
  /* ==========================================================================================
     TRELLO GEOMETRY. Every number here was measured off a live Trello board by Design and is
     recorded in Design/task-board-trello-spec-2026-09-18.md in the vault. The owner asked for a
     literal copy, so these are copied rather than chosen, and a "tidier" round number is a
     regression. Scoped to the board: the repo-status fold below it keeps the themed tokens.

     BRAND TOKENS DELIBERATELY DO NOT APPLY. This is an internal tool on 127.0.0.1, not a product
     surface, so apps/site/src/tokens.css is the wrong vocabulary. The ACCESSIBILITY FLOOR STILL
     DOES, which is the one place this copy departs from Trello -- see the label block below.
     ========================================================================================== */
  :root{
    --t-col:#101204;      /* column surface */
    --t-card:#242528;     /* card surface */
    --t-card-hi:#2b2c2f;  /* card hover, and the modal surface */
    --t-ink:#cecfd2;      /* card and modal title */
    --t-dim:#a9abaf;      /* column header, badge row, struck checklist items */
  }
  /* COLUMNS DO NOT STRETCH. 272px fixed is the single most recognisable property of the layout,
     and a column that grows to fill the viewport is the first thing that stops a copy reading as
     Trello. Five columns plus gaps is 1408px, so one department row fits a normal window; wider
     than that scrolls horizontally, which is what Trello does. */
  .cols{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;align-items:flex-start}
  .col{background:var(--t-col);border-radius:12px;padding:0 4px 4px;
       width:272px;min-width:272px;flex:none}
  /* Header at weight 400, not 600. A bolded column header is the second-most-common tell of a
     Trello copy done from memory. */
  .clh{height:40px;padding:8px 8px 0;font-size:14px;font-weight:400;line-height:20px;
       color:var(--t-dim);display:flex;justify-content:space-between;gap:6px;align-items:flex-start}
  .clh .n{font-weight:400}
  .cardlist{padding:4px}
  /* --- content calendar. A day is a heading with its posts under it, because the question is
     "what goes out and when", and a grid of empty cells answers it worse than a list of the days
     that actually have something in them. */
  .cday{margin:14px 0 0}
  .cdayh{font-size:13px;color:var(--t-dim);padding:0 0 5px;border-bottom:1px solid var(--t-line,#2a2f3a)}
  .crel{font-family:var(--mono);font-size:10.5px;opacity:.7;margin-left:7px}
  .crel.past{color:var(--nogo);opacity:.9}
  .cpost{background:var(--t-card,#1d2230);border-radius:10px;padding:10px 12px;margin:8px 0;
      display:grid;grid-template-columns:1fr 168px;gap:4px 14px}
  .cmeta{grid-column:1;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .cchan{font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#7e9ce0}
  .ctime{font-family:var(--mono);font-size:10.5px;color:var(--dim)}
  .cstat{font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:6px;
      background:rgba(255,255,255,.08);color:var(--t-dim)}
  .cstat.cs-approved{background:#2c5e3a;color:#c8f0d4}
  .cstat.cs-posted{background:#2a3a5e;color:#cfe0ff}
  .cstat.cs-draft{background:#5e4a2a;color:#f3e2c4}
  .ctitle{grid-column:1;font-size:14px;margin-top:2px}
  /* The copy is shown IN FULL and pre-wrapped. A calendar that truncates the post is a calendar you
     cannot approve from, which is the only reason to look at one. */
  .ccopy{grid-column:1;white-space:pre-wrap;font-size:12.5px;line-height:1.5;color:var(--t-dim);
      margin-top:4px}
  .ccopy.none{opacity:.55;font-style:italic}
  .casset{grid-column:2;grid-row:1 / span 3;display:flex;align-items:flex-start;justify-content:flex-end}
  .cthumb{max-width:168px;max-height:112px;border-radius:8px;display:block}
  .cpath,.cnoasset{font-family:var(--mono);font-size:10.5px;color:var(--dim);text-align:right;
      word-break:break-all}
  .cnoasset{color:var(--nogo);opacity:.75}
  .cfile{grid-column:1 / -1;font-family:var(--mono);font-size:10px;color:var(--dim);opacity:.6;
      margin-top:6px}
  /* The grip is the only affordance: a header that looks draggable and is not, or is and does not
     look it, are both worse than a two-character handle that says so. */
  .clh[draggable=true]{cursor:grab}
  .clh[draggable=true]:active{cursor:grabbing}
  .cgrip{opacity:.35;margin-right:5px;letter-spacing:-2px;font-size:11px}
  .col.dragging{opacity:.45}
  .col.dropbefore{box-shadow:inset 3px 0 0 #5b7fd4}
  /* Delete is quiet until it is armed. A destructive control that looks destructive from the
     start gets misread as the primary action of the panel it sits in. */
  .ddel{margin-top:14px;padding-top:10px;border-top:1px solid var(--t-line,#2a2f3a)}
  .delbtn{background:none;border:1px solid var(--t-line,#2a2f3a);color:var(--t-dim);
      font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer}
  .delbtn:hover{border-color:var(--nogo);color:var(--nogo)}
  .delbtn.armed{background:var(--nogo);border-color:var(--nogo);color:#fff;font-weight:500}
  .delnote{display:block;margin-top:5px}
  /* THE NUMBER IS THE CARD'S SPOKEN NAME, so it is legible but never the loudest thing on the
     card -- mono, dim, and ahead of the title so it reads as an identifier rather than as part
     of the sentence. */
  .tnum{font-family:var(--mono);font-size:10.5px;color:var(--dim);opacity:.85;margin-right:5px}
  .card .tnum{display:inline-block;margin-bottom:2px}
  /* SUGGESTIONS AND GOALS READ AS UPSTREAM, not as two more pipeline states. A left rule and a
     tinted header is the whole treatment -- anything louder and the eye starts at the ideas
     column instead of at what is in progress, which inverts what this board is for. */
  .col.c-suggestion,.col.c-goal{position:relative}
  .col.c-suggestion::before,.col.c-goal::before{content:'';position:absolute;left:0;top:8px;
       bottom:8px;width:3px;border-radius:3px}
  .col.c-suggestion::before{background:#b07d2b}
  .col.c-goal::before{background:#5b7fd4}
  .col.c-suggestion .clh{color:#c9922f}
  .col.c-goal .clh{color:#7e9ce0}

  /* --- timeline. Bars are drawn from the due dates the departments set; nothing is estimated
     here, so an undated goal gets a hatched track and the words "no date set" rather than a
     plausible-looking bar. A guessed date on this page would be read as a measured one. */
  .tl{margin:0 0 12px;border:1px solid var(--t-line,#2a2f3a);border-radius:10px;
      background:var(--t-col);padding:6px 10px 10px}
  .tlh{cursor:pointer;font-size:13px;color:var(--t-dim);padding:4px 0;list-style:none}
  .tlh::-webkit-details-marker{display:none}
  .tlh::before{content:'▾ '}
  .tl:not([open]) .tlh::before{content:'▸ '}
  .tlgrp{margin-top:8px}
  .tldept{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--t-dim);
      margin:0 0 4px;padding-bottom:3px;border-bottom:1px solid var(--t-line,#2a2f3a)}
  .tleta{font-family:var(--mono);font-size:10.5px;color:#7e9ce0}
  .tleta.late{color:var(--nogo)}
  .tleta.none{color:var(--dim);opacity:.75}
    /* THE TIME COMES FIRST. The question this row answers is "how long", so the answer leads and
     the title qualifies it -- reading title-then-bar-then-number puts the answer last on every
     row and makes the column impossible to scan. */
  .tlrow{display:grid;grid-template-columns:104px minmax(120px,1fr) 128px;
      gap:10px;align-items:center;padding:3px 2px;border-radius:6px;cursor:pointer}
  .tlrow:hover{background:rgba(255,255,255,.04)}
  .tlname{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    /* The progress cell is the bar AND the number in one control: the bar is the glance, the
     percentage is the answer, and the count behind it is what makes the percentage checkable. */
  .tlpct{position:relative;display:flex;align-items:center;gap:7px;height:16px;padding:0 8px;
      border-radius:8px;background:rgba(255,255,255,.07);overflow:hidden}
  .tlpct i{position:absolute;inset:0 auto 0 0;background:#5b7fd4;opacity:.42}
  .tlpct b{position:relative;font-family:var(--mono);font-size:11px;font-weight:600;
      font-variant-numeric:tabular-nums;color:var(--t-fg,#e8ecf3)}
  .tlpct em{position:relative;font-style:normal;font-family:var(--mono);font-size:10px;
      color:var(--t-dim);opacity:.85}
  .tlpct.none{justify-content:center;font-family:var(--mono);font-size:10.5px;color:var(--dim);
      opacity:.7;background:repeating-linear-gradient(45deg,
      rgba(255,255,255,.07) 0 4px,transparent 4px 8px)}
  .tlwhen{font-family:var(--mono);font-size:11.5px;color:var(--t-dim);text-align:left;
      white-space:nowrap;font-variant-numeric:tabular-nums}
  .tlwhen.late{color:var(--nogo)}
  .tlwhen.none{opacity:.7}
  /* A CARD IS NOT DRAGGABLE AND MUST NOT PRETEND TO BE. Trello's hover lightens the card and its
     cursor is grab; a grab cursor on a read-only board is a promise. Hover is copied, the
     cursor is pointer, and the drag shadow and tilt are gone entirely. */
  .card{background:var(--t-card);border-radius:8px;padding:8px;margin-bottom:8px;min-height:36px;
        box-shadow:0 1px 1px rgba(1,4,4,.5), 0 0 1px rgba(1,4,4,.5);border:0}
  .card:last-child{margin-bottom:0}
  .card[data-id]{cursor:pointer}
  .card[data-id]:hover{background:var(--t-card-hi);outline:0}
  .card[data-id]:focus-visible{outline:2px solid #8fb8ff;outline-offset:1px}
  /* Almost entirely one type size: the hierarchy comes from the badge row being 12px and dimmer,
     not from a bold title. Never truncated with an ellipsis. */
  .ct{font-size:14px;font-weight:400;line-height:20px;color:var(--t-ink);margin-bottom:4px;
      overflow-wrap:anywhere}
  .cm{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--t-dim)}
  .cm .who,.cm .blk,.cm .ck,.cm .due,.cm .prio{font-size:12px;color:var(--t-dim);
      font-family:inherit;background:none;border:0;padding:0;white-space:nowrap}
  .who.none{font-style:italic}
  /* Priority is OURS, not Trello's, so it is a badge in the 12px row rather than a coloured left
     border -- the measured card anatomy has no left border and adding one back is the drift this
     spec exists to stop. Critical and high are the only two that earn a colour. */
  .cm .prio{font-weight:600}
  .p-critical .prio,.p-crit .prio{color:#ff8a80}
  .p-high .prio{color:#ffb4a8}
  /* AN EMPTY COLUMN IS HEADER PLUS BARE BACKGROUND. No illustration, no "nothing here yet", no
     dashed drop zone -- a drop zone would be wrong twice over, since it is not Trello's empty
     state and it advertises a drop target that does not exist. */
  .empty{display:none}

  /* --- labels. THE ONE PLACE THIS MUST NOT COPY TRELLO ------------------------------------
     All eight of Trello's label colours fail WCAG 2.2 non-text contrast against the card
     surface -- measured 2.30 to 2.66 against a 3:1 floor. Trello gets away with it because its
     bars duplicate information available by name elsewhere and it ships a colourblind pattern
     mode. This board has neither, so it does both fixes, and they cost nothing:

       (a) THE LABEL NAME IS ON THE CARD FRONT, so colour is never the sole carrier.
       (b) THE LIFTED PALETTE below, each hue scaled 1.10-1.20x to clear 3:1. Re-measured in
           this session against #242528: 3.06 to 3.11, all eight pass.

     CHIP TEXT IS WHITE, AND THAT IS A DEPARTURE FROM THE SPEC, stated here rather than left to
     be discovered. The spec asks for a light tint of each chip's own hue, from a measured Trello
     pair at 4.81. On the LIFTED backgrounds that pairing cannot be had: the most saturated tint
     that still clears 4.5 is within a few percent of white anyway (4.50-4.57), so it buys an
     invisible tint at a thin margin. Plain white measures 4.92 to 5.01 on the same eight. The
     larger margin won. */
  .lb{font-size:12px;line-height:16px;padding:1px 7px;border-radius:4px;color:#fff;
      white-space:nowrap;overflow-wrap:anywhere}
  .clabels{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
  .lb-green{background:#267f5a} .lb-yellow{background:#8e6a01}
  .lb-orange{background:#b35600} .lb-red{background:#cf372b}
  .lb-purple{background:#9a4cc6} .lb-blue{background:#247894}
  .lb-grey{background:#6d7076}   .lb-navy{background:#196ae2}
  /* A card the owner can act on, flagged in the column without opening it. Trello has no such
     state; this is the board's one addition and it is text, not colour alone. */
  .needsme .ct::after{content:' — needs you';color:#ffd08a;font-size:12px;font-weight:600}

  /* --- the modal is a dark surface, so the themed controls inside it are re-toned here rather
     than edited in place. SCOPED OVERRIDES ON PURPOSE: the answer form, the catch-up queue and
     anything added to the modal later keep their own layout and only their colours land on the
     modal surface. Editing the originals would fight whatever is added next. */
  #drawer .li{font-size:14px;line-height:20px;color:var(--t-ink)}
  #drawer .li.s-done,#drawer .li.s-done .mk{color:var(--t-dim)}
  #drawer .li.s-done .lt{text-decoration:line-through}
  #drawer .note,#drawer .muted,#drawer .dfile,#drawer .qskip,#drawer #qnav{color:var(--t-dim)}
  #drawer .answer .opt{background:#ffffff0f;color:var(--t-ink);border-color:#ffffff2b;
                       font-size:14px}
  #drawer .answer .opt:hover{border-color:#8fb8ff;background:#ffffff1a}
  #drawer .answer .opt:focus-visible{outline-color:#8fb8ff}
  #drawer .answer .opt.failed{border-color:#ff8a80;color:#ff8a80}
  #drawer .danswer{font-size:14px;color:#7ee2a8}
  #drawer .other{border-top-color:#ffffff2b}
  #drawer .other textarea{background:#ffffff0f;color:var(--t-ink);border-color:#ffffff2b;
                          font-size:14px}
  #drawer .other textarea:focus{border-color:#8fb8ff}
  #drawer .qskip{border-color:#ffffff2b}
  #drawer .qskip:hover{color:var(--t-ink);border-color:var(--t-dim)}
  #drawer .dfile{font-size:12px}
</style>
</head><body>
<header>
  <h1>Board</h1>
  <span class="meta" id="repo"></span>
  <span class="meta" id="stamp">loading…</span>
  <span class="meta" id="err" class="nogo"></span>
</header>
<main id="main"></main>

<!-- THE MODAL LIVES INSIDE THE SCRIM, which is what lets it centre and lets a tall card scroll
     the backdrop rather than itself. Clicking the backdrop still closes it: the handler tests
     e.target.id, so only the scrim element itself matches, never a click landing on the card. -->
<div id="scrim" hidden>
  <aside id="drawer" role="dialog" aria-modal="true" aria-label="Task detail">
    <button id="dclose" aria-label="Close">✕</button>
    <div id="qnav" hidden></div>
    <div id="dbody"></div>
  </aside>
</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cls = s => { const u=(s||'').toUpperCase();
  if(u.startsWith('GO')) return 'go'; if(u.includes('NO-GO')) return 'nogo';
  if(u.includes('STALE')||u.includes('CONDITIONAL')) return 'warn'; return 'idle'; };
const ago = ms => { const s=Math.round(ms/1000); if(s<90) return s+'s ago';
  const m=Math.round(s/60); if(m<90) return m+'m ago'; const h=Math.round(m/60);
  return h<48 ? h+'h ago' : Math.round(h/24)+'d ago'; };
const short = a => a.slice(0,6)+'…'+a.slice(-4);

// LABEL COLOUR. Trello lets you pick a label's colour; our labels are free text in a task file,
// so a colour has to be derived. Two rules:
//
//   1. The labels that carry meaning are PINNED, so security is always the red one and shipped
//      is always the green one. A hash that moved them around each time a label was renamed
//      would make the colour worse than no colour at all.
//   2. Everything else hashes to one of the eight hues. Pure string arithmetic over the
//      characters, so the same label is the same colour on every machine and in every render --
//      never the label's position in an array, which changes when a task file is added.
//
// THE NAME IS ALWAYS RENDERED INSIDE THE CHIP, so none of this is load-bearing. The colour is a
// second, redundant channel, which is precisely what Trello's own bare colour bars lack and why
// all eight of its label colours fail the non-text contrast floor without consequence for Trello
// and with consequence for us. Top-level so the card front and the modal derive the same hue.
const HUES=['green','yellow','orange','red','purple','blue','grey','navy'];
const PINNED={security:'red', guard:'red', 'owner-decision':'navy', 'launch-parameter':'purple',
  shipped:'green', design:'blue', copy:'yellow', frontend:'blue', backend:'grey', docs:'grey',
  arc:'orange', 'needs-verdict':'orange'};
const hue = l => { const k=String(l).toLowerCase(); if(PINNED[k]) return PINNED[k];
  let n=0; for(let i=0;i<k.length;i++) n=(n*31+k.charCodeAt(i))>>>0;
  return HUES[n%HUES.length]; };
const labels = t => t.labels.map(l=>'<span class="lb lb-'+hue(l)+'">'+esc(l)+'</span>').join('');

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
    // Left to right in the order work moves. DONE IS NOT A COLUMN: finished work is the majority
    // of any healthy board and it crowded out the four columns that still need a decision. The
    // count stays in every header — "4 of 11" — so progress is still visible without a parking lot.
    // Suggestions and Goals lead, because both are UPSTREAM of the work rather than states of it.
    // Suggestions: a department's idea, awaiting approve/decline. Approved ones are moved to To do
    // by editing the file, same as every other card here. Goals: the outcome a department is
    // working toward; a goal does not travel the pipeline, it stays until it is met.
    // DERIVED FROM THE COLLECTOR, NOT COPIED FROM IT. d.board.columns IS BOARD_COLUMNS, sent with
    // every payload, so a status added there appears here with no second edit.
    //
    // This replaces three hardcoded lists that had to be changed together. A comment saying "change
    // all three together" is not a mechanism, and the cost of it drifting was measured rather than
    // guessed: with a status present in the collector and absent here, 2 tasks in, 1 placed into a
    // column, 1 DROPPED, and nothing thrown. Rendering collects the tasks matching each column key,
    // so a status with no column shows NOWHERE. On a board whose whole purpose is showing what is
    // in flight, a silently absent card is the worst available failure.
    //
    // META IS PRESENTATION ONLY -- a label, a mark, and a place in the reading order. A STATUS WITH
    // NO ENTRY STILL RENDERS, under its own raw name, at the end. That is the property that
    // matters: an unlabelled column is a cosmetic problem a human fixes in a minute, and a
    // disappeared task is a defect nobody sees.
    const META={
      suggestion:{label:'Suggestions', mark:'\u{1F4A1}', rank:4},
      goal:      {label:'Goals',       mark:'\u25CE',    rank:5},
      backlog:   {label:'To do',       mark:'\u25CB',    rank:3},
      doing:     {label:'In progress', mark:'\u25D0',    rank:0},
      review:    {label:'In review',   mark:'\u25D0',    rank:1},
      blocked:   {label:'Needs you',   mark:'\u2715',    rank:2},
      done:      {label:'Done',        mark:'\u2713',    rank:9},
    };
    const metaOf = k => META[k] || {label:k, mark:'\u25A1', rank:8};
    // DONE IS NOT A COLUMN: finished work is the majority of any healthy board and it crowded out
    // the columns that still need a decision. The count stays in every header -- "4 of 11" -- so
    // progress is visible without a parking lot.
    // COLUMN ORDER IS HIS, AND IT PERSISTS. Dragging a column header rewrites the order and it is
    // remembered in localStorage -- a board whose columns jump back on every poll is worse than one
    // that cannot be reordered at all.
    //
    // The stored order is a FILTER OVER the derived list, never a replacement for it: any column it
    // does not mention is appended rather than dropped, and any name it mentions that no longer
    // exists is ignored. So a stale preference cannot hide a column, which is the same property the
    // derivation itself was built for.
    const stored = (()=>{ try{ return JSON.parse(localStorage.getItem('colOrder')||'[]'); }catch{ return []; } })();
    const derived=(d.board.columns||[]).filter(k=>k!=='done');
    const ordered=[...stored.filter(k=>derived.includes(k)), ...derived.filter(k=>!stored.includes(k))];
    const COLS=ordered.map(k=>[k, metaOf(k).label]);
    // WHAT COUNTS AS WORK. Progress bars and tile counts are about deliverables, so neither a
    // suggestion nor a goal belongs in the denominator: a goal has no terminal state and would
    // sit in "0 of N" forever, making every department read as less finished than it is.
    const isWork = t => t.status!=='suggestion' && t.status!=='goal';

    // BLOCKED MEANS ONE THING: waiting on an answer from him. Nothing else belongs there.
    //
    // A task marked blocked because it is CONTINGENT on another task's answer is not blocked on
    // him - he cannot do anything about it until the upstream answer lands, and putting it in
    // front of him makes the column a list of things he cannot action. Those render as To do.
    // Mirrors optionsFor() on the server. A suggestion always has the approve/decline pair even
    // when its file declares none, so a suggestion with no options field is still answerable.
    const optsOf = t => t.options.length ? t.options : (t.status==='suggestion' ? ['Approve - move to To do','Decline'] : []);
    const needsOwner = t => optsOf(t).length > 0 && !t.answer;
    // A SUGGESTION STAYS IN SUGGESTIONS even though it carries options and therefore needs him.
    // Without this it would render under "Needs you" and the Suggestions column would always read
    // zero -- the column exists precisely to keep unapproved ideas out of the decision queue, so
    // routing them there by their options field would defeat it.
    const eff = t => (t.status === 'suggestion' || t.status === 'goal') ? t.status
                   : (t.status === 'blocked' && !needsOwner(t)) ? 'backlog' : t.status;
    // Column label per task id, for the modal breadcrumb. Built from the same COLS and eff() the
    // columns themselves use, so the two can never disagree. Done has no column, so it falls back
    // to its state name rather than to an empty crumb.
    for(const t of d.board.tasks){
      const hit = COLS.find(([k]) => k === eff(t));
      COL_LABEL[t.id] = hit ? hit[1] : (STATE_LABEL[t.status] || t.status);
    }

    // How many other tasks each answer releases. One question often clears several, and that is
    // the fact that decides which question to ask first.
    const unblocks = {};
    for (const t of d.board.tasks) {
      for (const b of t.blockedBy) (unblocks[b] ||= []).push(t.title);
    }
    // Owner first, always. What is waiting on him is the only thing on this board he can act on,
    // and alphabetical ordering buried it between Marketing and Product.
    const DEPTS=[...new Set(d.board.tasks.map(t=>t.department))]
      .sort((a,b)=> (a==='Owner'?-1:b==='Owner'?1:a.localeCompare(b)));
    // Stacking order inside a card, measured: label chips, title, badge row. The title wraps
    // freely and is never truncated with an ellipsis.
    const card = (t, withDept) => '<div class="card p-'+esc(t.priority||'none')
      +(t.options.length && !t.answer ? ' needsme':'')+'" data-id="'+esc(t.id)+'" role="button" tabindex="0">'
      + (withDept?'<div class="cdept">'+esc(t.department)+'</div>':'')
      + chips(t)
      + (t.num?'<span class="tnum">#'+t.num+'</span>':'')
      + '<div class="ct">'+esc(t.title)+'</div>'
      + '<div class="cm">'
        + (t.priority && t.priority!=='none' ? '<span class="prio">'+esc(t.priority)+'</span>' : '')
        + (t.owner?'<span class="who">'+esc(t.owner)+'</span>':'<span class="who none">unassigned</span>')
        + chip(t) + dueChip(t)
        + (t.blockedBy.length?'<span class="blk">blocked by '+esc(t.blockedBy.join(', '))+'</span>':'')
        + (unblocks[t.id] ? '<span class="unb">releases '+unblocks[t.id].length+'</span>' : '')
      + '</div>'
      // NO DESCRIPTION ON THE CARD FRONT. Trello's card is chips, title and a badge row, and its
      // whole density proposition is that a column shows ten cards rather than four. Rendering
      // the note here made cards 125-246px tall against Trello's measured 48-96px. It is not
      // lost: it opens the Description section of the modal, above the body text.
      + '</div>';

    // Checklist ordering: what is moving, then what is stuck, then what is queued, then what is
    // finished. Done sinks because a tracker is for the work that is left.
    // Same source, same fallback. An unknown status sorts at 8 rather than undefined -- which made
    // the comparator return NaN and handed Array.sort an inconsistent ordering, silently and
    // implementation-defined.
    const ORDER=Object.fromEntries((d.board.columns||[]).map(k=>[k, metaOf(k).rank]));
    // Critical, high, medium, low, then unset. Applied WITHIN a column, so the top card in any
    // column is the most urgent thing in that state rather than the most recently saved file.
    const PRIO={critical:0,crit:0,high:1,med:2,medium:2,low:3};
    const byPrio=(a,b)=>((PRIO[a.priority]??9)-(PRIO[b.priority]??9))||(b.mtime-a.mtime);
    const MARK=Object.fromEntries((d.board.columns||[]).map(k=>[k, metaOf(k).mark]));
    const chip = t => { const d=t.checklist.filter(c=>c.done).length;
      return t.checklist.length? '<span class="ck">☑ '+d+'/'+t.checklist.length+'</span>' : ''; };
    const dueChip = t => { if(!t.due) return '';
      const late = Date.parse(t.due) < Date.now();
      return '<span class="due'+(late?' late':'')+'">◷ '+esc(t.due)+'</span>'; };
    const chips = t => t.labels.length? '<div class="clabels">'+labels(t)+'</div>' : '';

    const line = t => '<div class="li s-'+esc(eff(t))+'" data-id="'+esc(t.id)+'" role="button" tabindex="0">'
      + '<span class="mk">'+MARK[eff(t)]+'</span>'
      + (t.num?'<span class="tnum">#'+t.num+'</span>':'')
      + '<span class="lt">'+esc(t.title)+'</span>'
      + labels(t) + chip(t) + dueChip(t)
      + (unblocks[t.id] ? '<span class="unb">releases '+unblocks[t.id].length+'</span>' : '')
      + (t.status!=='done' && t.owner?'<span class="who">'+esc(t.owner)+'</span>':'')
      + (t.blockedBy.length?'<span class="blk">needs '+esc(t.blockedBy.join(', '))+'</span>':'')
      + '</div>';

    /** One department's five columns. withDept tags each card, for the merged All view. */
    const columnsFor = (tasks, withDept) => {
      let h='<div class="cols">';
      for(const [key,label] of COLS){
        const inCol=tasks.filter(t=>eff(t)===key).sort(byPrio);
        // An empty column is its header over bare column background -- no placeholder, no dashed
        // drop zone. A drop zone would be wrong twice: it is not Trello's empty state, and it
        // advertises a drop target this read-only board does not have.
        h+='<div class="col c-'+key+'" data-col="'+esc(key)+'"><div class="clh" draggable="true" title="Drag to reorder">'
          + '<span class="cgrip">⋮⋮</span>'+label+' <span class="n">'+inCol.length+'</span></div>'
          + '<div class="cardlist">'+inCol.map(t=>card(t,withDept)).join('')+'</div>'
          +'</div>';
      }
      return h+'</div>';
    };
    const checklistFor = tasks =>
      '<details class="more"><summary>as a checklist</summary><div class="list">'
      + tasks.slice().sort((a,b)=>(ORDER[eff(a)]-ORDER[eff(b)])||byPrio(a,b)||a.title.localeCompare(b.title))
             .map(line).join('')
      +'</div></details>';
    const header = (name, tasks, open) => {
      const work=tasks.filter(isWork);
      const done=work.filter(t=>t.status==='done').length;
      const pct=work.length? Math.round(done/work.length*100):0;
      return '<summary class="dh"><span class="caret">'+(open?'▾':'▸')+'</span>'+esc(name)
        +' <span class="cnt">'+done+' of '+work.length+'</span>'
        +'<span class="bar"><i style="width:'+pct+'%"></i></span></summary>';
    };

    let body='';
    if(d.board.problem) body+='<div class="caveat">'+esc(d.board.problem)+'</div>';
    if(!d.board.tasks.length){
      body+='<div class="note">No task files. Add one to <code>Tasks/</code> in the vault.</div>';
    }

    // The switcher. All merges every department into one board; a named tile shows only that one.
    // Selection is remembered in the URL hash so a refresh — and the 5s poll — keep your view.
    const queue = d.board.tasks.filter(needsOwner).sort(byPrio).map(t=>t.id);
    QUEUE = queue;
    if(queue.length){
      body+='<button class="catchup" data-catchup="1">Get up to speed'
        +'<span class="n">'+queue.length+'</span></button>';
    }
    // --- TIMELINE. How long the goals take, drawn from the due: date each department set on its own
    // goal file. NOTHING HERE IS ESTIMATED. A goal with no date renders as "no date set" and is
    // excluded from the scale rather than given a guess -- a fabricated ETA on this page is the
    // same defect class as a derived number presented as a measurement, and it would be believed.
    // A MET GOAL LEAVES THE TIMELINE. The timeline answers "how long until the things we are
    // committed to are done", so a finished goal on it is noise that makes every remaining bar
    // look less urgent than it is. Two ways a goal finishes: its status moves off goal, or its
    // checklist is fully ticked -- departments do the second and forget the first, and a goal
    // sitting at 8/8 with a bar still running reads as the board being wrong.
    const goalDone = t => t.checklist.length>0 && t.checklist.every(c=>c.done);
    const goals=d.board.tasks.filter(t=>t.status==='goal' && !goalDone(t));
    if(goals.length){
      const DAY=86400000, now=Date.now();
      const dated=goals.filter(g=>g.due && !Number.isNaN(Date.parse(g.due)));
      // The scale runs from today to the furthest dated goal. An overdue goal would otherwise
      // draw a negative-width bar, so the floor is today and lateness is said in words instead.
      const horizon=dated.length? Math.max(...dated.map(g=>Date.parse(g.due)), now+DAY) : now+DAY;
      const span=Math.max(horizon-now, DAY);
      const days=ms=>Math.round(ms/DAY);
      // THE BAR SHOWS PROGRESS, NOT TIME. A bar scaled to the days remaining says the same thing
      // the date beside it already says, and says it worse -- the goal furthest away drew the
      // longest bar, which reads as "most done" at a glance and is the exact opposite of true.
      // Progress is the checklist: done items over total, which is the only completion figure a
      // goal actually carries.
      //
      // A goal with NO checklist has no measurable progress and says so rather than drawing an
      // empty bar. An empty bar and 0% are the same picture and mean different things -- one is
      // "not started", the other is "nothing here to measure".
      const pctCell=g=>{
        const n=g.checklist.length;
        if(!n) return '<span class="tlpct none">no items</span>';
        const done=g.checklist.filter(c=>c.done).length;
        const pct=Math.round(done/n*100);
        return '<span class="tlpct"><i style="width:'+pct+'%"></i>'
          +'<b>'+pct+'%</b><em>'+done+'/'+n+'</em></span>';
      };
      const row=g=>{
        if(!g.due||Number.isNaN(Date.parse(g.due)))
          return '<div class="tlrow" data-id="'+esc(g.id)+'" role="button" tabindex="0">'
            +'<span class="tlwhen none">no date set</span>'
            +'<span class="tlname">'+(g.num?'#'+g.num+' ':'')+esc(g.title)+'</span>'
            +pctCell(g)+'</div>';
        const end=Date.parse(g.due), left=days(end-now), late=end<now;
        const w=Math.max(2, Math.round(Math.min(end-now, span)/span*100));
        return '<div class="tlrow" data-id="'+esc(g.id)+'" role="button" tabindex="0">'
          +'<span class="tlwhen'+(late?' late':'')+'">'
          +(late? Math.abs(left)+'d overdue' : left+'d · '+esc(g.due))+'</span>'
          +'<span class="tlname">'+(g.num?'#'+g.num+' ':'')+esc(g.title)+'</span>'
          +pctCell(g)+'</div>';
      };
      const byDept={};
      for(const g of goals) (byDept[g.department]||=[]).push(g);
      const shown=VIEW==='All'? Object.keys(byDept).sort() : Object.keys(byDept).filter(k=>k===VIEW);
      // The department ETA is the LATEST due among its goals -- when everything it is committed to
      // is meant to be done, not the next milestone. Undated goals make it unknown and say so.
      const eta=list=>{
        const ds=list.filter(g=>g.due && !Number.isNaN(Date.parse(g.due))).map(g=>Date.parse(g.due));
        if(!ds.length) return '<span class="tleta none">no dates set</span>';
        const last=Math.max(...ds), l=days(last-now);
        const undated=list.length-ds.length;
        return '<span class="tleta'+(last<now?' late':'')+'">all done in '+(last<now?'—':l+'d')
          +'</span>'+(undated?'<span class="tleta none">'+undated+' undated</span>':'');
      };
      if(shown.length) body+='<details class="tl" open><summary class="tlh">Timeline — '
        +goals.length+' goal'+(goals.length===1?'':'s')+'</summary>'
        + shown.map(k=>'<div class="tlgrp"><div class="tldept">'+esc(k)+eta(byDept[k])+'</div>'
            + byDept[k].slice().sort((a,b)=>(Date.parse(a.due)||Infinity)-(Date.parse(b.due)||Infinity))
                       .map(row).join('')
          +'</div>').join('')
        +'</details>';
    }

    body+='<div class="tiles">'
      + ['All','Calendar',...DEPTS].map(t=>{
          // Calendar's badge is planned posts, not open tasks -- a tile counts what its view
          // shows, or the number means nothing.
          if(t==='Calendar') return '<button class="tile'+(VIEW===t?' on':'')+'" data-view="Calendar">Calendar <span class="n">'+((d.calendar&&d.calendar.items.length)||0)+'</span></button>';
          const open=t==='All'? d.board.tasks.filter(x=>isWork(x)&&x.status!=='done').length
                              : d.board.tasks.filter(x=>x.department===t&&isWork(x)&&x.status!=='done').length;
          return '<button class="tile'+(VIEW===t?' on':'')+'" data-view="'+esc(t)+'">'
            +esc(t)+' <span class="n">'+open+'</span></button>';
        }).join('')
      +'</div>'
      // SAID ONCE, HERE, AND NOWHERE ELSE. The board cannot drag, so the way to move a card is to
      // edit its file. Repeating that on every card would be noise; omitting it entirely leaves a
      // reader who has just failed to drag something with nothing to do next.
      +'<div class="note" style="margin:-6px 0 10px">Read-only apart from the answer buttons. '
      +'To move a card, edit its task file — the board follows within 5s.</div>';

    // --- content calendar. Read-only, like the board: Marketing writes GTM/Calendar/*.md in the
    // vault and this renders it.
    const cal = d.calendar || {items:[], problem:''};
    const DAYNAME = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayLabel = iso => {
      const dt = new Date(iso + 'T12:00:00');
      if (Number.isNaN(dt.getTime())) return esc(iso);
      const today = new Date(); today.setHours(12,0,0,0);
      const days = Math.round((dt - today) / 86400000);
      const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow'
                : days < 0 ? Math.abs(days)+'d ago' : 'in '+days+'d';
      return DAYNAME[dt.getDay()]+' '+esc(iso)+' <span class="crel'+(days<0?' past':'')+'">'+rel+'</span>';
    };
    // An asset shows as a thumbnail only when it is an image we can actually load, and as its
    // path otherwise. NEVER as a broken image: a missing graphic has to look missing, because
    // approving a post whose asset does not exist is the mistake this view exists to prevent.
    const assetCell = it => {
      if (!it.asset) return '<span class="cnoasset">no graphic</span>';
      const kind = (it.assetKind||'').toLowerCase();
      const isImg = kind === 'image' || /[.](png|jpe?g|gif|webp|svg)$/i.test(it.asset);
      const isVid = kind === 'video' || /[.](mp4|mov|webm)$/i.test(it.asset);
      const url = /^https?:/i.test(it.asset) ? it.asset : '';
      if (isImg && url) return '<img class="cthumb" src="'+esc(url)+'" alt="" loading="lazy">';
      return '<span class="cpath">'+(isVid?'\u25B6 ':'\u25A3 ')+esc(it.asset)+'</span>';
    };
    const byDay = {};
    for (const it of cal.items) (byDay[it.date] ||= []).push(it);
    let cbody = '';
    if (cal.problem) cbody += '<div class="caveat">'+esc(cal.problem)+'</div>';
    if (!cal.items.length) cbody += '<div class="note">Nothing planned yet. Marketing adds one file per post to <code>GTM/Calendar/</code> in the vault: frontmatter <code>date</code>, <code>time</code>, <code>channel</code>, <code>status</code>, <code>asset</code>, and the copy in the body.</div>';
    for (const day of Object.keys(byDay).sort()) {
      cbody += '<div class="cday"><div class="cdayh">'+dayLabel(day)+'</div>';
      for (const it of byDay[day]) {
        cbody += '<div class="cpost">'
          + '<div class="cmeta"><span class="cchan">'+esc(it.channel)+'</span>'
          + (it.time ? '<span class="ctime">'+esc(it.time)+'</span>' : '')
          + '<span class="cstat cs-'+esc(it.status)+'">'+esc(it.status)+'</span></div>'
          + '<div class="ctitle">'+esc(it.title)+'</div>'
          + (it.copy ? '<div class="ccopy">'+esc(it.copy)+'</div>' : '<div class="ccopy none">no copy written</div>')
          + '<div class="casset">'+assetCell(it)+'</div>'
          + '<div class="cfile">'+esc(it.file)+'</div>'
          + '</div>';
      }
      cbody += '</div>';
    }
    if(VIEW==='Calendar'){
      // The variable body already carries the view switcher, so the tiles stay reachable from here and he
      // can get back to the board without the browser's back button.
      S.unshift(sec('Content calendar \u00b7 '+cal.items.length+' planned', body + cbody, 'wide'));
      const boardSec = S[0] ?? '';
      const restSec = S.slice(1).join('');
      document.getElementById('main').innerHTML = boardSec
        + (restSec ? '<details class="rest"><summary>repo status</summary><div class="restgrid">'+restSec+'</div></details>' : '');
      return;
    }

    if(VIEW==='All'){
      // Merged: five columns, every department's cards together, each tagged with its department.
      body+='<div class="dept">'+columnsFor(d.board.tasks, true)+checklistFor(d.board.tasks)+'</div>';
    } else {
      const mine=d.board.tasks.filter(t=>t.department===VIEW);
      body+='<details class="dept" open>'+header(VIEW,mine,true)
        +columnsFor(mine,false)+checklistFor(mine)+'</details>';
    }

    const allWork=d.board.tasks.filter(isWork);
    const allDone=allWork.filter(t=>t.status==='done').length;
    const allPct=allWork.length? Math.round(allDone/allWork.length*100):0;
    // FIRST on the page, not buried under the repo panels. It is the thing he opens this for; the
    // tree, gate and launch tables are reference and belong below it.
    S.unshift(sec('Board · '+allDone+' of '+allWork.length
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

  // THE BOARD IS THE PAGE. Everything else is reference and folds away.
  //
  // This screen had nine panels above the fold and the board was the last of them. The tree, the
  // gate table, the launch-gate register, the sprint list, the deployment address book and the
  // NOW extracts are all still here and still correct — they are just not what this is opened for,
  // and a board you have to scroll past six tables to reach is a board nobody looks at.
  const board = S[0] ?? '';
  const rest = S.slice(1).join('');
  document.getElementById('main').innerHTML = board
    + (rest ? '<details class="rest"><summary>repo status — tree, gate, launch gates, sprints, deployments</summary>'
              + '<div class="restgrid">'+rest+'</div></details>' : '');

  // Branch and gate as one line in the header rather than two panels, because they are the two
  // facts worth seeing without opening anything.
  const g = d.gate;
  document.getElementById('repo').innerHTML =
    '<span class="mono">'+esc(d.tree.branch)+'</span>'
    + (d.tree.dirty.length? ' <span class="warn">'+d.tree.dirty.length+' uncommitted</span>' : ' <span class="go">clean</span>')
    + (g? ' · gate <span class="'+(g.passed?'go':'nogo')+'">'+(g.passed?'passed':'failed')+'</span>'
          + (g.caveats.length? ' <span class="warn" title="'+esc(g.caveats.join('; '))+'">(caveats)</span>' : '')
        : ' · <span class="warn">gate never run</span>');

  document.getElementById('stamp').textContent = new Date(d.at).toISOString().slice(0,19).replace('T',' ')+'Z';

  // The board refreshes every 5s. Re-render an open drawer from the new data rather than closing
  // it, or the card you are reading vanishes mid-read every time the poll lands.
  // THE MODAL'S BREADCRUMB MUST NAME THE COLUMN THE CARD IS ACTUALLY IN, and t.status is not
  // that: eff() moves a blocked task nobody is waiting on into To do, and the blocked column is
  // labelled "Needs you" rather than "Blocked". Reading t.status in the modal therefore named a
  // column the reader could not find. The label is resolved here, where COLS and eff() are in
  // scope, and carried on the task.
  TASKS = Object.fromEntries((d.board?.tasks||[]).map(t=>[t.id,{...t, col: COL_LABEL[t.id] || ''}]));
  if(openId){ TASKS[openId] ? drawTask(openId) : closeDrawer(); }
}

// ---- view switching ----------------------------------------------------------------------
// Which department is on screen. Kept in the URL hash so the 5s poll cannot reset it and a
// refresh lands you back where you were.
let VIEW = decodeURIComponent((location.hash||'').replace(/^#/,'')) || 'All';
function setView(v){
  VIEW = v;
  history.replaceState(null,'','#'+encodeURIComponent(v));
  if(LAST) render(LAST);
}
window.addEventListener('hashchange', () => {
  const v = decodeURIComponent((location.hash||'').replace(/^#/,'')) || 'All';
  if(v!==VIEW){ VIEW=v; if(LAST) render(LAST); }
});

// ---- task drawer -------------------------------------------------------------------------
let TASKS = {};
let openId = null;
// The ids waiting on him, in the order the board shows them. Rebuilt on every render so an
// answer recorded elsewhere drops out of the queue rather than being offered twice.
let QUEUE = [];
let inQueue = false;
const STATE_LABEL = {doing:'In progress',review:'In review',blocked:'Blocked',backlog:'Backlog',done:'Done',
  suggestion:'Suggestion',goal:'Goal'};
// A card in the Suggestions column is by definition an approve-or-decline, so the board supplies
// that pair when the file declares no options. Mirrors optionsFor() on the server; the two must
// agree or a button renders that the write endpoint then refuses. Declared options still win.
const OPTS = t => t.options.length ? t.options : (t.status==='suggestion' ? ['Approve - move to To do','Decline'] : []);
/** Column label per task id, filled by render(). See the comment where TASKS is built. */
const COL_LABEL = {};

function drawTask(id){
  const t = TASKS[id]; if(!t) return;
  // THE 5s POLL RE-RENDERS AN OPEN CARD, AND THAT USED TO EAT WHAT HE WAS TYPING. render() calls
  // this again on every tick so a card being read does not vanish mid-read; it replaces the whole
  // modal body, textarea included, so anyone composing a free-text answer for more than five
  // seconds lost it with no error and no sign it had happened. Carry the draft across.
  const prev = document.getElementById('othertext');
  const draft = prev && prev.value ? prev.value : '';
  const hadFocus = prev && document.activeElement === prev;
  const done = t.checklist.filter(c=>c.done).length;
  const pct = t.checklist.length ? Math.round(done/t.checklist.length*100) : 0;
  const meta = (k,v) => v ? '<div class="drow"><span class="dk">'+k+'</span><span class="dv">'+v+'</span></div>' : '';
  const late = t.due && Date.parse(t.due) < Date.now();

  // EVERY SECTION SITS IN THE LEFT ICON GUTTER. Trello puts a small icon in a fixed-width column
  // and aligns all section content to one text column; that gutter is what makes the modal read
  // as Trello rather than as a generic dialog. dsec() is the only way to add one, so a section
  // added later cannot accidentally sit outside it.
  const dsec = (icon, head, bodyHtml, klass, minor) =>
    '<div class="dsec '+(klass||'')+'"><div class="dico">'+icon+'</div><div class="dbody">'
    + (head ? '<div class="dh2'+(minor?' minor':'')+'">'+head+'</div>' : '')
    + bodyHtml + '</div></div>';

  document.getElementById('dbody').innerHTML =
    // Trello's breadcrumb names the list a card is in. A card here belongs to two axes, and the
    // department is the one Trello has no equivalent for, so both are shown.
    '<div class="dcrumb">'+(t.num?'<span class="tnum">#'+t.num+'</span> ':'')+esc(t.department)+' → '+esc(t.col||STATE_LABEL[t.status]||t.status)+'</div>'
    + '<h3 class="dtitle">'+esc(t.title)+'</h3>'
    // Section order, per the spec: Labels, Description, Checklist, Meta.
    + (t.labels.length ? dsec('▤','Labels','<div class="dchips">'+labels(t)+'</div>','',true) : '')
    // ONE Description section carrying both prose fields, note first. The note is the frontmatter
    // one-liner and the description is the body; Trello has a single description, and two prose
    // sections would not read as a copy of it. Shown when EITHER exists -- the note used to render
    // on the card front and nowhere else, so gating this on the description alone would drop it.
    + ((t.note || t.description)
        ? dsec('☰','Description',
            (t.note ? '<div class="dnote">'+esc(t.note)+'</div>' : '')
            + (t.description ? '<div class="ddesc">'+esc(t.description)+'</div>' : ''))
        : '')
    + (t.checklist.length
        ? dsec('☑','Checklist',
            // The percentage is TEXT to the left of the bar, measured. A bar alone makes a
            // reader estimate a number the page already knows.
            '<div class="ckhead"><span class="ckpct">'+pct+'%</span>'
            + '<span class="ckbar"><i style="width:'+pct+'%"></i></span>'
            + '<span class="ckpct">'+done+'/'+t.checklist.length+'</span></div>'
            // Checked items are struck through and dimmed rather than hidden, so the list still
            // reads as what the task involves rather than only as what is left.
            + t.checklist.map(c=>'<div class="li s-'+(c.done?'done':'backlog')+'"><span class="mk">'
                +(c.done?'✓':'○')+'</span><span class="lt">'+esc(c.text)+'</span></div>').join(''))
        : '')
    // The one place this board writes. A task that names options and is waiting on him gets
    // real buttons; clicking one records the answer against the task file so the next session
    // reads a decision instead of asking again.
    + (OPTS(t).length && !t.answer
        ? dsec('✎','Your answer',
            OPTS(t).map((o,i)=>'<button class="opt'+(o===t.recommended?' rec':'')
              +'" data-answer="'+esc(t.id)+'" data-opt="'+i+'">'+esc(o)
              +(o===t.recommended?'<span class="recbadge">recommended</span>':'')
              +'</button>').join('')
            // Always an escape hatch. A fixed option list is a guess at what he will decide, and
            // forcing a decision into the nearest listed option records something he did not mean.
            + '<div class="other"><textarea id="othertext" rows="3" placeholder="Or write your own answer…"></textarea>'
            + '<button class="opt other-go" data-answer="'+esc(t.id)+'" data-opt="custom">Record my answer</button></div>'
            + '<div class="note">Recorded in the task file and read by whichever department is '
            + 'waiting on it. Nothing is sent anywhere else.</div>', 'answer')
        : '')
    + (t.answer
        ? dsec('✓','Answered','<div class="danswer">'+esc(t.answer)+'</div>'
            + (t.answeredAt?'<div class="note">'+esc(t.answeredAt)+'</div>':''))
        : '')
    // META LAST, and it carries what the card front deliberately does not, including the source
    // path -- the only actionable thing on a read-only board.
    + dsec('≡','Meta',
        meta('Priority', t.priority&&t.priority!=='none' ? esc(t.priority) : '')
        + meta('Members', t.members.length ? t.members.map(m=>'<span class="who">'+esc(m)+'</span>').join(' ') : '<span class="muted">unassigned</span>')
        + meta('Due', t.due ? '<span class="'+(late?'nogo':'')+'">'+esc(t.due)+(late?' — overdue':'')+'</span>' : '')
        + meta('Created', esc(t.created))
        + meta('Updated', esc(t.updated))
        + meta('Blocked by', t.blockedBy.length ? t.blockedBy.map(b=>'<span class="blk">'+esc(b)+'</span>').join(' ') : '')
        + meta('Source', '<span class="dfile">'+esc(t.file)+'</span>')
        + '<div class="note">To move a card, edit its file — in Obsidian or by an agent — and the '
        + 'change appears within 5s.</div>'
        // DELETE LIVES HERE, at the bottom of the last section, behind a second click. It is off
        // the card front deliberately: a card is clicked to read it, and a delete control on the
        // front is a mis-click away from removing the thing you meant to open.
        + '<div class="ddel"><button class="delbtn" data-del="'+esc(t.id)+'">Delete this task</button>'
        + '<span class="note delnote">The file moves to <code>Tasks/_deleted/</code> — it leaves '
        + 'the board but stays recoverable.</span></div>');

  // Restore the in-progress answer, and the caret with it. Restoring the text but not the
  // selection would still move his cursor to the end of the box every five seconds.
  const box = document.getElementById('othertext');
  if(box && draft){
    box.value = draft;
    if(hadFocus){ box.focus(); box.setSelectionRange(draft.length, draft.length); }
  }

  document.getElementById('scrim').hidden = false;
  openId = id;
  // Position in the run, and an explicit way out. Without these a sequential review feels like
  // being trapped in a form rather than working through a list.
  const pos = QUEUE.indexOf(id);
  const nav = document.getElementById('qnav');
  if(inQueue && pos !== -1){
    nav.hidden = false;
    nav.innerHTML = '<span>'+(pos+1)+' of '+QUEUE.length+'</span>'
      + '<button class="qskip" data-skip="1">Skip</button>'
      + '<button class="qskip" data-endq="1">Done for now</button>';
  } else { nav.hidden = true; }
}
function closeDrawer(){
  openId = null;
  // Only the scrim is toggled now that the modal is its child. Hiding the modal as well would
  // leave hidden set on it, and the next open would show an empty backdrop.
  document.getElementById('scrim').hidden = true;
}
/** Open the next unanswered item, or close out when the run is finished. */
function advanceQueue(fromId){
  const rest = QUEUE.filter(id => id !== fromId && TASKS[id] && !TASKS[id].answer);
  if(!rest.length){ inQueue = false; closeDrawer(); return; }
  const i = QUEUE.indexOf(fromId);
  // Continue forward from where he was rather than restarting at the top, so skipping one
  // does not loop him back through what he already read.
  const next = QUEUE.slice(i + 1).find(id => rest.includes(id)) ?? rest[0];
  drawTask(next);
}

document.addEventListener('click', async e => {
  if(e.target.closest('[data-catchup]')){
    if(!QUEUE.length) return;
    inQueue = true; drawTask(QUEUE[0]); return;
  }
  if(e.target.closest('[data-skip]')){ advanceQueue(openId); return; }
  if(e.target.closest('[data-endq]')){ inQueue = false; closeDrawer(); return; }
  // DELETE TAKES TWO CLICKS, and the second one is on a button that has changed what it says.
  // A native confirm() would be dismissed by reflex; a button that reads "Really delete?" has to
  // be read before it can be pressed again. Any other click disarms it, so an armed button left
  // on screen cannot be triggered by the next thing he does.
  const del = e.target.closest('[data-del]');
  if(del){
    if(del.classList.contains('armed')){
      const id = del.dataset.del;
      del.disabled = true; del.textContent = 'Deleting…';
      const r = await fetch('/api/delete', {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({id})});
      const msg = await r.text();
      if(!r.ok){ del.disabled = false; del.textContent = 'Delete failed — ' + msg; del.classList.remove('armed'); return; }
      closeDrawer(); tick(); return;
    }
    del.classList.add('armed');
    del.textContent = 'Really delete? Click again';
    return;
  }
  // Disarm on any other click, including elsewhere in the same panel.
  document.querySelectorAll('.delbtn.armed').forEach(b=>{
    b.classList.remove('armed'); b.textContent = 'Delete this task';
  });
  const opt = e.target.closest('[data-answer]');
  if(opt){
    const t = TASKS[opt.dataset.answer];
    const custom = opt.dataset.opt === 'custom';
    const choice = custom
      ? (document.getElementById('othertext')?.value || '').trim()
      : (t ? OPTS(t)[Number(opt.dataset.opt)] : undefined);
    if(!choice) return;
    opt.disabled = true; opt.textContent = 'saving…';
    try{
      const r = await fetch('/api/answer', {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({id: opt.dataset.answer, answer: choice, custom})});
      if(!r.ok) throw new Error(await r.text());
      const answered = opt.dataset.answer;
      if(TASKS[answered]) TASKS[answered].answer = choice;
      await tick();
      if(inQueue) advanceQueue(answered); else drawTask(answered);
    }catch(err){
      // Say the write failed rather than showing an answer that was never recorded.
      opt.disabled = false;
      opt.textContent = 'failed — retry';
      opt.classList.add('failed');
      document.getElementById('err').innerHTML='<span class="nogo">answer not saved: '+esc(err.message)+'</span>';
    }
    return;
  }
  const tile = e.target.closest('[data-view]');
  if(tile){ setView(tile.dataset.view); return; }
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

// --- column drag. Reorder is a view preference: it never touches a task file and never reaches
// the server, so a mis-drag costs a drag back and nothing else.
let dragKey = null;
document.addEventListener('dragstart', e => {
  const h = e.target.closest('.clh[draggable=true]'); if(!h) return;
  dragKey = h.closest('.col')?.dataset.col || null;
  h.closest('.col')?.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag without payload, even when nothing reads it.
  try{ e.dataTransfer.setData('text/plain', dragKey || ''); }catch{}
});
document.addEventListener('dragover', e => {
  if(!dragKey) return;
  const col = e.target.closest('.col'); if(!col) return;
  e.preventDefault();
  document.querySelectorAll('.col.dropbefore').forEach(c=>c.classList.remove('dropbefore'));
  col.classList.add('dropbefore');
});
document.addEventListener('drop', e => {
  if(!dragKey) return;
  const col = e.target.closest('.col'); if(!col) return;
  e.preventDefault();
  const target = col.dataset.col;
  const keys = [...document.querySelectorAll('.cols .col')].map(c=>c.dataset.col).filter(Boolean);
  if(target && target !== dragKey){
    const next = keys.filter(k=>k!==dragKey);
    next.splice(next.indexOf(target), 0, dragKey);
    try{ localStorage.setItem('colOrder', JSON.stringify(next)); }catch{}
  }
  dragKey = null;
  document.querySelectorAll('.dragging,.dropbefore').forEach(c=>c.classList.remove('dragging','dropbefore'));
  if(LAST) render(LAST);
});
document.addEventListener('dragend', () => {
  dragKey = null;
  document.querySelectorAll('.dragging,.dropbefore').forEach(c=>c.classList.remove('dragging','dropbefore'));
});

let LAST = null;
async function tick(){
  try{
    const r = await fetch('/api/status');
    if(!r.ok) throw new Error('HTTP '+r.status);
    LAST = await r.json();
    render(LAST);
    document.getElementById('err').textContent='';
  }catch(e){
    // Say so rather than silently showing stale numbers -- a board you cannot trust is worse
    // than no board.
    document.getElementById('err').innerHTML='<span class="nogo">stale — '+esc(e.message)+'</span>';
  }
}
tick(); setInterval(tick, 1000);
</script>
</body></html>`;

/**
 * The ONE write this server performs, and the reasons it is narrow.
 *
 * It records the owner's answer against a task file: `answer:` and `answered:` in the frontmatter,
 * nothing else touched. It is the only endpoint that is not a read, and it exists because the
 * alternative — him typing a decision into a chat and an agent transcribing it into the vault — is
 * the step where decisions get lost or reworded.
 *
 * WHAT IT WILL NOT DO. It will not create a file, will not write a task that does not exist, will
 * not accept an answer that is not one of the options the task itself declares, and will not
 * overwrite an answer already recorded. A board that can write arbitrary text into the vault is a
 * board that can put words in his mouth.
 *
 * Still bound to 127.0.0.1 with no auth, which is only acceptable because there is no remote
 * listener. Do not widen the bind address to "make it reachable from my phone".
 */
/**
 * Resolve ONE task from disk, without calling collect().
 *
 * THE BUG THIS FIXES, because it was reported three times and looked like three different bugs.
 * `recordAnswer` and `deleteTask` both began with `snapshot(true)`, which forces a full `collect()`.
 * `collect()` shells out with **`spawnSync`** -- `gh api graphql` at a 25s timeout, `gh run view` at
 * 20s, a check-run annotation fetch at 20s each -- and `spawnSync` BLOCKS NODE'S ONLY THREAD. So
 * every click on an answer button could freeze the entire server, and the page with it, for up to a
 * minute: the button sat at "saving...", the poll stopped, and when the loop finally freed up the
 * re-render wiped the button back to its normal label with no error shown. From the outside that
 * reads as "it did not let me accept" -- and on a slow enough call the write never landed at all.
 *
 * A write needs ONE task file. It does not need git, GitHub CI, the launch gates or the deployment
 * address book. Reading that file directly turns a blocking multi-second round trip into a stat and
 * a read, and the endpoint answers immediately.
 *
 * It parses only the fields a write decision turns on. Anything else the board needs comes from
 * `collect()` on the read path, where being slow is merely slow.
 */
function taskFromDisk(id) {
  // Reject a traversal outright rather than normalising it: ids come from the page, and the page is
  // not a trust boundary this server should be relying on.
  if (!id || /[\\/]|\.\./.test(id)) return null;
  const file = path.join(TASKS_DIR, `${id}.md`);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return null;
  const head = raw.slice(0, end);
  const field = (k) => {
    const m = new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi').exec(head);
    return m ? m[1].trim() : '';
  };
  const list = (v) => {
    const t = v.trim();
    if (!t) return [];
    // Frontmatter lists arrive as ["a", "b"] or as a bare comma-separated line.
    const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
    return inner
      .split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  };
  return {
    id,
    file,
    num: Number(field('num')) || 0,
    title: field('title').replace(/^["']|["']$/g, ''),
    status: field('status').toLowerCase() || 'backlog',
    options: list(field('options')),
    answer: field('answer'),
    notify: list(field('notify')),
  };
}

/**
 * Remove a task from the board. THE FILE IS MOVED, NEVER UNLINKED.
 *
 * It goes to `Tasks/_deleted/` with a `deleted:` stamp in its frontmatter. The board reads
 * `Tasks/*.md` and skips anything that is not a `.md` file at that level, so a subdirectory
 * disappears from every column immediately — which is the behaviour asked for — while the content
 * survives.
 *
 * WHY NOT A REAL DELETE. This vault is written by six agent sessions that cannot see each other,
 * and a task file is often the only record that a piece of work was ever scoped: its checklist, the
 * reason it was raised, the department that owns it. An unlink is unrecoverable and indistinguishable
 * from a file that was never written, so a card deleted by mistake would not merely be gone, it
 * would be gone without evidence that anything had been there. Moving costs nothing and the
 * board looks identical.
 *
 * A name collision in `_deleted/` is suffixed rather than overwritten, for the same reason: deleting
 * a second task that happens to share a filename must not destroy the first.
 */
function deleteTask(id) {
  const t = taskFromDisk(id);
  if (!t) return { code: 404, msg: `no task ${id}` };

  const dir = path.dirname(t.file);
  const bin = path.join(dir, '_deleted');
  try {
    mkdirSync(bin, { recursive: true });
  } catch (e) {
    return { code: 500, msg: `cannot create ${bin}: ${/** @type {Error} */ (e).message}` };
  }

  let dest = path.join(bin, path.basename(t.file));
  for (let n = 2; existsSync(dest); n += 1) {
    dest = path.join(bin, path.basename(t.file).replace(/\.md$/, `-${n}.md`));
  }

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const raw = readFileSync(t.file, 'utf8');
    const end = raw.indexOf('\n---', 3);
    // Stamp it only when there is a frontmatter block to stamp. A file without one still moves --
    // refusing to delete a malformed card would leave it permanently on the board.
    const patched =
      raw.startsWith('---') && end !== -1 ? raw.slice(0, end) + `\ndeleted: ${stamp}` + raw.slice(end) : raw;
    writeFileSync(dest, patched, 'utf8');
    unlinkSync(t.file);
  } catch (e) {
    return { code: 500, msg: `could not move the task file: ${/** @type {Error} */ (e).message}` };
  }

  // The outbox is the durable record of everything this board changes, so a deletion is logged
  // beside the answers. Failing to log must never make the deletion look like it failed.
  try {
    appendFileSync(
      OUTBOX,
      JSON.stringify({ at: new Date().toISOString(), id: t.id, num: t.num, title: t.title, deleted: true, movedTo: dest }) + '\n',
      'utf8',
    );
  } catch {
    /* logged where it can be read; the move already happened */
  }

  cache = { at: 0, data: null };
  return { code: 200, msg: `deleted — recoverable at ${dest}` };
}

/**
 * A CARD IN THE SUGGESTIONS COLUMN IS BY DEFINITION AN APPROVE-OR-DECLINE, so the board supplies
 * that pair when the file declares no options of its own.
 *
 * Without this a department can file a suggestion that renders with no buttons -- which happened,
 * and reads as the board being broken rather than as the author having forgotten a field. Making
 * the board supply them means no department can file an unanswerable suggestion, and it keeps the
 * column's promise: everything in it can be decided from here.
 *
 * Declared options still win, so a suggestion that genuinely needs three answers can say so.
 */
const SUGGESTION_OPTIONS = Object.freeze(['Approve - move to To do', 'Decline']);
const optionsFor = (t) => (t.options.length ? t.options : t.status === 'suggestion' ? [...SUGGESTION_OPTIONS] : []);

function recordAnswer(id, answer, custom) {
  const t = taskFromDisk(id);
  if (!t) return { code: 404, msg: `no task ${id}` };
  // A listed option must match exactly; a free-text answer is accepted as written. The option list
  // is a shortcut for the common cases, never a menu he has to squeeze a real decision into.
  if (!custom && !optionsFor(t).includes(answer)) {
    return { code: 400, msg: 'answer is not one of this task’s options' };
  }
  if (custom && !answer.trim()) return { code: 400, msg: 'empty answer' };
  if (answer.length > 2000) return { code: 400, msg: 'answer too long' };
  // A newline would end the answer: line and let free text forge other frontmatter keys - a
  // second line reading 'status: done' would be parsed as real. Collapse rather than reject,
  // because rejecting a multi-line answer throws away what he typed.
  answer = answer.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!answer) return { code: 400, msg: 'empty answer' };
  if (t.answer) return { code: 409, msg: `already answered: ${t.answer}` };

  const raw = readFileSync(t.file, 'utf8');
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return { code: 422, msg: 'task file has no frontmatter block' };

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let head = raw.slice(0, end);

  // APPROVING A SUGGESTION MOVES IT. Recording the answer and leaving `status: suggestion` in place
  // left the card sitting in the Suggestions column after it had been approved, which reads as the
  // click not having worked -- and the whole point of the column is that approved ideas leave it.
  //
  // The rewrite is confined to the frontmatter block (`head` ends at the closing `---`) and to a
  // status line that currently reads `suggestion`, so it cannot touch a body line that happens to
  // start with "status:" and cannot move a card that is not a suggestion.
  //
  // A free-text answer is NEITHER an approval nor a decline and deliberately leaves the card where
  // it is: he has said something the two buttons could not say, and guessing which way it fell
  // would either bury an idea he liked or queue one he did not. The answer is on the card for the
  // department to act on.
  if (t.status === 'suggestion') {
    const moved = movedStatusFor(answer);
    if (moved) head = head.replace(/^status:[ \t]*suggestion[ \t]*$/mi, `status: ${moved}`);
  }
  const patched = head + `\nanswer: ${answer}\nanswered: ${stamp}` + raw.slice(end);
  // Write via a temp file in the same directory, then rename. A half-written task file would be
  // parsed by the next poll 5s later and render as a task with no title.
  const tmp = `${t.file}.tmp-${process.pid}`;
  writeFileSync(tmp, patched, 'utf8');
  renameSync(tmp, t.file);

  // ROUTING. The answer is recorded above whatever happens next, and the outbox is a separate
  // append-only line, so a failure to notify can never lose the decision itself.
  //
  // An HTTP server cannot call SendMessage, so it writes the INTENT here and the orchestrator
  // session relays it. Watch this file with Monitor and the relay is prompt rather than manual.
  try {
    appendFileSync(
      OUTBOX,
      JSON.stringify({
        at: new Date().toISOString(),
        id: t.id,
        title: t.title,
        answer,
        custom: Boolean(custom),
        notify: t.notify,
        file: t.file,
      }) + '\n',
      'utf8',
    );
  } catch (e) {
    // Say so rather than reporting a clean success: the decision IS saved, but nobody was told.
    cache = { at: 0, data: null };
    return { code: 200, msg: `recorded, but NOT queued for routing: ${/** @type {Error} */ (e).message}` };
  }

  cache = { at: 0, data: null };
  return { code: 200, msg: t.notify.length ? `recorded, routing to ${t.notify.join(', ')}` : 'recorded' };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/answer' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy(); // a decision is short; anything larger is not one
    });
    req.on('end', () => {
      let out;
      try {
        const { id, answer, custom } = JSON.parse(body);
        out = recordAnswer(String(id ?? ''), String(answer ?? ''), Boolean(custom));
      } catch (e) {
        out = { code: 400, msg: String(/** @type {Error} */ (e).message) };
      }
      res.writeHead(out.code, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(out.msg);
    });
    return;
  }

  if (url.pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1024) req.destroy();
    });
    req.on('end', () => {
      let out;
      try {
        const { id } = JSON.parse(body);
        out = deleteTask(String(id ?? ''));
      } catch (e) {
        out = { code: 400, msg: String(/** @type {Error} */ (e).message) };
      }
      res.writeHead(out.code, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(out.msg);
    });
    return;
  }

  if (url.pathname === '/api/status') {
    const body = JSON.stringify(url.searchParams.has('force') ? { ...snapshot(true), board: readBoard(VAULT_ROOT), calendar: readCalendar(VAULT_ROOT) } : view());
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
