// @ts-check
/**
 * Tests for the shared `chainBindingVerdict` decision (`scripts/lib/chain-binding.mjs`), reused by
 * `scripts/verify-mainnet-config.mjs` and `scripts/live-x402-run.mjs` to close issue #204: a script
 * that resolves an RPC by chain and never asks it which chain it actually is prints a verdict
 * computed against a chain nobody named.
 *
 * These mirror the pure-function tests for the sibling `chainBindingVerdict` in
 * `scripts/test/verify-chainlink-oracle.test.mjs` (#205) — same decision table, same wording
 * conventions — since the two are deliberately two small copies rather than one shared import (see
 * the header comment in `scripts/lib/chain-binding.mjs` for why).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainBindingVerdict } from '../lib/chain-binding.mjs';

test('a matching chain id binds, and the message names the chain and the declarer', () => {
  const r = chainBindingVerdict({
    declaredChainId: 8453, rpcChainId: 8453, rpc: 'https://rpc.example', declaredBy: 'contracts/config/base-mainnet.json',
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /chain 8453/);
  assert.match(r.message, /base-mainnet\.json/);
});

test('a declared chain of 8453 against an RPC answering 84532 REFUSES, naming both ids', () => {
  const r = chainBindingVerdict({
    declaredChainId: 8453, rpcChainId: 84532, rpc: 'https://rpc.example', declaredBy: 'contracts/config/base-mainnet.json',
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /WRONG CHAIN/);
  assert.match(r.message, /84532/, 'must name what the RPC reported');
  assert.match(r.message, /8453/, 'and what was declared');
});

test('the declared chain id is compared as a number — JSON/env can hold a string', () => {
  assert.equal(chainBindingVerdict({ declaredChainId: '8453', rpcChainId: 8453, rpc: 'r', declaredBy: 'c' }).ok, true);
  assert.equal(chainBindingVerdict({ declaredChainId: 8453, rpcChainId: '8453', rpc: 'r', declaredBy: 'c' }).ok, true);
});

test('an UNREADABLE chain id refuses too — an unproven binding is not a binding', () => {
  const r = chainBindingVerdict({ declaredChainId: 8453, rpcChainId: null, rpc: 'https://rpc.example', declaredBy: 'c' });
  assert.equal(r.ok, false, 'a chain id that could not be read must never pass as a match');
  assert.match(r.message, /UNPROVEN/);
  assert.doesNotMatch(r.message, /WRONG CHAIN/, 'unreadable is not the same finding as a mismatch');
});

test('a declarer with no usable chain id refuses rather than binding to whatever answers', () => {
  for (const bad of [undefined, null, 0, -1, 'base']) {
    assert.equal(chainBindingVerdict({ declaredChainId: bad, rpcChainId: 8453, rpc: 'r', declaredBy: 'c' }).ok, false, String(bad));
  }
});

test('an unreadable id is checked before the mismatch branch would even matter', () => {
  // Regression guard for evaluation order: a caller must never see "matched" just because null
  // happens to coerce oddly under a naive `!==` comparison.
  const r = chainBindingVerdict({ declaredChainId: 84532, rpcChainId: null, rpc: 'r', declaredBy: 'c' });
  assert.equal(r.ok, false);
  assert.match(r.message, /UNPROVEN/);
});
