/**
 * The build for app.rwally.com, which is a copy.
 *
 * WHY THERE IS NO BUNDLER. This surface is one HTML file, one stylesheet, one
 * ES module and two font files. A bundler would add a dependency tree, a lock
 * file entry and a build cache to save nothing: there is no JSX to compile, no
 * import graph to flatten and no dead code to shake. The page is authored in
 * the form the browser receives, so what you read in src/ is what ships.
 *
 * WHY THERE IS NO package.json EITHER. The repository root declares the
 * workspace glob `apps/*`, and a workspace package that is absent from
 * package-lock.json makes `npm ci` fail at the root for every other session in
 * this checkout. `apps/site` carries no package.json for the same reason and
 * the precedent is deliberate. Run this file directly:
 *
 *     node apps/app/build.mjs
 *
 * WHAT THE COPY HAS TO CARRY, and the one that is easy to lose: `_headers`.
 * Cloudflare Pages reads it from the root of the SERVED directory, so it lives
 * in src/ and lands at dist/_headers. A missing _headers produces no error and
 * no warning anywhere; the deploy simply serves with no Content-Security-Policy
 * and looks exactly like a correct one.
 *
 * DIST IS REBUILT, NOT PATCHED. The output directory is removed first, so a
 * file deleted from src/ cannot survive in a deploy as a stale artefact.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const DIST = path.join(HERE, 'dist');

/** Every file under a directory, relative and slash-separated, for the report. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(SRC, DIST, { recursive: true });

const files = await walk(DIST);
if (!files.includes('index.html')) throw new Error('build: dist/index.html is missing');
if (!files.includes('_headers')) throw new Error('build: dist/_headers is missing, so the deploy would carry no CSP');

console.log('built ' + files.length + ' files into apps/app/dist');
for (const f of files) console.log('  ' + f);
