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
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { collect } from './lib/project-status.mjs';
import { runLaunchChecks } from './lib/launch-checks.mjs';

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
const TTL_MS = 800;

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
  /* --- launch checks. On-demand, never polled: every row starts idle and only changes when the
     owner clicks Check. A row that silently went green on its own would be indistinguishable from
     one he actually verified. */
  #launchchecks{margin:0 0 16px}
  .lchead{display:flex;align-items:baseline;gap:10px;margin-bottom:2px}
  .lchead h2{margin:0}
  #lc-check{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:6px 14px;
             font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
  #lc-check:hover{filter:brightness(1.08)}
  #lc-check:disabled{opacity:.6;cursor:default}
  #lc-stamp{color:var(--dim);font-size:11.5px;font-family:var(--mono)}
  .lcrow{padding:9px 0;border-bottom:1px solid var(--line)}
  .lcrow:last-child{border-bottom:0}
  .lcrow-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .lcname{font-weight:600;font-size:13px}
  .lcdetail{color:var(--dim);font-size:12.5px;margin-top:4px;overflow-wrap:anywhere}
  .lcremedy{margin-top:7px;display:flex;gap:8px;align-items:flex-start}
  .lcremedy code{font-family:var(--mono);font-size:11.5px;background:var(--bg);color:var(--ink);
                 border:1px solid var(--line);border-radius:6px;padding:7px 9px;flex:1;min-width:0;
                 overflow-wrap:anywhere;user-select:all}
  .lccopy{background:var(--panel);color:var(--dim);border:1px solid var(--line);border-radius:6px;
          padding:6px 10px;font:inherit;font-size:11.5px;cursor:pointer;flex:none}
  .lccopy:hover{color:var(--ink);border-color:var(--dim)}
  .lc-pill{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
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
<section id="launchchecks" class="wide">
  <div class="lchead">
    <h2>Launch checks</h2>
    <button id="lc-check" type="button">Check</button>
    <span id="lc-stamp"></span>
  </div>
  <div id="lc-rows">
    <!-- Filled by JS. Rows start idle — nothing here has been read yet — and this panel is never
         driven by the 1s /api/status poll: it only runs when clicked, so a public RPC and two live
         websites are not hit once a second for a page that may sit open all day. -->
  </div>
  <div class="note">Every row is a read — <code>eth_call</code>, <code>eth_getCode</code>,
    <code>eth_chainId</code>, or a file/HTTP fetch. Nothing here signs or broadcasts. Where the fix
    is a transaction, the exact command is shown below the row for you to copy and run yourself.</div>
</section>
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
    const COLS=[['backlog','To do'],['doing','In progress'],['review','In review'],['blocked','Needs you']];

    // BLOCKED MEANS ONE THING: waiting on an answer from him. Nothing else belongs there.
    //
    // A task marked blocked because it is CONTINGENT on another task's answer is not blocked on
    // him - he cannot do anything about it until the upstream answer lands, and putting it in
    // front of him makes the column a list of things he cannot action. Those render as To do.
    const needsOwner = t => t.options.length > 0 && !t.answer;
    const eff = t => (t.status === 'blocked' && !needsOwner(t)) ? 'backlog' : t.status;
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
    const ORDER={doing:0,review:1,blocked:2,backlog:3,done:4};
    // Critical, high, medium, low, then unset. Applied WITHIN a column, so the top card in any
    // column is the most urgent thing in that state rather than the most recently saved file.
    const PRIO={critical:0,crit:0,high:1,med:2,medium:2,low:3};
    const byPrio=(a,b)=>((PRIO[a.priority]??9)-(PRIO[b.priority]??9))||(b.mtime-a.mtime);
    const MARK={done:'✓',doing:'◐',review:'◐',blocked:'✕',backlog:'○'};
    const chip = t => { const d=t.checklist.filter(c=>c.done).length;
      return t.checklist.length? '<span class="ck">☑ '+d+'/'+t.checklist.length+'</span>' : ''; };
    const dueChip = t => { if(!t.due) return '';
      const late = Date.parse(t.due) < Date.now();
      return '<span class="due'+(late?' late':'')+'">◷ '+esc(t.due)+'</span>'; };
    const chips = t => t.labels.length? '<div class="clabels">'+labels(t)+'</div>' : '';

    const line = t => '<div class="li s-'+esc(eff(t))+'" data-id="'+esc(t.id)+'" role="button" tabindex="0">'
      + '<span class="mk">'+MARK[eff(t)]+'</span>'
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
        h+='<div class="col c-'+key+'"><div class="clh">'+label+' <span class="n">'+inCol.length+'</span></div>'
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
      const done=tasks.filter(t=>t.status==='done').length;
      const pct=tasks.length? Math.round(done/tasks.length*100):0;
      return '<summary class="dh"><span class="caret">'+(open?'▾':'▸')+'</span>'+esc(name)
        +' <span class="cnt">'+done+' of '+tasks.length+'</span>'
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
    body+='<div class="tiles">'
      + ['All',...DEPTS].map(t=>{
          const open=t==='All'? d.board.tasks.filter(x=>x.status!=='done').length
                              : d.board.tasks.filter(x=>x.department===t&&x.status!=='done').length;
          return '<button class="tile'+(VIEW===t?' on':'')+'" data-view="'+esc(t)+'">'
            +esc(t)+' <span class="n">'+open+'</span></button>';
        }).join('')
      +'</div>'
      // SAID ONCE, HERE, AND NOWHERE ELSE. The board cannot drag, so the way to move a card is to
      // edit its file. Repeating that on every card would be noise; omitting it entirely leaves a
      // reader who has just failed to drag something with nothing to do next.
      +'<div class="note" style="margin:-6px 0 10px">Read-only apart from the answer buttons. '
      +'To move a card, edit its task file — the board follows within 5s.</div>';

    if(VIEW==='All'){
      // Merged: five columns, every department's cards together, each tagged with its department.
      body+='<div class="dept">'+columnsFor(d.board.tasks, true)+checklistFor(d.board.tasks)+'</div>';
    } else {
      const mine=d.board.tasks.filter(t=>t.department===VIEW);
      body+='<details class="dept" open>'+header(VIEW,mine,true)
        +columnsFor(mine,false)+checklistFor(mine)+'</details>';
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
const STATE_LABEL = {doing:'In progress',review:'In review',blocked:'Blocked',backlog:'Backlog',done:'Done'};
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
    '<div class="dcrumb">'+esc(t.department)+' → '+esc(t.col||STATE_LABEL[t.status]||t.status)+'</div>'
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
    + (t.options.length && !t.answer
        ? dsec('✎','Your answer',
            t.options.map((o,i)=>'<button class="opt'+(o===t.recommended?' rec':'')
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
        + '<div class="note">This board is read-only apart from the answer buttons. To move a '
        + 'card, edit its file — in Obsidian or by an agent — and the change appears within 5s.</div>');

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
  const opt = e.target.closest('[data-answer]');
  if(opt){
    const t = TASKS[opt.dataset.answer];
    const custom = opt.dataset.opt === 'custom';
    const choice = custom
      ? (document.getElementById('othertext')?.value || '').trim()
      : t?.options[Number(opt.dataset.opt)];
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

// ---- launch checks -----------------------------------------------------------------------
// Deliberately NOT part of tick()/render() and NOT on the 1s poll. This is the one panel on the
// page that reaches a public RPC and two live websites, so it runs only when clicked — a page
// left open all day must not hammer either.
const LC_ROWS = [
  { id:'safe', name:'Creator Safe live on Arc mainnet' },
  { id:'proposal', name:'Stale governance proposal blocking the soak' },
  { id:'balance', name:'Deployer balance margin' },
  { id:'arc-deploy', name:'Arc deployment' },
  { id:'member-surface', name:'What app.rwally.com and rwally.com are serving' },
];
const LC_STATE_CLASS = { green:'go', amber:'warn', red:'nogo', unknown:'idle' };
const LC_STATE_LABEL = { green:'PASS', amber:'CHECK', red:'FAIL', unknown:'UNKNOWN' };

function renderLaunchChecks(byId){
  document.getElementById('lc-rows').innerHTML = LC_ROWS.map(meta => {
    const r = byId && byId[meta.id];
    const state = r ? r.state : null;
    const pillClass = state ? LC_STATE_CLASS[state] : 'idle';
    const pillLabel = state ? LC_STATE_LABEL[state] : 'NOT CHECKED YET';
    const detail = r ? esc(r.detail) : 'Click Check to run this read.';
    const remedy = r && r.remedy
      ? '<div class="lcremedy"><code id="lc-cmd-'+meta.id+'">'+esc(r.remedy)+'</code>'
        + '<button class="lccopy" type="button" data-copy="lc-cmd-'+meta.id+'">Copy</button></div>'
      : '';
    return '<div class="lcrow">'
      + '<div class="lcrow-top"><span class="pill lc-pill '+pillClass+'">'+pillLabel+'</span>'
      + '<span class="lcname">'+esc(meta.name)+'</span></div>'
      + '<div class="lcdetail">'+detail+'</div>'
      + remedy
      + '</div>';
  }).join('');
}
renderLaunchChecks(null);

document.getElementById('lc-check').addEventListener('click', async () => {
  const btn = document.getElementById('lc-check');
  btn.disabled = true; btn.textContent = 'checking…';
  try{
    const r = await fetch('/api/launch-checks');
    if(!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    const byId = Object.fromEntries((data.rows||[]).map(row => [row.id, row]));
    renderLaunchChecks(byId);
    document.getElementById('lc-stamp').textContent =
      'checked '+new Date(data.at).toISOString().slice(0,19).replace('T',' ')+'Z';
  }catch(e){
    document.getElementById('lc-stamp').innerHTML = '<span class="nogo">check failed — '+esc(e.message)+'</span>';
  }finally{
    btn.disabled = false; btn.textContent = 'Check';
  }
});

document.getElementById('lc-rows').addEventListener('click', async e => {
  const btn = e.target.closest('[data-copy]');
  if(!btn) return;
  const text = document.getElementById(btn.dataset.copy)?.textContent || '';
  try{
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent; btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }catch{
    // Clipboard API can refuse (permissions, non-secure context edge cases). The command text is
    // already selectable in the box above the button, so this is a convenience failing, not a
    // dead end.
    btn.textContent = 'select & copy';
  }
});
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
function recordAnswer(id, answer, custom) {
  const tasks = snapshot(true).board?.tasks ?? [];
  const t = tasks.find((x) => x.id === id);
  if (!t) return { code: 404, msg: `no task ${id}` };
  // A listed option must match exactly; a free-text answer is accepted as written. The option list
  // is a shortcut for the common cases, never a menu he has to squeeze a real decision into.
  if (!custom && !t.options.includes(answer)) {
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
  const patched =
    raw.slice(0, end) + `\nanswer: ${answer}\nanswered: ${stamp}` + raw.slice(end);
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

  // Read-only, on demand, never cached: the owner clicked Check and wants THIS read, not a
  // snapshot from up to TTL_MS ago. See scripts/lib/launch-checks.mjs's header for why every row
  // here is an eth_call/eth_getCode/eth_chainId/file/HTTP read and never a signed transaction.
  if (url.pathname === '/api/launch-checks') {
    runLaunchChecks()
      .then((rows) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ at: new Date().toISOString(), rows }));
      })
      .catch((e) => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`launch-checks failed: ${/** @type {Error} */ (e).message}`);
      });
    return;
  }

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
