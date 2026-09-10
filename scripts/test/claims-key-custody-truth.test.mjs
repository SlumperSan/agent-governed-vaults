/**
 * Key/custody claims about the API process — guarded by shape, in a window, over every file type.
 *
 * ## The defect this exists to refuse
 *
 * `FACILITATOR=svm` settles x402 `exact` on Solana. The client builds and partially signs the whole
 * transaction and the facilitator co-signs as FEE PAYER, so there is nothing to delegate over HTTP:
 * `apps/api/src/serve.mjs` loads `SVM_KEYPAIR` and constructs a `Connection`, both inside the API
 * process. Every blanket "the API holds no key" sentence in this repository became false the day
 * that mode landed — including sentences in files the branch never opened, because the falsehood is
 * authored by the code, not by the edit.
 *
 * Five consecutive review rounds swept for it by hand and five missed at least one site. The sixth
 * found `.env.example`, whose first two lines read:
 *
 *     # ── Runtime configuration for the indexer + API stack ──
 *     # Copy to `.env` and fill in. Never commit a real .env. Neither process holds a private key.
 *
 * Three properties of that miss are the whole design of this file:
 *
 *   1. **The phrasing is a NEGATED POSITIVE.** "Neither process holds a private key" carries none
 *      of `keyless`, `non-custodial`, `no keys`, `holds no key`. A sweep for the positive family
 *      returns 125 hits and not this one. So `CLAIM_PATTERNS` below has two halves and both are
 *      required; adding to one half without the other reopens exactly this hole.
 *   2. **The SUBJECT is on a different line from the CLAIM.** "API" is on line 1, the claim on
 *      line 2. Every line-scoped grep misses it twice — once for the subject, once for the claim.
 *      So matching here is done against a WINDOW of ±`WINDOW` lines, flattened, never a line.
 *   3. **CI could not see the file at all.** `claims-lede-truth.test.mjs` walks `.md`, `.html`,
 *      `.txt` and `.json`. `.env.example` has no extension in that set — nor do `Dockerfile`,
 *      `.mjs` and `.yaml`, which between them hold most of this claim family. So this walk has NO
 *      extension allowlist: it takes every text file it can read and denies only binaries and
 *      generated blobs (`DENY_EXT`).
 *
 * ## The rule
 *
 * A claim of this family, in a window that names the API, must also carry a MODE TOKEN in the same
 * window: `FACILITATOR=stub`, `FACILITATOR=http`, `FACILITATOR=svm`, or `SVM_KEYPAIR`.
 *
 * The token requirement is deliberately not satisfiable by vagueness. "with one exception",
 * "opt-in", "in the launch modes" and a bare mention of the word `svm` all leave the reader to
 * guess which mode and which process, and guessing is what produced two of the sites fixed
 * alongside this file. A reader who sees `FACILITATOR=svm` next to the claim can check it against
 * `resolveApiConfig` in one grep. That is the bar.
 *
 * It is NOT a ban on the claim. `FACILITATOR=stub` and `FACILITATOR=http` genuinely hold no key,
 * and saying so is the single most useful sentence in the runbook. This guard only refuses the
 * UNQUALIFIED form.
 *
 * ## What is deliberately NOT guarded
 *
 * The indexer, the canary, the reference agent, the web front end and the contracts all carry
 * key/custody negatives of their own, and all of them are true — the canary's is enforced by its
 * own tests. `SUBJECT` is therefore narrow on purpose: the window must name the API or its server.
 * Widening `SUBJECT` to "any process" would red a hundred true sentences, and the predictable next
 * move is relaxing the patterns until it goes quiet, which manufactures a green.
 *
 * ## This file exempts itself, and that is a real hole
 *
 * A guard whose job is to carry every banned phrasing verbatim cannot be its own subject: the
 * `CLAIM_PATTERNS` literals below are, by construction, the exact text it bans. So `SELF` is
 * skipped by the walk. The consequence is stated rather than left to be discovered: prose in THIS
 * file is checked by review only. `claims-lede-truth.test.mjs` records the same hole from the other
 * side — its own docstring carried the universal it bans for six instances, invisible to it because
 * `.mjs` was outside its walk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(HERE), '..', '..');
const SELF = path.relative(REPO, HERE).split(path.sep).join('/');

// Build outputs, dependencies, vendored submodules and other agents' worktrees are not our prose.
// `.claude` matters most here: CLAUDE.md's worktree section records that sibling sessions check out
// whole copies of this repository underneath it, and a guard that read them would report another
// session's in-flight text as this branch's defect.
//
// THIS LIST DIVERGES FROM `claims-lede-truth.test.mjs`'s BY TWO ENTRIES, `dist` AND `dist-ssr`, AND
// THAT IS DELIBERATE. Its header argues at length that skipping build output is how a guard goes
// vacuous, and it is right for the claim family IT guards: `apps/site-next` publishes the public
// lede only as prerendered output, so a walk that skips `dist` guards the pages a reader receives
// by nothing. This family is the opposite shape. No page under `apps/site-next` mentions
// `FACILITATOR`, a facilitator mode or a keypair — the whole family lives in the runbook, the
// config templates and `apps/api` source, which are walked here whether or not anything has been
// built. What `dist` would add is a minified bundle whose token soup can match a prose pattern by
// accident, which is a false red on a guard whose value is that its reds are real. So the skip
// costs no coverage of THIS family and buys precision. Said out loud because the sibling header
// states that a skip list two guards disagree on is its own drift; this is the disagreement,
// declared, with its reason. If a public page ever starts describing facilitator modes, delete
// these two entries rather than reasoning from this paragraph.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'lib',
  'out',
  'cache',
  'broadcast',
  'coverage',
  'artifacts',
  'dist',
  'dist-ssr',
]);

// The walk has no allowlist, so the denial has to be explicit. These are files whose bytes are not
// prose in any language: images, fonts, archives, compiled output, lockfiles.
const DENY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.pdf', '.mp4', '.mov', '.webm', '.mp3', '.wav',
  '.wasm', '.node', '.bin',
]);
const DENY_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'foundry.lock']);

/** Files larger than this are generated, not written. 1 MiB is ~15k lines of hard-wrapped prose. */
const MAX_BYTES = 1024 * 1024;

