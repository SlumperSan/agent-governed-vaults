// @ts-check
/**
 * ops-check — watch the watchers.
 *
 * Reads every service's heartbeat file and exits NONZERO listing any service whose heartbeat is
 * missing, stale, unreadable, or dated in the future (a clock problem is also an ops problem).
 * Exit 0 and one line per service otherwise.
 *
 * Two jobs, one script:
 *   cron           `*./5 * * * *  node packages/oplog/src/ops-check.mjs || mail -s 'vault stack' …`
 *   compose        each service healthchecks ITSELF: `ops-check.mjs indexer`
 *
 * Restricting the compose healthcheck to one service is deliberate. A whole-stack check inside the
 * indexer container would mark the indexer unhealthy because the CANARY died, and Docker would
 * restart the wrong process. The cron form, which checks all three, is where cross-service
 * coverage belongs.
 *
 * `staleAfterMs` comes from each heartbeat file — the writer knows its own cadence. `--max-age-ms`
 * overrides it for every service when you want one blunt threshold.
 *
 * Uses Node built-ins only: no curl, no wget (node:24-slim ships neither).
 *
 * Run: `node packages/oplog/src/ops-check.mjs [--dir=/data] [--max-age-ms=N] [service…]`
 */

import { fileURLToPath } from 'node:url';
import { heartbeatPath, readHeartbeatFile, defaultHeartbeatDir } from './heartbeat.mjs';

export const DEFAULT_SERVICES = ['indexer', 'api', 'canary'];
export const DEFAULT_MAX_AGE_MS = 120_000;
/** Tolerance for a heartbeat stamped in the future before we call it a clock problem. */
const FUTURE_SLACK_MS = 60_000;

/**
 * Classify one service from its heartbeat record. Pure — the whole decision is here.
 * @param {string} service
 * @param {any} rec  parsed heartbeat, or null when the file is absent
 * @param {{nowMs:number, defaultMaxAgeMs?:number, maxAgeMs?:number|null}} opts
 */
export function evaluateHeartbeat(service, rec, { nowMs, defaultMaxAgeMs = DEFAULT_MAX_AGE_MS, maxAgeMs = null }) {
  const row = { service, ok: false, state: 'missing', ageMs: null, limitMs: null, detail: '' };
  if (rec == null) return { ...row, detail: 'no heartbeat file — service has never started, or the directory is wrong' };

  // `Number(null)` is 0, which would read as a heartbeat from 1970 — i.e. merely "stale".
  // A heartbeat we cannot date is UNREADABLE: a different fault with a different fix.
  const ts = rec.ts == null ? NaN : Number(rec.ts);
  if (!Number.isFinite(ts)) return { ...row, state: 'unreadable', detail: `heartbeat has no usable ts (got ${JSON.stringify(rec.ts)})` };

  // Precedence: explicit override → the writer's own hint → the blunt default.
  const hinted = Number(rec.staleAfterMs);
  const limitMs = maxAgeMs != null ? maxAgeMs : (Number.isFinite(hinted) && hinted > 0 ? hinted : defaultMaxAgeMs);
  const ageMs = nowMs - ts;

  if (ageMs < -FUTURE_SLACK_MS)
    return { ...row, state: 'future', ageMs, limitMs, detail: `heartbeat is ${Math.round(-ageMs / 1000)}s in the FUTURE — check clock skew between the checker and ${service}` };
  if (ageMs > limitMs)
    return { ...row, state: 'stale', ageMs, limitMs, detail: `last beat ${Math.round(ageMs / 1000)}s ago, limit ${Math.round(limitMs / 1000)}s — ${service} is down or wedged` };

  return { service, ok: true, state: 'fresh', ageMs, limitMs, detail: describe(rec) };
}

function describe(rec) {
  const d = rec.detail && typeof rec.detail === 'object' ? rec.detail : {};
  const kv = Object.entries(d).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return `pid=${rec.pid ?? '?'}${kv ? ` ${kv}` : ''}`;
}

