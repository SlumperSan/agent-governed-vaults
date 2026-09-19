/**
 * Stable task numbers, so a human can say "task 14" and everyone means the same card.
 *
 * WHY A NUMBER IN THE FILE, rather than a position or a hash. A board position changes every time
 * a card moves, so "the third one in To do" is a different task ten minutes later. A hash of the
 * filename is stable but unsayable. The number is written into the file's own frontmatter ONCE and
 * never changes after that, including when the task is renamed, reprioritised, moved between
 * columns or finished. It is an identity, not an ordering.
 *
 * NUMBERS ARE NEVER REUSED. The next number is max(existing) + 1, not count + 1: deleting task 12
 * must not hand 12 to something else, because a conversation, a commit message or a vault note may
 * already refer to the old 12. A freed number is a number that makes an old sentence false.
 *
 * ASSIGNMENT IS DETERMINISTIC WITHIN A RUN. Unnumbered files are sorted by name before numbering,
 * so a first run over a fresh vault gives the same answer twice rather than depending on readdir
 * order. Across runs it does not matter, because every earlier file already carries its number.
 *
 * This writes to task files, which is otherwise something the board does not do. It is narrow by
 * construction: it only ever INSERTS a `num:` line into a frontmatter block that has none, never
 * edits one that exists, never touches the body, and never creates or deletes a file.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Read the `num:` already in a frontmatter block, or 0 when there is none. */
function existingNum(raw) {
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return 0;
  const m = /^num:[ \t]*(\d+)[ \t]*$/m.exec(raw.slice(0, end));
  return m ? Number(m[1]) : 0;
}

/**
 * Give every task file in `dir` a permanent number, leaving files that already have one alone.
 * Returns { assigned, max, skipped } — `skipped` names files with no frontmatter block, which are
 * reported rather than silently passed over, the same way the collector reports them.
 */
export function assignNumbers(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  } catch {
    // A MISSING TASKS FOLDER IS REPORTED, NOT SWALLOWED. Returning a silent zero here would make
    // "no tasks yet" and "wrong path" look identical, which is the exact bug the vault-path fix
    // in 5a392a4d was written for.
    return { assigned: 0, max: 0, skipped: [], problem: `no Tasks folder at ${dir}` };
  }

  const unnumbered = [];
  const skipped = [];
  let max = 0;

  for (const f of files.sort()) {
    const full = path.join(dir, f);
    let raw;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      skipped.push(`${f} (unreadable)`);
      continue;
    }
    const end = raw.indexOf('\n---', 3);
    if (!raw.startsWith('---') || end === -1) {
      skipped.push(`${f} (no frontmatter block)`);
      continue;
    }
    const n = existingNum(raw);
    if (n) max = Math.max(max, n);
    else unnumbered.push({ full, raw, end });
  }

  let next = max;
  for (const { full, raw, end } of unnumbered) {
    next += 1;
    // Inserted at the TOP of the frontmatter so it is the first thing read in the file and in any
    // grep of the folder's frontmatter, which is how notes are located here.
    const patched = `---\nnum: ${next}${raw.slice(3, end)}${raw.slice(end)}`;
    // Temp file then rename, matching the board's own write: a half-written task file would be
    // parsed by the next poll and render as a task with no title.
    const tmp = `${full}.tmp-${process.pid}`;
    writeFileSync(tmp, patched, 'utf8');
    renameSync(tmp, full);
  }

  return { assigned: unnumbered.length, max: next, skipped };
}

/**
 * Where an answered suggestion belongs. THE ONE PLACE THIS IS DECIDED, imported by the board's
 * answer endpoint and by the reconcile below, so a card answered through the UI and a card
 * reconciled on startup can never disagree about what "Approve" meant.
 *
 * Free text is neither an approval nor a decline and returns '': he has said something the two
 * buttons could not say, and guessing which way it fell would either bury an idea he liked or
 * queue one he did not.
 */
export function movedStatusFor(answer) {
  if (/^\s*approve\b/i.test(answer)) return 'backlog';
  if (/^\s*decline\b/i.test(answer)) return 'done';
  return '';
}

/**
 * Move any suggestion that was ALREADY answered but never moved.
 *
 * The answer endpoint recorded `answer:` without touching `status:` until that was fixed, so a
 * suggestion approved before the fix shipped still sits in the Suggestions column with an approval
 * written on it. Without this the fix is only prospective and the card that prompted it stays
 * stuck — which is indistinguishable, to the person looking at the board, from the fix not working.
 * That is exactly how it was reported: "task #42 still hasn't moved to todo."
 *
 * Idempotent: after the move the status is no longer `suggestion`, so the next run skips it.
 */
export function reconcileAnsweredSuggestions(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
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
    const to = movedStatusFor(ans[1]);
    if (!to) continue;
    const patched = head.replace(/^status:[ \t]*suggestion[ \t]*$/im, `status: ${to}`) + raw.slice(end);
    const tmp = `${full}.tmp-${process.pid}`;
    writeFileSync(tmp, patched, 'utf8');
    renameSync(tmp, full);
    moved.push(`${f} -> ${to}`);
  }
  return { moved };
}
