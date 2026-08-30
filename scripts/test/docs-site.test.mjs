// @ts-check
/**
 * The docs site's gate. It exists to make one promise enforceable: **the documentation cannot
 * silently drift from the code it documents.**
 *
 * Four kinds of check, in increasing order of how much they would have saved someone:
 *
 *   1. The renderer works        — unit tests over docs/site/md.mjs, the module the browser loads.
 *   2. The links resolve         — every link in every rendered doc points at a file that exists,
 *                                  and every in-page anchor at a heading that exists.
 *   3. The SDK reference matches — the client's methods and the module's exports are enumerated at
 *                                  RUNTIME and compared against docs/SDK-REFERENCE.md, both ways.
 *   4. The quickstart runs       — docs/examples/read-vaults.mjs is executed end to end against a
 *                                  real API over the real projections.
 *
 * Check 4 is the one that matters most. This project has shipped two launch-class bugs that a green
 * suite did not catch and a live run did, so "the sample looks right" is not a standard this file
 * accepts. Nothing here needs a network, a chain, or a funded key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { renderMarkdown, renderInline, collectLinks, collectHeadings, resolveDocLink, slugify, escapeHtml } from '../../docs/site/md.mjs';
import { NAV, PAGES, HOME } from '../../docs/site/manifest.mjs';
import { resolveRequestPath } from '../../docs/site/serve.mjs';
import { createApi } from '../../apps/api/src/server.mjs';
import { createStubFacilitator } from '../../apps/api/src/facilitator.mjs';
import { createProtocolClient } from '../../packages/agent-sdk/src/index.mjs';
import * as sdk from '../../packages/agent-sdk/src/index.mjs';
import { demoEvents } from '../../packages/reference-agent/fixtures/seed-snapshot.mjs';
import { applyAll } from '../../packages/indexer/src/projections.mjs';

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const execFileAsync = promisify(execFile);

// ── 1. the renderer ─────────────────────────────────────────────────────────

test('renderer: headings carry GitHub-compatible anchor ids', () => {
  const { html, headings } = renderMarkdown('## 7. Risks and honest limitations\n');
  assert.equal(headings[0].id, '7-risks-and-honest-limitations');
  assert.match(html, /<h2 id="7-risks-and-honest-limitations">/);
});

test('renderer: duplicate headings get distinct ids', () => {
  const { headings } = renderMarkdown('# Notes\n\ntext\n\n# Notes\n');
  assert.deepEqual(headings.map((h) => h.id), ['notes', 'notes-1']);
});

test('renderer: GFM tables render with a horizontal scroll container', () => {
  const { html } = renderMarkdown('| A | B |\n| --- | ---: |\n| 1 | 2 |\n');
  assert.match(html, /<div class="table-scroll"><table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
});

test('renderer: a table cell may contain an escaped pipe', () => {
  const { html } = renderMarkdown('| A | B |\n| --- | --- |\n| a \\| b | c |\n');
  assert.match(html, /<td>a \| b<\/td>/);
});

test('renderer: fenced code is escaped, not interpreted, and keeps its language', () => {
  const { html } = renderMarkdown('```powershell\n$env:X = "<b>"\n```\n');
  assert.match(html, /data-lang="powershell"/);
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('renderer: emphasis inside a code span is left alone', () => {
  assert.equal(renderInline('use `a*b*c` here'), 'use <code>a*b*c</code> here');
});

test('renderer: bold containing nested italic keeps both, and shows no literal asterisks', () => {
  // Regression: `[^*]+` as the bold body failed on the nested `*is*`, leaving `**` visible in the
  // rendered page. Caught by looking at the site, not by a unit test — hence this one.
  assert.equal(renderInline('**x402 *is* the limiter**'), '<strong>x402 <em>is</em> the limiter</strong>');
  assert.equal(renderInline('**a** and **b**'), '<strong>a</strong> and <strong>b</strong>');
  assert.doesNotMatch(renderInline('**bold *nested* here**'), /\*/);
});

test('no rendered documentation page leaks a literal emphasis marker', () => {
  for (const page of PAGES) {
    const { html } = renderMarkdown(read(page.path), { docPath: page.path });
    // Strip code, where asterisks are legitimate, then look for surviving markup.
    const prose = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    const leaks = [...prose.matchAll(/\*\*[^*\n]{1,60}/g)].map((m) => m[0]);
    assert.deepEqual(leaks, [], `${page.path} renders literal ** markers: ${leaks.join(' | ')}`);
  }
});

test('renderer: raw HTML in a document is escaped, never passed through', () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renderer: nested lists nest', () => {
  const { html } = renderMarkdown('- one\n  - inner\n- two\n');
  assert.match(html, /<li>one<ul><li>inner<\/li><\/ul><\/li>/);
});

