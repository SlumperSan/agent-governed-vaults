// @ts-check
/**
 * Per-IP token bucket for the FREE routes.
 *
 * WHY ONLY THE FREE ROUTES: the paid routes are self-limiting — **x402 IS the rate limiter**.
 * Every metered read costs the caller real USDC through a facilitator settlement, so flooding
 * `/vaults` is not a denial-of-service, it is a purchase. The only requests an attacker gets for
 * nothing are the free ones, and those are what this bounds. (An unpaid request to a metered route
 * returns 402 without a facilitator call, a state read or a disk touch — building the challenge is
 * a JSON.stringify — so it is not a lever worth pulling either.)
 *
 * A token bucket rather than a fixed window because bursts are the normal shape of legitimate
 * traffic here: an agent bootstrapping reads `/.well-known/x402` then `/health`, and a monitoring
 * system scrapes `/metrics` on a tick. `capacity` is the burst it may take at once; `refillPerSec`
 * is the sustained rate it settles into.
 *
 * Memory is bounded: an unbounded per-IP map IS the denial-of-service. See `prune`.
 */

/**
 * @param {Object} [p]
 * @param {number} [p.capacity]       burst size, in requests
 * @param {number} [p.refillPerSec]   sustained requests per second
 * @param {number} [p.maxKeys]        hard cap on tracked IPs
 * @param {() => number} [p.now]
 */
export function createRateLimiter({ capacity = 60, refillPerSec = 1, maxKeys = 10_000, now = () => Date.now() } = {}) {
  if (!(capacity > 0)) throw new Error('ratelimit: capacity must be > 0');
  if (!(refillPerSec > 0)) throw new Error('ratelimit: refillPerSec must be > 0');
  /** @type {Map<string, {tokens:number, at:number}>} key → bucket. Insertion order doubles as LRU. */
  const buckets = new Map();
  let evicted = 0;

  const levelAt = (b, t) => Math.min(capacity, b.tokens + (Math.max(0, t - b.at) / 1000) * refillPerSec);

  /**
   * Keep the table bounded.
   *
   * A bucket that has fully refilled carries NO information — it is indistinguishable from an IP
   * we have never seen — so those go first and dropping them changes no decision. Only if the
   * table is still over the cap (every tracked IP is actively throttled) do we drop the
   * least-recently-used, which does hand that IP a fresh burst. That is the deliberate trade:
   * remembering an attacker perfectly is not worth letting them choose our heap size.
   */
  function prune(t) {
    if (buckets.size <= maxKeys) return;
    for (const [k, b] of buckets) {
      if (levelAt(b, t) >= capacity) buckets.delete(k);
    }
    while (buckets.size > maxKeys) {
      const lru = buckets.keys().next().value;
      buckets.delete(lru);
      evicted += 1;
    }
  }

  return {
    get size() { return buckets.size; },
    get evictions() { return evicted; },
    /**
     * Spend one token for `key`.
     * @returns {{allowed:boolean, limit:number, remaining:number, retryAfterSec:number}}
     */
    take(key, cost = 1) {
      const t = now();
      const existing = buckets.get(key);
      const b = existing ?? { tokens: capacity, at: t };
      if (existing) buckets.delete(key);   // re-insert below so Map order stays LRU-ordered
      b.tokens = levelAt(b, t);
      b.at = t;

      const allowed = b.tokens >= cost;
      if (allowed) b.tokens -= cost;
      buckets.set(key, b);
      prune(t);

      return {
        allowed,
        limit: capacity,
        remaining: Math.max(0, Math.floor(b.tokens)),
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((cost - b.tokens) / refillPerSec)),
      };
    },
    reset() { buckets.clear(); },
  };
}

/**
 * The key to bucket by.
 *
 * `x-forwarded-for` is CLIENT-SPOOFABLE: anyone can send it, so trusting it by default would let a
 * single attacker mint a fresh bucket per request and defeat the limiter entirely. It is honoured
 * only when the operator sets TRUST_PROXY, which is a promise that a reverse proxy in front of
 * this process overwrites the header. Without a proxy, `remoteAddress` is the truth; behind one,
 * it is the proxy for every request and every client would share one bucket — hence the knob.
 *
 * @param {{socket?:{remoteAddress?:string}, headers?:Record<string,any>}} req
 * @param {{trustProxy?:boolean}} [opts]
 */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const xff = req?.headers?.['x-forwarded-for'];
    if (xff) {
      const first = String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return req?.socket?.remoteAddress || 'unknown';
}
