// @ts-check
/**
 * The one logger for the runtime stack (indexer, API, canary).
 *
 * Two rendering modes over the SAME record, so nothing is lost by choosing one:
 *   json    — one JSON object per line: {ts, level, service, event, ...fields}. The production
 *             mode. Every line is greppable and machine-parseable without a log shipper.
 *   pretty  — a human line for a terminal. Auto-selected when stdout is a TTY, so `npm run
 *             start:indexer` in a shell stays readable and the same command under Docker (no TTY)
 *             emits JSON. Override either way with LOG_FORMAT=json|pretty.
 *
 * No dependency, by design: this repo's only runtime dependency is viem and it stays that way.
 * `warn`/`error` go to stderr and everything else to stdout, so `2>` gives a pure problem feed —
 * the same split the canary's console sink already relies on.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON.stringify replacer: bigints as decimal strings (state is full of them), Errors as objects. */
function replacer(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

/** One JSON line. Never throws — a log call must not be the thing that kills a service. */
export function formatJson(rec) {
  try {
    return JSON.stringify(rec, replacer);
  } catch (err) {
    return JSON.stringify({ ts: rec?.ts, level: rec?.level, service: rec?.service, event: rec?.event, logError: String(err?.message ?? err) });
  }
}

function scalar(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return formatJson(v);
  const s = String(v);
  return /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

/** `12:03:22.123 INFO  indexer batch.indexed  from=1 to=99 events=3` */
export function formatPretty(rec) {
  const { ts, level, service, event, ...fields } = rec;
  const kv = Object.entries(fields).map(([k, v]) => `${k}=${scalar(v)}`).join(' ');
  return `${String(ts).slice(11, 23)} ${String(level).toUpperCase().padEnd(5)} ${String(service).padEnd(7)} ${event}${kv ? `  ${kv}` : ''}`;
}

/**
 * Resolve format + level from env. Pure, so the TTY probe stays at the edge.
 * @param {Record<string,string|undefined>} [env]
 * @param {{isTTY?:boolean}} [io]
 */
export function resolveLogOptions(env = {}, { isTTY = false } = {}) {
  const fmt = String(env.LOG_FORMAT ?? '').toLowerCase();
  const lvl = String(env.LOG_LEVEL ?? '').toLowerCase();
  if (fmt && fmt !== 'json' && fmt !== 'pretty') throw new Error(`oplog: LOG_FORMAT must be 'json' or 'pretty', got '${fmt}'`);
  if (lvl && !(lvl in LEVELS)) throw new Error(`oplog: LOG_LEVEL must be one of ${Object.keys(LEVELS).join('|')}, got '${lvl}'`);
  return { pretty: fmt ? fmt === 'pretty' : Boolean(isTTY), level: lvl || 'info' };
}

/**
 * @param {Object} [p]
 * @param {string} [p.service]   the emitting process: 'indexer' | 'api' | 'canary'
 * @param {string} [p.level]     minimum level to emit
 * @param {boolean} [p.pretty]   human mode instead of JSON lines
 * @param {Record<string,any>} [p.base]  fields merged into every record (see `child`)
 * @param {(line:string)=>void} [p.write]       stdout sink
 * @param {(line:string)=>void} [p.errorWrite]  stderr sink (warn + error)
 * @param {() => Date} [p.now]
 */
export function createLogger({
  service = 'app', level = 'info', pretty = false, base = {},
  write = (l) => process.stdout.write(`${l}\n`),
  errorWrite = (l) => process.stderr.write(`${l}\n`),
  now = () => new Date(),
} = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lv, event, fields) {
    if (LEVELS[lv] < threshold) return null;
    const rec = { ts: now().toISOString(), level: lv, service, event, ...base, ...(fields || {}) };
    (LEVELS[lv] >= LEVELS.warn ? errorWrite : write)(pretty ? formatPretty(rec) : formatJson(rec));
    return rec;
  }

  const api = {
    get level() { return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold); },
    get service() { return service; },
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /** A logger carrying extra fields on every line (e.g. a vault, a request id). */
    child: (extra) => createLogger({ service, level: api.level, pretty, base: { ...base, ...extra }, write, errorWrite, now }),
    /** Adapter for the pre-existing `log(msg)` string callbacks (daemon, canary sinks). */
    text: (event, lv = 'info') => (msg) => emit(lv, event, { msg: String(msg) }),
  };
  return api;
}

/** The stack's standard logger: env-configured, TTY-aware. */
export function loggerFromEnv(service, env = process.env, opts = {}) {
  const { isTTY = Boolean(process.stdout.isTTY), ...rest } = opts;
  const { pretty, level } = resolveLogOptions(env, { isTTY });
  return createLogger({ service, pretty, level, ...rest });
}
