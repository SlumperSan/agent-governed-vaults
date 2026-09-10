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
 *      So the SUBJECT is looked for in a WINDOW of ±`WINDOW` lines, flattened, never a line, and
 *      the CLAIM itself is matched over a forward join of `CLAIM_SPAN` lines (see "gap 2" below).
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
 * ## The two completeness gaps an independent review found after this landed
 *
 * Both were demonstrated against synthetics and neither had a live instance in the tree. They are
 * closed here, and the synthetics are kept as tests (`SYNTHETIC` below) because a pattern with no
 * live instance is otherwise indistinguishable from a pattern that matches nothing.
 *
 *   **Gap 1 — `SVM_KEYPAIR` was advertised as a clearing token and could never match.** The
 *   emphasis normaliser strips `*`, `_` and `` ` `` from every line before matching, so by the time
 *   `MODE_TOKEN` saw the token it read `SVMKEYPAIR` and the `\bSVM_KEYPAIR\b` alternative was dead.
 *   It failed SAFE — extra reds, never fewer — but the header and the assertion message both told a
 *   reader that writing `SVM_KEYPAIR` next to a claim would clear it, and it would not. Fixed by
 *   making the token tolerate the strip (`SVM_?KEYPAIR`) rather than by dropping `_` from the
 *   normaliser: `_no key_` is live markdown emphasis in this repository, and a normaliser that
 *   stopped folding it would fail UNSAFE on the claim half, which is the wrong direction for the
 *   one character that decides whether a claim is seen at all.
 *
 *   **Gap 2 — the claim was matched single-line while only the subject was windowed.** This repo
 *   hard-wraps prose at 100 columns, so `Neither the indexer nor the API process\nholds a private
 *   key.` passed while the same sentence on one line redded. The docstring stated the windowing
 *   property in general terms and so overstated what was implemented. Fixed by matching each claim
 *   over `lines[i .. i + CLAIM_SPAN]` joined, and reporting the hit only when the match BEGINS
 *   inside line `i` — which is also what keeps one wrapped claim from being reported `CLAIM_SPAN`
 *   times. The `[^.!?]` bounds already in the negated-positive patterns stop a join at a sentence
 *   boundary, so the join cannot weld two unrelated sentences into one claim.
 *
 *   Measured cost of gap 2 on the tree as it stands: zero true cross-line claims exist to catch
 *   today (its whole value is prospective) and it produced exactly one new match, at
 *   `apps/web/index.html:1583`, which is TRUE and is exempted below with its geometry written out.
 *   That ratio is stated rather than buried: a reviewer will compute it.
 *
 * ## What was measured and DELIBERATELY NOT added
 *
 * The same review listed further phrasings. Widening a pattern set has a false-positive cost, and
 * this family's value is that its reds are real, so each was measured against the tree first.
 *
 *   **`never signs` / `does not sign` / `cannot sign` — DECLINED.** Thirteen instances tree-wide,
 *   every one of them TRUE, and none of them about the API: the indexer (`index-runner.mjs:5`), the
 *   canary (`canary-runner.mjs:11`), the reference agent (`run.mjs:102`, `REFERENCE-AGENT.md:384`)
 *   and the oracle sampler (`scripts/soak/oracle-sampler.mjs:4`) all say it about themselves. Ten
 *   sit further than 12 lines from any API mention, but TWO do not: `docs/REFERENCE-AGENT.md:384`
 *   at distance 5 and `docs/RUNTIME.md:432` at distance 6. A two-line edit to either paragraph
 *   would red a true sentence. The shape is real — `FACILITATOR=svm` co-signs as fee payer, so "the
 *   API never signs" IS false at this head — but catching it needs a subject test that requires the
 *   API to be the SENTENCE's subject rather than merely present in the window, and that test does
 *   not exist here. Build it, measure it against those two distances, and then add the pattern.
 *
 *   **`no key here` (`docs/RUNTIME.md:34`) — NOT CLOSED, and green for the wrong reason.** That
 *   line is an ASCII-diagram annotation, `(no key here: stub/http)`, and it is true. It passes
 *   because no pattern matches `no key here`, not because anything cleared it. Both halves of the
 *   blindness matter: a bare `\bno keys?\b` would be wide enough to catch it, and it would then
 *   RED, because `stub/http` is not a `MODE_TOKEN` — the token requires `FACILITATOR=stub`. So
 *   closing the pattern alone converts a true line into a false red, and closing it properly means
 *   rewriting the diagram annotation to carry the token. Recorded as a known limit, not fixed.
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
//
// `lib` USED TO BE IN THIS SET AND IS NOT ANY MORE. Matching a bare directory NAME at any depth is
// right for `node_modules` and wrong for `lib`: the entry was meant for `contracts/lib`, the forge
// dependency checkout, but it also silenced `scripts/lib/` (6 files) and `contracts/src/lib/` (3),
// both of which are this repository's own source. Nine files were outside the walk for no stated
// reason. `contracts/lib` is now skipped by PATH, so the vendored checkout stays out and our source
// comes in; `coverage:` below asserts both halves so neither can be lost to a later tidy-up.
const SKIP_PATHS = new Set(['contracts/lib']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
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

/**
 * Lines AFTER a line that a single claim may run into. Prose here hard-wraps at 100 columns, so a
 * claim that starts near the end of a line finishes on the next one; two is enough for every
 * phrasing in `CLAIM_PATTERNS` at that width and is deliberately smaller than `WINDOW`. Bigger is
 * not free: the join is the haystack a claim is matched in, so every extra line is another chance
 * for a pattern to weld two sentences together. The `[^.!?]` bounds inside the negated-positive
 * patterns are the other half of that defence.
 */
const CLAIM_SPAN = 2;

/**
 * A line as a READER sees it, which is not how the plainest author happened to type it.
 *
 * 1. HTML inline emphasis. `holds <strong>no key</strong>` survives a markdown strip and did:
 *    `apps/web/index.html` and `apps/site/*.html` are hand-written HTML, and this guard walks
 *    them. The set is inline emphasis only — dropping BLOCK tags would fuse `<td>keyless</td>`
 *    into the next cell and LOSE matches. Tags are dropped rather than spaced for the same reason
 *    `**` is: the reader sees `holds no key`, one space, and the patterns are written with one.
 * 2. Markdown emphasis. `holds **no key**` does not match /holds no key/, and bolding exactly
 *    these words is this repository's dominant style — `**no key**`, `**Keyless by design**`,
 *    `**non-custodial**`, `**no client for the indexed chain by design**`. Measured over the tree
 *    when it was added: one true finding, zero new false positives. It is also the cause of gap 1,
 *    which is fixed in `MODE_TOKEN` rather than here — see that comment for why this stays greedy.
 * 3. Whitespace, collapsed and trimmed. Steps 1 and 2 leave double spaces behind wherever an
 *    emphasis run sat between two words, and every pattern in this file is written with single
 *    literal spaces, so skipping this step silently loses the matches the other two just bought.
 *    Trimming matters for the join: an indented continuation line would otherwise contribute a
 *    leading space that breaks a phrase straddling the boundary.
 */
