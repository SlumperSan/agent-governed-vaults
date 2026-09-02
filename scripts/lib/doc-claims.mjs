/**
 * Resolve the checkable claims a document makes about the repository.
 *
 * Two claim shapes, both of which went silently false on `protocol/main` in one night:
 *
 *  1. **`file:line` citations.** A triage of record is a mapping from `file:line` to a
 *     disposition. When the line moves the document does not become useless — it keeps asserting
 *     a disposition, about the wrong code, and the citation text never changed so nothing shows
 *     up in a diff. PR #110 merged `protocol/main` into itself and shipped 12 of 16 citations
 *     pointing at unrelated lines: the row for the ERC-4626 inflation site (`_mintShares`)
 *     resolved to `require(p.amountUsdc > 0, NoPending());`, and the row for `convertToAssets`
 *     resolved to `return _eligibleHist[member].getAt(ts);`.
 *
 *  2. **Present-tense claims about pull-request state.** "#98 is OPEN, so H-9 is UNFIXED on
 *     `protocol/main`" reads perfectly after #98 merges. A wrong line number is at least visibly
 *     wrong to whoever follows it; a wrong branch-state claim is not.
 *
 * Both are resolved from the repository itself — the source tree and `git log` — so this module
 * is offline and deterministic. It does not call `gh`, and it must not: a merge gate that needs
 * the network is a merge gate somebody switches off.
 *
 * ## Why the assertion is on the enclosing SYMBOL, not on the text of the line
 *
 * Asserting a substring of the cited line makes the guard fire on `forge fmt`, on a reflowed
 * comment, on a renamed local — none of which invalidate the citation. A guard with false
 * positives gets deleted, and then the real defect ships. The enclosing declaration is the
 * coarsest thing that still changes exactly when the citation stops meaning what it said, so
 * that is what is checked: `VaultCore.sol:445` is asserted to be inside `_mintShares`, not to
 * contain any particular characters.
 *
 * The expectation comes from the prose, not from a lockfile. A checked-in expected-value file is
 * regenerated blindly the moment it goes red — that is exactly what happened to `.gas-snapshot`
 * — and it puts the expectation where no reader looks. These documents already name the symbol
 * each row is about (`` `VaultCore.sol:342` `navPerShareWad` ``), so the guard reads the
 * expectation out of the sentence that makes the claim. Writing the symbol next to the line
 * number is also what makes a citation survivable by a human after the next rebase.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const NEWLINE = /\r?\n/;
const SOURCE_EXT = /\.(sol|mjs|ts|json|sh|yml|yaml)$/;

/** A citation: `VaultCore.sol:445`, `contracts/src/VaultCore.sol:445`, `Governance.sol:519-521`. */
const CITATION =
  /([A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\.(?:sol|mjs|ts|json|sh|yml|yaml)):(\d+)(?:-(\d+))?/g;

const TICKED = /`([^`]{1,120})`/g;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Present-tense claims that a pull request is unmerged. Deliberately narrow: the clause must name
 * a PR number AND assert openness. "#98 raised this" is a reference, not a claim, and a guard
 * that cannot tell them apart is a guard someone turns off.
 */
const OPEN_CLAIM = [
  /#(\d+)\s+is\s+(?:still\s+)?open\b/gi,
  /#(\d+)\s+is\s+(?:still\s+)?(?:un|not\s+)merged\b/gi,
  /#(\d+)\s+has\s+not\s+(?:yet\s+)?(?:been\s+)?merged\b/gi,
  /#(\d+)\s+is\s+(?:still\s+)?in\s+flight\b/gi,
  /\bopen\s+PR\s+#(\d+)/gi,
  /\bPR\s+#(\d+)\s*\((?:still\s+)?open\)/gi,
];

/** Documents that record a moment rather than assert the present. Opt OUT, never opt IN. */
export const RECORD_MARKER = 'doc-claims: historical record';

export function isHistoricalRecord(text) {
  return text.includes(RECORD_MARKER);
}

// ── the source tree ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'out', 'cache', 'broadcast']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export const DEFAULT_SOURCE_ROOTS = [
  'contracts/src',
  'contracts/script',
  'contracts/test',
  'contracts/config',
  'scripts',
  'packages',
  'apps',
];

/**
 * Index every source file by basename AND by every path suffix, so `VaultCore.sol:445` and
 * `contracts/src/VaultCore.sol:445` both resolve, and an ambiguous basename is reported as
 * ambiguous rather than guessed at.
 */
export function indexSources(repo, roots = DEFAULT_SOURCE_ROOTS) {
  const byKey = new Map();
  for (const root of roots) {
    let files;
    try {
      files = walk(path.join(repo, root));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!SOURCE_EXT.test(file)) continue;
      const rel = path.relative(repo, file).split(path.sep).join('/');
      const parts = rel.split('/');
      for (let i = parts.length - 1; i >= 0; i--) {
        const key = parts.slice(i).join('/');
        if (!byKey.has(key)) byKey.set(key, new Set());
        byKey.get(key).add(rel);
      }
    }
  }
  return byKey;
}

// ── enclosing-symbol resolution ───────────────────────────────────────────────

const DECL = [
  /\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /\b(?:function|modifier|struct|event|error|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /\b(constructor)\s*\(/,
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /\b(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(|function)/,
];

const OWN_DECL = [
  /\b(?:constant|immutable)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  /\b(?:error|event)\s+([A-Za-z_][A-Za-z0-9_]*)/,
];

/**
 * Every symbol whose body encloses `line` (1-indexed), plus any symbol declared on the line
 * itself. Brace depth, not a parser: these files are formatted by `forge fmt`, and a Solidity
 * parser is a dependency this check has not earned.
 */
export function symbolsAt(text, line) {
  const lines = text.split(NEWLINE);
  const stack = [];
  const found = [];
  let depth = 0;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const code = lines[i].replace(/\/\/.*$/, '');
    let decl = null;
    for (const re of DECL) {
      const m = code.match(re);
      if (m) {
        decl = m[1];
        break;
      }
    }
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;
    if (decl) stack.push({ name: decl, depth, pending: opens === 0 });
    depth += opens - closes;
    while (stack.length && depth <= stack[stack.length - 1].depth) {
      if (stack[stack.length - 1].pending && opens === 0 && closes === 0) break;
      stack.pop();
    }
    if (i + 1 === line) {
      for (const s of stack) found.push(s.name);
      for (const re of OWN_DECL) {
        const m = code.match(re);
        if (m) found.push(m[1]);
      }
      if (decl) found.push(decl);
    }
  }
  return [...new Set(found)];
}

// ── claim extraction ──────────────────────────────────────────────────────────

/**
 * Proximity, not the whole line, and that is the difference between a guard and a rubber stamp.
 * A wide table row names a dozen symbols; "does the cited line contain ANY of them" then passes
 * by luck, and the check quietly loses the ability to fail — the very defect this module exists
 * to catch, reproduced inside it. So the anchors are the backticked identifiers NEAREST the
 * citation, within a window, closest first, capped.
 */
const ANCHOR_WINDOW = 90;
const ANCHOR_MAX = 3;

/**
 * A fenced block is pasted code or pasted tool output — `--> test/retired/PythSource.sol:4:1` is
 * Slither reporting where it looked, not the document asserting anything. Blank those regions
 * (preserving offsets) rather than checking them: being wrong about what counts as a claim is how
 * a guard gets switched off.
 */
function blankFences(text) {
  const lines = text.split('\n');
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return ' '.repeat(line.length);
      }
      return fenced ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

export function citationsIn(text) {
  // Offsets over the WHOLE document, not per line: these documents hard-wrap, and a code span
  // that wraps ("`try ...\ncatch {}`") inverts backtick pairing on every following line if you
  // scan line by line — silently emptying the anchor list, which would let any wrapped sentence
  // walk past the guard.
  const scan = blankFences(text.replace(/\r\n/g, '\n'));
  const lineStarts = [0];
  for (let i = 0; i < scan.length; i++) if (scan[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = scan.split('\n');

  const ticked = [];
  for (const t of scan.matchAll(/`([^`\n]{1,200}(?:\n[^`\n]{0,200})?)`/g)) {
    const inner = t[1].replace(/\s*\n\s*/g, ' ');
    const at = t.index ?? 0;
    const push = (name) => ticked.push({ name, at });
    if (IDENTIFIER.test(inner)) push(inner);
    const dotted = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\(?\)?$/);
    if (dotted) {
      push(dotted[1]);
      push(dotted[2]);
    }
    const called = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (called) push(called[1]);
  }

  // Full citations first, then the bare `:N` continuations that follow one ("`VaultCore.sol:480`;
  // `deposit` (`:387`)"). These are everywhere in these documents and go stale just as readily,
  // so they resolve against the nearest preceding full citation's file rather than being ignored.
  const sites = [];
  for (const m of scan.matchAll(CITATION)) {
    sites.push({ at: m.index ?? 0, raw: m[0], file: m[1], start: Number(m[2]), end: m[3] ? Number(m[3]) : Number(m[2]) });
  }
  for (const m of scan.matchAll(/`:(\d+)(?:-(\d+))?`/g)) {
    const at = m.index ?? 0;
    const prior = sites.filter((s) => s.at < at && lineOf(s.at) === lineOf(at)).sort((a, b) => b.at - a.at)[0];
    if (!prior) continue;
    sites.push({ at, raw: m[0], file: prior.file, start: Number(m[1]), end: m[2] ? Number(m[2]) : Number(m[1]) });
  }

  const out = [];
  for (const s of sites) {
    const anchors = ticked
      .map((t) => ({ name: t.name, d: Math.abs(t.at - s.at) }))
      .filter((t) => t.d <= ANCHOR_WINDOW)
      .sort((a, b) => a.d - b.d)
      .slice(0, ANCHOR_MAX)
      .map((t) => t.name);
    const line = lineOf(s.at);
    out.push({
      line,
      raw: s.raw,
      file: s.file,
      start: s.start,
      end: s.end,
      anchors: [...new Set(anchors)],
      context: (lines[line - 1] ?? '').trim().slice(0, 160),
    });
  }
  return out;
}

/** PR numbers a document claims are still open. */
export function openPrClaimsIn(text) {
  const out = [];
  const lines = text.split(NEWLINE);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    for (const re of OPEN_CLAIM) {
      for (const m of line.matchAll(new RegExp(re.source, re.flags))) {
        out.push({ line: idx + 1, pr: Number(m[1]), raw: m[0], context: line.trim().slice(0, 160) });
      }
    }
  }
  return out;
}

/**
 * PR numbers merged into `ref`, read from git history — offline, no `gh`. Covers merge commits
 * ("Merge pull request #92 from ...") and squashes ("... (#98)"). Returns null when the ref is
 * absent from this checkout, which the caller must treat as "cannot check", never as "clean".
 */
export function mergedPrNumbers(repo, ref = 'origin/protocol/main') {
  let log;
  try {
    log = execFileSync('git', ['-C', repo, 'log', '--format=%s', ref], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const merged = new Set();
  for (const subject of log.split('\n')) {
    const m1 = subject.match(/^Merge pull request #(\d+)\b/);
    if (m1) merged.add(Number(m1[1]));
    const m2 = subject.match(/\(#(\d+)\)\s*$/);
    if (m2) merged.add(Number(m2[1]));
  }
  return merged;
}

// ── checking ──────────────────────────────────────────────────────────────────

/**
 * @param {string} repo repository root
 * @param {string[]} docs document paths relative to `repo`
 * @param {{ref?: string, requireAnchor?: boolean, sourceRoots?: string[]}} opts
 */
/**
 * Waivers exist because a guard that cannot land is worth nothing, and one live citation set is
 * mid-flight in another PR. They are self-expiring in BOTH directions: a waiver whose `ownedByPr`
 * has merged is itself an error, and so is a waiver that no longer matches anything. That is the
 * difference between this and the hand-maintained allow-lists that went stale twice this week.
 */
export function loadWaivers(repo, file = 'scripts/doc-claims-waivers.json') {
  try {
    return JSON.parse(readFileSync(path.join(repo, file), 'utf8')).waivers ?? [];
  } catch {
    return [];
  }
}

export function checkDocs(repo, docs, opts = {}) {
  const { ref = 'origin/protocol/main', requireAnchor = true, sourceRoots, waivers = loadWaivers(repo) } = opts;
  const index = indexSources(repo, sourceRoots);
  const merged = mergedPrNumbers(repo, ref);
  const waiverHits = new Map(waivers.map((w) => [w, 0]));
  const sourceCache = new Map();
  const problems = [];
  const skipped = [];
  let checked = 0;

  for (const doc of docs) {
    const text = readFileSync(path.join(repo, doc), 'utf8');
    if (isHistoricalRecord(text)) {
      skipped.push(doc);
      continue;
    }

    for (const c of citationsIn(text)) {
      const candidates = index.get(c.file);
      if (!candidates) continue; // a filename in prose, or a file outside this repo
      checked++;
      if (candidates.size > 1) {
        problems.push({
          kind: 'ambiguous',
          doc,
          ...c,
          detail: `matches ${[...candidates].join(', ')} — cite a path, not a basename`,
        });
        continue;
      }
      const rel = [...candidates][0];
      if (!sourceCache.has(rel)) sourceCache.set(rel, readFileSync(path.join(repo, rel), 'utf8'));
      const src = sourceCache.get(rel);
      const total = src.split(NEWLINE).length;
      if (c.start > total) {
        problems.push({ kind: 'out-of-range', doc, ...c, detail: `${rel} has ${total} lines` });
        continue;
      }
      if (!c.anchors.length) {
        if (requireAnchor) {
          problems.push({
            kind: 'unanchored',
            doc,
            ...c,
            detail:
              'no backticked symbol next to the citation — name the symbol it is about ' +
              `(e.g. \`${c.raw}\` \`someFunction\`), so that a moved line can be detected at all`,
          });
        }
        continue;
      }
      // A citation's subject is legitimately either the declaration that CONTAINS the line
      // ("`VaultCore.sol:480` `_mintShares`") or a symbol USED on it ("`DeployTestnet.s.sol:181`
      // `isAllowedOracle`"). Both are honest ways to write the reference, so both resolve. The
      // second is a text match, but only ever against an identifier the prose itself named —
      // not the open-ended "does this line still look similar" that would fire on `forge fmt`.
      const symbols = new Set();
      const srcLines = src.split(NEWLINE);
      const used = new Set();
      for (let ln = c.start; ln <= Math.min(c.end, total); ln++) {
        for (const s of symbolsAt(src, ln)) symbols.add(s);
        for (const w of srcLines[ln - 1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) used.add(w);
      }
      if (!c.anchors.some((a) => symbols.has(a) || used.has(a))) {
        problems.push({
          kind: 'moved',
          doc,
          ...c,
          detail:
            `${rel}:${c.start}${c.end !== c.start ? `-${c.end}` : ''} is inside ` +
            `{${[...symbols].join(', ') || 'nothing'}} and mentions none of them; ` +
            `the citation names {${c.anchors.join(', ')}}`,
        });
      }
    }

    if (merged) {
      for (const claim of openPrClaimsIn(text)) {
        checked++;
        if (merged.has(claim.pr)) {
          problems.push({
            kind: 'merged-pr-claimed-open',
            doc,
            line: claim.line,
            raw: claim.raw,
            context: claim.context,
            detail:
              `#${claim.pr} is merged into ${ref}; this document still asserts it is open. ` +
              'Re-read the claim that DEPENDS on it: branch state establishes that the premise ' +
              'is gone, not that the conclusion is safe.',
          });
        }
      }
    }
  }
  // Waivers apply last, so the report still knows what they are hiding.
  const kept = [];
  for (const p of problems) {
    const w = waivers.find((x) => x.doc === p.doc && x.citation === p.raw);
    if (w) waiverHits.set(w, waiverHits.get(w) + 1);
    else kept.push(p);
  }
  for (const [w, hits] of waiverHits) {
    if (merged && merged.has(w.ownedByPr)) {
      kept.push({
        kind: 'waiver-expired',
        doc: 'scripts/doc-claims-waivers.json',
        line: 0,
        raw: `${w.doc} ${w.citation}`,
        context: w.why ?? '',
        detail: `#${w.ownedByPr} has merged into ${ref}; delete this waiver and check the citation for real.`,
      });
    } else if (hits === 0) {
      kept.push({
        kind: 'waiver-unused',
        doc: 'scripts/doc-claims-waivers.json',
        line: 0,
        raw: `${w.doc} ${w.citation}`,
        context: w.why ?? '',
        detail: 'this waiver no longer suppresses anything — delete it rather than leaving a permission nobody needs.',
      });
    }
  }
  return { problems: kept, checked, skipped, waivers, canCheckPrState: merged !== null };
}

export function formatProblems(problems) {
  return problems
    .map((p) => `  ${p.doc}:${p.line}  [${p.kind}]  ${p.raw}\n      ${p.detail}\n      > ${p.context}`)
    .join('\n');
}
