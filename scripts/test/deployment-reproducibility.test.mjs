// @ts-check
/**
 * Pure-logic tests for scripts/lib/deployment-reproducibility.mjs -- the "why" is in that
 * module's header. No real git repo is touched; `gitResolves`/`gitIsAncestor` are stubbed so the
 * suite exercises every branch of the verdict, not whatever this checkout's history happens to
 * contain right now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDeploymentRecord,
  anyHardFail,
  formatResultLine,
} from '../lib/deployment-reproducibility.mjs';

test('no sourceCommit recorded -> SKIP, not a hard failure', () => {
  const r = checkDeploymentRecord(
    {chainName: 'base-mainnet'},
    {
      gitResolves: () => {
        throw new Error('must not be called');
      },
      gitIsAncestor: () => {
        throw new Error('must not be called');
      },
      haveMainline: true,
      fallbackChainName: 'base-mainnet',
    }
  );
  assert.equal(r.sourceCommit, '(none)');
  assert.equal(r.resolves, false);
  assert.equal(r.isAncestor, null);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^  SKIP/);
});

test('sourceCommit does not resolve locally -> hard FAIL, ancestry never checked', () => {
  let ancestorCalled = false;
  const r = checkDeploymentRecord(
    {chainName: 'base-sepolia', sourceCommit: 'deadbeef'},
    {
      gitResolves: () => false,
      gitIsAncestor: () => {
        ancestorCalled = true;
        return true;
      },
      haveMainline: true,
      fallbackChainName: 'base-sepolia',
    }
  );
  assert.equal(r.resolves, false);
  assert.equal(r.isAncestor, null);
  assert.equal(r.hardFail, true);
  assert.equal(ancestorCalled, false, 'a commit that does not resolve must not be checked for ancestry');
  assert.match(formatResultLine(r), /^  FAIL.*does not resolve/);
});

test('sourceCommit resolves but is not an ancestor of the mainline -> hard FAIL', () => {
  const r = checkDeploymentRecord(
    {chainName: 'base-sepolia', sourceCommit: '5934ef22'},
    {
      gitResolves: () => true,
      gitIsAncestor: () => false,
      haveMainline: true,
      fallbackChainName: 'base-sepolia',
    }
  );
  assert.equal(r.resolves, true);
  assert.equal(r.isAncestor, false);
  assert.equal(r.hardFail, true);
  assert.match(formatResultLine(r), /^ {2}FAIL.*NOT an ancestor/);
});

test('sourceCommit resolves and is an ancestor of the mainline -> OK, no failure', () => {
  const r = checkDeploymentRecord(
    {chainName: 'base-sepolia', sourceCommit: '5934ef22'},
    {
      gitResolves: () => true,
      gitIsAncestor: () => true,
      haveMainline: true,
      fallbackChainName: 'base-sepolia',
    }
  );
  assert.equal(r.resolves, true);
  assert.equal(r.isAncestor, true);
  assert.equal(r.hardFail, false);
  assert.match(formatResultLine(r), /^  OK .*ancestor of the mainline/);
});

test('no mainline ref available -> ancestry not checked, resolution alone is enforced', () => {
  let ancestorCalled = false;
  const r = checkDeploymentRecord(
    {chainName: 'base-sepolia', sourceCommit: '5934ef22'},
    {
      gitResolves: () => true,
      gitIsAncestor: () => {
        ancestorCalled = true;
        return true;
      },
      haveMainline: false,
      fallbackChainName: 'base-sepolia',
    }
  );
  assert.equal(r.resolves, true);
  assert.equal(r.isAncestor, null);
  assert.equal(r.hardFail, false, 'missing mainline ref must be advisory, not a failure');
  assert.equal(ancestorCalled, false);
  assert.match(formatResultLine(r), /^  OK /);
  assert.doesNotMatch(formatResultLine(r), /ancestor of the mainline/);
});

test('chainName falls back to the filename stem when the record omits it', () => {
  const r = checkDeploymentRecord(
    {sourceCommit: '5934ef22'},
    {
      gitResolves: () => true,
      gitIsAncestor: () => true,
      haveMainline: true,
      fallbackChainName: 'base-sepolia',
    }
  );
  assert.equal(r.chainName, 'base-sepolia');
});

test('anyHardFail is true if any record hard-failed, false otherwise', () => {
  const ok = {chainName: 'a', sourceCommit: 'x', resolves: true, isAncestor: true, hardFail: false};
  const bad = {chainName: 'b', sourceCommit: 'y', resolves: false, isAncestor: null, hardFail: true};
  assert.equal(anyHardFail([ok]), false);
  assert.equal(anyHardFail([ok, bad]), true);
  assert.equal(anyHardFail([]), false);
});
