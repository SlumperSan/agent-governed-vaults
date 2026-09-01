// @ts-check
/**
 * How old the data is, and what the app is allowed to do with it at that age.
 *
 * A financial UI that silently shows stale data is a defect, so staleness is a first-class value
 * here rather than a footnote: every figure this app renders is a projection of chain state at
 * some block, and the distance from "now" is the user's only handle on how much to trust it.
 *
 * Two independent signals, both free (unmetered) on the API:
 *   /health   → lastBlock, the block the projection has folded up to
 *   /metrics  → vault_indexer_snapshot_age_seconds, seconds since the indexer last wrote
 *
 * The tiers below are display policy, not protocol: Base produces a block roughly every 2s, so a
 * projection minutes behind can already be wrong about a proposal phase or a freeze.
 */

/** Seconds. Deliberately tight — this is money, and the read is cheap. */
export const TIERS = [
  { key: 'live', maxAgeSec: 30, tone: 'good', label: 'Live' },
  { key: 'lagging', maxAgeSec: 300, tone: 'warn', label: 'Lagging' },
  { key: 'stale', maxAgeSec: 1800, tone: 'critical', label: 'Stale' },
  { key: 'unusable', maxAgeSec: Infinity, tone: 'critical', label: 'Too old to act on' },
];

/**
 * @param {number|null|undefined} ageSec
 * @returns {{key:string, tone:string, label:string, ageSec:number|null, actionable:boolean, note:string}}
 */
export function classify(ageSec) {
  // `Number(null)` is 0 and `Number('')` is 0, both of which would classify a MISSING age as the
  // freshest possible reading. Reject the non-numeric types before coercing.
  const age = typeof ageSec === 'number' || (typeof ageSec === 'string' && ageSec.trim() !== '')
    ? Number(ageSec)
    : NaN;
  if (!Number.isFinite(age) || age < 0) {
    return {
      key: 'unknown',
      tone: 'critical',
      label: 'Age unknown',
      ageSec: null,
      actionable: false,
      // Unknown age is treated as the worst case, not the best. An indexer that cannot say how
      // old it is has told you something.
      note: 'The indexer did not report a snapshot age. Treat every figure here as unverified.',
    };
  }
  const tier = TIERS.find((t) => age <= t.maxAgeSec) ?? TIERS[TIERS.length - 1];
  return {
    key: tier.key,
    tone: tier.tone,
    label: tier.label,
    ageSec: age,
    actionable: tier.key === 'live' || tier.key === 'lagging',
    note:
      tier.key === 'live'
        ? 'Indexed within the last half-minute.'
        : tier.key === 'lagging'
          ? 'The indexer is behind the chain. A freeze or a new proposal may not be reflected here yet.'
          : 'This projection is far enough behind that a vault’s state may have changed materially. Re-read before acting.',
  };
}

/**
 * Pull `vault_indexer_snapshot_age_seconds` out of the free Prometheus-text /metrics body.
 * Returns null rather than 0 when absent — see classify's treatment of unknown.
 * @param {string} text
 */
export function parseSnapshotAge(text) {
  const m = String(text ?? '').match(/^vault_indexer_snapshot_age_seconds\s+([0-9.eE+-]+)\s*$/m);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Same, for `vault_indexer_last_block`. */
export function parseLastBlock(text) {
  const m = String(text ?? '').match(/^vault_indexer_last_block\s+([0-9.eE+-]+)\s*$/m);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * The four states every network-backed surface in this app must be able to render. Having them
 * as a named union stops a screen from quietly having only two of them.
 * @typedef {{kind:'loading'}|{kind:'empty', message:string}|{kind:'error', message:string,
 *            detail?:string, retryable:boolean}|{kind:'ready', data:any, freshness:object}} Fetched
 */

/** @returns {Fetched} */
export const loading = () => ({ kind: 'loading' });
/** @returns {Fetched} */
export const empty = (message) => ({ kind: 'empty', message });
/** @returns {Fetched} */
export const failed = (message, detail, retryable = true) => ({ kind: 'error', message, detail, retryable });
/** @returns {Fetched} */
export const ready = (data, freshness) => ({ kind: 'ready', data, freshness });

/**
 * Turn a thrown error into a message that says what the user can do about it. The x402 cases are
 * specific because a 402 reaching a browsing user at all is a product bug (the app is meant to
 * absorb metered reads), and it should read as one rather than as "your funds are inaccessible".
 * @param {any} err
 */
export function describeError(err) {
  const status = err?.status;
  const msg = String(err?.message ?? err ?? 'unknown error');
  if (status === 402) {
    return failed(
      'This read is metered and was not paid for.',
      'Vault data is served over x402. Nothing about your position is affected — this is a data-access problem, not a protocol one.',
      true,
    );
  }
  if (status === 429) return failed('Rate limited by the API.', 'Too many reads from this address. Wait a moment and retry.', true);
  if (status === 404) return failed('Not found in the indexer.', 'The vault may exist on-chain but not yet be indexed.', false);
  if (status >= 500) return failed('The read API failed.', msg, true);
  if (/fetch|network|Failed to fetch|ECONNREFUSED/i.test(msg)) {
    return failed('Could not reach the read API.', 'No data is shown rather than old data. Your position on-chain is unaffected.', true);
  }
  return failed('Could not load this data.', msg, true);
}