/** Lines either side of a match that count as "the same claim". See property 2 in the header. */
const WINDOW = 3;

/** Every readable text file in the repository, enumerated from the filesystem — never a list. */
const textFiles = () => {
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a directory that vanished mid-walk is not a claim
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (DENY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        if (DENY_FILES.has(entry.name)) continue;
        try {
          if (statSync(full).size > MAX_BYTES) continue;
        } catch {
          continue;
        }
        found.push(full);
      }
    }
  })(REPO);
  return found
    .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    .filter((f) => f !== SELF);
};

/** NUL in the first 4 KiB means bytes, not text. Cheaper and more honest than trusting extensions. */
const readText = (rel) => {
  let text;
  try {
    text = readFileSync(path.join(REPO, rel), 'utf8');
  } catch {
    return null;
  }
  return text.slice(0, 4096).includes('\u0000') ? null : text;
};

/**
 * The claim family, in BOTH phrasings. Neither half may be extended alone — see property 1.
 *
 * The negated half is the one five sweeps missed. It matches an absence-of-a-holder construction
 * ("neither … holds", "no process … holds", "nothing … holds a key", "does not hold … key",
 * "never holds … key", "without a key") rather than any fixed sentence.
 */
const CLAIM_PATTERNS = [
  // ── positive: the claim names its own quality ──
  /\bkeyless\b/i,
  /\bnon-?custodial\b/i,
  /\bno keys\b/i,
  /\bno private keys?\b/i,
  /\bholds? no (?:private )?keys?\b/i,
  // ── negated positive: the claim denies a holder ──
  /\bneither\b[^.!?]{0,90}?\bhold/i,
  /\bno process\b[^.!?]{0,90}?\bhold/i,
  /\bnothing\b[^.!?]{0,90}?\bholds an?\b[^.!?]{0,30}?\bkey/i,
  /\bdoes not hold\b[^.!?]{0,60}?\bkey/i,
  /\bnever holds\b[^.!?]{0,60}?\bkey/i,
  /\bwithout a (?:private )?key\b/i,
];

/** The blanket "no RPC client" shape, found by the same sweep and false for the same reason. */
const RPC_PATTERNS = [
  /\bno RPC client\b/i,
  /\bholds? no RPC\b/i,
  /\bhas no RPC client\b/i,
];

/**
 * The window must be ABOUT the API for either guard to fire. Narrow on purpose — see the header's
 * "what is deliberately NOT guarded".
 */
const SUBJECT = /\bAPIs?\b|\bapps\/api\b|\bserve\.mjs\b|\bthe API server\b/;

/**
 * What clears a match. A mode token, not a mood: the reader can check any of these against
 * `resolveApiConfig` in one grep, and none of them can be satisfied by hedging.
 */
