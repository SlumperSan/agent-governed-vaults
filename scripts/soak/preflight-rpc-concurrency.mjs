#!/usr/bin/env node
// @ts-check
/**
 * RPC CONCURRENCY PREFLIGHT — refuse loudly if the configured RPC endpoint rate-limits under the
 * soak's own concurrent load, rather than degrading silently for 14 hours.
 *
 * Measured: `over rate limit` from `https://sepolia.base.org` on `eth_getLogs`, hitting the
 * indexer (`poll.failed`, stuck at block 47133502) AND the canary, which went `DETECTOR BROKEN`
 * on five signals across two vaults. `run-soak.ps1` starts five things that all poll this RPC —
 * the indexer, the canary, the oracle sampler, and two drill tracks — and that is more than this
 * endpoint sustains at once, even though each of them alone works fine.
 *
 * THIS IS A DIFFERENT FAILURE FROM THE PRUNING ONE `lib.mjs` already guards
 * (`assertLogsServed`) — same symptom shape (an `eth_getLogs` call that should have data comes
 * back wrong), opposite cause and opposite remedy. Pruning: the endpoint silently returns `[]`
 * for old ranges even under NO load — the fix is to stop using that endpoint (see
 * `base-sepolia-rpc.publicnode.com`'s retirement, `lib.mjs`'s own `RPC` comment). Throttling: THIS
 * endpoint serves history correctly in isolation and only degrades once several pollers hit it at
 * once — the fix is reducing concurrency or getting a dedicated endpoint, not switching away from
 * it (switching TO publicnode to escape throttling would run straight into pruning instead).
 * `assertLogsServed`'s single sequential positive-control read cannot see this: it is a
 * concurrency effect, and asking once, politely, proves nothing about five things asking at once.
 *
 * ## The design choice this makes, stated rather than left implicit
 *
 * A preflight that MEASURES rate-limit headroom by hammering the endpoint contributes to the
 * exact problem it is checking. A preflight that measures one sequential request (what this repo
 * already had) proves nothing about concurrent load — that is precisely how this went undetected.
 * This chooses to MEASURE: fire a short concurrent burst — `CONCURRENCY` requests, sized to the
 * number of things run-soak.ps1 itself starts that poll this endpoint (indexer + canary + sampler
 * + 2 drill tracks = 5), not an arbitrary or escalating number — using the REAL failing call shape
 * (`eth_getLogs` over a realistic range, not the cheaper `eth_blockNumber`). Five requests once,
 * at startup, is a bounded, one-time cost that is smaller than the load an actual poll cycle
 * already puts on the endpoint every ~12-30s for 14 hours; it is not "hammering" in the sense the
 * tension warns against. The alternative (refuse purely on endpoint identity + configured process
 * count) was rejected because this launcher's process topology is FIXED — it always starts the
 * same five things — so a static "more than N processes" check would either always fire (useless)
 * or never fire (worthless), regardless of whether the endpoint can actually sustain today's load.
 * A real measurement is the only version of this check that can be wrong in the useful direction.
 *
 * ## What this explicitly does NOT do
 *
 * It does not retry, back off, or change how the indexer/canary/sampler poll — those are runtime
 * behaviors, not preflight behaviors, and are out of scope here. It does not silently pass on a
 * measurement it could not complete (see `reason: 'unmeasurable'` below) — an RPC that is simply
 * unreachable is not evidence it will not also rate-limit once reachable.
 *
 * Run:  node scripts/soak/preflight-rpc-concurrency.mjs
 * Env:  SOAK_RPC (or BASE_SEPOLIA_RPC) — the endpoint to test, same resolution as every other
 *       soak script. SOAK_RPC_CONCURRENCY_CHECK=skip to bypass with an explicit, named, printed
 *       override — never silent — for an operator who has already verified a dedicated endpoint.
 * Exit: 0 clear (or explicitly skipped). 1 refused — rate-limited, or the measurement itself could
 *       not complete.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROOT, RPC, log, cast } from './lib.mjs';
import { deploymentPath, loadDeployment } from './deployment.mjs';

const execFileAsync = promisify(execFile);
const CAST_BIN = process.env.CAST ?? 'cast';

/** The five things run-soak.ps1 itself starts that poll the configured RPC: indexer, canary,
 * sampler, track A, track B. Not "how many processes exist on the box" — how many THIS launcher
 * is about to add. */
export const SOAK_RPC_CONCURRENCY = 5;

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;

