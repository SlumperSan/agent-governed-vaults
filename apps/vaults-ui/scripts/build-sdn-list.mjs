#!/usr/bin/env node
// @ts-check
/**
 * Vendors the EVM-format addresses out of OFAC's Specially Designated Nationals (SDN) list into
 * `src/lib/sdn-addresses.ts`, for card 213 (SDN-address check at wallet connect).
 *
 * RUN BY HAND, NOT BY CI OR THE GATE. This makes one outbound network call to a U.S. Treasury
 * government feed and nothing in `npm run gate` may depend on network access — see the gate's own
 * `--quick`/advisory-step philosophy. Re-run this whenever the vendored list needs refreshing
 * (`sanctions.ts`'s `assertSdnListFresh` fails the gate once `fetchedAt` is older than
 * `SDN_LIST_MAX_AGE_DAYS`, which is the signal to do that):
 *
 *     node apps/vaults-ui/scripts/build-sdn-list.mjs
 *
 * SOURCE. `https://www.treasury.gov/ofac/downloads/sdn.xml` is OFAC's own published redirect (302)
 * to the current SDN.XML export on its sanctions-list-service host — it is the same URL OFAC's own
 * "SDN List" download page links to, and it always resolves to the LATEST publication, so this
 * script never has to track a dated or paginated URL. Confirmed live 2026-09-23: it redirects to
 * `sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML`, which itself
 * redirects to a signed, short-lived S3 URL — both hops are followed automatically by `fetch`.
 * This is public U.S. government data (31 CFR Chapter V); OFAC publishes it for exactly this kind
 * of compliance screening and states no license fee or registration requirement for using it.
 *
 * WHY EVERY "Digital Currency Address" TYPE, FILTERED BY ADDRESS SHAPE — NOT A FIXED WHITELIST OF
 * OFAC'S OWN TYPE LABELS. The SDN list tags each digital-currency identifier with the chain OFAC
 * happened to observe the address on (`Digital Currency Address - ETH`, `- USDC`, `- BSC`, `- BNB`,
 * `- ARB`, `- ETC`, ...), but a 20-byte hex address in that exact `0x` + 40-hex-character shape is
 * valid on every EVM chain, regardless of which one OFAC's label names — this app connects to a
 * single target chain (`src/lib/chains.ts`), and a member's wallet address does not change when the
 * chain does. Filtering by ADDRESS FORMAT rather than by a hand-maintained list of OFAC type labels
 * means a new EVM-chain label OFAC adds later (there is no fixed set) is picked up automatically
 * the next time this script runs, rather than silently excluded until someone notices and edits a
 * whitelist here.
 *
 * NOT XBT/TRX/LTC/XMR/BCH/DASH/ZEC/SOL/DOGE/XRP/BTG/BSV/XVG addresses: those are not `0x`-hex EVM
 * addresses (Bitcoin, Tron, Litecoin, Monero, ... use their own address formats) and a connected
 * EVM wallet in this app can never present one, so screening against them would be dead weight,
 * not defense in depth.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml';
const OUT_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'lib', 'sdn-addresses.ts');

/** ISO 3166-1-style plain hex EVM address, exactly the shape `chain-actions.ts`'s `Address` (viem) is. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A handful of XML entities are all this file ever needs decoded — no CDATA, no external entities. */
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function main() {
  const res = await fetch(SDN_URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`build-sdn-list: fetching ${SDN_URL} returned HTTP ${res.status} — OFAC's feed may be down or the URL may have moved.`);
  }
  const xml = await res.text();

  const publishDateMatch = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(xml);
  const recordCountMatch = /<Record_Count>([^<]+)<\/Record_Count>/.exec(xml);
  if (!publishDateMatch || !recordCountMatch) {
    throw new Error('build-sdn-list: could not find <Publish_Date>/<Record_Count> in the fetched XML — the feed\'s shape may have changed; do not trust a silently empty parse.');
  }

  const idBlocks = xml.match(/<id>[\s\S]*?<\/id>/g) ?? [];
  if (idBlocks.length === 0) {
    throw new Error('build-sdn-list: parsed zero <id> blocks out of a 200 response — the feed shape likely changed; refusing to write an empty/wrong list.');
  }

  const byType = new Map();
  const addresses = new Set();
  for (const block of idBlocks) {
    const typeMatch = /<idType>([^<]*)<\/idType>/.exec(block);
    const numberMatch = /<idNumber>([^<]*)<\/idNumber>/.exec(block);
    if (!typeMatch || !numberMatch) continue;
    const idType = decodeXmlEntities(typeMatch[1]).trim();
    if (!idType.startsWith('Digital Currency Address')) continue;
    byType.set(idType, (byType.get(idType) ?? 0) + 1);
    const idNumber = decodeXmlEntities(numberMatch[1]).trim();
    if (EVM_ADDRESS_RE.test(idNumber)) addresses.add(idNumber.toLowerCase());
  }

  if (addresses.size === 0) {
    throw new Error('build-sdn-list: found "Digital Currency Address" entries but zero matched the 0x-EVM shape — the feed shape likely changed; refusing to write an empty list.');
  }

  const sortedAddresses = [...addresses].sort();
  const fetchedAt = new Date().toISOString();

  const out = `// AUTO-GENERATED by scripts/build-sdn-list.mjs — do not hand-edit. Re-run the script to refresh.
// @ts-check

/**
 * The EVM-format (0x + 40 hex chars) addresses carried by OFAC's Specially Designated Nationals
 * (SDN) list under any "Digital Currency Address" identifier type, vendored at build time rather
 * than fetched at runtime — no network call, no third-party lookup, nothing about a connecting
 * wallet leaves the browser. See scripts/build-sdn-list.mjs's header for the source, the fetch
 * path, and why every EVM-shaped address is included regardless of which chain OFAC's own label
 * names.
 *
 * FRESHNESS. \`sanctions.ts\`'s \`assertSdnListFresh\` fails once \`fetchedAt\` is more than
 * \`SDN_LIST_MAX_AGE_DAYS\` old, so a stale, silently-rotting list cannot pass the gate unnoticed —
 * the remedy is re-running the build script above, not editing the constant.
 */
export const SDN_ADDRESS_DATA = {
  sourceUrl: ${JSON.stringify(SDN_URL)},
  sourceUrlNote: 'OFAC\\'s own published redirect to the current SDN.XML export; resolves to the latest publication, never a dated snapshot.',
  fetchedAt: ${JSON.stringify(fetchedAt)},
  sdnPublishDate: ${JSON.stringify(publishDateMatch[1].trim())},
  sdnRecordCount: ${JSON.stringify(recordCountMatch[1].trim())},
  digitalCurrencyIdTypesSeen: ${JSON.stringify(Object.fromEntries(byType), null, 2).split('\n').join('\n  ')},
  addresses: ${JSON.stringify(sortedAddresses, null, 2).split('\n').join('\n  ')},
} as const;
`;

  writeFileSync(OUT_PATH, out);
  console.log(`build-sdn-list: wrote ${addresses.size} unique EVM addresses (SDN publish date ${publishDateMatch[1].trim()}, ${recordCountMatch[1].trim()} total SDN records) to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