test('renderer: ordered lists render as <ol>', () => {
  const { html } = renderMarkdown('1. first\n2. second\n');
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test('renderer: blockquotes render their contents as markdown', () => {
  const { html } = renderMarkdown('> **warning** text\n');
  assert.match(html, /<blockquote><p><strong>warning<\/strong> text<\/p><\/blockquote>/);
});

test('escapeHtml neutralises every character that could open a tag or attribute', () => {
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('slugify matches GitHub for punctuation and case', () => {
  assert.equal(slugify('The dry-run/execute gate'), 'the-dry-runexecute-gate');
  assert.equal(slugify('4. What Now?'), '4-what-now');
});

// ── 2. link rewriting and resolution ────────────────────────────────────────

test('a relative link resolves against the FILE, not the page', () => {
  assert.equal(resolveDocLink('docs/AGENT-QUICKSTART.md', 'api/openapi.yaml'), 'docs/api/openapi.yaml');
  assert.equal(resolveDocLink('docs/AGENT-QUICKSTART.md', '../llms.txt'), 'llms.txt');
  assert.equal(resolveDocLink('docs/site/HOME.md', '../X402-FLOW.md'), 'docs/X402-FLOW.md');
});

test('absolute URLs, mailto and bare anchors are left untouched', () => {
  for (const href of ['https://example.com', 'mailto:a@b.c', '#section', '/root']) {
    assert.equal(resolveDocLink('docs/A.md', href), null, href);
  }
});

test('a link fragment survives resolution', () => {
  assert.equal(resolveDocLink('docs/A.md', 'B.md#part-2'), 'docs/B.md#part-2');
});

test('every page in the nav manifest exists on disk', () => {
  for (const page of [...PAGES, { path: HOME, title: 'home' }]) {
    assert.ok(existsSync(join(REPO, page.path)), `manifest page missing: ${page.path}`);
  }
  assert.ok(PAGES.some((p) => p.path === HOME), 'HOME must also appear in the nav');
});

test('every link in every documented page points at something that exists', () => {
  const broken = [];
  for (const page of PAGES) {
    const src = read(page.path);
    const anchors = new Set(collectHeadings(src).map((h) => h.id));
    for (const link of collectLinks(src, page.path)) {
      if (link.resolved === null) {
        // in-page anchor: must name a heading in THIS document
        if (link.href.startsWith('#') && !anchors.has(link.href.slice(1))) {
          broken.push(`${page.path} → ${link.href} (no such heading)`);
        }
        continue;
      }
      const [path, frag] = link.resolved.split('#');
      if (!existsSync(join(REPO, path))) {
        broken.push(`${page.path} → ${link.href} (no file ${path})`);
        continue;
      }
      if (frag && path.endsWith('.md')) {
        const targetAnchors = new Set(collectHeadings(read(path)).map((h) => h.id));
        if (!targetAnchors.has(frag)) broken.push(`${page.path} → ${link.href} (no heading #${frag} in ${path})`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken links:\n  ${broken.join('\n  ')}`);
});

test('every documented page renders without throwing and produces content', () => {
  for (const page of PAGES) {
    const { html, headings } = renderMarkdown(read(page.path), { docPath: page.path });
    assert.ok(html.length > 200, `${page.path} rendered almost nothing`);
    assert.ok(headings.length > 0, `${page.path} has no headings`);
  }
});

// ── 3. the static server ────────────────────────────────────────────────────

test('the docs server refuses to escape the repo root', () => {
  for (const url of ['/../../../etc/passwd', '/docs/../../secret.md', '/%2e%2e/%2e%2e/etc/passwd']) {
    assert.equal(resolveRequestPath(url), null, url);
  }
});

test('the docs server refuses extensions outside the read-only allowlist', () => {
  for (const url of ['/.env', '/keystore.json.key', '/foo.exe', '/id_rsa']) {
    assert.equal(resolveRequestPath(url), null, url);
  }
});

test('the docs server serves the site shell and the markdown it renders', () => {
  assert.ok(String(resolveRequestPath('/')).endsWith(join('docs', 'site', 'index.html')));
  assert.ok(String(resolveRequestPath('/docs/AGENT-QUICKSTART.md')).endsWith('AGENT-QUICKSTART.md'));
});

// ── 4. the SDK reference cannot drift from the SDK ──────────────────────────

/** Identifiers documented as a `## \`name\`` or `### \`name\`` heading, with any call syntax stripped. */
function documentedSymbols(md) {
  const out = new Set();
  for (const m of md.matchAll(/^#{2,3}\s+`([^`]+)`/gm)) {
    out.add(m[1].replace(/^client\./, '').replace(/\(.*$/, '').trim());
  }
  return out;
}

test('SDK reference documents exactly the client methods that exist at runtime', () => {
  const client = createProtocolClient({
    baseUrl: 'http://127.0.0.1:1', wallet: { address: '0x' + '1'.repeat(40), sign: async () => '0x' }, domain: {},
  });
  const actual = Object.keys(client).filter((k) => typeof client[k] === 'function');
  const documented = documentedSymbols(read('docs/SDK-REFERENCE.md'));

  const undocumented = actual.filter((m) => !documented.has(m));
  assert.deepEqual(undocumented, [], `client methods missing from docs/SDK-REFERENCE.md: ${undocumented.join(', ')}`);

  // …and the other direction: the page must not describe a method that no longer exists.
  const clientHeadings = [...read('docs/SDK-REFERENCE.md').matchAll(/^#{2,3}\s+`client\.([a-zA-Z]+)/gm)].map((m) => m[1]);
  const phantom = clientHeadings.filter((m) => !actual.includes(m));
  assert.deepEqual(phantom, [], `docs/SDK-REFERENCE.md documents methods the SDK does not have: ${phantom.join(', ')}`);
});

test('SDK reference documents every public module export', () => {
  const documented = documentedSymbols(read('docs/SDK-REFERENCE.md'));
  const missing = Object.keys(sdk).filter((k) => !documented.has(k));
  assert.deepEqual(missing, [], `exports missing from docs/SDK-REFERENCE.md: ${missing.join(', ')}`);
});

test('SDK reference documents every createProtocolClient config field the source accepts', () => {
  // Parsed from the destructured parameter list, so a new option cannot be added without the table
  // growing a row for it.
  const src = read('packages/agent-sdk/src/index.mjs');
  const sig = /export function createProtocolClient\(\{([^}]*)\}/.exec(src);
  assert.ok(sig, 'could not find createProtocolClient signature');
  const fields = sig[1].split(',').map((f) => f.trim().split(/[=:]/)[0].trim()).filter(Boolean);
  const doc = read('docs/SDK-REFERENCE.md');
  const missing = fields.filter((f) => !doc.includes(`\`${f}\``));
  assert.deepEqual(missing, [], `config fields missing from docs/SDK-REFERENCE.md: ${missing.join(', ')}`);
});

test('the chain/domain table in the docs matches the addresses the example ships', async () => {
  // The USDC EIP-712 domain name differs per chain and getting it wrong fails silently
  // (X402-LIVE-REPORT §7.1). The values are asserted here so the table cannot rot; they were also
  // read from the live tokens, which this test deliberately does NOT do — no network in the gate.
  const example = read('docs/examples/read-vaults.mjs');
  for (const [addr, name] of [
    ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USD Coin'],
    ['0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'USDC'],
  ]) {
    assert.ok(example.includes(addr), `example lost the USDC address ${addr}`);
    for (const doc of ['docs/AGENT-QUICKSTART.md', 'docs/SDK-REFERENCE.md']) {
      assert.ok(read(doc).includes(addr), `${doc} lost the USDC address ${addr}`);
      assert.ok(read(doc).includes(name), `${doc} lost the domain name "${name}"`);
    }
  }
});

// ── 5. the quickstart's sample is EXECUTED, not eyeballed ───────────────────

/** Boot the real API over the real projections, on an ephemeral port. */
async function startApi() {
  const state = applyAll(demoEvents());
  state.lastBlock = 1010;
  const { server } = createApi({
    state,
    facilitator: createStubFacilitator(),
    price: {
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '10000',
      payTo: '0x000000000000000000000000000000000000beef',
      network: 'base',
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test('the quickstart example runs end to end against a real API', async (t) => {
  const { server, baseUrl } = await startApi();
  t.after(() => new Promise((r) => server.close(r)));

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(REPO, 'docs/examples/read-vaults.mjs'), `--api=${baseUrl}`, '--chain-id=84532', '--json',
     '--vault=0x3333333333333333333333333333333333333333'],
    { cwd: REPO, timeout: 60_000 },
  );

  const result = JSON.parse(stdout.slice(stdout.indexOf('{')));

  // The whole 402 → authorize → retry loop ran three times and produced data.
  assert.equal(result.payments.length, 3, 'expected three metered reads to have been paid for');
  for (const p of result.payments) {
    assert.equal(p.value, '10000', 'each read authorizes exactly the advertised price');
    assert.match(p.nonce, /^0x[0-9a-f]{64}$/, 'authorization nonce must be 32 unpredictable bytes');
  }
  assert.equal(new Set(result.payments.map((p) => p.nonce)).size, 3, 'nonces must never repeat');

  // The domain the example signs under is the Base Sepolia one, not the mainnet default.
  assert.equal(result.domain.name, 'USDC');
  assert.equal(result.domain.chainId, 84532);

  // The data is the projection's, and it carries the signals the docs tell an agent to read.
  assert.equal(result.vaults.length, 3);
  const unattested = result.vaults.filter((v) => !v.attested);
  assert.equal(unattested.length, 1, 'the fixture must keep exercising the operatorId 0 branch');
  assert.equal(unattested[0].capacityCapUsdc, '0', 'and the "0 means uncapped" branch');
  assert.equal(result.leaderboard.length, 2);
  assert.ok(result.leaderboard.some((r) => BigInt(r.netRealizedUsdc) < 0n),
    'the leaderboard must keep showing a negative operator — losses are not cherry-picked');
});

test('the example refuses a mainnet chain id, because it mints a throwaway key', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [join(REPO, 'docs/examples/read-vaults.mjs'), '--chain-id=8453'], { cwd: REPO, timeout: 30_000 }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 2, 'must exit 2, not fall through to signing');
      assert.match(String(/** @type {any} */ (err).stderr), /not a known testnet/);
      return true;
    },
  );
});

test('the example decodes an ABI string return without a web3 library', async () => {
  const { decodeAbiString } = await import('../../docs/examples/read-vaults.mjs');
  // abi.encode("USD Coin") — offset 0x20, length 8, then the bytes, right-padded.
  const encoded = '0x'
    + '0000000000000000000000000000000000000000000000000000000000000020'
    + '0000000000000000000000000000000000000000000000000000000000000008'
    + Buffer.from('USD Coin', 'utf8').toString('hex').padEnd(64, '0');
  assert.equal(decodeAbiString(encoded), 'USD Coin');
});

// ── 6. the SDK snippets in the docs are the SDK's real shape ────────────────

test('the SDK usage shown in the docs actually drives the real client', async (t) => {
  const { server, baseUrl } = await startApi();
  t.after(() => new Promise((r) => server.close(r)));

  // This is docs/SDK-REFERENCE.md's spend-control snippet, verbatim in structure: the cap is
  // enforced INSIDE the signer, because under EIP-3009 a signature is the spend.
  const CAP = 20_000n; // exactly two reads at $0.01
  let spent = 0n;
  const paid = [];
  const client = createProtocolClient({
    baseUrl,
    wallet: {
      address: '0x' + 'ab'.repeat(20),
      sign: async (td) => {
        const value = BigInt(td.message.value);
        if (spent + value > CAP) throw new Error('x402 budget exhausted');
        spent += value;
        return '0x' + '11'.repeat(65);
      },
    },
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    onPayment: ({ path, envelope }) => paid.push({ path, envelope }),
  });

  // free routes cost nothing
  const disc = await client.discovery();
  assert.equal(disc.x402Version, 2);
  assert.deepEqual(disc.routes.free, ['/health', '/.well-known/x402', '/metrics']);
  assert.equal((await client.health()).ok, true);
  assert.equal(paid.length, 0, 'free routes must not sign anything');

  // metered routes return { data, receipt }
  const vaults = await client.listVaults();
  assert.ok(Array.isArray(vaults.data.vaults));
  assert.ok(vaults.receipt?.receiptId, 'a paid read echoes a receipt');

  const board = await client.leaderboard();
  assert.equal(board.data.leaderboard.length, 2);
  assert.equal(paid.length, 2, 'onPayment fires once per metered read');

  // the third read is over the cap, and it dies in the SIGNER — before a signature exists
  await assert.rejects(() => client.getVault('0x1111111111111111111111111111111111111111'), /budget exhausted/);
  assert.equal(paid.length, 2, 'a refused signature must not be recorded as a payment');
  assert.equal(spent, CAP);
});

test('an unknown vault is a PAID 404 — the docs say so because the gate runs first', async (t) => {
  const { server, baseUrl } = await startApi();
  t.after(() => new Promise((r) => server.close(r)));

  const paid = [];
  const client = createProtocolClient({
    baseUrl,
    wallet: { address: '0x' + 'ab'.repeat(20), sign: async () => '0x' + '11'.repeat(65) },
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    onPayment: (p) => paid.push(p),
  });

  await assert.rejects(
    () => client.getVault('0x9999999999999999999999999999999999999999'),
    (err) => {
      assert.equal(/** @type {any} */ (err).name, 'ProtocolError');
      assert.equal(/** @type {any} */ (err).status, 404);
      return true;
    },
  );
  assert.equal(paid.length, 1,
    'the payment was signed before the 404 — which is why docs/SDK-REFERENCE.md tells callers to record the envelope in onPayment');
});
