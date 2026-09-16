/* ===========================================================================
   Live reads for app.rwally.com, straight from the browser to Robinhood Chain.

   WHY THIS FILE EXISTS AS A FILE. The page ships script-src 'self' with no
   'unsafe-inline', so an inline <script> would be blocked by the browser with
   no visible error. Every line of behaviour on this page is here.

   THE VAULT LIST IS DISCOVERED, NOT SHIPPED. `VaultFactory` declares
   `address[] public allVaults`, which Solidity gives a public getter
   `allVaults(uint256)`, so a browser can read `vaultCount()` and then index
   straight into the array. An earlier draft of this page shipped the two
   addresses as static markup and said the factory exposed no enumeration
   function. That was wrong, and it was wrong in the way worth naming: it came
   from reading a checkout that was behind origin rather than the contract. The
   table now cannot disagree with the chain, because the chain is where it comes
   from, and the deployment ledger is no longer in the path at all.

   WHAT IT DOES. One eth_blockNumber and one vaultCount(), then one allVaults(i)
   per vault, then five calls per vault. Every figure lands in the page.

   REQUEST SHAPE IS LOAD-BEARING. The RPC's CORS preflight allows exactly one
   request header, content-type. Adding any other header, or any credential,
   turns a working read into a browser-side failure that never reaches the
   network tab as a useful message. Do not add headers here.

   NO PERFORMANCE FIGURE IS COMPUTED ANYWHERE IN THIS FILE, and that is a rule
   rather than an omission. Share price is navWad over totalShares, a ratio of
   two current reads. Turning it into a return would need an entry price this
   page cannot read and a time series the chain does not serve to a browser, so
   the page states the ratio and stops.
   =========================================================================== */

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';
const EXPLORER = 'https://robinhoodchain.blockscout.com/address/';

/* Selectors, computed with viem's toFunctionSelector and pinned here so this
   file carries no dependency and no keccak implementation of its own. */
const SEL = {
  vaultCount: '0xa7c6a100', // vaultCount()
  allVaults: '0x9094a91e', // allVaults(uint256)
  creator: '0x02d05d3f', // creator()
  capacityCapUsdc: '0xb857d9b9', // capacityCapUsdc()
  totalShares: '0x3a98ef39', // totalShares()
  holderCount: '0x1aab9a9f', // holderCount()
  navWad: '0xd09074c0', // navWad()
};

const TIMEOUT_MS = 12000;

/* USDG is six decimals on this chain; navWad and totalShares are WAD, which is
   18. Both are named here rather than inlined so the difference is impossible
   to misread at a call site. */
const USDG_DECIMALS = 6n;
const WAD = 10n ** 18n;

/* A cap of 100 bounds the enumeration loop. It is not a claim about how many
   vaults exist: it stops a factory that returned a nonsense count from making
   this page issue unbounded requests, and the page says so when it bites. */
const MAX_ENUMERATE = 100;

