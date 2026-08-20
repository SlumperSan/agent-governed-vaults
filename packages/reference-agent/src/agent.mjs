// @ts-check
/**
 * The agent loop: perceive → decide → act, composed from the pure pieces.
 *
 * This module holds no protocol knowledge of its own — it wires perception, policy and action
 * together and owns the two things that must be true across a whole session:
 *
 *  - the **startup declaration**, printed before anything happens, saying exactly what this
 *    process will and will not sign. "Dry-run signs nothing" is ambiguous (the agent does sign
 *    x402 payment authorizations, because that is how a metered read is paid for), so the run
 *    states its signing scope in the artifact itself rather than leaving it to a doc.
 *  - the **entry marks**: NAV/share at the moment the agent first observes itself holding a vault,
 *    which is the baseline the drawdown policy measures against. Held in memory and re-seeded
 *    each session; a restarted agent starts measuring from the restart, which is stated as a known
 *    limitation rather than papered over.
 */

import { createBudget } from './budget.mjs';
import { createApiClient, perceive } from './perceive.mjs';
import { plan, partitionDue } from './plan.mjs';
import { createActor } from './act.mjs';
import { fromBaseUnits, gateMode, redact } from './config.mjs';

/**
 * @param {Object} p
 * @param {any} p.config
 * @param {{address:string, signMessage:Function}|null} [p.account]  on-chain signer (execute mode)
 * @param {{address:string}|null} [p.payer]      x402 payment signer (may be the same account)
 * @param {any} p.chainReader
 * @param {any} p.log
 * @param {Record<string,string|undefined>} [p.env]
 * @param {typeof fetch} [p.fetchImpl]
 * @param {{writeContract:Function}|null} [p.walletClient]
 * @param {Record<string,bigint>|Map<string,bigint>} [p.entryMarks]  pre-seeded drawdown baselines
 * @param {() => number} [p.nowSec]
 */