/**
 * Fire `concurrency` concurrent `eth_getLogs` calls against `rpc` over the same block range and
 * classify what came back. `run` is injectable so this is testable without a real RPC or `cast`.
 *
 * @param {{rpc: string, address: string, fromBlock: number, toBlock: number, concurrency?: number,
 *   run?: (args: string[]) => Promise<{stdout: string}>}} args
 * @returns {Promise<{concurrency: number, rateLimited: string[], otherFailures: string[],
 *   ok: boolean, reason: 'rate-limited'|'unmeasurable'|null}>}
 */
export async function measureRpcConcurrency({
  rpc, address, fromBlock, toBlock, concurrency = SOAK_RPC_CONCURRENCY, run = defaultRun,
}) {
  const calls = Array.from({ length: concurrency }, () => run([
    'logs', '--rpc-url', rpc,
    '--from-block', String(fromBlock), '--to-block', String(toBlock),
    '--address', address,
  ]));
  const settled = await Promise.allSettled(calls);

  const rateLimited = [];
  const otherFailures = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') continue;
    const msg = String(r.reason?.stderr || r.reason?.message || r.reason).trim();
    if (RATE_LIMIT_RE.test(msg)) rateLimited.push(msg);
    else otherFailures.push(msg);
  }

  const allFailed = concurrency > 0 && rateLimited.length + otherFailures.length === concurrency;
  let reason = null;
  if (rateLimited.length > 0) reason = 'rate-limited';
  else if (allFailed) reason = 'unmeasurable'; // every call failed, but none in a rate-limit shape
  return { concurrency, rateLimited, otherFailures, ok: reason === null, reason };
}

async function defaultRun(args) {
  return execFileAsync(CAST_BIN, args, { windowsHide: true });
}

function main() {
  if (process.env.SOAK_RPC_CONCURRENCY_CHECK === 'skip') {
    log('RPC concurrency preflight SKIPPED — SOAK_RPC_CONCURRENCY_CHECK=skip was set explicitly');
    process.exit(0);
  }

  log(`RPC concurrency preflight: ${SOAK_RPC_CONCURRENCY} concurrent eth_getLogs against ${RPC}`);

  // The deployment's own factory — a real, always-deployed contract on the configured chain, so
  // the call shape is identical to what the indexer's own poller actually sends. No dependency on
  // any particular vault existing or having recent activity: this measures the ENDPOINT's
  // concurrency behavior, not log content. Read from the SAME address book every other soak
  // script does, not a second copy of the address.
  const dep = loadDeployment(deploymentPath(ROOT));
  const head = Number(cast(['block-number', '--rpc-url', RPC]));
  // A realistic recent span, not the whole chain: 2000 blocks matches BATCH_BLOCKS' default, the
  // range size the indexer itself actually requests per poll.
  const fromBlock = Math.max(0, head - 2000);

  measureRpcConcurrency({ rpc: RPC, address: dep.factory, fromBlock, toBlock: head })
    .then((result) => {
      if (result.ok) {
        log(`OK — ${result.concurrency} concurrent eth_getLogs calls all returned cleanly`);
        process.exit(0);
      }
      console.error('\n[soak] RPC CONCURRENCY PREFLIGHT REFUSED\n');
      if (result.reason === 'rate-limited') {
        console.error(`${RPC} rate-limited ${result.rateLimited.length}/${result.concurrency} concurrent `
          + `eth_getLogs calls — this is the SAME symptom the indexer and canary hit mid-soak `
          + `(poll.failed / DETECTOR BROKEN), not a fluke of this one check.`);
        console.error(`\nExample: ${result.rateLimited[0]}\n`);
        console.error('This is NOT the pruning failure (that returns [] with no error, always, '
          + 'load or no load) — this endpoint serves history fine alone and throttles under this '
          + 'launcher\'s own concurrency (indexer + canary + sampler + 2 drill tracks). Switching '
          + 'to a pruning endpoint would trade this failure for a worse, silent one.\n');
        console.error('Remedy: point SOAK_RPC (and RPC_URL in .env) at a dedicated/paid Base '
          + 'Sepolia endpoint, or re-run with SOAK_RPC_CONCURRENCY_CHECK=skip if you have already '
          + 'verified the configured endpoint can sustain this launcher\'s load.\n');
      } else {
        console.error(`could not complete the measurement — every concurrent call failed, but not in a `
          + `rate-limit shape (so this is not necessarily throttling, but an unmeasured RPC is not `
          + `evidence it will hold up either):\n`);
        for (const f of result.otherFailures.slice(0, 3)) console.error(`  ${f}`);
        console.error('\nCheck SOAK_RPC / network connectivity, then re-run.\n');
      }
      process.exit(1);
    })
    .catch((e) => {
      console.error(`\n[soak] RPC CONCURRENCY PREFLIGHT COULD NOT RUN: ${e.message}\n`);
      process.exit(1);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
