/**
 * Live reads, straight from the reader's browser to Robinhood Chain, id 4663.
 *
 * WHY THIS EXISTS AT ALL. Every other number on this site is a claim: written
 * here, checked by a guard, believed by the reader. These five are not. They are
 * fetched by the reader's own browser from the chain's public JSON-RPC endpoint
 * while the page is open, which means a reader who doubts them can open the
 * network panel and watch the request go out. That is the difference between
 * "the factory has created no vault" as a sentence and as an observation, and it
 * is the whole reason the section exists.
 *
 * THIS FILE IS A PORT, NOT AN INVENTION. `apps/app/src/app.js` has been doing
 * exactly this against the same endpoint since 2026-09-05 and the request shape
 * there is load-bearing and hard-won. The rules it records are reproduced here
 * because they are the same rules:
 *
 *   THE ENDPOINT'S CORS PREFLIGHT ALLOWS EXACTLY ONE REQUEST HEADER,
 *   content-type. Adding any other header, or any credential, turns a working
 *   read into a browser-side failure that never reaches the network panel as a
 *   useful message. Do not add headers here.
 *
 *   NO DEPENDENCY AND NO KECCAK. The four-byte selectors below are pinned
 *   literals, computed once with viem's `toFunctionSelector` and written down,
 *   so this file carries no ABI encoder and no hash implementation. Everything
 *   read here is a zero-argument function returning fixed-width words, which is
 *   the only reason that is affordable.
 *
 * THE CONTENT SECURITY POLICY HAS TO KNOW. `public/_headers` names exactly one
 * origin under `connect-src`, and it is `RPC` below. If this constant ever
 * changes, that file changes in the same commit or every read fails silently
 * with a console refusal and no visible error on the page.
 *
 * WHAT IS DELIBERATELY NOT HERE. There is no write path, no wallet, no signer
 * and no `eth_sendTransaction`. This module can read and can do nothing else.
 * There is also no polling loop for the prices: a Chainlink feed that last
 * printed on Friday does not print again because the page asked twice. Only the
 * block number re-reads, because only the block number moves.
 */

/** The chain's public JSON-RPC endpoint. Mirrored in `public/_headers`. */
export const RPC = 'https://rpc.mainnet.chain.robinhood.com';

/** Robinhood Chain mainnet. Stated on the page, and asserted against this read. */
export const CHAIN_ID = 4663;

/**
 * The addresses, as `contracts/config/deployments/robinhood-mainnet.json`
 * records them, read back on-chain rather than transcribed from a deploy log.
 *
 * Only two of the seven singletons appear on this page. The factory is the one
 * address a reader can verify every other from, and USDG is the settlement
 * token a depositor would actually hold. Publishing all seven here would be the
 * status page again, and the status page is retired.
 */
export const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/**
 * RWLY, and it is NOT one of the seven and NOT in the deployment record.
 *
 * The two constants above are singletons from `contracts/config/deployments/
 * robinhood-mainnet.json`. This one is not in that file and cannot be: it is a
 * token launched through a third-party launchpad on 2026-09-05T21:51:57Z,
 * thirteen hours after that record was written and certified byte-for-byte
 * against source commit b1cde122. `git grep -i 2eed8ae7` returns nothing on the
 * default branch, which is the same fact the page states in words.
 *
 * SO IT IS A CHIP AND NOT A LIVE READ, and the distinction is deliberate. The
 * panel below reads the factory's own answers from the chain because those
 * answers move. This address is a constant a reader copies into a block
 * explorer to check the supply, the absence of an owner and the launch
 * transaction for themselves. Nothing on this page calls it.
 *
 * Read back on 2026-09-05 rather than transcribed from a launch log: `name()`
 * returns RWAlly, `symbol()` returns RWLY, `totalSupply()` returns 1e27.
 */
export const RWLY = '0x2eed8ae78AE1aa6824e1C378F46d5C51b6B7FDF9';

/**
 * The two Chainlink feed proxies this page reads, both on chain 4663, both
 * eight decimals.
 *
 * THEY ARE HERE AS A PAIR ON PURPOSE, AND THE PAIR IS THE POINT. ETH/USD is a
 * crypto feed: it prints on deviation, many times a day, every day. RHSPY/USD
 * is an equity feed: the underlying market closes, and the feed goes quiet with
 * it. Reading both and stamping each with its OWN `updatedAt` shows the reader
 * the difference rather than describing it, and it makes it impossible for this
 * page to imply that a Saturday reading of an equity feed is a Saturday price.
 *
 * The description strings are read from the feeds themselves rather than
 * written down, because the on-chain description and the Chainlink directory
 * name disagree for nine of the thirty-five equity feeds on this chain: the
 * directory says "Robinhood SPY / USD" and the contract says "RHSPY / USD".
 * Keying on the proxy address and rendering whatever the contract calls itself
 * is the only version of this that cannot drift.
 */
export const ETH_FEED = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
export const SPY_FEED = '0x319724394D3A0e3669269846abE664Cd621f9f6A';

/** Four-byte selectors, pinned rather than hashed. See the header note. */
const SEL_VAULT_COUNT = '0xa7c6a100'; // vaultCount()
const SEL_ALLOW_SUB = '0x1979d1fd'; // allowSubVaults()
const SEL_LATEST_ROUND_DATA = '0xfeaf968c'; // latestRoundData()
const SEL_DESCRIPTION = '0x7284e416'; // description()

/** A hung endpoint has to fail visibly rather than leave the panel reading. */
const TIMEOUT_MS = 12000;