const MODE_TOKEN = /FACILITATOR\s*=\s*[`'"]?(?:svm|stub|http)\b|\bSVM_KEYPAIR\b/i;

/**
 * Exemptions, by exact `path:line`, each with the reason written out.
 *
 * Named individually rather than by loosening a pattern or exempting a directory, because that is
 * how a real miss hides. Two admissible reasons and no third:
 *
 *   RECORD — a dated account of a run that HAPPENED. `docs/X402-LIVE-REPORT.md` describes a
 *            `FACILITATOR=http` run, and "keyless API / key-holding facilitator split" is what that
 *            run was. Rewriting it would make the record describe something that did not happen.
 *
 *   WINDOW — the ±`WINDOW` window is a heuristic and it has a known cost: it reaches across a
 *            paragraph break, a table row and a list item. Where the API is named by a NEIGHBOURING
 *            sentence with a different subject, the claim is true and the match is an artefact of
 *            the window. The alternative — shrinking the window until these stop — reintroduces the
 *            exact miss this file exists for, since `.env.example`'s subject was one line above its
 *            claim. Both entries below name the claim's real subject, which is what makes them
 *            checkable rather than a mute.
 *
 * An entry whose reason cannot be written in one clause is a claim that needs fixing, not exempting.
 */
const EXEMPT = new Map([
  ['docs/X402-LIVE-REPORT.md:41', 'RECORD: a FACILITATOR=http run; the API was keyless in it'],
  ['docs/X402-LIVE-REPORT.md:305', 'RECORD: same run — the keyless-API/key-holding-facilitator split as measured'],
  ['docs/audit/TEST-CROSS-REFERENCE.md:125', 'WINDOW: subject is the canary and the reference agent, both genuinely keyless; `apps/api` is two lines later in a different sentence about audit scope'],
  ['docs/LAUNCH-READINESS.md:278', 'WINDOW: subject is scripts/verify-chainlink-oracle.mjs, which is read-only and keyless; the API is two table ROWS above, at line 276'],
]);

/**
 * Every unqualified claim of `patterns` whose window names the API.
 *
 * Exported shape is `{file, line, quote}`. `line` is 1-based so it pastes into an editor and into
 * `RECORDS` unchanged.
 *
 * @param {RegExp[]} patterns
 * @param {{files?: string[], read?: (rel:string)=>string|null}} [opts]
 */
function unqualifiedClaims(patterns, { files = textFiles(), read = readText } = {}) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (text == null) continue;
    // Cheap reject: a file with no subject anywhere cannot produce a window with one.
    if (!SUBJECT.test(text)) continue;
    // EMPHASIS IS STRIPPED BEFORE MATCHING, and this is the third thing that hid a false claim
    // from a sweep. `holds **no key**` does not match /holds no key/, and bolding exactly these
    // words is this repository's dominant style — `**no key**`, `**Keyless by design**`,
    // `**non-custodial**`, and this very branch's `**no client for the indexed chain by design**`.
    // A guard for a claim family has to read the family as a reader sees it, not as the plainest
    // author happened to type it. Measured over the tree: stripping these three characters turns
    // up exactly one true finding and zero new false positives.
    const lines = text.split(/\r?\n/).map((l) => l.replace(/[*_`]/g, ''));
    const raw = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!patterns.some((p) => p.test(lines[i]))) continue;
      const window = lines
        .slice(Math.max(0, i - WINDOW), Math.min(lines.length, i + WINDOW + 1))
        .join(' ')
        .replace(/\s+/g, ' ');
      if (!SUBJECT.test(window)) continue;
      if (MODE_TOKEN.test(window)) continue;
      const key = `${file}:${i + 1}`;
      if (EXEMPT.has(key)) continue;
      hits.push({ file, line: i + 1, quote: raw[i].trim() });
    }
  }
  return hits;
}

const report = (hits) => hits.map((h) => `  ${h.file}:${h.line}: "${h.quote}"`).join('\n');

