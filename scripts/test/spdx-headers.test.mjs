/**
 * Every first-party Solidity file carries the MIT SPDX identifier.
 *
 * Written after PR #223's review found three files under contracts/src/lib
 * still declaring BUSL-1.1: a sweep exclusion meant for the vendored
 * contracts/lib/forge-std tree also swallowed the source tree's own lib
 * directory, and nothing in CI reads .sol headers, so the run stayed green
 * while the repository publicly said "Open source under the MIT licence."
 * LICENSE states that the header on a file is what governs it, which makes a
 * wrong header a licence claim, not a comment.
 *
 * The walk is positive: it enumerates the first-party trees from the
 * filesystem and asserts the identifier on every file it finds, so a new file
 * is covered the day it lands. Only the vendored carve-outs LICENSE names are
 * exempt, by their exact paths, and each still must carry SOME identifier.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** First-party Solidity trees. contracts/lib is vendored and stays out. */
const TREES = ['contracts/src', 'contracts/script', 'contracts/test'];

/** The vendored carve-outs LICENSE names, relative to the repo root. */
const VENDORED = new Set([
  'contracts/test/retired/vendor/FullMath.sol',
  'contracts/test/retired/vendor/TickMath.sol',
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.sol')) out.push(p);
  }
  return out;
}

test('every first-party .sol file declares SPDX-License-Identifier: MIT', () => {
  let seen = 0;
  for (const tree of TREES) {
    for (const p of walk(path.join(ROOT, tree))) {
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      const head = readFileSync(p, 'utf8').slice(0, 200);
      // The vendored carve-outs keep their upstream licence, so MIT is not required of them. What
      // IS required is that they declare something: a vendored file carrying no identifier at all
      // is the same unlabelled-licence problem this test exists to catch. `continue`ing before any
      // assertion ran made the docstring's "still must carry SOME identifier" a comment rather
      // than a check, which a mutation proved. `seen` is deliberately not incremented here, so the
      // >= 80 floor keeps counting only the first-party files actually held to MIT.
      if (VENDORED.has(rel)) {
        assert.ok(
          /SPDX-License-Identifier:\s*\S/.test(head),
          `${rel}: vendored carve-out, so MIT is not required of it, but it must still declare an ` +
            'SPDX-License-Identifier naming the licence it does carry',
        );
        continue;
      }
      assert.ok(
        head.includes('SPDX-License-Identifier: MIT'),
        `${rel}: first line must declare the MIT identifier; LICENSE says the header governs the file, ` +
          'so any other identifier is a licence claim this repository no longer makes',
      );
      assert.ok(
        !head.includes('BUSL'),
        `${rel}: carries a BUSL marker in its header`,
      );
      seen += 1;
    }
  }
  assert.ok(seen >= 80, `walked only ${seen} Solidity files; the first-party trees should hold at least 80`);
});
