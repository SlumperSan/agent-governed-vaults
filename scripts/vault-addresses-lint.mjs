#!/usr/bin/env node
// @ts-check
/**
 * `node scripts/vault-addresses-lint.mjs [--vaults-ui-dir <path>] [--deployments-dir <path>] [--repo-root <path>]`
 *
 * Card A2. Cross-checks `VITE_VAULT_ADDRESSES` — `apps/vaults-ui/.env*`, and any CI/deploy config
 * that sets it — against `contracts/config/deployments/*.json`, this repository's own source of
 * truth for what is actually deployed. See `scripts/lib/vault-addresses-lint.mjs` for the checks and
 * why "unknown address" and "wrong chain" are reported as distinct failures.
 *
 * BLOCKING in `npm run gate` and in CI, not advisory. Unlike `vault-lint.mjs` (reads a local vault
 * path that does not exist in CI) or `verify-deployment-currency.mjs` (advisory because both
 * recorded deployments are KNOWINGLY behind mainline, a fact no single PR can fix), every input this
 * script reads is checked into this repository and the comparison is deterministic: there is no
 * environment where it is expected to be red for a reason other than a real config error. A wrong
 * vault address is fund-safety-adjacent — the live UI would read the wrong contract, or nothing —
 * so this fails the gate rather than warning past it.
 *
 * The `--*-dir` flags exist for the test suite (`scripts/test/vault-addresses-lint.test.mjs`), which
 * runs this exact CLI as a subprocess against fixture directories to capture real RED/GREEN output
 * rather than only exercising the pure functions in-process.
 *
 * EXIT CODES: 0 every declared VITE_VAULT_ADDRESSES address is a known vault on its declared chain.
 * 1 at least one address is unknown, malformed, or on the wrong chain -- see the printed FAIL lines
 * for which and why. 2 the check could not run at all (no .env-shaped file under apps/vaults-ui, no
 * deployment manifest, or nothing anywhere declares VITE_VAULT_ADDRESSES) -- the zero-coverage trap:
 * reporting "0 issues" here would look identical to a real clean pass, so it is a distinct exit code
 * and a hard failure, never a silent 0.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatIssue, lintVaultAddresses } from './lib/vault-addresses-lint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const get = (flag, def) => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? def : argv[idx + 1];
  };
  return {
    vaultsUiDir: get('--vaults-ui-dir', path.join(REPO, 'apps', 'vaults-ui')),
    deploymentsDir: get('--deployments-dir', path.join(REPO, 'contracts', 'config', 'deployments')),
    repoRoot: get('--repo-root', REPO),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outcome = lintVaultAddresses(args);

  if (outcome.hardError) {
    console.error(`vault-addresses-lint: ${outcome.hardError}`);
    process.exit(2);
  }

  let failCount = 0;
  for (const r of outcome.results) {
    const label = path.relative(args.repoRoot, r.file) || r.file;
    for (const issue of r.issues) {
      failCount += 1;
      console.error(`FAIL  ${label}: ${formatIssue(issue)}`);
    }
  }

  console.log(
    `vault-addresses-lint: ${outcome.results.length} config source(s) declaring VITE_VAULT_ADDRESSES, ` +
      `${failCount} failing address(es)`,
  );
  process.exit(failCount > 0 ? 1 : 0);
}

main();
