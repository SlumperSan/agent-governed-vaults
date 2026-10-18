// @ts-check
/**
 * `docs/AGENT-QUICKSTART.md` IS THE FIRST PAGE AN AGENT READS, AND IT SAID THE WRONG THINGS ABOUT ARC.
 *
 * Until this guard it carried two claims that stopped being true on 2026-09-24, when the Arc mainnet
 * deploy wrote `contracts/config/deployments/arc-mainnet.json`:
 *
 *   1. "the protocol is built for Arc but has no live chain configuration yet". There is a live
 *      chain configuration: chain 5042, a deployment record, a first vault.
 *   2. "WETH via ETH/USD, cbBTC via BTC/USD, USDC pinned". Those were the Base feeds. Arc's basket
 *      has ONE non-stable asset, cirBTC, priced by ONE Chainlink BTC / USD feed, and the sequencer
 *      uptime feed is the zero address because Chainlink publishes none for an L1.
 *
 * An agent that believed (1) would conclude there is nothing to integrate with; one that believed
 * (2) would look for a WETH leg that does not exist. Neither claim was reachable by the other claims
 * guards, because each is a statement about a DEPLOYMENT, not about contract mechanics.
 *
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *   - The retired strings stay retired. Whitespace is collapsed before matching, so a hard wrap
 *     cannot split a retired phrase in half and walk past.
 *   - Every `0x` address the page quotes appears in the deployment record. The page is told to quote
 *     as few as possible and to send the reader to the record instead; the ones it does quote are
 *     pinned here, so they cannot drift from the chain.
 *   - The Arc facts the page now states (chain id, USDC, one basket asset, the heartbeat, the zero
 *     sequencer feed) are each read from the record and the config in this test, not copied into it.
 *
 * It does NOT assert the page has no OTHER false sentence: that is the job of the shape guards
 * (`claims-lede-truth`, `claims-exit-usdc-truth`, `config-doc-truth`). This file owns only the
 * deployment facts on this one page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PAGE_REL = 'docs/AGENT-QUICKSTART.md';
const RECORD_REL = 'contracts/config/deployments/arc-mainnet.json';
const CONFIG_REL = 'contracts/config/arc-mainnet.json';

/**
 * @param {string} rel
 */
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

const record = JSON.parse(read(RECORD_REL));
const config = JSON.parse(read(CONFIG_REL));
const recordText = read(RECORD_REL).toLowerCase();

/** Collapse every run of whitespace, so a line wrap cannot hide a phrase. */
const flat = (/** @type {string} */ s) => s.replace(/\s+/g, ' ');

/**
 * Strings this page must never contain again. Each entry is the reason it is retired.
 * @type {Array<{ re: RegExp, why: string }>}
 */
export const RETIRED = [
  { re: /no live chain configuration/i, why: 'Arc has a live deployment record since 2026-09-24' },
  { re: /\bWETH\b/, why: 'Arc has no WETH leg; cirBTC is the only basket asset' },
  { re: /\bcbBTC\b/, why: 'Arc prices Circle cirBTC, not Coinbase cbBTC' },
  { re: /ETH\s*\/\s*USD/i, why: 'there is no ETH/USD feed in the Arc oracle' },
  { re: /on Base only/i, why: 'the sequencer note is per chain, not a Base-only fact' },
  { re: /arc-mainnet-survey\.json/, why: 'the survey is raw evidence, not the configuration an agent should read' },
  { re: /arc-deploy-runbook/, why: 'the runbook was "what remains before a config exists"; one exists' },
  { re: /robinhood/i, why: 'the Robinhood Chain record left deployments/' },
];

/** @param {string} page */
export function retiredHits(page) {
  const text = flat(page);
  return RETIRED.filter(({ re }) => re.test(text)).map(({ re }) => String(re));
}

/** @param {string} page */
export function quotedAddresses(page) {
  return [...new Set((page.match(/0x[0-9a-fA-F]{40}\b/g) ?? []).map((a) => a.toLowerCase()))];
}

