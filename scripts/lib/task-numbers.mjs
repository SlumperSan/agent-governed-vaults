/**
 * Stable task numbers, so a human can say "task 14" and everyone means the same card.
 *
 * WHY A NUMBER IN THE FILE, rather than a position or a hash. A board position changes every time
 * a card moves, so "the third one in To do" is a different task ten minutes later. A hash of the
 * filename is stable but unsayable. The number is written into the file's own frontmatter ONCE and
 * never changes after that, including when the task is renamed, reprioritised, moved between
 * columns or finished. It is an identity, not an ordering.
 *
 * NUMBERS ARE NEVER REUSED, and that is enforced by a persisted high-water mark, not by scanning.
 * The next number is max(high-water, every num in Tasks/ and Tasks/_deleted/) + 1, and the
 * high-water mark lives in `Tasks/_task-counter.json` and only ever rises. A scan alone is not
 * enough: the board's delete MOVES a file to `_deleted/`, but a file removed by hand, or a vault
 * restored from backup, would hand the highest number out again, and a freed number makes an old
 * sentence ("task 12") false. The mark is written BEFORE the task files are patched, so a crash in
 * between wastes a number rather than reusing one.
 *
 * ALLOCATION IS SAFE ACROSS PROCESSES. Two dashboards (a worktree copy, a second port) can point at
 * the same vault, so the whole read-allocate-write section runs under an exclusive lock made of
 * generation files (`Tasks/_task-numbers.lock.<n>`, each created with the `wx` flag, which is
 * atomic; see withDirLock). A file records its owner (pid, host, a random token). The lock passes
 * to a new generation only when the holder's owner process is gone, or when it is older than
 * LIVE_OWNER_STALE_MS (ten minutes, for a recycled pid or an owner on another machine); a file with
 * no readable owner (a crash between create and write) is passed over after STALE_LOCK_MS. A mere
 * 30 s mtime is not enough on its own: it let a second process into the section while the first
 * still held it. Nothing ever deletes a lock file it did not create, so a takeover is a single
 * atomic `wx` and no stale judgement can destroy a live lock. Unnumbered files are re-read inside
 * the lock, immediately before each write, so a number is never given to a file another process
 * has already numbered.
 *
 * ASSIGNMENT IS DETERMINISTIC WITHIN A RUN. Unnumbered files are sorted by name before numbering,
 * so a first run over a fresh vault gives the same answer twice rather than depending on readdir
 * order. Across runs it does not matter, because every earlier file already carries its number.
 *
 * This writes to task files, which is otherwise something the board does not do. It is narrow by
 * construction: it only ever INSERTS a `num:` line into a frontmatter block that has none, never
 * edits one that exists, never touches the body, and never deletes a task file. Besides the task
 * files it creates and updates only the counter and the lock files named above.
 */

