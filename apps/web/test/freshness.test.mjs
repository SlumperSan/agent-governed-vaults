// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseSnapshotAge, parseLastBlock, describeError, loading, empty, ready, failed } from '../src/freshness.mjs';

test('staleness tiers gate whether the data is safe to act on', () => {
  assert.equal(classify(5).key, 'live');
  assert.equal(classify(5).actionable, true);
  assert.equal(classify(120).key, 'lagging');
  assert.equal(classify(120).actionable, true);
  assert.equal(classify(600).key, 'stale');
  assert.equal(classify(600).actionable, false);
  assert.equal(classify(99_999).key, 'unusable');
});

test('an unknown age is the worst case, not the best', () => {
  // An indexer that cannot say how old it is has told you something.
  for (const v of [undefined, null, NaN, -1, 'x']) {
    const c = classify(v);
    assert.equal(c.key, 'unknown');
    assert.equal(c.actionable, false);
    assert.equal(c.ageSec, null);
  }
});

test('a lagging projection warns about the states it could be missing', () => {
  assert.match(classify(120).note, /freeze|proposal/i);
});

test('parses the free /metrics gauges', () => {
  const body = [
    '# HELP vault_indexer_last_block last indexed block',
    'vault_indexer_last_block 20481234',
    'vault_indexer_snapshot_age_seconds 12.5',
    'vault_api_requests_total 99',
  ].join('\n');
  assert.equal(parseSnapshotAge(body), 12.5);
  assert.equal(parseLastBlock(body), 20481234);
  // Absent gauges are null, so classify() treats them as unknown rather than as zero/fresh.
  assert.equal(parseSnapshotAge('vault_api_requests_total 1'), null);
  assert.equal(parseLastBlock(''), null);
  assert.equal(parseSnapshotAge(undefined), null);
});

test('the four fetch states are all constructible and distinct', () => {
  assert.equal(loading().kind, 'loading');
  assert.equal(empty('No vaults match').kind, 'empty');
  assert.equal(ready([], classify(1)).kind, 'ready');
  assert.equal(failed('boom').kind, 'error');
});

test('a 402 reaching a browsing user reads as a data problem, not a fund problem', () => {
  const e = describeError({ status: 402, message: 'HTTP 402' });
  assert.equal(e.kind, 'error');
  assert.equal(e.retryable, true);
  assert.match(e.detail, /not a protocol one/i);
});

test('error messages map to what the user can do', () => {
  assert.match(describeError({ status: 429 }).detail, /retry/i);
  assert.equal(describeError({ status: 404 }).retryable, false);
  assert.equal(describeError({ status: 503, message: 'x' }).retryable, true);
  const net = describeError(new TypeError('Failed to fetch'));
  assert.match(net.detail, /No data is shown rather than old data/i);
  assert.match(net.detail, /unaffected/i);
});
