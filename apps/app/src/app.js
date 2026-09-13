/* ===========================================================================
   Live reads, straight from the browser to chain 4663.

   WHY THIS FILE EXISTS AS A FILE. The page ships script-src 'self' with no
   'unsafe-inline', so an inline <script> would be blocked by the browser with
   no visible error. Every line of behaviour on this page is here.

   WHAT IT DOES. Two independent passes, and a failure in one must not blank the
   other.

   Pass 1, the LIVE READS panel: four eth_call requests and one eth_blockNumber.
   index.html's "Four eth_call requests and one eth_blockNumber" sentence cites
   THIS COMMENT as its authority, so if you change the calls there, change that
   sentence too.

   Pass 2, the VAULT ROWS: vaultCount(), then allVaults(i) for each index, then
   five reads per vault (navWad, totalShares, idleUsdc, holderCount,
   capacityCapUsdc). That is 1 + n + 5n eth_calls, so the cost grows with the
   vault count and this is the thing to change first if the table ever gets
   long: a multicall, or an indexer, rather than a read per cell.

   WHAT IT STILL DELIBERATELY DOES NOT DO. It invents nothing. A failed row read
   leaves the tbody empty and names the failure, because the honest version of a
   failed read is an error, not a blank and not a zero. The fallback block under
   the table is static markup for the same reason: it is what a reader sees when
   this file does not run at all.

   REQUEST SHAPE IS LOAD-BEARING. The RPC's CORS preflight allows exactly one
   request header, content-type. Adding any other header, or any credential,
   turns a working read into a browser-side failure that never reaches the
   network tab as a useful message. Do not add headers here.
   =========================================================================== */

const RPC = 'https://rpc.mainnet.chain.robinhood.com';

const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
const ORACLE = '0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB';

// Selectors, computed with viem's toFunctionSelector and pinned here so this
// file carries no dependency and no keccak implementation of its own.
const SEL_VAULT_COUNT = '0xa7c6a100'; // vaultCount()
const SEL_ALLOW_SUB = '0x1979d1fd'; // allowSubVaults()
const SEL_USDC = '0x3e413bee'; // usdc()
const SEL_SYMBOL = '0x95d89b41'; // symbol()

// Vault-row selectors, same provenance as the four above: computed with
// `cast sig` and pinned, so this file carries no keccak implementation.
const SEL_ALL_VAULTS = '0x9094a91e'; // allVaults(uint256)
const SEL_NAV_WAD = '0xd09074c0'; // navWad()
const SEL_TOTAL_SHARES = '0x3a98ef39'; // totalShares()
const SEL_IDLE_USDC = '0x047b7fc7'; // idleUsdc()
const SEL_HOLDER_COUNT = '0x1aab9a9f'; // holderCount()
const SEL_CAPACITY_CAP = '0xb857d9b9'; // capacityCapUsdc()

const EXPLORER = 'https://robinhoodchain.blockscout.com/address/';

/** A uint256 argument, ABI-encoded as one 32-byte word. */
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

const TIMEOUT_MS = 12000;

