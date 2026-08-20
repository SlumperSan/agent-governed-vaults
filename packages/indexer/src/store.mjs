// @ts-check
/**
 * Persistence for the projection state: serialize (bigint- and Map-safe), snapshot to disk, and
 * resume from a cursor. The projection is a pure fold over events, so persistence = periodically
 * snapshot the folded state + remember (lastBlock, lastLogIndex); on restart, load the snapshot
 * and replay only newer logs.
 */

import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyState } from './projections.mjs';
import { createRotatingWriter, listBackups } from '../../oplog/src/durable.mjs';

const VERSION = 1;

/** Convert the live state (Maps + bigints) into a JSON-serializable plain object. */
export function serializeState(state) {
  const mapEntries = (m, valFn = (v) => v) => [...m.entries()].map(([k, v]) => [k, valFn(v)]);
  const vault = (v) => ({
    ...v,
    totalShares: v.totalShares.toString(),
    idleUsdc: v.idleUsdc.toString(),
    capacityCapUsdc: v.capacityCapUsdc.toString(),
  });
  const op = (o) => ({
    ...o,
    lifetimeGainUsdc: o.lifetimeGainUsdc.toString(),
    lifetimeLossUsdc: o.lifetimeLossUsdc.toString(),
    lifetimeFeesUsdc: o.lifetimeFeesUsdc.toString(),
  });
  const prop = (p) => ({
    ...p,
    forWeight: p.forWeight.toString(),
    againstWeight: p.againstWeight.toString(),
    revealedWeight: p.revealedWeight.toString(),
  });
  return {
    version: VERSION,
    lastBlock: state.lastBlock,
    lastLogIndex: state.lastLogIndex,
    vaults: mapEntries(state.vaults, vault),
    operators: mapEntries(state.operators, op),
    shares: mapEntries(state.shares, (book) => mapEntries(book, (b) => b.toString())),
    proposals: mapEntries(state.proposals, prop),
    activeProposal: mapEntries(state.activeProposal),
  };
}

/** Rebuild live state (Maps + bigints) from a serialized object. */
export function deserializeState(obj) {
  if (!obj || obj.version !== VERSION) throw new Error(`unsupported snapshot version: ${obj?.version}`);
  const s = emptyState();
  s.lastBlock = obj.lastBlock;
  s.lastLogIndex = obj.lastLogIndex;
  for (const [k, v] of obj.vaults) {
    s.vaults.set(k, {
      ...v,
      totalShares: BigInt(v.totalShares),
      idleUsdc: BigInt(v.idleUsdc),
      capacityCapUsdc: BigInt(v.capacityCapUsdc),
    });
  }
  for (const [k, o] of obj.operators) {
    s.operators.set(Number(k), {
      ...o,
      lifetimeGainUsdc: BigInt(o.lifetimeGainUsdc),
      lifetimeLossUsdc: BigInt(o.lifetimeLossUsdc),
      lifetimeFeesUsdc: BigInt(o.lifetimeFeesUsdc),
    });
  }
  for (const [k, book] of obj.shares) {
    s.shares.set(k, new Map(book.map(([m, b]) => [m, BigInt(b)])));
  }
  for (const [k, p] of obj.proposals) {
    s.proposals.set(Number(k), {
      ...p,
      forWeight: BigInt(p.forWeight),
      againstWeight: BigInt(p.againstWeight),
      revealedWeight: BigInt(p.revealedWeight),
    });
  }
  for (const [k, pid] of obj.activeProposal) s.activeProposal.set(k, pid);
  return s;
}

/** Atomically snapshot state to `path` (write-temp-then-rename, so a crash never truncates). */
export async function saveSnapshot(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(serializeState(state)), 'utf8');
  await rename(tmp, path);
}

/**
 * `saveSnapshot` plus a time-spaced backup ring (oplog/durable.mjs). Atomicity survives a crash;
 * the ring survives a write that succeeded and was wrong. Returns an object whose `save(state)`
 * replaces `saveSnapshot` in the daemon.
 * @param {{path:string, backups?:number, backupIntervalMs?:number, now?:() => number}} p
 */
export function createSnapshotWriter({ path, backups = 0, backupIntervalMs = 0, now }) {
  const writer = createRotatingWriter({ path, backups, backupIntervalMs, now, serialize: (st) => JSON.stringify(serializeState(st)) });
  return {
    path,
    backups,
    get backupCount() { return writer.backupCount; },
    save: (state) => writer.write(state),
  };
}

