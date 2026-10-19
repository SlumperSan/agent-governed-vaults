// @ts-check
import { SETTLE_SECONDS } from './constants.mjs';
import { epochBounds } from './epoch.mjs';
import { reduce } from './ledger.mjs';
import { assertHeadState, assertSameChainView } from './consistency.mjs';
import { buildTeamSet } from './team.mjs';
import { buildBoard } from './board.mjs';

/**
 * One epoch, end to end, over injected readers. Per chain: pin the chain, take the confirmed head,
 * page the vault logs, fold them, run the head-state check (throws, writes nothing), and look up the
 * code hash of every address that holds a position. Then form the board.
 *
 * @param {object} p
 * @param {Array<{
 *   chainId:number, name:string,
 *   vaults: Array<{address:string, fromBlock:number}>,
 *   deployers: string[],
 *   reader: ReturnType<typeof import('./source.mjs').createChainReader>,
 *   crossReader?: ReturnType<typeof import('./source.mjs').createChainReader> | null
 * }>} p.chains
 * @param {number} p.anchor          unix seconds the epochs are counted from (first agent vault's deploy block)
 * @param {number} p.epochNumber
 * @param {number} p.nowSec          wall clock as an input, so a run is replayable
 * @param {{addresses: Array<{address:string}>}} p.seededDoc
 * @param {string} p.seededSha256
 * @param {string} p.codeCommit
 */
export async function runEpoch({ chains, anchor, epochNumber, nowSec, seededDoc, seededSha256, codeCommit }) {
  if (chains.length === 0) throw new Error('run: no chains configured');
  for (const c of chains) if (c.vaults.length === 0) throw new Error(`run: chain ${c.name} has no vaults configured`);
  const { start, end } = epochBounds(anchor, epochNumber);
  const closed = nowSec >= end + SETTLE_SECONDS;

  const creators = [];
  const deployers = [];
  for (const c of chains) {
    await c.reader.assertBoundToDeclaredChain();
    if (c.crossReader) await c.crossReader.assertBoundToDeclaredChain();
    deployers.push(...c.deployers);
    for (const v of c.vaults) creators.push(await c.reader.creatorOf(v.address));
  }
  const team = buildTeamSet({ seededDoc, creators, deployers });

  const diagnostics = [];
  const perChain = [];
  for (const c of chains) {
    const head = await c.reader.confirmedHead();
    const events = await c.reader.vaultEvents(c.vaults, head.number);

    let toBlock = head;
    let windowEnd;
    if (closed) {
      if (head.timestamp < end) throw new Error(`run: epoch ${epochNumber} is closed by the clock but ${c.name}'s confirmed head (${head.timestamp}) is before its end (${end}); the endpoint is behind`);
      toBlock = await c.reader.lastBlockBefore(end, head.number);
      windowEnd = end;
    } else {
      windowEnd = Math.max(start, Math.min(end, head.timestamp));
    }

    const { usdcSeconds, positions } = reduce(events, { windowStart: start, windowEnd });
    const vaultAddresses = c.vaults.map((v) => v.address.toLowerCase());
    const check = await assertHeadState({
      vaults: vaultAddresses, positions, readPosition: c.reader.readPosition, readTotalShares: c.reader.readTotalShares, blockNumber: head.number,
    });
    // A second endpoint, when one is given, must agree on the head block hash and each vault's totalShares.
    if (c.crossReader) await assertSameChainView({ primary: c.reader, secondary: c.crossReader, vaults: vaultAddresses, blockNumber: head.number });

    const codeHashes = new Map();
    for (const addr of [...usdcSeconds.keys()].sort()) codeHashes.set(addr, await c.reader.codeHash(addr));

    diagnostics.push({ chain: c.name, headBlock: head.number, eventsRead: events.length, positionsChecked: check.checked, vaultsChecked: check.vaultsChecked, secondEndpointChecked: Boolean(c.crossReader) });
    perChain.push({
      chainId: c.chainId,
      name: c.name,
      vaults: c.vaults.map((v) => v.address),
      fromBlock: Math.min(...c.vaults.map((v) => v.fromBlock)),
      toBlock: toBlock.number,
      toBlockHash: toBlock.hash,
      integratedUntil: windowEnd,
      usdcSeconds,
      codeHashes,
    });
  }

  const board = buildBoard({
    epoch: { number: epochNumber, start, end, status: closed ? 'closed' : 'provisional' },
    codeCommit,
    seededAddressesSha256: seededSha256,
    team,
    chains: perChain,
  });
  return { board, diagnostics };
}
