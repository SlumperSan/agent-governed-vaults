#!/usr/bin/env node
// @ts-check
/**
 * Regenerate apps/site/public/agent-manifest.json from the Arc deployment record, the Arc config
 * and VaultCore.sol. The builder is `scripts/lib/agent-manifest.mjs`; this file only reads and
 * writes. The JSON is generated and committed, never hand-edited: `scripts/test/agent-manifest.test.mjs`
 * fails when the committed bytes differ from this script's output.
 *
 * Run:  node scripts/build-agent-manifest.mjs
 * Then: git add apps/site/public/agent-manifest.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, observationWindowFromSource, renderManifest } from './lib/agent-manifest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));

export const MANIFEST_PATH = 'apps/site/public/agent-manifest.json';

export function generate() {
  return renderManifest(
    buildManifest({
      record: readJson('contracts/config/deployments/arc-mainnet.json'),
      config: readJson('contracts/config/arc-mainnet.json'),
      observationWindowSeconds: observationWindowFromSource(
        readFileSync(path.join(REPO, 'contracts/src/VaultCore.sol'), 'utf8'),
      ),
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(REPO, MANIFEST_PATH), generate());
  console.log(`wrote ${MANIFEST_PATH}`);
}
