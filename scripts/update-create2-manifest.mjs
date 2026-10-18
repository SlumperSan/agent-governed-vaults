#!/usr/bin/env node
// @ts-check
/**
 * Regenerate `contracts/config/create2-manifest.json` from `contracts/out`.
 *
 *     cd contracts && forge build && cd .. && node scripts/update-create2-manifest.mjs
 *
 * Writes the file; `--check` compares instead and exits 1 on any difference. Run it after any change
 * under `contracts/src` that reaches a singleton, then read the diff: a moved address is a moved
 * deployment. It reads and writes files only. No RPC, no key, no transaction.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildManifest, MANIFEST_PATH } from './lib/create2-manifest.mjs';

const next = `${JSON.stringify(buildManifest(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const cur = readFileSync(MANIFEST_PATH, 'utf8');
  if (cur !== next) {
    console.error('create2-manifest.json is out of date with contracts/out. Run: node scripts/update-create2-manifest.mjs');
    process.exit(1);
  }
  console.log('create2-manifest.json matches contracts/out');
} else {
  writeFileSync(MANIFEST_PATH, next);
  console.log(`wrote ${MANIFEST_PATH}`);
}