/** @param {string} page */
export function addressesMissingFromRecord(page) {
  return quotedAddresses(page).filter((a) => !recordText.includes(a));
}

const page = read(PAGE_REL);

test('the quickstart no longer carries any retired Arc claim', () => {
  assert.deepEqual(retiredHits(page), [], 'retired string(s) are back in docs/AGENT-QUICKSTART.md');
});

test('every 0x address the quickstart quotes is in the Arc deployment record', () => {
  const quoted = quotedAddresses(page);
  assert.ok(quoted.length >= 1, 'the page quotes no address at all; the USDC address is the one it must state');
  assert.deepEqual(addressesMissingFromRecord(page), [], 'the page quotes an address the deployment record does not contain');
});

test('the Arc facts the quickstart states match the deployment record and the config', () => {
  const text = flat(page);
  const usdc = String(record.infrastructure.usdc);

  assert.equal(record.chainId, 5042);
  assert.equal(config.chainId, 5042);
  assert.match(text, /\bchain id 5042\b/, 'the page does not state Arc chain id 5042');

  assert.equal(String(record.oracle.usdc).toLowerCase(), usdc.toLowerCase(), 'oracle.usdc and infrastructure.usdc disagree in the record');
  assert.equal(String(config.usdc).toLowerCase(), usdc.toLowerCase(), 'config usdc and record usdc disagree');
  assert.ok(text.toLowerCase().includes(usdc.toLowerCase()), 'the page does not quote the USDC address from the record');
  assert.match(text, /settlement token and the gas asset/, 'the page no longer says USDC is both settlement and gas');

  const basket = Object.keys(record.oracle.assets);
  assert.deepEqual(basket, ['cirBTC'], 'the record now lists a different basket; the page says cirBTC is the only non-stable asset');
  assert.match(text, /one non-stable asset, cirBTC/, 'the page does not name cirBTC as the one basket asset');
  assert.match(text, /BTC \/ USD feed/, 'the page does not name the BTC / USD feed');

  const zero = `0x${'0'.repeat(40)}`;
  assert.equal(String(record.oracle.sequencerUptimeFeed).toLowerCase(), zero, 'the record now has a sequencer feed; the page says it is the zero address');
  assert.match(text, /sequencerUptimeFeed. is the zero address/, 'the page does not say the Arc sequencer feed is the zero address');

  assert.equal(record.oracle.maxStalenessSeconds, 90000);
  assert.match(text, /configured heartbeat for the cirBTC feed, which is its staleness bound, is 90,000 seconds/, 'the page does not state the 90,000 second configured heartbeat as the oracle staleness bound');
  assert.match(text, /not a statement of how often the feed itself publishes/, "the page no longer separates the oracle bound from the feed's own cadence");
  assert.ok(!/feed heartbeat is 90,000/i.test(text), "the page calls 90,000 s the feed heartbeat; it is the oracle's configured staleness bound");
});

test('the page says sub-vaults are disabled on Arc, and the record and the factory source agree', () => {
  assert.equal(record.verifiedWiring['factory.allowSubVaults()'], false, 'the record now has sub-vaults enabled; the page says they are disabled');
  const factory = read('contracts/src/VaultFactory.sol');
  assert.match(factory, /bool public immutable allowSubVaults;/, 'allowSubVaults is no longer an immutable of the factory');
  assert.match(factory, /require\(allowSubVaults, SubVaultsDisabled\(\)\);/, 'createChildVault no longer reverts when sub-vaults are disabled');
  const text = flat(page);
  assert.match(text, /allowSubVaults\(\). reads false/, 'the page does not say the Arc factory allowSubVaults() reads false');
  assert.match(text, /Every Arc vault is a root vault and there are no stacked fees to read/, 'the page does not say Arc has no stacked fees');
});

