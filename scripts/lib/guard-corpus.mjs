/**
 * ONE CORPUS DERIVATION FOR EVERY GUARD THAT WALKS FILES.
 *
 * ## Why this exists
 *
 * Four claims/secret guards in this repository each derived their own file set, and **two of the
 * four shipped a corpus that was complete until it wasn't** — zero shipped a broken extractor:
 *
 * - `claims-vaults-ui-prose-truth.test.mjs` named two directories (`src/components`, `src/lib`)
 *   non-recursively. `apps/vaults-ui/src` has four modules at its root, and `App.tsx` — the only
 *   file in the app carrying the enumerated operator-authority sentence that guard polices — was
 *   outside the corpus. A planted violation in it reddened nothing.
 * - `simulate-before-sign.test.mjs` named three Solidity files while `VaultCore` binds three
 *   libraries via `using`, so `SafeTransferLib`'s `TransferFromFailed` was unreachable by the scan
 *   that asserted every revert was decodable.
 *
 * Both passed their own tests **by construction**, and both were caught only because a person
 * planted a fresh violation in a location the corpus did not name and watched the guard stay green.
 *
 * So the extractors stay separate — they are three genuinely different problems (a JS lexer, a TSX
 * AST, static markup) and collapsing them means one change can break three surfaces. **Only the
 * part that failed twice is consolidated here.** Chairman's call, 2026-09-21.
 *
 * ## The contract every consumer gets
 *
 * A corpus is derived from the filesystem or from git, never from a list, and it is returned
 * together with a tripwire that **THROWS** rather than warns. A guard that can skip is a guard that
 * will: a warn on a shrunken corpus is a green build over reduced coverage, which reads identically
 * to a green build over full coverage.
 *
 * ## The rule this file exists to make mandatory
 *
 * Any guard consuming this must carry a test that **plants a violation in a location the previous
 * corpus did not name, and expects RED.** A file count proves the corpus did not shrink; it does not
 * prove the corpus reaches the prose. Those are different claims, and the gap between them is where
 * both defects above lived.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Every file under `root`, RECURSIVELY, whose name ends in one of `exts`.
 *
 * No directory list and no per-directory extension rules — that shape is what failed. Exclusions are
 * by EXTENSION only (`excludeSuffixes`), because an extension describes what a file *is* while a
 * directory name describes only where someone put it, and the second goes stale when someone moves
 * it.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @param {string} root repo-relative directory to walk
 * @param {{exts: string[], excludeSuffixes?: string[]}} opts
 * @returns {string[]} repo-relative paths, sorted
 */
export function filesUnder(repoRoot, root, { exts, excludeSuffixes = [] }) {
  /** @type {string[]} */
  const found = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (
        e.isFile() &&
        exts.some((x) => e.name.endsWith(x)) &&
        !excludeSuffixes.some((x) => e.name.endsWith(x))
      ) {
        found.push(child);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Every file git TRACKS, which is the authoritative answer to "what is published in this repository"
 * — the corpus a secret-shape guard needs, and one no directory walk can produce correctly (a walk
 * cannot tell a tracked file from a local scratch file, and `.gitignore` is not a thing to
 * reimplement).
 *
 * `-z` and a NUL split, deliberately: a path containing a space or a quote is mangled by git's
 * default path quoting, and a mangled path silently drops out of the corpus.
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths, sorted
 */
export function trackedFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).sort();
}

/**
 * Whether a file is text this repository's guards can meaningfully scan.
 *
 * DERIVED, NOT A NAMED EXTENSION LIST. A list of "binary extensions" is the same staleness shape as
 * a list of directories — the next image format nobody added slips through as text and produces
 * garbage matches, or a text file with an unusual extension gets skipped silently. A NUL byte in the
 * first 8 KiB is the standard heuristic and it is what git itself uses to decide binary-ness.
 *
 * @param {string} abs absolute path
 */
export function isProbablyText(abs) {
  try {
    if (statSync(abs).size === 0) return true;
    return !readFileSync(abs).subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

/**
 * THE TRIPWIRE. Throws unless the corpus still looks like a corpus.
 *
 * `minFiles` catches the set shrinking. `minRootFiles` catches the set changing SHAPE — a walk that
 * covers subdirectories and silently skips the root clears any sane total floor, which is exactly
 * how `App.tsx` went unread while ten subdirectory files kept the count healthy. `mustInclude`
 * pins named files whose presence is the whole point of the corpus, so their coverage never rests on
 * a count happening to clear a floor.
 *
 * Throws rather than returning a boolean, so a consumer cannot accidentally treat a shrunken corpus
 * as a warning.
 *
 * @param {string[]} files repo-relative paths
 * @param {{label: string, minFiles: number, root?: string, minRootFiles?: number, mustInclude?: string[]}} opts
 * @returns {string[]} `files`, unchanged, so this can wrap a derivation inline
 */
export function assertCorpus(files, { label, minFiles, root, minRootFiles, mustInclude = [] }) {
  if (files.length < minFiles) {
    throw new Error(
      `${label}: corpus is ${files.length} file(s), below the floor of ${minFiles}. Either the ` +
        "surface moved or this guard's derivation is wrong. This THROWS rather than warns because a " +
        'green build over reduced coverage reads identically to a green build over full coverage.',
    );
  }
  if (root !== undefined && minRootFiles !== undefined) {
    const atRoot = files.filter((f) => f.startsWith(`${root}/`) && !f.slice(root.length + 1).includes('/'));
    if (atRoot.length < minRootFiles) {
      throw new Error(
        `${label}: only ${atRoot.length} file(s) directly in ${root}, below the floor of ` +
          `${minRootFiles}. A walk that reaches the subdirectories and misses the root passes a ` +
          `total-count floor while leaving the root unread — the defect this floor exists for. ` +
          `Found: ${atRoot.join(', ') || '(none)'}`,
      );
    }
  }
  const missing = mustInclude.filter((f) => !files.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `${label}: corpus is missing file(s) it is defined to cover: ${missing.join(', ')}. These are ` +
        'pinned by name because their coverage must not rest on a count clearing a floor.',
    );
  }
  return files;
}