import {
  readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

const COUNTER_FILE = '_task-counter.json';
const LOCK_FILE = '_task-numbers.lock';
/** A lock whose owner cannot be read (empty file, older format) is broken after this long. */
const STALE_LOCK_MS = 30_000;
/** A lock whose owner is alive, or on another host, is broken only after this long. */
const LIVE_OWNER_STALE_MS = 600_000;
const LOCK_TIMEOUT_MS = 10_000;

/**
 * The frontmatter key the answer endpoint writes when the answer was TYPED rather than clicked.
 * Lives here because the reconcile must honour it: it sees only the file.
 */
export const ANSWER_CUSTOM_KEY = 'answer_custom';

/** Read the `num:` already in a frontmatter block, or 0 when there is none. Quoted values count. */
function existingNum(raw) {
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return 0;
  const m = /^num:[ \t]*["']?(\d+)["']?[ \t]*$/m.exec(raw.slice(0, end));
  return m ? Number(m[1]) : 0;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when a process with this pid exists. EPERM means it exists but is not ours. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The owner recorded in a lock file's text, or null when it is empty or not ours. */
function parseOwner(raw) {
  try {
    const o = JSON.parse(raw);
    if (Number.isInteger(o.pid) && o.pid > 0 && typeof o.token === 'string' && typeof o.host === 'string') return o;
  } catch {
    /* empty or half-written */
  }
  return null;
}

/** Whether a lock with this owner and age may be broken. See the header for the three cases. */
function lockBreakable(owner, ageMs) {
  if (!owner) return ageMs > STALE_LOCK_MS;
  if (owner.host !== hostname()) return ageMs > LIVE_OWNER_STALE_MS; // cannot probe another machine's pid
  if (!pidAlive(owner.pid)) return true;
  return ageMs > LIVE_OWNER_STALE_MS; // alive: a recycled pid is the only way it is stale
}

/**
 * THE LOCK IS AN APPEND-ONLY SERIES OF GENERATION FILES. Nothing is ever deleted, renamed or
 * overwritten, so there is no step at which a judgement about one file can be applied to another.
 *
 * WHY. Every earlier shape of this lock took over a dead holder's lock by READING it, JUDGING it
 * stale and then DELETING (or renaming) it. Those are separate syscalls, so between the judgement
 * and the removal another process can replace the file with a live one, and the removal then
 * destroys a live lock: two processes inside the section, and `allocate()` hands out one number
 * twice. Guarding the removal with a second lock file only moves the same read-then-act step one
 * level down (measured: duplicate numbers 1,1,2,2 at 8 processes with a dead lock and a dead breaker
 * left behind). A first attempt at a lock-free series that DELETED on release failed the same way
 * through name reuse: a freed generation name was taken again while a slow process was still judging
 * the previous file of that name.
 *
 * HOW. The lock is `_task-numbers.lock.<generation>`, and the state is the file with the HIGHEST
 * generation. A file is either an owner record (pid, host, token: the lock is held) or
 * `{"released":true}` (the lock is free). To take the lock, create generation top+1 with `wx`
 * (atomic, exactly one creator per name, and a name is never created twice) when there is no
 * generation file, or the top one is a release record, or it is an owner record that is breakable
 * (its owner is gone, or it is far older than any real section; see lockBreakable). To release, the
 * holder creates top+1 as a release record. A dead holder's file is simply left under the next
 * generation. So a takeover is one `wx`: a stale judgement can only lead to a `wx` on a name that
 * now exists, which fails, and correctness does not depend on how fresh any liveness judgement is.
 *
 * Why two holders cannot coexist: generation G+1 is created over G only by a taker (G was free or
 * its owner gone) or by G's own holder releasing, and each name is created once, ever.
 *
 * COST. Two small files per locked section, never removed. The lock is only taken when a card needs
 * a number or the mark must rise (see assignNumbers), which is human-paced.
 *
 * RESIDUAL, STATED: the judgement itself can be wrong in one case, an owner that is alive yet far
 * past LIVE_OWNER_STALE_MS (ten minutes), or an owner file whose text was never written. The wait
 * for a lock is capped at LOCK_TIMEOUT_MS (ten seconds), so a waiter gives up long before it would
 * judge a live section stale.
 */
const LOCK_PREFIX = `${LOCK_FILE}.`;
const RELEASED_TEXT = JSON.stringify({ released: true });

/** Highest generation number among the lock files in `dir`, or 0 when there are none. */
function topLockGeneration(dir) {
  let top = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(LOCK_PREFIX)) continue;
    const g = f.slice(LOCK_PREFIX.length);
    if (/^\d{1,15}$/.test(g)) top = Math.max(top, Number(g));
  }
  return top;
}

/** Create `file` exclusively with `text`. False when the name already exists. */
function createExclusive(file, text) {
  let fd;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    // EEXIST: someone created this generation first. EPERM: it is delete-pending on Windows.
    if (e.code === 'EEXIST' || e.code === 'EPERM') return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Run `fn` holding the exclusive lock for `dir`. Throws if the lock cannot be taken in time.
 * `lockTimeoutMs` exists for the tests, which must not wait ten seconds to prove a refusal.
 */
export function withDirLock(dir, fn, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + lockTimeoutMs;
  const genPath = (g) => path.join(dir, `${LOCK_PREFIX}${g}`);
  let held;
  for (;;) {
    const top = topLockGeneration(dir);
    let free = top === 0;
    if (!free) {
      try {
        const file = genPath(top);
        const raw = readFileSync(file, 'utf8');
        let released = false;
        try {
          released = JSON.parse(raw)?.released === true;
        } catch {
          /* an owner record, or empty */
        }
        free = released || lockBreakable(parseOwner(raw), Date.now() - statSync(file).mtimeMs);
      } catch {
        continue; // unreadable for a moment: list again
      }
    }
    if (free) {
      const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(8).toString('hex') });
      if (createExclusive(genPath(top + 1), owner)) {
        held = top + 1;
        break;
      }
      continue; // another process took top+1 first: list again
    }
    if (Date.now() > deadline) throw new Error(`could not take ${path.join(dir, LOCK_FILE)} within ${lockTimeoutMs}ms`);
    sleepMs(25);
  }
  try {
    return fn();
  } finally {
    // Release by appending a release record. If someone judged us dead and took held+1, that is
    // theirs: the create fails and we leave it alone.
    createExclusive(genPath(held + 1), RELEASED_TEXT);
  }
}