/**
 * Check a set of services. `read` is injected so tests need no filesystem.
 * @param {{dir:string, services?:string[], nowMs?:number, defaultMaxAgeMs?:number, maxAgeMs?:number|null, read?:(p:string)=>Promise<any>}} p
 */
export async function checkServices({ dir, services = DEFAULT_SERVICES, nowMs = Date.now(), defaultMaxAgeMs = DEFAULT_MAX_AGE_MS, maxAgeMs = null, read = readHeartbeatFile }) {
  const rows = [];
  for (const service of services) {
    try {
      rows.push(evaluateHeartbeat(service, await read(heartbeatPath(dir, service)), { nowMs, defaultMaxAgeMs, maxAgeMs }));
    } catch (err) {
      // A corrupt or unreadable file is a failure, not a crash: the other services still get checked.
      rows.push({ service, ok: false, state: 'unreadable', ageMs: null, limitMs: null, detail: String(err?.message ?? err) });
    }
  }
  return { ok: rows.every((r) => r.ok), rows, dir, nowMs };
}

/** Render a report. Failures first — the reason you ran this is at the top. */
export function formatReport(report) {
  const line = (r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.service.padEnd(8)} ${r.state.padEnd(10)} ${r.ageMs == null ? 'age=-' : `age=${Math.round(r.ageMs / 1000)}s`}  ${r.detail}`;
  const bad = report.rows.filter((r) => !r.ok);
  const good = report.rows.filter((r) => r.ok);
  const head = report.ok
    ? `ops-check: ${good.length}/${report.rows.length} healthy (heartbeats in ${report.dir})`
    : `ops-check: ${bad.length} of ${report.rows.length} service(s) UNHEALTHY: ${bad.map((r) => `${r.service}(${r.state})`).join(', ')}`;
  return [head, ...bad.map(line), ...good.map(line)].join('\n');
}

/**
 * Parse argv/env into check options. Pure.
 * @param {string[]} argv  args AFTER the script path
 * @param {Record<string,string|undefined>} [env]
 */
export function parseArgs(argv, env = {}) {
  let dir = env.HEARTBEAT_DIR || defaultHeartbeatDir(env);
  let maxAgeMs = env.HEARTBEAT_MAX_AGE_MS ? Number(env.HEARTBEAT_MAX_AGE_MS) : null;
  const services = [];
  for (const a of argv) {
    if (a.startsWith('--dir=')) dir = a.slice(6);
    else if (a.startsWith('--max-age-ms=')) maxAgeMs = Number(a.slice(13));
    else if (a === '--help' || a === '-h') return { help: true, dir, maxAgeMs, services: DEFAULT_SERVICES };
    else if (a.startsWith('-')) throw new Error(`ops-check: unknown flag ${a}`);
    else services.push(a);
  }
  if (maxAgeMs != null && !Number.isFinite(maxAgeMs)) throw new Error('ops-check: max-age-ms must be a number');
  const listed = services.length ? services : (env.OPS_CHECK_SERVICES ? env.OPS_CHECK_SERVICES.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SERVICES);
  return { help: false, dir, maxAgeMs, services: listed };
}

const USAGE = `ops-check — exit nonzero if any service heartbeat is stale.

  node packages/oplog/src/ops-check.mjs [--dir=<heartbeat dir>] [--max-age-ms=<n>] [service...]

  --dir           default: HEARTBEAT_DIR, else dirname(STATE_PATH), else ./data
  --max-age-ms    override every service's own staleAfterMs hint
  service...      default: indexer api canary (or OPS_CHECK_SERVICES)`;

// -- entrypoint --
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2), process.env);
    if (opts.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const report = await checkServices({ dir: opts.dir, services: opts.services, maxAgeMs: opts.maxAgeMs });
    (report.ok ? console.log : console.error)(formatReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`ops-check: ${err?.message ?? err}`);
    process.exit(2);
  }
}
