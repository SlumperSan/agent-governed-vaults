#!/usr/bin/env node
/**
 * Resolve every checkable claim in a set of documents against this repository, and report the
 * ones that are false. See `scripts/lib/doc-claims.mjs` for what "checkable claim" means and why
 * the assertion is on the enclosing symbol rather than on the text of the line.
 *
 *   node scripts/check-doc-claims.mjs                     # the tracked docs/ tree
 *   node scripts/check-doc-claims.mjs --all               # every .md under docs/, records included
 *   node scripts/check-doc-claims.mjs --no-anchor         # only report citations that MOVED
 *   node scripts/check-doc-claims.mjs --ref origin/main   # which ref defines "merged"
 *   node scripts/check-doc-claims.mjs --root "<dir>"      # point it at any document tree
 *
 * `--root` is the reason this is a CLI and not only a test: the Obsidian vault makes the same two
 * kinds of claim about this repository and is not in it. `npm run gate` checks `docs/`; a human
 * runs this against the vault.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocs, formatProblems, commitsBehind } from './lib/doc-claims.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const root = flag('--root', path.join(REPO, 'docs'));
const ref = flag('--ref', 'origin/protocol/main');

function markdownUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const base = path.resolve(root);
const docs = markdownUnder(base).map((f) => path.relative(REPO, f).split(path.sep).join('/'));

const { problems, checked, skipped, canCheckPrState } = checkDocs(REPO, docs, {
  ref,
  requireAnchor: !has('--no-anchor'),
});

// Before anything else: a resolver run against a stale tree answers confidently and wrongly.
const behind = commitsBehind(REPO, ref);
if (behind) {
  console.log(
    `doc-claims: WARNING — this working tree is ${behind} commit(s) behind ${ref}.\n` +
      '            Every answer below is about THIS tree, not that branch. A symbol added by a\n' +
      '            merge you do not have reads as absent. Rebase, or read the results as historical.\n'
  );
}

const kinds = problems.reduce((a, p) => ((a[p.kind] = (a[p.kind] ?? 0) + 1), a), {});
console.log(`doc-claims: ${checked} claims resolved across ${docs.length - skipped.length} documents`);
if (skipped.length) console.log(`            ${skipped.length} skipped as historical records`);
// The half that ran and the half that did not are reported separately. A summary line that says
// only "N claims resolved" reads as a clean bill when half the check never executed.
console.log(
  `            branch-state half: ${canCheckPrState ? 'CHECKED' : 'NOT RUN — reported as a failure below'}`
);
if (!problems.length) {
  console.log('doc-claims: OK');
  process.exit(0);
}
console.log(`\n${problems.length} false claim(s): ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}\n`);
console.log(formatProblems(problems));
process.exit(1);
