#!/usr/bin/env node
// @ts-check
/**
 * `node scripts/vault-lint.mjs [--vault <path>]`
 *
 * Card 189, advisory in `npm run gate` for one week then blocking (Chairman directive 6). See
 * `scripts/lib/vault-lint.mjs` for the three checks and why they are scoped as narrowly as they are.
 *
 * EXIT CODES: 0 clean (or the vault is absent from this environment -- see below), 1 a fail was
 * found, 2 the vault exists but the Tasks folder is missing or empty (a floor emptied, not a pass).
 *
 * THE VAULT IS A LOCAL PATH, NOT PART OF THIS REPO. It exists on the machine this was written on
 * and does not exist in CI. That is a different fact from "the Tasks folder is missing inside an
 * existing vault" -- the latter is exactly what this check exists to catch and exits 2. The former
 * means this check does not apply in this environment and exits 0 with a one-line notice, the same
 * way a Windows-only script no-ops on a runner that is not Windows.
 */
import { existsSync } from 'node:fs';
import { lintVault } from './lib/vault-lint.mjs';

const DEFAULT_VAULT = 'C:/Users/Micha/Desktop/Claude/Obsidian Vault/Agent-Governed Vaults';

function parseArgs(argv) {
  const idx = argv.indexOf('--vault');
  return { vault: idx === -1 ? DEFAULT_VAULT : argv[idx + 1] };
}

function main() {
  const { vault } = parseArgs(process.argv.slice(2));

  if (!existsSync(vault)) {
    console.log(`vault-lint: no vault at ${vault} in this environment -- check does not apply here, skipping`);
    process.exit(0);
  }

  let results;
  try {
    results = lintVault(vault);
  } catch (err) {
    console.error(`vault-lint: ${err.message}`);
    process.exit(2);
  }

  const failed = results.filter((r) => r.fails.length > 0);
  const warned = results.filter((r) => r.warns.length > 0 && r.fails.length === 0);

  for (const r of warned) {
    for (const w of r.warns) console.log(`WARN  ${r.file}: ${w}`);
  }
  for (const r of failed) {
    for (const f of r.fails) console.error(`FAIL  ${r.file}: ${f}`);
    for (const w of r.warns) console.log(`WARN  ${r.file}: ${w}`);
  }

  console.log(`vault-lint: ${failed.length} failing card(s), ${warned.length} warning-only card(s)`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
