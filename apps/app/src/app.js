/* ===========================================================================
   Live reads for app.rwally.com, straight from the browser to Robinhood Chain.

   WHY THIS FILE EXISTS AS A FILE. The page ships script-src 'self' with no
   'unsafe-inline', so an inline <script> would be blocked by the browser with
   no visible error. Every line of behaviour on this page is here.

   WHAT IT DOES. One eth_blockNumber, one vaultCount() on the factory, and six
   calls per vault. It writes the answers into slots that already exist in the
   document. It creates no rows and no sections: the table's structure, its
   addresses and every sentence around it are static markup, so a reader whose
   RPC call fails sees a page that still says what it is rather than a blank.

   REQUEST SHAPE IS LOAD-BEARING. The RPC's CORS preflight allows exactly one
   request header, content-type. Adding any other header, or any credential,
   turns a working read into a browser-side failure that never reaches the
   network tab as a useful message. Do not add headers here.

   NO PERFORMANCE FIGURE IS COMPUTED ANYWHERE IN THIS FILE, and that is a rule
   rather than an omission. Share price is navWad divided by totalShares, which
   is a ratio of two current reads. Turning it into a return would need an entry
   price this page cannot read and a time series the chain does not serve to a
   browser, so the page states the ratio and stops.
   =========================================================================== */

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0xc44B853F037b4fF33B831C9a2B341686dEC88Fd1';

/* Selectors, computed with viem's toFunctionSelector and pinned here so this
   file carries no dependency and no keccak implementation of its own. */
const SEL = {
  vaultCount: '0xa7c6a100', // vaultCount()
  creator: '0x02d05d3f', // creator()
  capacityCapUsdc: '0xb857d9b9', // capacityCapUsdc()
  totalShares: '0x3a98ef39', // totalShares()
  holderCount: '0x1aab9a9f', // holderCount()
  navWad: '0xd09074c0', // navWad()
};

const TIMEOUT_MS = 12000;

/* USDG is six decimals on this chain; shares and navWad are WAD, which is 18.
   Both constants are here rather than inline so the difference is impossible to
   misread at a call site. */
const USDG_DECIMALS = 6n;
const WAD = 10n ** 18n;

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

/** Shorten an address for a column without hiding either end. */
const shorten = (a) => a.slice(0, 10) + '…' + a.slice(-8);

/**
 * A fixed-point integer as a decimal string, grouped, with `places` decimals
 * kept. Done on BigInt throughout: navWad on a funded vault exceeds the safe
 * integer range once it is scaled, and a Number conversion would lose the tail
 * silently rather than throw.
 */
function fixed(value, decimals, places) {
  const scale = 10n ** decimals;
  const whole = value / scale;
  const frac = value % scale;
  const fracStr = frac.toString().padStart(Number(decimals), '0').slice(0, places);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places > 0 ? grouped + '.' + fracStr : grouped;
}

function setSlot(root, name, text, state) {
  const slot = root.querySelector('[data-slot="' + name + '"]');
  if (!slot) return;
  slot.textContent = text;
  slot.classList.remove('reading', 'is-bad');
  if (state) slot.classList.add(state);
}

function setStamp(text, state) {
  const stamp = document.getElementById('reads-stamp');
  if (!stamp) return;
  stamp.textContent = text;
  stamp.classList.remove('is-bad');
  if (state) stamp.classList.add(state);
  const dot = document.getElementById('chain-dot');
  if (dot) {
    dot.classList.remove('is-ok', 'is-bad');
    dot.classList.add(state === 'is-bad' ? 'is-bad' : 'is-ok');
  }
}

/** Local wall clock, formatted so a reader can tell how fresh the read is. */
function stampNow() {
  const now = new Date();
  const hhmmss = now.toTimeString().slice(0, 8);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  return 'Read from chain just now, ' + hhmmss + ' ' + zone + '.';
}

/** Every figure for one vault row. Six calls, issued together. */
async function readVault(row) {
  const address = row.getAttribute('data-vault');
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

  /* Share price is navWad / totalShares, both WAD, so the quotient is scaled
     back up by WAD to keep four decimals of it. A vault with no shares has no
     share price rather than a zero one, and says so. */
  setSlot(row, 'price', shares === 0n ? 'no shares' : fixed((nav * WAD) / shares, 18n, 4));

  /* CAPACITY IS IN USDG UNITS AND NAV IS IN WAD, so the comparison scales nav
     down rather than cap up: scaling cap up by 1e12 would be exact too, but it
     invites the next reader to treat a WAD figure as a token figure somewhere
     else in this function. A cap of zero means uncapped, which the contract
     documents, and an uncapped vault has no percentage to show. */
  const navUsdg = nav / 10n ** (18n - USDG_DECIMALS);
  if (cap === 0n) {
    setSlot(row, 'pct', 'uncapped');
  } else {
    /* PRECISION IS CHOSEN BY MAGNITUDE, because a fixed one decimal turns a
       real 0.04% into "0.0%", and a reader cannot tell that apart from an empty
       vault. These vaults hold tens of USDG against a cap of fifty thousand, so
       the honest figure is the small one, not a rounded zero. */
    const pct = Number((navUsdg * 1000000n) / cap) / 10000;
    const places = pct > 0 && pct < 1 ? 3 : 1;
    setSlot(row, 'pct', pct.toFixed(places) + '%');
    const bar = row.querySelector('[data-slot="bar"]');
    if (bar) bar.style.setProperty('--fill', Math.min(pct, 100).toFixed(4) + '%');
  }

  return { nav, holders: word(holdersW) };
}

async function run() {
  const rows = [...document.querySelectorAll('#vault-rows tr[data-vault]')];

  try {
    const [countW, blockHex] = await Promise.all([
      ethCall(FACTORY, SEL.vaultCount),
      rpc('eth_blockNumber', []),
    ]);

    const count = word(countW);
    setSlot(document.getElementById('stat-count'), 'value', count.toString());
    setSlot(
      document.getElementById('stat-block'),
      'value',
      BigInt(blockHex).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    );

    const results = await Promise.all(rows.map((row) => readVault(row)));

    const tvl = results.reduce((sum, r) => sum + r.nav, 0n);
    const holders = results.reduce((sum, r) => sum + r.holders, 0n);
    setSlot(document.getElementById('stat-tvl'), 'value', fixed(tvl, 18n, 2));
    setSlot(document.getElementById('stat-holders'), 'value', holders.toString());

    /* THE COUNT AND THE ROW LIST CAN DISAGREE, and when they do the reader is
       told which one to trust. The factory is the chain; the rows come from the
       deployment ledger, which a human updates. Saying nothing here would let a
       stale ledger read as a complete list. */
    const listed = BigInt(rows.length);
    if (count !== listed) {
      setStamp(
        stampNow() +
          ' The factory reports ' +
          count.toString() +
          ' vaults and this table lists ' +
          listed.toString() +
          '. The factory is the chain and this table is the deployment ledger, so the ledger is behind.',
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
    for (const row of rows) {
      for (const name of ['creator', 'nav', 'price', 'holders', 'pct']) {
        setSlot(row, name, 'failed', 'is-bad');
      }
    }
    /* THE FAILURE IS NAMED, NOT SWALLOWED. A blank column and a zero look the
       same to a reader, and one of them is a lie. */
    setStamp('Could not read the chain: ' + message, 'is-bad');
  }
}

run();