function listMd(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
}

/** Highest num on any file in `dir`; a missing or unreadable folder counts as 0. */
function maxNumIn(dir) {
  let max = 0;
  let files;
  try {
    files = listMd(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    try {
      max = Math.max(max, existingNum(readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      /* an unreadable archived file cannot lower the mark, which is all this read is for */
    }
  }
  return max;
}

function readHighWater(dir) {
  try {
    const n = Number(JSON.parse(readFileSync(path.join(dir, COUNTER_FILE), 'utf8')).highWater);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeHighWater(dir, n) {
  const file = path.join(dir, COUNTER_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ highWater: n }) + '\n', 'utf8');
  renameSync(tmp, file);
}

/**
 * Give every task file in `dir` a permanent number, leaving files that already have one alone.
 * Returns { assigned, max, skipped } — `skipped` names files with no frontmatter block, which are
 * reported rather than silently passed over, the same way the collector reports them.
 */
export function assignNumbers(dir, { lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
  try {
    listMd(dir);
  } catch {
    // A MISSING TASKS FOLDER IS REPORTED, NOT SWALLOWED. Returning a silent zero here would make
    // "no tasks yet" and "wrong path" look identical, which is the exact bug the vault-path fix
    // in 5a392a4d was written for.
    return { assigned: 0, max: 0, skipped: [], problem: `no Tasks folder at ${dir}` };
  }
  // Nothing to number and the mark already covers every number on disk: the common poll. Read-only,
  // so it needs no lock, and it keeps the lock series (which is never pruned) growing at the pace
  // of new cards rather than the pace of polling.
  const scan = scanTasks(dir);
  if (!scan.unnumbered.length && scan.max <= readHighWater(dir)) return { assigned: 0, max: scan.max, skipped: scan.skipped };
  return withDirLock(dir, () => allocate(dir), lockTimeoutMs);
}

/** Read-only pass: the highest number on disk, the files still without one, and the files skipped. */
function scanTasks(dir) {
  const skipped = [];
  const unnumbered = [];
  let max = Math.max(readHighWater(dir), maxNumIn(path.join(dir, '_deleted')));

  for (const f of listMd(dir).sort()) {
    const full = path.join(dir, f);
    let raw;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      skipped.push(`${f} (unreadable)`);
      continue;
    }
    if (!raw.startsWith('---') || raw.indexOf('\n---', 3) === -1) {
      skipped.push(`${f} (no frontmatter block)`);
      continue;
    }
    const n = existingNum(raw);
    if (n) max = Math.max(max, n);
    else unnumbered.push(full);
  }
  return { skipped, unnumbered, max };
}

function allocate(dir) {
  const { skipped, unnumbered, max: scanned } = scanTasks(dir);
  let max = scanned;

  // Raise the mark to what is already on disk even when nothing is unnumbered, so the mark is
  // never behind the files and a later deletion cannot lower the floor.
  if (max > readHighWater(dir)) writeHighWater(dir, max);
  if (!unnumbered.length) return { assigned: 0, max, skipped };

  // Persist the new ceiling BEFORE touching any file: a crash after this wastes numbers, it cannot
  // reuse them.
  const ceiling = max + unnumbered.length;
  writeHighWater(dir, ceiling);

  let next = max;
  let assigned = 0;
  for (const full of unnumbered) {
    // Re-read right before the write, so an edit made since the scan above is kept, not overwritten.
    let raw;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const end = raw.indexOf('\n---', 3);
    if (!raw.startsWith('---') || end === -1 || existingNum(raw)) continue;
    next += 1;
    // Inserted at the TOP of the frontmatter so it is the first thing read in the file and in any
    // grep of the folder's frontmatter, which is how notes are located here.
    const patched = `---\nnum: ${next}${raw.slice(3, end)}${raw.slice(end)}`;
    // Temp file then rename, matching the board's own write: a half-written task file would be
    // parsed by the next poll and render as a task with no title.
    const tmp = `${full}.tmp-${process.pid}`;
    writeFileSync(tmp, patched, 'utf8');
    renameSync(tmp, full);
    assigned += 1;
  }

  return { assigned, max: ceiling, skipped };
}

/**
 * The pair a card in the Suggestions column is answered with when the file declares no options of
 * its own. Lives here, beside movedStatusFor, because the answer endpoint and the reconcile below
 * must agree on exactly which strings are the buttons.
 */
export const SUGGESTION_OPTIONS = Object.freeze(['Approve - move to To do', 'Decline']);

/** Parse a frontmatter list value: ["a", "b"] or a bare comma-separated line. */
export function parseList(v) {
  const s = v.trim();
  if (!s) return [];
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  return inner
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Where an answered suggestion belongs. THE ONE PLACE THIS IS DECIDED, imported by the board's
 * answer endpoint and by the reconcile below, so a card answered through the UI and a card
 * reconciled on startup can never disagree about what "Approve" meant.
 *
 * ONLY AN EXPLICIT BUTTON MOVES A CARD. `options` is the list of button labels the card offers;
 * the answer must equal one of them exactly before its first word is read. Free text that merely
 * starts with "Decline" or "Approve" ("Decline for now, revisit after launch") is neither an
 * approval nor a decline and returns '': he has said something the two buttons could not say, and
 * guessing which way it fell would either bury an idea he liked or queue one he did not.
 */
export function movedStatusFor(answer, options) {
  if (!options.includes(answer)) return '';
  if (/^\s*approve\b/i.test(answer)) return 'backlog';
  if (/^\s*decline\b/i.test(answer)) return 'done';
  return '';
}

/**
 * Move any suggestion that was ALREADY answered with a button but never moved.
 *
 * The answer endpoint recorded `answer:` without touching `status:` until that was fixed, so a
 * suggestion approved before the fix shipped still sits in the Suggestions column with an approval
 * written on it. Without this the fix is only prospective and the card that prompted it stays
 * stuck — which is indistinguishable, to the person looking at the board, from the fix not working.
 * That is exactly how it was reported: "task #42 still hasn't moved to todo."
 *
 * A card whose answer is free text is left where it is, for the same reason movedStatusFor
 * refuses it: the card's own `options:` (or the default pair) decide what counts as a button.
 *
 * Idempotent: after the move the status is no longer `suggestion`, so the next run skips it.
 */
export function reconcileAnsweredSuggestions(dir) {
  let files;
  try {
    files = listMd(dir);
  } catch {
    return { moved: [] };
  }
  const moved = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let raw;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const end = raw.indexOf('\n---', 3);
    if (!raw.startsWith('---') || end === -1) continue;
    const head = raw.slice(0, end);
    // Both reads are scoped to the frontmatter block, so a body line starting "status:" or
    // "answer:" can never move a card.
    if (!/^status:[ \t]*suggestion[ \t]*$/im.test(head)) continue;
    const ans = /^answer:[ \t]*(.+?)[ \t]*$/im.exec(head);
    if (!ans) continue;
    // A TYPED answer never moves a card, even one that spells a button label exactly. The answer
    // endpoint leaves such a card in place and marks it; honour the mark, or the next refresh moves
    // the card the endpoint just refused to move.
    if (new RegExp(`^${ANSWER_CUSTOM_KEY}:[ \\t]*true[ \\t]*$`, 'im').test(head)) continue;
    const opts = /^options:[ \t]*(.*)$/im.exec(head);
    const declared = opts ? parseList(opts[1]) : [];
    const to = movedStatusFor(ans[1], declared.length ? declared : SUGGESTION_OPTIONS);
    if (!to) continue;
    const patched = head.replace(/^status:[ \t]*suggestion[ \t]*$/im, `status: ${to}`) + raw.slice(end);
    const tmp = `${full}.tmp-${process.pid}`;
    writeFileSync(tmp, patched, 'utf8');
    renameSync(tmp, full);
    moved.push(`${f} -> ${to}`);
  }
  return { moved };
}
