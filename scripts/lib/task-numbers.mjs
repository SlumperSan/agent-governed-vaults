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
 * the same vault, so the whole read-allocate-write section runs under an exclusive lock file
 * (`Tasks/_task-numbers.lock`, created with the `wx` flag, which is atomic). The lock file records
 * its owner (pid, host, a random token). A lock is broken only when its owner process is gone, or
 * when it is older than LIVE_OWNER_STALE_MS (ten minutes, for a recycled pid or an owner on another
 * machine); a lock with no readable owner (a crash between create and write) is broken after
 * STALE_LOCK_MS. A mere 30 s mtime is not enough on its own: it let a second process into the
 * section while the first still held it. A stale lock is removed only under a second `wx` file
 * (`<lock>.break`), where it is re-read and re-judged first, so exactly one process takes it over (see
 * breakStaleLock). The holder removes the lock on exit only if the file still
 * carries ITS token, so it can never delete a lock someone else now holds. Unnumbered files are re-read inside the
 * lock, immediately before each write, so a number is never given to a file another process has
 * already numbered.
 *
 * ASSIGNMENT IS DETERMINISTIC WITHIN A RUN. Unnumbered files are sorted by name before numbering,
 * so a first run over a fresh vault gives the same answer twice rather than depending on readdir
 * order. Across runs it does not matter, because every earlier file already carries its number.
 *
 * This writes to task files, which is otherwise something the board does not do. It is narrow by
 * construction: it only ever INSERTS a `num:` line into a frontmatter block that has none, never
 * edits one that exists, never touches the body, and never deletes a task file. Besides the task
 * files it creates and updates only the counter and the lock file named above.
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

/** How long a breaker file may exist before it is presumed left by a process that died mid-break. */
const BREAKER_STALE_MS = 10_000;

/**
 * Take over a lock judged stale, with EXACTLY ONE process doing the removal at a time.
 *
 * WHY A SECOND FILE. Reading the lock and then unlinking it are two syscalls, so between them
 * another stealer can remove the stale file and create its own live lock, and the unlink then
 * deletes THAT one: two processes inside the section at once, and `allocate()` can hand out one
 * number twice. (Measured on the first version of this guard: two processes overlapped in 16 of 40
 * rounds against a seeded dead-owner lock.) The fix is that nobody removes a stale lock except
 * under `<lock>.break`, itself created with `wx`. Under it the lock is read AGAIN and judged again:
 * it is removed only if its text is still the text the caller judged and it is still breakable. For a
 * dead owner that is airtight: the owner is gone and cannot release, a creator cannot get past
 * `wx` while the file exists, and every other would-be breaker is shut out by the breaker file, so
 * nothing can change the lock between the re-read and the unlink.
 *
 * Returns true when this call removed the lock, false when it did not (not the breaker, or the lock
 * had changed hands). The caller retries its `wx` either way.
 *
 * RESIDUAL, STATED: a breaker file left by a process killed mid-break is itself taken over (owner
 * gone, or older than BREAKER_STALE_MS) by an atomic rename to a unique name. That inner takeover
 * can in principle race the same way, but only after a process died inside a window of a few
 * microseconds AND two more processes collide on the leftover file at the same instant.
 */
export function breakStaleLock(lock, judgedRaw) {
  const brk = `${lock}.break`;
  const token = randomBytes(8).toString('hex');
  let fd;
  try {
    fd = openSync(brk, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    reapDeadBreaker(brk);
    return false;
  }
  try {
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }));
    } finally {
      closeSync(fd);
    }
    let raw;
    let ageMs;
    try {
      raw = readFileSync(lock, 'utf8');
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return false; // released or removed already
    }
    if (raw !== judgedRaw || !lockBreakable(parseOwner(raw), ageMs)) return false; // changed hands
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (parseOwner(readFileSync(brk, 'utf8'))?.token === token) unlinkSync(brk);
    } catch {
      /* already gone */
    }
  }
}

/** Remove a breaker file whose owner is gone or which is far older than any real break. */
function reapDeadBreaker(brk) {
  try {
    const raw = readFileSync(brk, 'utf8');
    const ageMs = Date.now() - statSync(brk).mtimeMs;
    const o = parseOwner(raw);
    const dead = o ? o.host === hostname() && !pidAlive(o.pid) : ageMs > BREAKER_STALE_MS;
    if (!dead && ageMs <= BREAKER_STALE_MS) return;
    // Rename to a name no one else will use: only one renamer can win, the rest get ENOENT.
    const tomb = `${brk}.dead-${randomBytes(6).toString('hex')}`;
    renameSync(brk, tomb);
    unlinkSync(tomb);
  } catch {
    /* someone else got there first */
  }
}

/**
 * Run `fn` holding the exclusive lock for `dir`. Throws if the lock cannot be taken in time.
 * `lockTimeoutMs` exists for the tests, which must not wait ten seconds to prove a refusal.
 */
export function withDirLock(dir, fn, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const lock = path.join(dir, LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token }));
      } catch (e) {
        closeSync(fd);
        unlinkSync(lock);
        throw e;
      }
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const raw = readFileSync(lock, 'utf8');
        const ageMs = Date.now() - statSync(lock).mtimeMs;
        if (lockBreakable(parseOwner(raw), ageMs)) {
          // false: another process is breaking it, or it changed hands. Either way, look again.
          if (!breakStaleLock(lock, raw)) sleepMs(2);
          if (Date.now() <= deadline) continue;
        }
      } catch {
        continue; // released between our open and our read: just try again
      }
      if (Date.now() > deadline) throw new Error(`could not take ${lock} within ${lockTimeoutMs}ms`);
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    // Only our own lock. If it was broken and re-taken while we ran, that lock is not ours to remove.
    try {
      if (parseOwner(readFileSync(lock, 'utf8'))?.token === token) unlinkSync(lock);
    } catch {
      /* already gone */
    }
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
  return withDirLock(dir, () => allocate(dir), lockTimeoutMs);
}

function allocate(dir) {
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