const HTML_INLINE_EMPHASIS = /<\/?(?:b|strong|em|i|u|mark|small|code|span|kbd|samp|var|sub|sup)(?:\s[^<>]*)?>/gi;
const normalise = (line) => line
  .replace(HTML_INLINE_EMPHASIS, '')
  .replace(/[*_`]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

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
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SKIP_PATHS.has(path.relative(REPO, full).split(path.sep).join('/'))) continue;
        walk(full);
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
  /\bnot custodial\b/i,
  /\bkey-?free\b/i,
  /\bcustody-?free\b/i,
  /\bno keys\b/i,
  /\bno private keys?\b/i,
  /\bno keypairs?\b/i,
  /\bno (?:signing|secret) keys?\b/i,
  // The holder verb and the quantifier are both open, and the ADJECTIVE SET IS CLOSED. That last
  // point is load-bearing and was measured: adding `api` to the adjective set — which looks like an
  // obvious omission next to `signing` and `secret` — reds two TRUE lines immediately,
  // `docs/DEPLOYMENT.md:734` and `docs/TESTNET-CHECKLIST.md:87`, both of which say "no API key"
  // about an Etherscan verification credential. "API key" is a different noun that happens to
  // contain this guard's subject. Do not put it back.
  /\b(?:holds?|has|have|carries|carry|keeps?|stores?) (?:no|zero) (?:private |signing |secret )?(?:keys?|keypairs?|key material)\b/i,
  // Adjacent noun, same shape. One live instance tree-wide, `packages/reference-agent/src/salt.mjs:11`
  // ("The fix is to hold no secret at all"), which is true, is about the reference agent's salt
  // derivation, and sits more than 30 lines from any API mention. `.github/` contains the word
  // `secret` zero times, so the CI-credential sense that would make this risky is not in the tree.
  /\b(?:holds?|has|have|keeps?|stores?) no secrets?\b/i,
  // ── negated positive: the claim denies a holder ──
  //
  // BOTH HALVES MOVE TOGETHER, and the noun is where they drift apart. `keypair` and `key material`
  // need nothing here — `\bkey` already matches inside both — and `not custodial`, `key-free` and
  // `custody-free` are adjectives with no negated form. `secret` is the one that needed carrying
  // across: the three patterns below are noun-gated, so adding `holds no secrets` positive-side
  // without this left "the API does not hold a secret", "the API server never holds any secrets"
  // and "nothing in the API holds a secret" passing. `neither` and `no process` are noun-agnostic
  // and caught their variants already, which is why this was narrow rather than fatal — but narrow
  // is how the first eight rounds of this family were missed.
  /\bneither\b[^.!?]{0,90}?\bhold/i,
  /\bno process\b[^.!?]{0,90}?\bhold/i,
  /\bnothing\b[^.!?]{0,90}?\bholds an?\b[^.!?]{0,30}?\b(?:key|secret)/i,
  /\bdoes not hold\b[^.!?]{0,60}?\b(?:key|secret)/i,
  /\bnever holds\b[^.!?]{0,60}?\b(?:key|secret)/i,
  // `any` covers "runs without any private key"; `\b` after the alternation is what stops this
  // matching "without anything" and "without anyone", of which the tree has eight.
  /\bwithout (?:an?|any)\b ?(?:private |signing |secret )?keys?\b/i,
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
 *
 * `SVM_?KEYPAIR`, NOT `SVM_KEYPAIR`, and the underscore is the whole of gap 1. This regex is tested
 * against the NORMALISED window, and the normaliser folds `*`, `_` and `` ` `` away so that
 * `holds **no key**` and `_keyless_` are seen the way a reader sees them. `SVM_KEYPAIR` therefore
 * arrives as `SVMKEYPAIR` and the anchored form matched nothing, ever. Making the token optional in
 * the pattern is the fix that keeps the normaliser aggressive on the claim half, which is the half
 * where being too lax loses a false claim rather than gaining a false red.
 */
const MODE_TOKEN = /FACILITATOR\s*=\s*[`'"]?(?:svm|stub|http)\b|\bSVM_?KEYPAIR\b/i;

/**
 * Exemptions, by exact `path:line`, each with the reason written out.
 *
 * Named individually rather than by loosening a pattern or exempting a directory, because that is
 * how a real miss hides. Three admissible reasons and no fourth:
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
 *            claim. Every entry below names the claim's real subject, which is what makes them
 *            checkable rather than a mute.
 *
 *   CLAUSE — the same cost one scale down. The API is named in the SAME sentence as the claim, in
 *            a preceding clause with a different subject. Only reachable since the `CLAIM_SPAN`
 *            join, which can see a claim that wraps away from the clause naming the API. One
 *            instance, and it must name the claim's real subject exactly as a WINDOW entry does.
 *
 * An entry whose reason cannot be written in one clause is a claim that needs fixing, not exempting.
 *
 * ONE THING AN ENTRY DOES THAT ITS `path:line` DOES NOT SAY, disclosed rather than left to be
 * found. `unqualifiedClaims` consumes the lines a matched claim runs into BEFORE it applies any
 * filter, so an exempted claim that wraps also silences its own continuation — up to `CLAIM_SPAN`
 * lines past the one pinned here. That is deliberate: a claim and its own tail are one claim, and
 * suppressing on the match rather than on the reported hit is what stops two patterns reporting one
 * wrapped sentence twice. The cost was measured, not assumed: removing the suppression entirely
 * changes no hit on the tree — only a synthetic goes red — so no claim is hidden by it today. The
 * one entry it currently reaches past is `apps/web/index.html:1583`, whose match runs into 1584.
 */
const EXEMPT = new Map([
  ['docs/X402-LIVE-REPORT.md:41', 'RECORD: a FACILITATOR=http run; the API was keyless in it'],
  ['docs/X402-LIVE-REPORT.md:305', 'RECORD: same run — the keyless-API/key-holding-facilitator split as measured'],
  ['docs/audit/TEST-CROSS-REFERENCE.md:125', 'WINDOW: subject is the canary and the reference agent, both genuinely keyless; `apps/api` is two lines later in a different sentence about audit scope'],
  ['docs/LAUNCH-READINESS.md:278', 'WINDOW: subject is scripts/verify-chainlink-oracle.mjs, which is read-only and keyless; the API is two table ROWS above, at line 276'],
  // CLAUSE, not WINDOW, and the difference is worth the extra line. The two entries above are the
  // documented cost of the ±WINDOW heuristic: a NEIGHBOURING sentence names the API. This one is
  // different geometry — the API is named in the SAME sentence, in the clause before the `;`, and
  // the claim's subject is the second clause. `unqualifiedClaims` has no clause parser and should
  // not grow one for a single site. The claim is true: the browser demo signs a dummy all-zero
  // envelope against a dev facilitator and never asks the user for a key (`renderApiConsent` at
  // :1513 says the same thing about the same subject and is unaffected).
  //
  // This is the only exemption pinned inside a 1500-line file that is edited often, so it WILL
  // drift. When it does, the fix is to re-pin the line, not to drop the CLAIM_SPAN join: the join
  // is what makes the claim visible at all, and a wrapped claim about the API is exactly the miss
  // this file exists for.
  ['apps/web/index.html:1583', 'CLAUSE: subject is the browser demo, which holds no key; the API is named in the preceding clause of the same sentence'],
]);

/**
 * Every unqualified claim of `patterns` whose window names the API.
 *
 * Exported shape is `{file, line, quote}`. `line` is 1-based so it pastes into an editor and into
 * `RECORDS` unchanged.
 *
 * @param {RegExp[]} patterns
 * @param {{files?: string[], read?: (rel:string)=>string|null, exempt?: Map<string,string>}} [opts]
 */
function unqualifiedClaims(patterns, { files = textFiles(), read = readText, exempt = EXEMPT } = {}) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (text == null) continue;
    // Cheap reject: a file with no subject anywhere cannot produce a window with one.
    if (!SUBJECT.test(text)) continue;
    const raw = text.split(/\r?\n/);
    const lines = raw.map(normalise);
    // The last line index a matched claim ran into. A claim that wraps is ONE claim, and the lines
    // it covers must not be rescanned: "The API server / holds / no private key." matches
    // `holds no … key` from line 2 and `no private key` again from line 3, which reports one
    // sentence twice and sends a reader to the fragment. Consuming is done on the MATCH, not on the
    // reported hit, so a claim cleared by a mode token or an exemption silences its own tail too.
    let consumed = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (i <= consumed) continue;
      // GAP 2. The claim is matched over a forward join, not over `lines[i]`, because this repo
      // hard-wraps at 100 columns and half this family's phrasings are longer than what is left of
      // a line by the time the subject has been named. `match.index < lines[i].length` is what
      // reports a wrapped claim ONCE, at the line it begins on, instead of once per line it
      // touches — the probe below asserts exactly that count.
      const span = Math.min(lines.length, i + CLAIM_SPAN + 1);
      const hay = lines.slice(i, span).join(' ');
      let match = null;
      for (const p of patterns) {
        const m = hay.match(p);
        if (m && m.index < lines[i].length) {
          match = m;
          break; // one hit per line, never one per pattern: two patterns can match one sentence
        }
      }
      if (!match) continue;
      // The last line the match reaches, computed before any filter so that a cleared claim still
      // consumes its own continuation lines.
      const end = match.index + match[0].length;
      let last = i;
      for (let k = i, off = 0; k < span; k += 1) {
        if (off < end) last = k;
        off += lines[k].length + 1;
      }
      consumed = last;
      const window = lines
        .slice(Math.max(0, i - WINDOW), Math.min(lines.length, i + WINDOW + 1))
        .join(' ')
        .replace(/\s+/g, ' ');
      if (!SUBJECT.test(window)) continue;
      if (MODE_TOKEN.test(window)) continue;
      const key = `${file}:${i + 1}`;
      if (exempt.has(key)) continue;
      // A cross-line claim quoted as its first line alone reads as a sentence fragment and sends
      // the reader to the wrong place. Quote every line the match actually covers.
      hits.push({
        file,
        line: i + 1,
        quote: raw.slice(i, last + 1).map((l) => l.trim()).join(' ⏎ '),
      });
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
      + 'A quote containing ⏎ is one claim that wraps: the line NUMBER is where it begins, and the\n'
      + 'text after the ⏎ is the continuation line the match ran into.\n'
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

// ---------------------------------------------------------------------------------------------
// SYNTHETICS — the capability half of the probe above.
//
// `RETIRED` proves the patterns still catch text this repository actually wrote. Everything added
// in the gap-closing pass has NO live instance: `not custodial`, `key-free`, `custody-free`,
// `no keypair`, `zero keys`, `without any private key`, `no signing key` and `holds no secrets`
// occur zero times tree-wide, and the `CLAIM_SPAN` join has zero true cross-line claims to find.
// A green tree is therefore equally consistent with "these work" and "these match nothing" — the
// exact confusion `RETIRED` exists to refuse, one axis over. So each family gets a synthetic that
// must RED, and the two that turn on a clearing token get the paired control that must stay red
// when the token is removed. Deleting a row here is deleting the only evidence for a pattern.
//
// `expect: 0` rows are just as load-bearing: `hasNoAPIKey` is the false positive this pass
// measured and removed, and without a test the next person to widen the noun set re-breaks it.
// ---------------------------------------------------------------------------------------------
const SUBJECT_LINE = '# Runtime configuration for the indexer + API stack\n';

/** @type {{what: string, text: string, expect: number, line?: number, quotes?: string}[]} */
const SYNTHETIC = [
  // ── gap 1: SVM_KEYPAIR survives the emphasis strip and clears a claim ──
  {
    what: 'gap 1: SVM_KEYPAIR in the window clears the claim',
    text: `${SUBJECT_LINE}# Neither process holds a private key unless SVM_KEYPAIR is set.\n`,
    expect: 0,
  },
  {
    what: 'gap 1 control: the same claim without the token still reds',
    text: `${SUBJECT_LINE}# Neither process holds a private key unless the operator decides otherwise.\n`,
    expect: 1,
    line: 2,
  },
  {
    what: 'gap 1: the token clears through bold emphasis too',
    text: `${SUBJECT_LINE}# Neither process holds a private key unless **SVM_KEYPAIR** is set.\n`,
    expect: 0,
  },
  // ── gap 2: the claim wraps ──
  {
    what: 'gap 2: a claim hard-wrapped away from the line naming its subject',
    text: 'Neither the indexer nor the API process\nholds a private key.\n',
    expect: 1,
    line: 1,
    quotes: 'holds a private key.',
  },
  {
    what: 'gap 2 control: the same wrapped claim with the mode named clears',
    text: 'Neither the indexer nor the API process\nholds a private key under `FACILITATOR=stub`.\n',
    expect: 0,
  },
  {
    what: 'gap 2: a claim spanning all of CLAIM_SPAN is reported once, at the line it begins on',
    text: 'The API server\nholds\nno private key.\n',
    expect: 1,
    line: 2,
    quotes: 'no private key.',
  },
  {
    // The whitespace half of `normalise`. A continuation line is indented in every list, table and
    // JSDoc block in this repository, and joining without trimming leaves a double space exactly
    // where a phrase straddles the boundary — which every pattern here, written with single literal
    // spaces, then misses. Without the trim this row reports line 2 instead of line 1: the claim is
    // found only by the shorter pattern that starts after the gap, so the reader is sent to the
    // fragment and the sentence's real subject is a line further away than the guard thinks.
    what: 'gap 2: an indented continuation still joins into one phrase',
    text: 'The API server holds\n    no private key.\n',
    expect: 1,
    line: 1,
    quotes: 'no private key.',
  },
  // ── HTML emphasis survives the markdown strip ──
  {
    what: 'HTML emphasis: holds <strong>no key</strong>',
    text: '<p>The API server holds <strong>no key</strong> in this mode.</p>\n',
    expect: 1,
    line: 1,
  },
  {
    what: 'HTML control: BLOCK tags are not stripped, so a cell boundary stays a word boundary',
    text: '<tr><td>keyless</td><td>the API</td></tr>\n',
    expect: 1,
    line: 1,
  },
  // ── families added with no live instance ──
  { what: 'not custodial', text: 'The API is not custodial.\n', expect: 1, line: 1 },
  { what: 'key-free', text: 'The API server is key-free.\n', expect: 1, line: 1 },
  { what: 'custody-free', text: 'The API is custody-free.\n', expect: 1, line: 1 },
  // The next two are phrased with NO holder verb on purpose. `holds no keypair` and `has no
  // signing key` are already caught by the holder-verb family, so a synthetic using those verbs
  // passes with the bare-noun pattern deleted and proves nothing about it. These do not.
  { what: 'no keypair', text: 'apps/api/src/serve.mjs runs with no keypair on disk.\n', expect: 1, line: 1 },
  { what: 'no signing key', text: 'There is no signing key anywhere in apps/api.\n', expect: 1, line: 1 },
  { what: 'zero keys (holder verb)', text: 'The API holds zero keys.\n', expect: 1, line: 1 },
  { what: 'no secret key (holder verb)', text: 'The API server has no secret key.\n', expect: 1, line: 1 },
  { what: 'holds no secrets', text: 'The API server stores no secrets.\n', expect: 1, line: 1 },
  // The negated half of the `secret` noun. Three rows because three separate patterns are gated on
  // the noun, and each was passing this text before `key` became `(?:key|secret)`.
  { what: 'secret, negated: does not hold', text: 'The API does not hold a secret.\n', expect: 1, line: 1 },
  { what: 'secret, negated: never holds', text: 'The API server never holds any secrets.\n', expect: 1, line: 1 },
  { what: 'secret, negated: nothing holds', text: 'Nothing in the API holds a secret.\n', expect: 1, line: 1 },
  {
    what: 'without any private key',
    text: 'The API server runs without any private key.\n',
    expect: 1,
    line: 1,
  },
  // ── negative controls: the measured false positives, locked out ──
  {
    what: 'control: "no API key" is an Etherscan credential, not this family',
    text: 'The pinned rebuild has no API key, so apps/api verification was skipped.\n',
    expect: 0,
  },
  {
    what: 'control: "without anything" / "without anyone" are not "without a key"',
    text: 'The API ships without anything to configure and without anyone to ask.\n',
    expect: 0,
  },
];

test('synthetic: every claim family reds, and every measured false positive stays green', () => {
  for (const s of SYNTHETIC) {
    const hits = unqualifiedClaims(CLAIM_PATTERNS, {
      files: ['synthetic'],
      read: () => s.text,
    });
    assert.equal(
      hits.length,
      s.expect,
      `synthetic "${s.what}" matched ${hits.length} times, expected ${s.expect}:\n`
        + `${report(hits)}\n${JSON.stringify(s.text)}`,
    );
    if (s.line !== undefined) assert.equal(hits[0].line, s.line, `synthetic "${s.what}": wrong line`);
    if (s.quotes !== undefined) {
      assert.ok(
        hits[0].quote.includes(s.quotes),
        `synthetic "${s.what}": the quote stops before the claim does — a cross-line hit reported\n`
          + `as its first line alone sends the reader to a fragment. Got: ${hits[0].quote}`,
      );
    }
  }
});

// Every exemption is a claim that this file would otherwise report, and an exemption that has
// stopped matching is a silent mute: it looks identical to a live one and protects nothing, while
// the line it was pinned to has drifted somewhere the guard is no longer looking. Cheapest possible
// check — run with the exemptions off and require every key to come back.
test('exemptions: every entry is still load-bearing, none has rotted', () => {
  const all = unqualifiedClaims(CLAIM_PATTERNS, { exempt: new Map() })
    .concat(unqualifiedClaims(RPC_PATTERNS, { exempt: new Map() }))
    .map((h) => `${h.file}:${h.line}`);
  for (const [key, reason] of EXEMPT) {
    assert.ok(
      all.includes(key),
      `EXEMPT has ${key} (${reason}) but nothing matches there any more.\n`
        + 'Either the line moved — re-pin it — or the claim was rewritten and the entry should go.\n'
        + 'A stale exemption is indistinguishable from a live one, which is how the next miss hides.',
    );
  }
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
  // Both halves of the `lib` fix, because each protects against the opposite mistake: the positives
  // stop a future tidy-up putting the bare name back in SKIP_DIRS, and the negative stops a noisy
  // vendored checkout being silenced by deleting SKIP_PATHS instead of narrowing it.
  for (const required of ['scripts/lib/verdicts.mjs', 'contracts/src/lib/BoundedCall.sol']) {
    assert.ok(
      files.includes(required),
      `the walk did not reach ${required}. \`lib\` is skipped by PATH (contracts/lib, the forge\n`
        + 'dependency checkout) and never by bare directory name — this repository keeps its own\n'
        + 'source in two directories called lib.',
    );
  }
  assert.equal(
    files.filter((f) => f.startsWith('contracts/lib/')).length,
    0,
    'the walk descended into contracts/lib, the vendored forge dependency checkout. Its prose is\n'
      + 'not ours to guard and its volume would drown a real red.',
  );
});