/** One JSON-RPC round trip, with a timeout so a hung endpoint fails visibly. */
async function rpc(method, params) {
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
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    if (typeof body.result !== 'string') throw new Error('no result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/** A 32-byte return word as a decimal string. */
const wordToNumber = (hex) => BigInt(hex.slice(0, 66)).toString(10);

/** The low byte of a 32-byte return word, read as a Solidity bool. */
const wordToBool = (hex) => (BigInt(hex.slice(0, 66)) === 0n ? 'false' : 'true');

/** The last 20 bytes of a 32-byte return word, as a checksum-free address. */
const wordToAddress = (hex) => '0x' + hex.slice(26, 66);

/**
 * A dynamic string return, ABI decoded: offset word, length word, then bytes.
 * Kept deliberately small; this decodes symbol() and nothing else.
 */
function decodeString(hex) {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const offset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  const length = Number(BigInt('0x' + body.slice(offset, offset + 64)));
  const bytes = body.slice(offset + 64, offset + 64 + length * 2);
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

/** Shorten an address for a value column without hiding its ends. */
const shorten = (a) => a.slice(0, 10) + '…' + a.slice(-8);

function setValue(id, text, state) {
  const slot = document.querySelector('#' + id + ' [data-slot="value"]');
  if (!slot) return;
  slot.textContent = text;
  slot.classList.remove('is-ok', 'is-bad');
  if (state) slot.classList.add(state);
}

function setStamp(text, state) {
  const stamp = document.getElementById('reads-stamp');
  if (!stamp) return;
  stamp.textContent = text;
  stamp.classList.remove('is-ok', 'is-bad');
  if (state) stamp.classList.add(state);
}

/** Local wall clock, formatted so the reader can tell how fresh the read is. */
function stampNow() {
  const now = new Date();
  const hhmmss = now.toTimeString().slice(0, 8);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  return 'Read from chain just now, ' + hhmmss + ' ' + zone;
}

/**
 * Format a fixed-point integer as a decimal string, without floating point.
 *
 * Number() on a uint256 loses precision above 2^53, and every figure here is
 * wad or 6-decimal USDG, so the arithmetic stays in BigInt and only the
 * formatting is string work.
 */
function fixed(value, decimals, places) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, places);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places > 0 ? grouped + '.' + fracStr : grouped;
}

/** One vault's row data, or null if any of its reads failed. */
async function readVault(address) {
  const [navWad, totalShares, idle, holders, cap] = await Promise.all([
    ethCall(address, SEL_NAV_WAD),
    ethCall(address, SEL_TOTAL_SHARES),
    ethCall(address, SEL_IDLE_USDC),
    ethCall(address, SEL_HOLDER_COUNT),
    ethCall(address, SEL_CAPACITY_CAP),
  ]);
  return {
    address,
    navWad: BigInt(navWad.slice(0, 66)),
    totalShares: BigInt(totalShares.slice(0, 66)),
    idleUsdc: BigInt(idle.slice(0, 66)),
    holders: BigInt(holders.slice(0, 66)),
    cap: BigInt(cap.slice(0, 66)),
  };
}

function renderVaultRows(vaults) {
  const body = document.getElementById('vault-rows');
  if (!body) return;
  for (const v of vaults) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'addr';
    link.href = EXPLORER + v.address;
    link.rel = 'noopener';
    link.textContent = shorten(v.address);
    name.appendChild(link);
    tr.appendChild(name);

    // NAV per share is navWad / totalShares, both 18-dp. A vault with no
    // shares has no NAV per share -- it is 0/0, not 0 -- so it prints as
    // absent rather than as a number nobody can act on.
    const navPerShare = v.totalShares === 0n
      ? null
      : (v.navWad * 10n ** 18n) / v.totalShares;

    for (const text of [
      fixed(v.navWad, 18, 2),
      navPerShare === null ? 'no shares' : fixed(navPerShare, 18, 6),
      v.holders.toString(),
      fixed(v.cap, 6, 0),
    ]) {
      const td = document.createElement('td');
      td.className = 'col-num';
      td.textContent = text;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }

  // Only once a row actually exists does the fallback stop being the truth.
  if (vaults.length > 0) {
    const empty = document.getElementById('vault-empty');
    if (empty) empty.hidden = true;
  }
}

async function loadVaults() {
  const fail = document.getElementById('vault-rows-fail');
  try {
    const count = Number(BigInt(await ethCall(FACTORY, SEL_VAULT_COUNT)));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('vaultCount out of range');
    if (count === 0) return; // nothing to render; the fallback block is already correct

    const addresses = await Promise.all(
      Array.from({ length: count }, (_, i) => ethCall(FACTORY, SEL_ALL_VAULTS + word(i))),
    );
    const vaults = await Promise.all(addresses.map((w) => readVault(wordToAddress(w))));
    renderVaultRows(vaults);
    if (fail) fail.hidden = true;
  } catch {
    // Deliberately silent about the cause here: the panel above already reports
    // RPC errors in full, and a second copy of the same message reads as two
    // failures. What matters is that no row is invented.
    if (fail) fail.hidden = false;
  }
}

async function run() {
  setStamp('Reading from the public RPC.');
  for (const id of ['read-vaultcount', 'read-allowsub', 'read-usdc']) setValue(id, 'reading');

  try {
    const [countWord, allowWord, usdcWord, blockHex] = await Promise.all([
      ethCall(FACTORY, SEL_VAULT_COUNT),
      ethCall(FACTORY, SEL_ALLOW_SUB),
      ethCall(ORACLE, SEL_USDC),
      rpc('eth_blockNumber', []),
    ]);

    const count = wordToNumber(countWord);
    setValue('read-vaultcount', count, 'is-ok');
    setValue('read-allowsub', wordToBool(allowWord), 'is-ok');

    const token = wordToAddress(usdcWord);
    let symbol = 'symbol() did not answer';
    let symbolState = 'is-bad';
    try {
      symbol = '"' + decodeString(await ethCall(token, SEL_SYMBOL)) + '"';
      symbolState = 'is-ok';
    } catch {
      // The address read succeeded; only the token's own symbol() did not.
      // Say which half failed rather than discarding both.
    }
    setValue('read-usdc', shorten(token) + ' → ' + symbol, symbolState);

    const block = BigInt(blockHex).toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    setStamp(stampNow() + ', at block ' + block, 'is-ok');

    const fail = document.getElementById('reads-fail');
    if (fail) fail.hidden = true;
  } catch (err) {
    for (const id of ['read-vaultcount', 'read-allowsub', 'read-usdc']) {
      setValue(id, 'not read', 'is-bad');
    }
    setStamp('The read failed: ' + (err && err.message ? err.message : 'unknown error'), 'is-bad');
    const fail = document.getElementById('reads-fail');
    if (fail) fail.hidden = false;
  }
}

// The two passes are started separately and neither is awaited by the other:
// a dead RPC should not let the panel's failure suppress the table's, nor the
// reverse, and a slow vault read should not delay the block stamp.
run();
loadVaults();
