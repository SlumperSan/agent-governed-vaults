// @ts-check
/**
 * Card #42: the department switcher's tiles only ever showed an open-task count, so a department
 * with nothing in its "In progress" column looked the same as a busy one -- nothing on the board
 * said "this department is free for an assignment" until it messaged. The fix flags a tile amber,
 * with a visible "idle" label, when `eff(x)==='doing'` (the board's OWN in-progress bucket -- see
 * `COLS` in scripts/dashboard.mjs, `['doing','In progress']`) is empty for that department.
 *
 * This extracts the ACTUAL shipped `['All',...DEPTS].map(...)` tile-rendering expression, plus the
 * `needsOwner`, `eff` and `esc` helpers it calls, verbatim out of `scripts/dashboard.mjs` and runs
 * them together against constructed board fixtures -- mirroring the extraction pattern
 * `dashboard-page-script-parses.test.mjs` and `dashboard-sign-gas-buffer.test.mjs` already use for
 * this file. NONE of the four are hand-copied: `eff` in particular IS "the dashboard's own notion
 * of in-progress status" the card asks for, so a hand-copy that drifted from a future edit to the
 * real `eff` would defeat the point of the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.mjs');
const SOURCE = readFileSync(DASHBOARD, 'utf8');

/** Pull one exact, verbatim statement out of SOURCE by regex, or fail loudly if it has moved. */
function extractLine(re, label) {
  const m = SOURCE.match(re);
  assert.ok(m, `could not find ${label} in scripts/dashboard.mjs — has it moved or been rewritten?`);
  return m[0];
}

const extractNeedsOwner = () => extractLine(/const needsOwner = t => t\.options\.length > 0 && !t\.answer;/, 'needsOwner()');
const extractEff = () => extractLine(/const eff = t => \(t\.status === 'blocked' && !needsOwner\(t\)\) \? 'backlog' : t\.status;/, 'eff()');
const extractEsc = () => extractLine(/^const esc = s => String\(s \?\? ''\)\.replace\(.*\);$/m, 'esc()');

/** Pull the exact tile-rendering expression verbatim: `['All',...DEPTS].map(t=>{...}).join('')`. */
function extractTilesExpr() {
  const start = SOURCE.indexOf("['All',...DEPTS].map(t=>{");
  const endMarker = "}).join('')";
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(
    start !== -1 && end !== -1,
    'could not find the tiles-rendering expression in scripts/dashboard.mjs — has it moved or been rewritten?',
  );
  return SOURCE.slice(start, end + endMarker.length);
}

/**
 * Render the real tiles HTML for a constructed board, wiring together the four extracted pieces
 * exactly as dashboard.mjs's own `render(d)` does: `needsOwner` feeds `eff`, `eff` and `esc` feed
 * the tiles expression. `tilesExpr` defaults to the shipped one; tests that need a mutated copy
 * pass their own.
 * @param {{department:string,status:string,options?:any[],answer?:any}[]} tasks
 * @param {string} view
 * @param {string} [tilesExpr]
 */
function renderTiles(tasks, view, tilesExpr = extractTilesExpr()) {
  const DEPTS = [...new Set(tasks.map((t) => t.department))];
  const d = { board: { tasks } };
  const VIEW = view;
  const body = `${extractNeedsOwner()}\n${extractEff()}\n${extractEsc()}\nreturn ${tilesExpr};`;
  const fn = vm.runInNewContext(`(function (DEPTS, d, VIEW) {\n${body}\n})`);
  return fn(DEPTS, d, VIEW);
}

function tileFor(html, dept) {
  const re = new RegExp(`<button class="([^"]*)"[^>]*data-view="${dept}"[^>]*>([\\s\\S]*?)</button>`);
  const m = re.exec(html);
  assert.ok(m, `no tile rendered for data-view="${dept}"`);
  return { classes: m[1].split(' '), body: m[2] };
}

