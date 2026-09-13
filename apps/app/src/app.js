/* ===========================================================================
   Live reads, straight from the browser to chain 4663.

   WHY THIS FILE EXISTS AS A FILE. The page ships script-src 'self' with no
   'unsafe-inline', so an inline <script> would be blocked by the browser with
   no visible error. Every line of behaviour on this page is here.

   WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT DO. It sends four eth_call
   requests and one eth_blockNumber to the public RPC, and it writes the answers
   into the LIVE READS panel. It renders NOTHING ELSE on the page. The vault
   table's empty state is static markup, because that sentence has to be true
   whether or not this file runs: a claim produced by a fetch is a claim that
   disappears when the fetch fails, and the honest version of a failed read is
   an error, not a blank.

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

run();