/** One JSON-RPC round trip. The header set is exactly one entry; see above. */
async function rpc(method: string, params: unknown[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
    if (body.error) throw new Error(body.error.message || 'RPC error');
    if (typeof body.result !== 'string') throw new Error('no result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

const ethCall = (to: string, data: string) => rpc('eth_call', [{ to, data }, 'latest']);

/** The n-th 32-byte word of a return buffer, as a BigInt. */
const wordAt = (hex: string, n: number): bigint =>
  BigInt('0x' + hex.slice(2).slice(n * 64, (n + 1) * 64));

/**
 * A dynamic `string` return, ABI decoded: offset word, length word, then bytes.
 *
 * Deliberately small, and deliberately not a general decoder. It handles
 * `description()` and nothing else. Feed descriptions on this chain are ASCII
 * ("ETH / USD", "RHSPY / USD"), so a byte is a character; if that ever stops
 * being true this returns mojibake rather than throwing, which is the right
 * failure for a label.
 */
function decodeString(hex: string): string {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const offset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  const length = Number(BigInt('0x' + body.slice(offset, offset + 64)));
  const bytes = body.slice(offset + 64, offset + 64 + length * 2);
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * One feed's latest round, decoded.
 *
 * `answer` IS SIGNED. `latestRoundData` returns `int256`, and reading it as
 * unsigned turns a negative price into a number near 2^256. No feed this page
 * reads has ever printed one, and that is not a reason to decode it wrongly:
 * the two's-complement fold below costs one comparison and removes the class of
 * bug entirely.
 *
 * `updatedAt` is the feed's own timestamp, in seconds. It is the single most
 * important value in this module and the reason `price` and `updatedAt` are
 * returned together and rendered together: a price without its timestamp is a
 * claim about now, and for an equity feed on a Saturday that claim is false.
 */
export type Feed = {
  readonly description: string;
  readonly price: number;
  readonly updatedAt: number;
};

const FEED_DECIMALS = 8;

async function readFeed(address: string): Promise<Feed> {
  const [roundHex, descHex] = await Promise.all([
    ethCall(address, SEL_LATEST_ROUND_DATA),
    ethCall(address, SEL_DESCRIPTION),
  ]);
  let answer = wordAt(roundHex, 1);
  if (answer >= 1n << 255n) answer -= 1n << 256n;
  return {
    description: decodeString(descHex),
    price: Number(answer) / 10 ** FEED_DECIMALS,
    updatedAt: Number(wordAt(roundHex, 3)),
  };
}

/**
 * Everything the LIVE section renders, in one shape.
 *
 * `readAt` is when THIS BROWSER made the call, and it is not interchangeable
 * with a feed's `updatedAt`. The section stamps the read with `readAt` and each
 * price with its own feed's `updatedAt`, and the two are never merged into one
 * "as of" line, because merging them is exactly the misstatement this module
 * exists to make impossible.
 */
export type ChainState = {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly vaultCount: number;
  readonly allowSubVaults: boolean;
  readonly eth: Feed;
  readonly spy: Feed;
  readonly readAt: number;
};

/** Every read, in one round of parallel requests. */
export async function readChain(): Promise<ChainState> {
  const [chainIdHex, blockHex, countWord, allowWord, eth, spy] = await Promise.all([
    rpc('eth_chainId', []),
    rpc('eth_blockNumber', []),
    ethCall(FACTORY, SEL_VAULT_COUNT),
    ethCall(FACTORY, SEL_ALLOW_SUB),
    readFeed(ETH_FEED),
    readFeed(SPY_FEED),
  ]);
  return {
    chainId: Number(BigInt(chainIdHex)),
    blockNumber: Number(BigInt(blockHex)),
    vaultCount: Number(wordAt(countWord, 0)),
    allowSubVaults: wordAt(allowWord, 0) !== 0n,
    eth,
    spy,
    readAt: Math.floor(Date.now() / 1000),
  };
}

/** Just the head, for the cheap re-read that keeps the block number moving. */
export async function readBlockNumber(): Promise<number> {
  return Number(BigInt(await rpc('eth_blockNumber', [])));
}

/**
 * Formatting. Kept here beside the decoding so a number is shaped once.
 *
 * `groups` uses a lookahead rather than `toLocaleString` on purpose: the reader's
 * locale decides whether a thousands separator is a comma, a full stop or a thin
 * space, and a block number that renders as 55.447.043 next to a price that
 * renders as $2.471,60 is not a ledger, it is a puzzle. This page states figures
 * the way the deployment record states them.
 */
export const groups = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A price, always two decimals, always grouped. Never a bare float. */
export const usd = (n: number): string =>
  '$' + groups(Math.trunc(n)) + '.' + Math.round((n - Math.trunc(n)) * 100).toString().padStart(2, '0');

/**
 * A feed timestamp, as UTC, to the minute.
 *
 * UTC RATHER THAN THE READER'S ZONE, and the "UTC" is written out rather than
 * left to be inferred. A feed's `updatedAt` is a fact about the chain, the same
 * fact for every reader; rendering it in local time makes two readers disagree
 * about when a print happened. The read stamp is the opposite case and is shown
 * in local time, because "when did MY browser ask" is a fact about the reader.
 */
export const utc = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    p(d.getUTCMonth() + 1) +
    '-' +
    p(d.getUTCDate()) +
    ' ' +
    p(d.getUTCHours()) +
    ':' +
    p(d.getUTCMinutes()) +
    ' UTC'
  );
};

/** An address, shortened without hiding either end. Both ends are checkable. */
export const shorten = (a: string): string => a.slice(0, 10) + '…' + a.slice(-8);
