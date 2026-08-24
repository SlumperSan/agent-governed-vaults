// @ts-check
/**
 * The canary's own transition state on disk — never the indexer's snapshot, which it opens
 * read-only.
 *
 * Small file, big consequence: it is what stops a restart from re-paging every alert that was
 * already acknowledged, and what remembers `lastScannedBlock` so the event signals do not re-scan
 * or, worse, silently skip a range. Losing it is not fatal — the canary rebuilds by observing —
 * but the rebuild costs one duplicate page per still-firing signal, at exactly the moment an
 * operator is least able to absorb noise. So it gets the same durability as the snapshot: atomic
 * write plus a time-spaced backup ring.
 */

import { readFile } from 'node:fs/promises';
import { createRotatingWriter, listBackups } from '../../oplog/src/durable.mjs';

export const emptyCanaryState = () => ({ transitions: {}, lastScannedBlock: null });

/** Atomic writer with the backup ring. `save(obj)` replaces the old inline temp-then-rename. */
export function createCanaryStateWriter({ path, backups = 0, backupIntervalMs = 0, now }) {
  const writer = createRotatingWriter({ path, backups, backupIntervalMs, now });
  return { path, backups, get backupCount() { return writer.backupCount; }, save: (obj) => writer.write(obj) };
}

/** Load, treating an absent file as a first run rather than an error. */
export async function loadCanaryState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyCanaryState();
    throw err;
  }
}

/** Tallies over a persisted transition map: how many signals, and which are not OK. */
export function summariseTransitions(transitions) {
  const entries = Object.entries(transitions ?? {});
  const byStatus = {};
  const notOk = [];
  for (const [id, s] of entries) {
    const status = s?.status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status !== 'ok') notOk.push({ id, status, since: s?.since ?? null });
  }
  return { tracked: entries.length, byStatus, notOk };
}

/**
 * Read the canary state and report it, WITHOUT starting a sweep — no RPC, no RPC_URL required.
 * The question after an incident is "what did it already know, and how far had it scanned?".
 */
export async function verifyCanaryState(path, { keep = 5 } = {}) {
  const report = { path, ok: false, exists: false, error: null, lastScannedBlock: null, summary: null, backups: [] };
  for (const b of await listBackups(path, keep)) {
    const row = { ...b, ok: false, lastScannedBlock: null, tracked: null, error: null };
    try {
      const obj = JSON.parse(await readFile(b.path, 'utf8'));
      row.ok = true;
      row.lastScannedBlock = obj.lastScannedBlock ?? null;
      row.tracked = summariseTransitions(obj.transitions).tracked;
    } catch (err) {
      row.error = String(err?.message ?? err);
    }
    report.backups.push(row);
  }
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    report.error = err && err.code === 'ENOENT'
      ? `no canary state at ${path} — a fresh canary would re-observe every signal (expect one page per signal already firing)`
      : String(err?.message ?? err);
    return report;
  }
  report.exists = true;
  report.bytes = raw.length;
  try {
    const obj = JSON.parse(raw);
    report.lastScannedBlock = obj.lastScannedBlock ?? null;
    report.summary = summariseTransitions(obj.transitions);
    report.ok = true;
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  return report;
}

/** Render a verify report for a terminal. */
export function formatCanaryStateReport(report) {
  const lines = [];
  if (!report.ok) {
    lines.push(`canary state ${report.path}: UNUSABLE — ${report.error}`);
  } else {
    const s = report.summary;
    lines.push(`canary state ${report.path}: OK`);
    lines.push(`  cursor      lastScannedBlock=${report.lastScannedBlock ?? 'null (cold start)'}`);
    lines.push(`  signals     ${s.tracked} tracked — ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
    for (const n of s.notOk) lines.push(`    NOT OK    ${n.id} (${n.status} since poll ${n.since})`);
    lines.push(`  file        ${report.bytes} bytes`);
  }
  if (report.backups.length === 0) {
    lines.push('  backups     none on disk (SNAPSHOT_BACKUPS=0, or none taken yet)');
  } else {
    lines.push(`  backups     ${report.backups.length} (newest first)`);
    for (const b of report.backups) {
      lines.push(b.ok
        ? `    .${b.n}  lastScannedBlock=${b.lastScannedBlock} tracked=${b.tracked} ${b.bytes} bytes  ${b.mtime}`
        : `    .${b.n}  UNREADABLE — ${b.error}`);
    }
  }
  return lines.join('\n');
}