// ---------------------------------------------------------------------------------------------
// Guard 1 — a key/custody negative about the API must name the mode it is true of.
// ---------------------------------------------------------------------------------------------
test('no unqualified key/custody claim about the API', () => {
  const hits = unqualifiedClaims(CLAIM_PATTERNS);
  assert.equal(
    hits.length,
    0,
    `Unqualified key/custody claim(s) about the API:\n${report(hits)}\n\n`
      + 'Under `FACILITATOR=svm` the API loads `SVM_KEYPAIR` and co-signs as fee payer\n'
      + '(apps/api/src/serve.mjs), so a blanket "the API holds no key" is false at this head.\n'
      + 'Name the mode within 3 lines of the claim — `FACILITATOR=stub` and `FACILITATOR=http`\n'
      + 'hold no key, `FACILITATOR=svm` does. Do not delete the sentence and do not widen this\n'
      + 'guard: the qualified form is the useful one.\n'
      + 'If the line is a dated record of a run that happened, add it to EXEMPT with its reason.',
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 2 — the same shape, one noun over. `serve.mjs` constructs `new Connection(...)` in svm
// mode, so "the API holds no RPC client" is false for exactly the same reason and was missed by
// exactly the same sweeps.
// ---------------------------------------------------------------------------------------------
test('no unqualified "no RPC client" claim about the API', () => {
  const hits = unqualifiedClaims(RPC_PATTERNS);
  assert.equal(
    hits.length,
    0,
    `Unqualified "no RPC client" claim(s) about the API:\n${report(hits)}\n\n`
      + '`FACILITATOR=svm` constructs a Solana `Connection` in apps/api/src/serve.mjs. The true\n'
      + 'claim is narrower and is the one the sentence was reaching for: the API holds no client\n'
      + 'for the INDEXED CHAIN, which is why it reports snapshot age and not a blocks-behind\n'
      + 'figure. Say that, and name the mode.',
  );
});

// ---------------------------------------------------------------------------------------------
// PROBE, NOT A GUARD — the mutation, kept.
//
// Both wordings below are retired text, quoted here so the patterns can never go quiet without a
// test going red. A guard that stops matching is indistinguishable from a repository that stopped
// lying, and this family has produced two consecutive review rejections on exactly that confusion.
// ---------------------------------------------------------------------------------------------
const RETIRED = [
  {
    what: 'the negated positive, .env.example:1-2 before this commit',
    file: '.env.example',
    text: '# ── Runtime configuration for the indexer + API stack ──\n'
      + '# Copy to `.env` and fill in. Never commit a real .env. Neither process holds a private key.\n',
    line: 2,
  },
  {
    what: 'the positive, packages/canary/README.md before 1ecb4877',
    file: 'packages/canary/README.md',
    text: 'The indexer and API are non-custodial (no keys).\n',
    line: 1,
  },
];

test('probe: the patterns still catch both retired wordings', () => {
  for (const r of RETIRED) {
    const hits = unqualifiedClaims(CLAIM_PATTERNS, {
      files: [r.file],
      read: (rel) => (rel === r.file ? r.text : null),
    });
    assert.equal(
      hits.length,
      1,
      `guard 1 no longer catches ${r.what} — it matched ${hits.length} times, expected 1.\n`
        + 'A pattern was narrowed or the window shrank. Restore it rather than deleting this probe.',
    );
    assert.equal(hits[0].line, r.line);
  }
});

test('probe: naming the mode clears the claim, and a bare "svm" does not', () => {
  const subject = '# Runtime configuration for the indexer + API stack\n';
  const claim = '# Neither process holds a private key';

  const vague = unqualifiedClaims(CLAIM_PATTERNS, {
    files: ['probe'],
    read: () => `${subject}${claim} — except in svm mode, which is opt-in.\n`,
  });
  assert.equal(
    vague.length,
    1,
    'a bare "svm" plus "opt-in" cleared the guard. MODE_TOKEN is meant to require\n'
      + '`FACILITATOR=<mode>` or `SVM_KEYPAIR` precisely so hedging cannot satisfy it.',
  );

  const named = unqualifiedClaims(CLAIM_PATTERNS, {
    files: ['probe'],
    read: () => `${subject}${claim} — except the API under \`FACILITATOR=svm\`.\n`,
  });
  assert.equal(named.length, 0, `naming FACILITATOR=svm should clear it:\n${report(named)}`);
});

// The walk is the coverage, so assert it reached the file type that produced the defect. A pass
// over nothing reads exactly like a pass over everything — the failure `claims-lede-truth.test.mjs`
// records twice, once for the store axis and once for the file-type axis.
test('coverage: the walk reaches extensionless and non-.md config templates', () => {
  const files = textFiles();
  for (const required of ['.env.example', 'Dockerfile', 'apps/api/src/serve.mjs', 'docs/api/openapi.yaml']) {
    assert.ok(
      files.includes(required),
      `the walk did not reach ${required}. Every guard above is then vacuous over the file type\n`
        + 'that produced this defect. Check SKIP_DIRS, DENY_EXT and MAX_BYTES before anything else.',
    );
  }
});
