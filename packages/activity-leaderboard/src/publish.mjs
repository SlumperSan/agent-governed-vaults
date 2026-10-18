// @ts-check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFileText } from './board.mjs';
import { sha256Hex } from './canonical.mjs';

/**
 * The publisher. OFF BY DEFAULT: unless the environment variable LEADERBOARD_PUBLISH is exactly
 * `yes`, it prints what it would write and touches nothing.
 *
 * When on, it writes a commit to the LOCAL ref `refs/heads/leaderboard-data` of the repository it is
 * pointed at, using git plumbing only (no checkout, no working-tree change, no push). The first
 * commit has no parent, so the branch is an orphan that shares no history with the code branches.
 * Pushing it and serving it are separate steps, deliberately not performed here.
 *
 * Files: `epochs/NNNN.json` for a CLOSED epoch (immutable: an existing epoch file with different
 * bytes is refused), and `latest.json` for the newest board of any status.
 */

export const PUBLISH_BRANCH = 'leaderboard-data';
export const PUBLISH_FLAG = 'LEADERBOARD_PUBLISH';

/** @param {{epoch:{number:number,status:string}}} board */
export function filesFor(board) {
  /** @type {Record<string,string>} */
  const files = { 'latest.json': boardFileText(board) };
  if (board.epoch.status === 'closed') files[`epochs/${String(board.epoch.number).padStart(4, '0')}.json`] = boardFileText(board);
  return files;
}

const git = (repo, args, opts = {}) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/**
 * @param {object} p
 * @param {string} p.repoDir          a git repository (its refs are what gets written)
 * @param {Record<string,string>} p.files  path -> file text
 * @param {string} p.message
 * @param {Record<string,string|undefined>} [p.env]  defaults to process.env
 */
export function publish({ repoDir, files, message, env = process.env }) {
  const plan = Object.entries(files)
    .map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const ref = `refs/heads/${PUBLISH_BRANCH}`;
  if (env[PUBLISH_FLAG] !== 'yes') {
    return { published: false, dryRun: true, ref, plan, note: `dry run: set ${PUBLISH_FLAG}=yes to write ${ref}` };
  }

  let parent = null;
  try { parent = git(repoDir, ['rev-parse', '--verify', '--quiet', ref]); } catch { parent = null; }

  const tmp = mkdtempSync(join(tmpdir(), 'leaderboard-index-'));
  const indexEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    if (parent) git(repoDir, ['read-tree', parent], { env: indexEnv });
    for (const [path, text] of Object.entries(files)) {
      if (parent && path.startsWith('epochs/')) {
        let existing = null;
        try { existing = execFileSync('git', ['-C', repoDir, 'show', `${parent}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { existing = null; }
        if (existing !== null && existing !== text) throw new Error(`publish: ${path} already exists with different bytes; closed epochs are immutable`);
      }
      const blob = execFileSync('git', ['-C', repoDir, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).trim();
      git(repoDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env: indexEnv });
    }
    const tree = git(repoDir, ['write-tree'], { env: indexEnv });
    const commit = git(repoDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    git(repoDir, ['update-ref', ref, commit, ...(parent ? [parent] : [])]);
    return { published: true, dryRun: false, ref, commit, plan };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