/** One JSON-RPC round trip, with a timeout so a hung endpoint fails visibly. */
async function rpc(method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/** A 32-byte return word as a BigInt. */
const word = (hex) => BigInt(hex.slice(0, 66));

/** The last 20 bytes of a 32-byte return word, as an address. */
const wordToAddress = (hex) => '0x' + hex.slice(26, 66);

/** A uint256 argument, ABI encoded: one 32-byte big-endian word. */
const encodeUint = (n) => BigInt(n).toString(16).padStart(64, '0');

/** Shorten an address for a column without hiding either end. */
const shorten = (a) => a.slice(0, 10) + '…' + a.slice(-8);

const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * A fixed-point integer as a decimal string with `places` decimals kept. Done
 * on BigInt throughout: navWad on a funded vault exceeds the safe integer range
 * once it is scaled, and a Number conversion would lose the tail silently
 * rather than throw.
 */
function fixed(value, decimals, places) {
  const scale = 10n ** decimals;
  const fracStr = (value % scale).toString().padStart(Number(decimals), '0').slice(0, places);
  const grouped = group((value / scale).toString());
  return places > 0 ? grouped + '.' + fracStr : grouped;
}

function setSlot(root, name, text, state) {
  const slot = root && root.querySelector('[data-slot="' + name + '"]');
  if (!slot) return;
  slot.textContent = text;
  slot.classList.remove('reading', 'is-bad');
  if (state) slot.classList.add(state);
}

function setStamp(text, state) {
  const stamp = document.getElementById('reads-stamp');
  if (stamp) {
    stamp.textContent = text;
    stamp.classList.remove('is-bad');
    if (state) stamp.classList.add(state);
  }
  const dot = document.getElementById('chain-dot');
  if (dot) {
    dot.classList.remove('is-ok', 'is-bad');
    dot.classList.add(state === 'is-bad' ? 'is-bad' : 'is-ok');
  }
}

/** Local wall clock, so a reader can tell how fresh the read is. */
function stampNow() {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  return 'Read from chain just now, ' + now.toTimeString().slice(0, 8) + ' ' + zone + '.';
}

/** Build one row from a template clone, so the markup lives in the document. */
function newRow(address) {
  const tpl = document.getElementById('vault-row');
  const row = tpl.content.firstElementChild.cloneNode(true);
  const link = row.querySelector('[data-slot="address"]');
  link.textContent = shorten(address);
  link.setAttribute('href', EXPLORER + address);
  return row;
}

/** Every figure for one vault. Five calls, issued together. */
async function readVault(row, address) {
  const [creatorW, capW, sharesW, holdersW, navW] = await Promise.all([
    ethCall(address, SEL.creator),
    ethCall(address, SEL.capacityCapUsdc),
    ethCall(address, SEL.totalShares),
    ethCall(address, SEL.holderCount),
    ethCall(address, SEL.navWad),
  ]);

  const cap = word(capW);
  const shares = word(sharesW);
  const nav = word(navW);

  setSlot(row, 'creator', shorten(wordToAddress(creatorW)));
  setSlot(row, 'holders', word(holdersW).toString());
  setSlot(row, 'nav', fixed(nav, 18n, 2));
  setSlot(row, 'price', shares === 0n ? 'no shares' : fixed((nav * WAD) / shares, 18n, 4));

  /* CAPACITY IS IN USDG UNITS AND NAV IS IN WAD, so the comparison scales nav
     down rather than cap up. A cap of zero means uncapped, which the contract
     documents, and an uncapped vault has no percentage to show. */
  const navUsdg = nav / 10n ** (18n - USDG_DECIMALS);
  if (cap === 0n) {
    setSlot(row, 'pct', 'uncapped');
  } else {
    /* PRECISION FOLLOWS MAGNITUDE, and the smallest bucket says "under" rather
       than rounding to zero. A vault holding 20 USDG against a 50,000 cap is at
       0.04%; a fixed one decimal prints that as 0.0%, which a reader cannot
       tell from an empty vault, and enough decimals to print any figure exactly
       would be noise on a full one. */
    const millionths = (navUsdg * 1000000n) / cap;
    const pct = Number(millionths) / 10000;
    if (millionths === 0n && nav > 0n) setSlot(row, 'pct', 'under 0.0001%');
    else setSlot(row, 'pct', pct.toFixed(pct > 0 && pct < 1 ? 3 : 1) + '%');
    const bar = row.querySelector('[data-slot="bar"]');
    if (bar) bar.style.setProperty('--fill', Math.min(pct, 100).toFixed(4) + '%');
  }

  return { nav, holders: word(holdersW) };
}

async function run() {
  const body = document.getElementById('vault-rows');
  const empty = document.getElementById('vault-empty');

  try {
    const [countW, blockHex] = await Promise.all([
      ethCall(FACTORY, SEL.vaultCount),
      rpc('eth_blockNumber', []),
    ]);

    const count = word(countW);
    setSlot(document.getElementById('stat-count'), 'value', count.toString());
    setSlot(document.getElementById('stat-block'), 'value', group(BigInt(blockHex).toString()));

    const wanted = count > BigInt(MAX_ENUMERATE) ? BigInt(MAX_ENUMERATE) : count;
    const addresses = await Promise.all(
      Array.from({ length: Number(wanted) }, (_, i) =>
        ethCall(FACTORY, SEL.allVaults + encodeUint(i)).then(wordToAddress),
      ),
    );

    if (empty) empty.hidden = addresses.length > 0;

    const rows = addresses.map((address) => {
      const row = newRow(address);
      body.appendChild(row);
      return { row, address };
    });

    const results = await Promise.all(rows.map(({ row, address }) => readVault(row, address)));

    const tvl = results.reduce((sum, r) => sum + r.nav, 0n);
    const positions = results.reduce((sum, r) => sum + r.holders, 0n);
    setSlot(document.getElementById('stat-tvl'), 'value', fixed(tvl, 18n, 2));
    setSlot(document.getElementById('stat-holders'), 'value', positions.toString());

    if (count > BigInt(MAX_ENUMERATE)) {
      setStamp(
        stampNow() +
          ' The factory reports ' +
          count.toString() +
          ' vaults and this page reads the first ' +
          MAX_ENUMERATE +
          '. The rest are on the chain and not on this page.',
        'is-bad',
      );
    } else {
      setStamp(stampNow());
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    for (const id of ['stat-tvl', 'stat-count', 'stat-holders', 'stat-block']) {
      setSlot(document.getElementById(id), 'value', 'read failed', 'is-bad');
    }
    /* A FAILED READ LEAVES NO TABLE, so the failure has to be said where the
       table would have been. An empty tbody and a vault-less protocol look the
       same to a reader, and one of them is a lie. */
    if (empty) {
      empty.hidden = false;
      empty.textContent = 'The vault list could not be read, so this table is empty for that reason and not because the protocol has no vaults.';
      empty.classList.add('is-bad');
    }
    setStamp('Could not read the chain: ' + message, 'is-bad');
  }
}

run();
