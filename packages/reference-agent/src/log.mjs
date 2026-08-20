// @ts-check
/**
 * The session narrative.
 *
 * The agent's output is the product here: an operator reading a run should be able to answer
 * "what did it see, what did it decide, why, and what would it have done" without reading code.
 * So the logger is structured around the loop's three phases and prints every policy check with
 * its inputs — a verdict without its predicate is not auditable.
 *
 * Everything printed passes through `redact()` first (config.mjs). Salts and commitments are shown
 * only through `hexPreview`, which prints the first and last four bytes: enough to correlate two
 * log lines, never enough to reconstruct the value.
 */

import { redact } from './config.mjs';

/** First/last 4 bytes of a 32-byte hex value. Correlatable, not reconstructible. */
export function hexPreview(hex) {
  const s = String(hex ?? '');
  if (!/^0x[0-9a-fA-F]{16,}$/.test(s)) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

const ICONS = { perceive: '👁', decide: '⚖', act: '→', warn: '!', error: '✖', info: '·', ok: '✓' };

/**
 * @param {Object} [p]
 * @param {(line:string)=>void} [p.write]
 * @param {boolean} [p.json]   emit one JSON object per line instead of prose
 * @param {() => number} [p.nowSec]
 */
export function createLogger({ write = (l) => console.log(l), json = false, nowSec = () => Math.floor(Date.now() / 1000) } = {}) {
  /** @type {Array<any>} */
  const records = [];

  function emit(level, phase, msg, detail) {
    const rec = { t: nowSec(), level, phase, msg, ...(detail !== undefined ? { detail: redact(detail) } : {}) };
    records.push(rec);
    if (json) {
      write(JSON.stringify(rec));
      return rec;
    }
    const icon = ICONS[level] ?? ICONS[phase] ?? ICONS.info;
    write(`${icon} ${msg}`);
    return rec;
  }

  return {
    records: () => records,
    banner(lines) {
      if (json) return;
      const width = Math.max(...lines.map((l) => l.length), 40);
      write('┌' + '─'.repeat(width + 2) + '┐');
      for (const l of lines) write('│ ' + l.padEnd(width) + ' │');
      write('└' + '─'.repeat(width + 2) + '┘');
    },
    section(title) {
      if (json) {
        records.push({ t: nowSec(), level: 'info', phase: 'section', msg: title });
        write(JSON.stringify({ t: nowSec(), level: 'info', phase: 'section', msg: title }));
        return;
      }
      write('');
      write(`── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
    },
    perceive: (msg, detail) => emit('info', 'perceive', msg, detail),
    decide: (msg, detail) => emit('info', 'decide', msg, detail),
    act: (msg, detail) => emit('info', 'act', msg, detail),
    info: (msg, detail) => emit('info', 'info', msg, detail),
    ok: (msg, detail) => emit('ok', 'info', msg, detail),
    warn: (msg, detail) => emit('warn', 'warn', msg, detail),
    error: (msg, detail) => emit('error', 'error', msg, detail),

    /** Print a policy decision's full check list — the "why", not just the "what". */
    checks(title, list) {
      if (json) {
        const rec = { t: nowSec(), level: 'info', phase: 'decide', msg: title, checks: redact(list) };
        records.push(rec);
        write(JSON.stringify(rec));
        return;
      }
      write(`  ${title}`);
      for (const c of list) write(`    ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
    },
  };
}
