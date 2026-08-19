// @ts-check
/**
 * Persistence for the projection state: serialize (bigint- and Map-safe), snapshot to disk, and
 * resume from a cursor. The projection is a pure fold over events, so persistence = periodically
 * snapshot the folded state + remember (lastBlock, lastLogIndex); on restart, load the snapshot
 * and replay only newer logs.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyState } from './projections.mjs';

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