test('the MAX_HEARTBEAT source cite points at the line that declares it, at the recorded value', () => {
  const cite = /contracts\/src\/oracle\/ChainlinkOracle\.sol:(\d+)/.exec(page);
  assert.ok(cite, 'the page no longer cites ChainlinkOracle.sol:<line> for MAX_HEARTBEAT');
  const line = read('contracts/src/oracle/ChainlinkOracle.sol').split('\n')[Number(cite[1]) - 1] ?? '';
  const declared = /uint32 private constant MAX_HEARTBEAT = ([0-9_]+);/.exec(line);
  assert.ok(declared, `ChainlinkOracle.sol:${cite[1]} no longer declares MAX_HEARTBEAT (the line reads: ${line.trim()})`);
  assert.equal(Number(declared[1].replace(/_/g, '')), record.oracle.maxStalenessSeconds, 'MAX_HEARTBEAT no longer equals the recorded staleness bound');
});

/**
 * The text of one section of the page: from `startRe` to the next match of `endRe` (or the end).
 * @param {string} src
 * @param {RegExp} startRe
 * @param {RegExp} endRe
 */
export function sectionOf(src, startRe, endRe) {
  const start = src.search(startRe);
  assert.ok(start >= 0, `section not found: ${startRe}`);
  const rest = src.slice(start + 1);
  const end = rest.search(endRe);
  return end < 0 ? src.slice(start) : src.slice(start, start + 1 + end);
}

/** The chain-configuration bullet, and section 3 (the indexer): the two places the record is linked. */
export const chainBullet = (/** @type {string} */ p) => sectionOf(p, /^- \*\*Chain configuration:\*\*/m, /^- \*\*/m);
export const indexerSection = (/** @type {string} */ p) => sectionOf(p, /^## 3\./m, /^## /m);

/**
 * @param {string} section
 * @param {string} rel
 */
const linksTo = (section, rel) => section.includes(`](../${rel})`);

test('the quickstart links the deployment record and the config, and both files exist', () => {
  for (const rel of [RECORD_REL, CONFIG_REL]) {
    assert.ok(existsSync(path.join(REPO, rel)), `${rel} is missing`);
  }
  const bullet = chainBullet(page);
  assert.ok(linksTo(bullet, RECORD_REL), 'the chain-configuration bullet does not link the deployment record');
  assert.ok(linksTo(bullet, CONFIG_REL), 'the chain-configuration bullet does not link the launch config');
  assert.ok(linksTo(indexerSection(page), RECORD_REL), 'section 3 (index the chain) does not link the deployment record');
});

// Self-tests: run the SAME checks against corrupted copies of the page, so a regex edited into a
// no-op turns this red instead of letting the guard above pass vacuously.
test('self-test: each retired string is caught, including across a hard line wrap', () => {
  for (const bad of [
    'has no live chain configuration yet',
    'has no live chain\nconfiguration yet',
    'WETH via ETH/USD',
    'cbBTC via BTC/USD',
    '(on Base only)',
    'see docs/evidence/arc-mainnet-survey.json',
    'see docs/evidence/arc-deploy-runbook.md',
    'robinhood-mainnet.json',
  ]) {
    assert.notDeepEqual(retiredHits(`${page}\n${bad}`), [], `not caught: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(retiredHits(page), []);
});

test('self-test: the link checks are scoped, not satisfied by a link elsewhere on the page', () => {
  // Drop the record link from the chain-configuration bullet only: section 3 still carries one.
  const noBulletRecord = page.replace(`](../${RECORD_REL})`, '](../x)');
  assert.ok(!linksTo(chainBullet(noBulletRecord), RECORD_REL));
  assert.ok(linksTo(indexerSection(noBulletRecord), RECORD_REL));
  assert.ok(linksTo(chainBullet(page), RECORD_REL) && linksTo(chainBullet(page), CONFIG_REL));
  assert.ok(!linksTo(chainBullet(page.replace(`](../${CONFIG_REL})`, '](../x)')), CONFIG_REL));
});

test('self-test: a quoted address absent from the record is caught, a recorded one is not', () => {
  const stray = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(addressesMissingFromRecord(`${page}\n${stray}`), [stray]);
  assert.deepEqual(addressesMissingFromRecord(page), []);
});
