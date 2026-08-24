// @ts-check
/**
 * Durable state files: atomic write (already the rule here) plus a rotating backup ring.
 *
 * Atomicity stops a CRASH from truncating a file. It does nothing about the other way state dies:
 * a write that succeeds and is wrong — a bad fold, a half-migrated schema, a disk that returned
 * success and lied. By the time anyone notices, the good state has been overwritten dozens of
 * times. The ring keeps N older copies so the answer to "restore from what?" is not "re-index from
 * the deploy block".
 *
 * Two rules the implementation exists to honour:
 *
 *  - **`path` never blinks out of existence.** The current file is COPIED to `.1`, never renamed
 *    there. The API reloads the snapshot on a timer; a reader that found it missing would drop to
 *    stale-state serving for no reason at all.
 *  - **Backups are spaced by TIME, not by write.** The indexer snapshots every batch — every 12s
 *    at the default poll, and far faster during a cold-start catch-up. Rotating per write would
 *    give a 36-second backup horizon (useless: corruption is noticed minutes later) and turn
 *    catch-up into a copy-per-batch hot loop. `backupIntervalMs` decouples the two.
 */

import { writeFile, rename, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `state.json` → `state.json.1` (1 = most recent backup). */
export function backupPath(path, n) {
  return `${path}.${n}`;
}

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Shift the ring and copy the current file into slot 1. No-op (returns false) when backups are
 * disabled or there is nothing to back up yet.
 * @returns {Promise<boolean>} whether a backup was taken
 */
export async function rotateBackups(path, keep) {
  if (!(keep > 0)) return false;
  if (!(await statOrNull(path))) return false;
  await rm(backupPath(path, keep), { force: true });        // drop the oldest
  for (let n = keep - 1; n >= 1; n -= 1) {                  // .2 → .3, .1 → .2
    if (await statOrNull(backupPath(path, n))) await rename(backupPath(path, n), backupPath(path, n + 1));
  }
  await copyFile(path, backupPath(path, 1));                // copy, never rename — see the header
  return true;
}

/** Write-temp-then-rename, creating the directory. The repo's existing snapshot discipline. */
export async function atomicWriteFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/**
 * What is actually on disk right now, newest first. Used by the `verify` subcommands so an
 * operator picking a file to restore can see sizes and ages instead of guessing.
 */
export async function listBackups(path, keep = 5) {
  const out = [];
  for (let n = 1; n <= keep; n += 1) {
    const p = backupPath(path, n);
    const st = await statOrNull(p);
    if (st) out.push({ n, path: p, bytes: st.size, mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString() });
  }
  return out;
}

/**
 * An atomic writer with a time-spaced backup ring.
 *
 * @param {Object} p
 * @param {string} p.path
 * @param {number} [p.backups]            ring size; 0 disables backups entirely
 * @param {number} [p.backupIntervalMs]   minimum wall-clock spacing between backups
 * @param {() => number} [p.now]
 * @param {(o:any)=>string} [p.serialize]
 */
export function createRotatingWriter({ path, backups = 0, backupIntervalMs = 0, now = () => Date.now(), serialize = (o) => JSON.stringify(o) }) {
  let lastBackupAt = -Infinity;
  let backupCount = 0;

  return {
    path,
    get lastBackupAt() { return lastBackupAt; },
    get backupCount() { return backupCount; },
    /** @returns {Promise<{backedUp:boolean}>} */
    async write(obj) {
      const t = now();
      let backedUp = false;
      if (backups > 0 && t - lastBackupAt >= backupIntervalMs) {
        // On the very first write `path` does not exist yet, so this is a no-op and lastBackupAt
        // stays unset — the FIRST real snapshot gets captured by the next write rather than being
        // skipped for a whole interval.
        backedUp = await rotateBackups(path, backups);
        if (backedUp) { lastBackupAt = t; backupCount += 1; }
      }
      await atomicWriteFile(path, serialize(obj));
      return { backedUp };
    },
  };
}

/**
 * Resolve the durability knobs shared by the indexer and the canary. One pair of env vars for both
 * — compose feeds them a single .env, and two spellings of the same policy is a trap.
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveDurabilityOptions(env = {}) {
  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const backups = num('SNAPSHOT_BACKUPS', 3);
  const backupIntervalMs = num('SNAPSHOT_BACKUP_INTERVAL_MS', 300_000);
  if (!Number.isInteger(backups) || backups < 0) throw new Error(`oplog: SNAPSHOT_BACKUPS must be a non-negative integer, got '${env.SNAPSHOT_BACKUPS}'`);
  if (!Number.isFinite(backupIntervalMs) || backupIntervalMs < 0) throw new Error(`oplog: SNAPSHOT_BACKUP_INTERVAL_MS must be a non-negative number, got '${env.SNAPSHOT_BACKUP_INTERVAL_MS}'`);
  return { backups, backupIntervalMs };
}
