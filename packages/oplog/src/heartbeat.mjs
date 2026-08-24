// @ts-check
/**
 * Heartbeat files — how a service proves it is alive to something that is not itself.
 *
 * Each runtime process writes `<dir>/<service>.heartbeat.json` on every successful work cycle.
 * `ops-check.mjs` reads them and fails when one goes stale. A crashed process stops writing; a
 * WEDGED process — the one a `restart: unless-stopped` policy never notices — also stops writing,
 * which is the failure this exists to catch.
 *
 * The writer stamps its OWN `staleAfterMs`, because only the writer knows its cadence: the API
 * reloads every 5s, the indexer polls every 12s, the canary sweeps every 30s. The checker uses
 * that hint, so nobody has to keep three thresholds in sync by hand.
 *
 * Written with the same write-temp-then-rename discipline as the snapshot: a reader must never
 * see a torn heartbeat and conclude a healthy service is broken.
 */

import { writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where a service's heartbeat lives. One directory for the whole stack (the shared volume). */
export function heartbeatPath(dir, service) {
  return join(dir, `${service}.heartbeat.json`);
}

/**
 * The default heartbeat directory: alongside the snapshot, so the shared volume that already
 * carries indexer state carries the heartbeats too and no new mount is needed.
 * @param {Record<string,string|undefined>} [env]
 */
export function defaultHeartbeatDir(env = {}) {
  return env.HEARTBEAT_DIR || dirname(env.STATE_PATH || './data/indexer-state.json');
}

export async function writeHeartbeatFile(path, rec) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(rec), 'utf8');
  await rename(tmp, path);
}

/** Read one heartbeat. Absent file → null (a service that has never started, not an error). */
export async function readHeartbeatFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A per-service heartbeat writer.
 *
 * `beat()` never rejects: a full disk must not take down the indexer, and the resulting silence
 * is itself the alarm — ops-check sees the stale file either way. Failures go to `onError`.
 *
 * @param {Object} p
 * @param {string} p.dir
 * @param {string} p.service
 * @param {number} p.staleAfterMs      how long this service's own silence is tolerable
 * @param {number} [p.minIntervalMs]   floor between writes (a cold-start catch-up loop can tick fast)
 * @param {() => number} [p.now]
 * @param {number} [p.pid]
 * @param {(path:string, rec:object)=>Promise<void>} [p.write]
 * @param {(err:any)=>void} [p.onError]
 */
export function createHeartbeat({
  dir, service, staleAfterMs, minIntervalMs = 0,
  now = () => Date.now(), pid = process.pid,
  write = writeHeartbeatFile, onError = () => {},
}) {
  const path = heartbeatPath(dir, service);
  let lastAt = -Infinity;

  return {
    path,
    service,
    /** @returns {Promise<boolean>} true iff a file was written this call. */
    async beat(detail = {}, { force = false } = {}) {
      const ts = now();
      if (!force && ts - lastAt < minIntervalMs) return false;
      try {
        await write(path, { service, ts, iso: new Date(ts).toISOString(), pid, staleAfterMs, detail });
        lastAt = ts;
        return true;
      } catch (err) {
        onError(err);
        return false;
      }
    },
  };
}
