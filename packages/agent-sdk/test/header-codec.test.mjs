// @ts-check
/**
 * `decodeHeaderJson` reads BOTH x402 header encodings, and the two cannot be confused.
 *
 * `specs/transports-v2/http.md:161-167` specifies base64; this API emitted raw JSON until
 * 2026-09-13. The dual accept is what lets a client of either vintage talk to a server of either
 * vintage during the transition, so the property under test is that BOTH forms decode — a reader
 * that quietly lost one of them would strand half of that matrix.
 *
 * The encoder side is `apps/api/src/x402.mjs`'s `encodeHeaderJson`, imported here rather than
 * reimplemented: a test that encodes with its own helper proves the helper round-trips, not that
 * the server's bytes are readable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeaderJson } from '../src/header-codec.mjs';
import { encodeHeaderJson } from '../../../apps/api/src/x402.mjs';

const sample = {
  x402Version: 2,
  scheme: 'exact',
  asset: '0x' + 'c'.repeat(40),
  accepts: [{ network: 'eip155:84532', amount: '10000' }],
  extensions: {},
};

test('decodes what the server actually emits (base64)', () => {
  const header = encodeHeaderJson(sample);
  assert.ok(!header.startsWith('{'), 'the fixture must really be base64, or this proves nothing');
  assert.deepEqual(decodeHeaderJson(header), sample);
});

test('still decodes the raw JSON emitted before 2026-09-13', () => {
  assert.deepEqual(decodeHeaderJson(JSON.stringify(sample)), sample);
  assert.deepEqual(decodeHeaderJson(`\n  ${JSON.stringify(sample)}\n`), sample, 'space tolerated');
});

test('non-ASCII survives the base64 round trip', () => {
  // `atob` yields one byte per character, so a decoder that skipped the UTF-8 step would mangle
  // any multi-byte character rather than fail — silent corruption, not an error.
  const unicode = { description: 'Zugang zu Marktdaten — 0.01 €', mimeType: 'application/json' };
  assert.deepEqual(decodeHeaderJson(encodeHeaderJson(unicode)), unicode);
});

test('anything that is neither encoding returns null rather than throwing', () => {
  for (const bad of [undefined, null, '', '    ', 'plainly not a header', '{"unterminated":', 7, {}, []]) {
    assert.equal(decodeHeaderJson(/** @type {any} */ (bad)), null, `must reject: ${String(bad)}`);
  }
});
