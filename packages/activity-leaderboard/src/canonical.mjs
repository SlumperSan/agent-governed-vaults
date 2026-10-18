// @ts-check
import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted, no whitespace, BigInt rendered as a decimal string, numbers
 * only if they are safe integers. Anything else (undefined, NaN, floats, functions) throws, because a
 * value that cannot be written one way only cannot be hashed one way only.
 * @param {unknown} v
 * @returns {string}
 */
export function canonicalJson(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return JSON.stringify(v.toString(10));
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error(`canonicalJson: ${v} is not a safe integer`);
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const o = /** @type {Record<string, unknown>} */ (v);
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot encode a ${typeof v}`);
  }
}

/** @param {string | Uint8Array} data */
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