export function createAgent({
  config,
  account = null,
  payer = null,
  chainReader,
  log,
  env = {},
  fetchImpl = fetch,
  walletClient = null,
  entryMarks: seedMarks = {},
  nowSec = () => Math.floor(Date.now() / 1000),
}) {
  // The gate throws rather than downgrading — see config.gateMode.
  const gated = gateMode({ mode: config.mode, account, env });

  const budget = createBudget({
    maxSessionSpendUsdc: config.api.payments.maxSessionSpendUsdc,
    maxSingleReadUsdc: config.api.payments.maxSingleReadUsdc,
    enabled: config.api.payments.enabled && payer != null,
  });

  const client = createApiClient({ config, payer, budget, fetchImpl });
  const actor = createActor({ mode: gated.mode, config, account, chainReader, log, walletClient });

  /**
   * vault ⇒ NAV/share when the agent first saw itself holding it.
   *
   * KNOWN LIMITATION: this is in-memory and session-scoped. A restarted agent re-marks at the
   * restart price, so a drawdown that happened before the restart is invisible to it. The reveal
   * obligation is deliberately NOT handled this way (it is recovered from chain state) because
   * losing that one forfeits a vote; losing an entry mark only makes the exit policy less
   * sensitive, which fails in the conservative direction. Callers with durable history can seed
   * marks in via `entryMarks`.
   */
  const entryMarks = seedMarks instanceof Map ? new Map(seedMarks) : new Map(Object.entries(seedMarks).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  const member = account?.address ?? null;

  function declareScope() {
    const cap = `$${fromBaseUnits(budget.cap)}`;
    log.banner([
      `x402-vaults reference agent — MODE: ${gated.mode.toUpperCase()}`,
      '',
      gated.mode === 'dry-run'
        ? 'WILL NOT sign or send any on-chain transaction.'
        : 'WILL sign and send on-chain transactions that move real funds.',
      budget.enabled
        ? `WILL sign x402 payment authorizations for metered reads, up to ${cap} this session.`
        : 'WILL NOT sign any x402 payment (no payer configured) — free routes only.',
      // Deliberately does NOT claim "this process holds no key": the agent takes an account
      // OBJECT and never sees key material, but whoever constructed that object may hold one in
      // the same process. Overclaiming here would be the kind of reassuring lie this codebase
      // refuses elsewhere (see the S-1 "emergency withdraw" prohibition in CONSUMER-UX-SPEC).
      account
        ? `Identity: ${account.address} (account object injected by the operator; no key material is read, stored, or logged by the agent).`
        : 'No account injected — read-only observation.',
      `skipWindow (irreversible): ${config.danger?.allowSkipWindow === true ? 'ENABLED BY CONFIG' : 'disabled'}.`,
    ]);
  }

  /** Record the drawdown baseline the first time we see ourselves holding a vault. */
  function seedEntryMarks(world) {
    for (const o of world.vaults) {
      const shares = o.chain?.self?.shares;
      if (shares == null || BigInt(shares) === 0n) continue;
      if (entryMarks.has(o.chain.vault)) continue;
      if (o.chain.navPerShareWad == null) continue;
      entryMarks.set(o.chain.vault, BigInt(o.chain.navPerShareWad));
      log.info(`entry mark for ${o.chain.vault.slice(0, 10)}… set to NAV/share ${o.chain.navPerShareWad} (this session's drawdown baseline)`);
    }
  }

  /** One full perceive → decide → act pass. */
  async function tick() {
    const t = nowSec();

    log.section('PERCEIVE');
    const world = await perceive({ client, chainReader, budget, config, member, log, nowSec: t });
    if (world.gaps.length) log.warn(`perception gaps: ${world.gaps.join('; ')}`);
    seedEntryMarks(world);

    log.section('DECIDE');
    const { intents, decisions } = plan({ world, config, entryMarks, log });
    const { due, deferred } = partitionDue(intents, t);
    for (const d of deferred)
      log.info(`scheduled: ${d.kind} on ${d.vault.slice(0, 10)}… due at ${d.dueAtSec} (in ${d.dueAtSec - t}s) — ${d.reason}`);
    if (!intents.length) log.info('no action warranted this tick');

    log.section('ACT');
    const results = [];
    for (const intent of due) results.push(await actor.run(intent));
    if (!due.length) log.info('nothing due this tick');

    const spend = budget.summary();
    log.section('SESSION');
    log.info(
      `x402: ${spend.paidReads} paid read(s), $${spend.spentUsdc} of $${spend.capUsdc} spent, $${spend.remainingUsdc} left` +
        (spend.enabled ? '' : ' (payments disabled)'),
    );
    log.info(`mode: ${gated.mode} — ${results.filter((r) => r.sent).length} transaction(s) sent, ${results.filter((r) => r.dryRun).length} described but not sent`);

    return { world, decisions, intents, due, deferred, results, budget: spend, mode: gated.mode };
  }

  /**
   * Run forever on the configured interval. `maxTicks` bounds it for tests and demo runs.
   * @param {{maxTicks?:number, sleep?:(ms:number)=>Promise<void>}} [opts]
   */
  async function loop({ maxTicks = Infinity, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    declareScope();
    const ticks = [];
    for (let i = 0; i < maxTicks; i++) {
      try {
        ticks.push(await tick());
      } catch (err) {
        // A tick must never kill the session: the next one re-perceives from scratch, and an
        // outstanding reveal obligation is rediscovered from chain state rather than lost.
        log.error(`tick failed — ${String(err?.message ?? err)}`);
        ticks.push({ error: String(err?.message ?? err) });
      }
      if (i + 1 < maxTicks) await sleep(Number(config.policy.timing.tickIntervalSec) * 1000);
    }
    return ticks;
  }

  return {
    mode: gated.mode,
    tick,
    loop,
    declareScope,
    budget,
    entryMarks,
    /** Log-safe config dump — proves the account never reaches the record. */
    describe: () => redact({ config, account, payer }),
  };
}
