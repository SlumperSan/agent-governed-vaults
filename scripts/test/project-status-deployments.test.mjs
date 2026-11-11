// @ts-check
/**
 * The deployment board names a record by its file, so a versioned record file must still show as
 * its network. `contracts/config/deployments/arc-mainnet-v1.json` is chain 5042's record, and
 * `contracts/config/arc-mainnet.json` is the launch config with the same chain name: the record
 * must win the shared name, exactly as it did when it was called `arc-mainnet.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentNetworkName, deployments } from '../lib/project-status.mjs';

test('a -vN record file maps to its network name; an unversioned one is unchanged', () => {
  assert.equal(deploymentNetworkName('arc-mainnet-v1.json'), 'arc-mainnet');
  assert.equal(deploymentNetworkName('arc-mainnet-v12.json'), 'arc-mainnet');
  assert.equal(deploymentNetworkName('base-sepolia.json'), 'base-sepolia');
  assert.equal(deploymentNetworkName('arc-mainnet-v1-extra.json'), 'arc-mainnet-v1-extra');
});

test('the real tree lists chain 5042 once as arc-mainnet and never as a -vN network', () => {
  const nets = deployments().map((d) => d.network);
  assert.equal(nets.filter((n) => n === 'arc-mainnet').length, 1, nets.join(','));
  assert.deepEqual(nets.filter((n) => /-v\d+$/.test(n)), []);
  const arc = deployments().find((d) => d.network === 'arc-mainnet');
  assert.ok(arc?.addresses.VaultFactory, 'the record (not the launch config) won the shared name');
});