/** Load a snapshot, or return a fresh empty state if the file is absent. */
export async function loadSnapshot(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return deserializeState(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

/** The resume cursor an indexer should poll *after*. */
export function resumeCursor(state) {
  return { fromBlock: state.lastBlock === 0 && state.lastLogIndex === -1 ? 0 : state.lastBlock + 1 };
}

/**
 * Read a snapshot and report what is in it, WITHOUT starting a poller or touching an RPC.
 *
 * This is the after-the-incident question — "is this file usable, and how far behind is it?" —
 * and answering it must not require the six env vars a running indexer needs, nor risk a process
 * that starts indexing from a cursor you were about to reject. Backups are summarised alongside,
 * because the next question is always "restore from which one?".
 *
 * @param {string} path
 * @param {{keep?:number}} [opts]
 */
export async function verifySnapshot(path, { keep = 5 } = {}) {
  const report = { path, ok: false, exists: false, bytes: null, mtime: null, version: VERSION, error: null,
    lastBlock: null, lastLogIndex: null, counts: null, backups: [] };
  try {
    report.backups = await summariseBackups(path, keep);
  } catch (err) {
    report.backups = [];
  }
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    report.error = err && err.code === 'ENOENT'
      ? `no snapshot at ${path} — a fresh indexer would start from START_BLOCK`
      : String(err?.message ?? err);
    return report;
  }
  report.exists = true;
  report.bytes = st.size;
  report.mtime = new Date(st.mtimeMs).toISOString();
  report.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  try {
    const state = deserializeState(JSON.parse(await readFile(path, 'utf8')));
    report.lastBlock = state.lastBlock;
    report.lastLogIndex = state.lastLogIndex;
    report.resumeFrom = resumeCursor(state).fromBlock;
    report.counts = countState(state);
    report.ok = true;
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  return report;
}

/** The per-collection tallies an operator compares against a backup before restoring. */
export function countState(state) {
  let holders = 0;
  for (const book of state.shares.values()) holders += book.size;
  return {
    vaults: state.vaults.size,
    operators: state.operators.size,
    proposals: state.proposals.size,
    shareBooks: state.shares.size,
    holders,
    activeProposals: state.activeProposal.size,
  };
}

/** Backups with their own cursor, so "which one do I roll back to" is answerable at a glance. */
async function summariseBackups(path, keep) {
  const out = [];
  for (const b of await listBackups(path, keep)) {
    const row = { ...b, ok: false, lastBlock: null, counts: null, error: null };
    try {
      const state = deserializeState(JSON.parse(await readFile(b.path, 'utf8')));
      row.ok = true;
      row.lastBlock = state.lastBlock;
      row.counts = countState(state);
    } catch (err) {
      row.error = String(err?.message ?? err);
    }
    out.push(row);
  }
  return out;
}

/** Render a verify report for a terminal. Exit code comes from `report.ok`. */
export function formatSnapshotReport(report) {
  const lines = [];
  if (!report.exists || !report.ok) {
    lines.push(`snapshot ${report.path}: UNUSABLE — ${report.error}`);
  } else {
    const c = report.counts;
    lines.push(`snapshot ${report.path}: OK`);
    lines.push(`  cursor      lastBlock=${report.lastBlock} lastLogIndex=${report.lastLogIndex} → resumes from block ${report.resumeFrom}`);
    lines.push(`  counts      vaults=${c.vaults} operators=${c.operators} proposals=${c.proposals} shareBooks=${c.shareBooks} holders=${c.holders} activeProposals=${c.activeProposals}`);
    lines.push(`  file        ${report.bytes} bytes, written ${report.mtime} (${report.ageSec}s ago)`);
  }
  if (report.backups.length === 0) {
    lines.push('  backups     none on disk (SNAPSHOT_BACKUPS=0, or none taken yet)');
  } else {
    lines.push(`  backups     ${report.backups.length} (newest first)`);
    for (const b of report.backups) {
      lines.push(b.ok
        ? `    .${b.n}  lastBlock=${b.lastBlock} vaults=${b.counts.vaults} ${b.bytes} bytes  ${b.mtime}`
        : `    .${b.n}  UNREADABLE — ${b.error}  (${b.bytes} bytes, ${b.mtime})`);
    }
  }
  return lines.join('\n');
}