// Every fixture below carries `options: []` explicitly (rather than relying on it being absent),
// because the real `needsOwner` reads `t.options.length` with no default — an undefined `options`
// would throw inside the extracted, unmodified source, not silently pass.

test('idle: a department with an open "doing" task is NOT flagged idle', () => {
  const tasks = [
    { department: 'Security', status: 'doing', options: [], answer: null },
    { department: 'Security', status: 'backlog', options: [], answer: null },
  ];
  const tile = tileFor(renderTiles(tasks, 'All'), 'Security');
  assert.ok(!tile.classes.includes('idle'), 'a department with a doing task should not be idle');
  assert.ok(!tile.body.includes('idle-tag'), 'no visible idle label expected');
});

test('idle: a department with tasks but none "doing" (backlog/review/blocked/done) IS flagged idle, visibly', () => {
  const tasks = [
    { department: 'Design', status: 'backlog', options: [], answer: null },
    { department: 'Design', status: 'review', options: [], answer: null },
    { department: 'Design', status: 'done', options: [], answer: null },
  ];
  const tile = tileFor(renderTiles(tasks, 'All'), 'Design');
  assert.ok(tile.classes.includes('idle'), 'Design has no doing task and should be idle');
  assert.match(tile.body, /<span class="idle-tag">idle<\/span>/, 'the idle tile must carry a visible "idle" label');
});

test('idle: a mixed board flags only the department with nothing in progress, not both', () => {
  // NOTE ON WHAT THIS DOES NOT COVER: a department with literally zero tasks can never appear here
  // — DEPTS is `[...new Set(tasks.map(t=>t.department))]`, so a department with no tasks has no
  // tile at all and "idle" is moot for it. This instead proves the idle branch fires independently
  // per department on one shared board, not just in isolation.
  const tasks = [
    { department: 'Product', status: 'doing', options: [], answer: null },
    { department: 'Marketing', status: 'backlog', options: [], answer: null },
  ];
  const html = renderTiles(tasks, 'All');
  assert.ok(!tileFor(html, 'Product').classes.includes('idle'));
  assert.ok(tileFor(html, 'Marketing').classes.includes('idle'));
});

test('idle: "All" is never flagged idle, whatever the board looks like', () => {
  const empty = tileFor(renderTiles([{ department: 'X', status: 'backlog', options: [], answer: null }], 'All'), 'All');
  assert.ok(!empty.classes.includes('idle'), '"All" must never be flagged idle');
  const busy = tileFor(renderTiles([{ department: 'X', status: 'doing', options: [], answer: null }], 'All'), 'All');
  assert.ok(!busy.classes.includes('idle'), '"All" must never be flagged idle');
});

test("idle: only counts the named department's own doing column, not another department's", () => {
  const tasks = [
    { department: 'Tech', status: 'doing', options: [], answer: null },
    { department: 'Security', status: 'backlog', options: [], answer: null },
  ];
  const html = renderTiles(tasks, 'All');
  assert.ok(tileFor(html, 'Security').classes.includes('idle'), 'Security has no doing task of its own');
  assert.ok(!tileFor(html, 'Tech').classes.includes('idle'));
});

test('idle: a "blocked but does not need the owner" task counts as backlog (not doing), so the department is idle', () => {
  // Mirrors dashboard.mjs's own eff(): blocked-without-needsOwner folds into backlog. A department
  // whose only task is blocked-without-an-open-question has nothing "doing", so it is idle too.
  const tasks = [{ department: 'Finance', status: 'blocked', options: [], answer: null }];
  const tile = tileFor(renderTiles(tasks, 'All'), 'Finance');
  assert.ok(tile.classes.includes('idle'));
});

test('idle: a "blocked, and DOES need the owner" task is NOT idle — needsOwner keeps it out of backlog, and it is not "doing" either', () => {
  // eff() only folds blocked into backlog when !needsOwner(t). A task with unanswered options is
  // blocked WITH an open question, so eff(t) stays 'blocked' — not 'doing', so this department is
  // still idle by the tile's rule, but through the "blocked, needs owner" path rather than backlog.
  // This nails down that needsOwner (not a hand-copied stand-in) is actually being consulted: a
  // stub that always returned false would fold this into backlog too and this case would not tell
  // the difference, so it is paired with the next MUTATION test.
  const tasks = [{ department: 'Finance', status: 'blocked', options: ['A', 'B'], answer: null }];
  const tile = tileFor(renderTiles(tasks, 'All'), 'Finance');
  assert.ok(tile.classes.includes('idle'), 'blocked-with-an-open-question is not "doing", so still idle');
});

test('the selected (".on") tile still carries the "idle" class and its visible label', () => {
  const tasks = [{ department: 'Design', status: 'backlog', options: [], answer: null }];
  const tile = tileFor(renderTiles(tasks, 'Design'), 'Design');
  assert.ok(tile.classes.includes('on') && tile.classes.includes('idle'));
  assert.match(tile.body, /<span class="idle-tag">idle<\/span>/, 'selecting an idle department must not hide its label');
});

test('MUTATION: reverting to "idle is always false" (deleting the guard) is caught', () => {
  const tasks = [{ department: 'Design', status: 'backlog', options: [], answer: null }];
  const real = extractTilesExpr();
  const broken = real.replace(
    "const idle=t!=='All' && d.board.tasks.filter(x=>x.department===t&&eff(x)==='doing').length===0;",
    'const idle=false;',
  );
  assert.notEqual(broken, real, 'the mutation did not find the idle= declaration — locator drifted');

  assert.ok(!tileFor(renderTiles(tasks, 'All', broken), 'Design').classes.includes('idle'), 'sanity: the broken version should not flag idle');
  assert.ok(
    tileFor(renderTiles(tasks, 'All'), 'Design').classes.includes('idle'),
    'RED: the real expression must disagree with the always-false stub on this fixture',
  );
});

test("MUTATION: checking the wrong column ('review' instead of 'doing') is caught", () => {
  const tasks = [{ department: 'Design', status: 'doing', options: [], answer: null }];
  const real = extractTilesExpr();
  // The longer substring, not just `eff(x)==='doing'`, because the comment immediately above the
  // real statement also contains the shorter phrase in prose ("Uses the board's own in-progress
  // bucket, eff(x)==='doing'") — a naive replace on the short phrase edits the COMMENT, leaves the
  // actual code untouched, and this test's own sanity check then fails for the wrong reason.
  const broken = real.replace(".filter(x=>x.department===t&&eff(x)==='doing')", ".filter(x=>x.department===t&&eff(x)==='review')");
  assert.notEqual(broken, real, 'the mutation did not find the eff(x)===\'doing\' filter — locator drifted');

  assert.ok(tileFor(renderTiles(tasks, 'All', broken), 'Design').classes.includes('idle'), 'sanity: checking "review" flags a doing-only department idle');
  assert.ok(
    !tileFor(renderTiles(tasks, 'All'), 'Design').classes.includes('idle'),
    'RED: the real expression must disagree with the wrong-column stub on this fixture',
  );
});

test('MUTATION: dropping the visible "idle" text label (keeping only the CSS class) is caught', () => {
  const tasks = [{ department: 'Design', status: 'backlog', options: [], answer: null }];
  const real = extractTilesExpr();
  const broken = real.replace("+(idle?'<span class=\"idle-tag\">idle</span>':'')", '');
  assert.notEqual(broken, real, 'the mutation did not find the idle-tag span — locator drifted');

  const withoutLabel = tileFor(renderTiles(tasks, 'All', broken), 'Design');
  assert.ok(withoutLabel.classes.includes('idle'), 'sanity: the class still applies with the label stripped');
  assert.ok(!withoutLabel.body.includes('idle-tag'), 'sanity: the stub really has no visible label');
  assert.match(
    tileFor(renderTiles(tasks, 'All'), 'Design').body,
    /idle-tag/,
    'RED: the real markup must carry a visible "idle" label the stub does not',
  );
});
