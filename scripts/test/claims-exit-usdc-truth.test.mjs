/**
 * Card #133 (P-O21) — no shipped surface may claim exits pay USDC unconditionally, or that the
 * exit swap replaced the deposit cap.
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs` walks the whole repository but its `PUBLIC_EXT` is `.md`, `.html`,
 * `.txt` and `.json` — it never reaches `.ts`, `.tsx`, `.mjs` or `.js`, so none of an app's own
 * rendered TSX/JS source was ever reachable by that guard (`launch-product-21-...md`, reconciled
 * 2026-09-21: "no claims-guard file exists for apps/vaults-ui at all"). `claims-web-prose-truth
 * .test.mjs` closed the analogous gap for `apps/web/src/*.mjs` alone (card #68). This file is the
 * guard for the two P-O21 shapes, and it is scoped exactly to the three surfaces the card names —
 * `apps/site`, `apps/vaults-ui` (their WHOLE trees: `src/`, plus the top-level HTML templates,
 * `public/` and the built `dist/`, all of which are shipped copy, not only their `src/`), and
 * `apps/web` — the card names this surface `apps/web/src`, but `apps/web/index.html` is
 * itself a real, wallet-free preview page ("Vault Atlas: the allocator front end" — its own
 * README: "Open `index.html` ... Four flows: discover, inspect, deposit, exit") that renders
 * exit copy directly, not only the domain layer `apps/vaults-ui` imports from `apps/web/src` via
 * aliases. Walking `apps/web/src` alone would leave that page's own rendered text unguarded, so
 * this is a DELIBERATE, DISCLOSED widening past the card's literal wording, in the same direction
 * as the other two roots rather than a narrowing of them.
 *
 * ## What is actually true today, read from the source rather than asserted
 *
 * `contracts/src/VaultCore.sol` `_settleExit`: an exit pays pro rata from idle USDC FIRST (SV-5).
 * The basket-asset slice goes out **in kind** — `slices[i] = assetBalance[a] * burnKeep / tsBps`
 * is a direct transfer, not a swap. Only a residual CASH shortfall (idle USDC insufficient to
 * cover the target) unwinds CHILD VAULT positions via `_redeemChildMeasured`; the basket itself is
 * never unwound for a shortfall, it is paid out directly. `grep -c exitSwap contracts/src` is 0 —
 * there is no swap-to-USDC path in the deployed contract at all. `exit-payout-copy-2026-09-18.md`
 * is explicit that Design A (in-kind, live) is what ships and Design B (a conditional USDC swap)
 * is "WRITTEN AND HELD. Do not ship" until a contract exists and is audited. So:
 *
 *   (a) "exits pay USDC", stated with no qualifier, is false today — the true forms name the
 *       in-kind leg ("cirBTC and USDC", "in kind") or, once Design B ships, the condition under
 *       which USDC is paid.
 *   (b) "the exit swap replaced the cap" is false regardless of which design ships:
 *       `No deposit cap 2026-09-18.md` — the cap bounded the POSITION, an exit swap only ever
 *       bounds the PRICE of converting one, and a member past the pool's usable depth still
 *       degrades to in-kind every time, swap or no swap.
 *
 * ## Why raw file text, not an extracted-string-literal tokenizer
 *
 * `claims-web-prose-truth.test.mjs` tokenizes `.mjs` source to skip comments, because several of
 * its modules narrate banned shapes in their own docstrings to explain why they are refused. This
 * guard reads the raw file text instead for every extension it walks, the same way
 * `claims-lede-truth.test.mjs` reads `.md`/`.html`/`.txt` — full text, comments included — because
 * that pattern (a comment narrating one of these two shapes to explain a refusal) does not exist
 * anywhere in these three trees today, and building a second extraction path to spare a
 * hypothetical comment is one more place the walk could silently under-read. The one thing this
 * file DOES strip is inline HTML/JSX tags (`stripTags`, from the shared shapes module) — not to
 * hide anything, but because a real rendered sentence can be split by markup ("Exits pay
 * <strong>USDC</strong>.") and a regex over the untouched source would read that as two runs of
 * text instead of one. `stripTags`'s own doc in `claims-shapes.mjs` states the verified limit of
 * this precisely: matching a real HTML/JSX attribute LIST rather than "any non-`<>` characters" is
 * what keeps a comparison expression (`n<max ? '...' : n>0`) from being misread as a tag and
 * swallowing a claim inside it — that shape was a genuine hole, found in review and closed, not
 * merely documented. Read that doc before changing this function; do not assume it is inert.
 *
 * ## Why the qualifier check is a character WINDOW, not `sentencesOf`
 *
 * `sentencesOf` (used by the RWLY guards in `claims-lede-truth.test.mjs`) splits on `.`/`!`/`?`
 * followed by whitespace, which is the right unit for prose but the wrong one for source code: a
 * single JSX render function or a minified line can run for hundreds of characters with no
 * sentence-ending punctuation at all, so "one sentence" in a `.tsx` file can mean "the whole
 * file". A qualifier word anywhere in that span would exempt an unrelated claim far away from it.
 * This guard bounds that instead with a fixed character window around each match (`QUALIFIER_
 * WINDOW`), the same tool `claims-lede-truth.test.mjs`'s guard 4 uses for `REMEDIATION_STATUS`.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 * Each of the three roots is walked and asserted non-empty INDIVIDUALLY, and each throws by name
 * rather than the walk merging all three into one flat list and asserting the total. Merging would
 * let one root silently contribute zero files (a renamed directory, a moved app) while the other
 * two carried the floor — a pass over two-thirds of the required surface reading as a full pass,
 * the exact failure `claims-lede-truth.test.mjs`'s own header calls out for `surfacesWithText`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flat,
  stripTags,
  EXIT_PAYS_USDC_UNCONDITIONALLY,
  EXIT_USDC_QUALIFIER,
  EXIT_SWAP_REPLACED_CAP_VERB,
  EXIT_SWAP_REPLACED_CAP_NO_NEED,
  EXIT_SWAP_REPLACED_CAP_NEGATED,
} from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The three shipped app surfaces, walked WHOLE: their top-level HTML templates, `public/`,
// `dist/` and `src/` are all shipped copy. `apps/web` is included whole rather than as
// `apps/web/src` alone — see the header for why that is a deliberate widening past the card's
// literal wording, not a narrowing of it.
const ROOTS = ['apps/site', 'apps/vaults-ui', 'apps/web'];

// `.txt` is here for `apps/site/public/llms.txt` (and its `dist/` copy) — real positioning prose
// an agent or a reader fetches directly, not a build artefact. Not `.json`: nothing under these
// three roots carries member-facing copy in JSON, and the whole-repo sweep in
// `claims-lede-truth.test.mjs` already reads every `.json` file for its own shapes.
const WALK_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.html', '.txt']);

// `test/` and `scripts/` hold QA fixtures and build tooling, never member-facing copy, and
// walking them risks a false hit from this guard's OWN sibling shape appearing in a fixture file
// (this file's own probe strings are the exact pattern that risk describes). `dist-ssr` is
// excluded because `claims-lede-truth.test.mjs`'s header already establishes (checked 2026-09-18
// with `diff`) that its only two prose files, `llms.txt` and `robots.txt`, are byte-identical
// copies of `public/`'s — walking it too would only duplicate hits under a second path, never add
// coverage. `node_modules` should never appear under an app's own directory, but a guard that
// assumes that rather than stating it is the guard that gets surprised first.
const SKIP_DIRS = new Set(['node_modules', 'test', 'scripts', 'dist-ssr', '.turbo', 'coverage']);

const walkFiles = (absDir) => {
  const found = [];
  (function inner(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) inner(path.join(dir, entry.name));
      } else if (WALK_EXT.has(path.extname(entry.name))) {
        found.push(path.join(dir, entry.name));
      }
    }
  })(absDir);
  return found;
};

/**
 * Every `.ts`/`.tsx`/`.mjs`/`.js`/`.html`/`.txt` file under one root, relative to the repo root.
 * THROWS if the root yields zero files — a guard that can skip a root is a guard that will, and a
 * pass over zero files in a named surface reads identically to a pass over everything in it.
 */
const filesUnder = (root) => {
  const abs = path.join(REPO, root);
  const found = walkFiles(abs).map((f) => path.relative(REPO, f).split(path.sep).join('/'));
  assert.ok(
    found.length > 0,
    `${root} yielded zero .ts/.tsx/.mjs/.js/.html/.txt files. Either the app moved, was renamed, ` +
      "or this guard's path is wrong — either way this THROWS rather than reporting a silent " +
      'pass over zero coverage for one of the three surfaces card #133 names.',
  );
  return found;
};

/**
 * Every file across all three roots, with TWO whitespace-flattened texts: `raw` (untouched) and
 * `stripped` (tags blanked via `stripTags`). Every shape below is matched against BOTH and the
 * hits are unioned — see `stripTags`'s own doc in `claims-shapes.mjs` for why relying on the
 * stripped text alone is unsafe: it JOINS a claim markup split in two ("Exits pay
 * <strong>USDC</strong>.") but it also BLANKS a claim sitting inside a real attribute value
 * (`<span title="Exits pay USDC">`) whole, value included — a hole the raw pass alone closes,
 * since nothing about ordinary attribute syntax stops the raw text from containing the claim in
 * plain sight. Each root is validated non-empty above BEFORE the flatMap merges them, so a
 * zero-file root throws by name rather than being absorbed into a merged total that still clears
 * a floor.
 */
const allSurfaces = () =>
  ROOTS.flatMap((root) => filesUnder(root)).map((file) => {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    return { file, raw: flat(source), stripped: flat(stripTags(source)) };
  });

/** Dedupe hits collected from BOTH the raw and stripped passes over the same file so the report
 * does not print the same real claim twice when both passes happen to catch it identically. Near-
 * duplicates that differ because one pass still carries a tag are left as separate lines
 * deliberately — collapsing on anything looser than an exact match risks collapsing two DIFFERENT
 * claims that happen to share a prefix. */
const dedupeHits = (hits) => {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.file}\u0000${h.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
};

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('every one of the three P-O21 app roots yields at least one file to guard', () => {
  for (const root of ROOTS) {
    assert.ok(filesUnder(root).length > 0, `${root} yielded zero files`);
  }
});

/**
 * Coverage floor, the same role `MIN_MODULES`/`MIN_PAGES` play in the sibling guards: not a fact
 * asserted for its own sake, but a tripwire that catches this guard silently walking far less than
 * it should (a broken glob, a directory that shrank to near-nothing) without hardcoding today's
 * exact per-root counts, which would make this test the next thing that goes stale.
 */
const MIN_FILES_PER_ROOT = 3;

test('coverage: this guard walks a non-trivial slice of each of the three roots', () => {
  for (const root of ROOTS) {
    const n = filesUnder(root).length;
    assert.ok(
      n >= MIN_FILES_PER_ROOT,
      `${root}: only ${n} file(s) walked, fewer than the ${MIN_FILES_PER_ROOT} floor — coverage regressed`,
    );
  }
});

/**
 * How far EXIT_USDC_QUALIFIER is allowed to sit from a shape-A match and still count as the SAME
 * claim being qualified — see the header for why this is a character window and not `sentencesOf`.
 *
 * DELIBERATELY SHORT, not sized to span a whole sentence. Every TRUE instance in exit-payout-
 * copy-2026-09-18.md carries its qualifier in the same clause as the claim or the one immediately
 * after it — ", not cash alone", ", not a promise" — a handful of characters away, never a
 * separate sentence or paragraph; checked against `EXIT_PAYS_USDC_UNCONDITIONALLY`'s own probe
 * cases below, every "ok" (spared) example either matches no shape at all or carries its
 * qualifier word INSIDE the matched span itself, so none of them needs a window wider than the
 * match. A wide window was tried first (160) and rejected: `apps/web/src/exit-preview.mjs`'s own
 * docstrings say "in-kind" and "pro rata" repeatedly while EXPLAINING the settlement math, not
 * qualifying any claim, and that file is exactly where this claim is most likely to get written —
 * a wide window would let that nearby, unrelated vocabulary launder a real unqualified claim a
 * few lines away. 40 is short enough to stay inside one clause and long enough to reach the very
 * next one ("Not cash for the whole amount" sits within ~40 characters of "cirBTC" in that
 * sentence's own money figures). See the "adversarial" probe case below, which plants the banned
 * claim NEXT TO this exact vocabulary and confirms it is still caught.
 *
 * LIMIT, stated rather than implied: a qualifier within this window exempts the match whether or
 * not it actually MODIFIES that specific claim. "Exits pay USDC. Settles in kind." is two
 * sentences, and the second one's "in kind" is close enough to spare the first — a human reader
 * would read them as two separate, contradictory claims, not one qualified by the other. This
 * guard cannot make that distinction; the window trades a small amount of that kind of blindness
 * for closing the far larger hole a whole-sentence or whole-file scope leaves open (see above).
 */
const QUALIFIER_WINDOW = 40;

/** Shape-A hits in ONE text (no dedup, no file tag — the caller adds both). Factored out so the
 * content test and the probe helper below run the identical check, and so it can be called once
 * per text on BOTH the raw and the stripped pass (see `allSurfaces`'s doc for why both). */
const exitPaysUsdcHits = (text) => {
  const quotes = [];
  for (const re of EXIT_PAYS_USDC_UNCONDITIONALLY) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const windowText = text.slice(Math.max(0, start - QUALIFIER_WINDOW), start + m[0].length + QUALIFIER_WINDOW);
      if (EXIT_USDC_QUALIFIER.test(windowText)) continue; // the true, qualified form nearby
      quotes.push(m[0]);
    }
  }
  return quotes;
};

/** Shape-B hits in ONE text — same factoring reason as `exitPaysUsdcHits`. */
const exitSwapReplacedCapHits = (text) => {
  const quotes = [];
  for (const re of EXIT_SWAP_REPLACED_CAP_VERB) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (EXIT_SWAP_REPLACED_CAP_NEGATED.test(m[0])) continue; // the correction, not the claim
      quotes.push(m[0]);
    }
  }
  // No negation filter here — see EXIT_SWAP_REPLACED_CAP_NO_NEED's export note: this shape IS
  // already the negative form ("no need"), and there is no correction sentence shaped like it.
  for (const re of EXIT_SWAP_REPLACED_CAP_NO_NEED) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) quotes.push(m[0]);
  }
  return quotes;
};

test('no shipped surface claims exits pay USDC unconditionally', () => {
  const hits = [];
  for (const { file, raw, stripped } of allSurfaces()) {
    for (const quote of exitPaysUsdcHits(raw)) hits.push({ file, quote });
    for (const quote of exitPaysUsdcHits(stripped)) hits.push({ file, quote });
  }
  const deduped = dedupeHits(hits);
  assert.deepEqual(
    deduped.map((h) => h.file),
    [],
    '`VaultCore._settleExit` pays pro rata from idle USDC FIRST (SV-5); the basket-asset slice\n' +
      'goes out IN KIND (a direct transfer, never a swap), and only a residual CASH shortfall\n' +
      'unwinds CHILD VAULT positions. `grep -c exitSwap contracts/src` is 0. Design A (live) pays\n' +
      'in kind; Design B (a conditional USDC swap) is written and HELD, not shipped (exit-payout-\n' +
      'copy-2026-09-18.md). Say "settles in kind", "paid in cirBTC and USDC", or, once a swap\n' +
      'contract ships, name the condition ("in ordinary conditions", "unless the market is\n' +
      'stressed") — never "exits pay USDC" or "you receive USDC" unqualified.\n' +
      `Offending text:\n${report(deduped)}`,
  );
});

test('no shipped surface claims the exit swap replaced the deposit cap', () => {
  const hits = [];
  for (const { file, raw, stripped } of allSurfaces()) {
    for (const quote of exitSwapReplacedCapHits(raw)) hits.push({ file, quote });
    for (const quote of exitSwapReplacedCapHits(stripped)) hits.push({ file, quote });
  }
  const deduped = dedupeHits(hits);
  assert.deepEqual(
    deduped.map((h) => h.file),
    [],
    '`No deposit cap 2026-09-18.md`: the cap (`capacityCapUsdc`) bounded the POSITION; an exit\n' +
      "swap only ever bounds the PRICE of converting one, and a member past the pool's usable\n" +
      'depth still degrades to in-kind every time, swap or no swap — "no improvement at all for\n' +
      'the largest one". Never say the swap replaced, closed, superseded, or removed the need for\n' +
      'the cap.\n' +
      `Offending text:\n${report(deduped)}`,
  );
});

test('probe: shape A catches the wide, unqualified claim and spares the qualified/conditional form', () => {
  // Checks BOTH the raw and the stripped text, matching the content test above — see
  // `allSurfaces`'s doc for why relying on the stripped text alone would miss an attribute-value
  // hit and rewarding the probe for passing on the stripped text alone would hide that regression.
  const caught = (s) => exitPaysUsdcHits(flat(s)).length > 0 || exitPaysUsdcHits(flat(stripTags(s))).length > 0;
  for (const bad of [
    'Exits pay USDC.',
    'When you exit, you receive USDC for your shares.',
    'Withdrawals are settled in USDC.',
    'Redemptions are paid in USDC.',
    'This is a USDC-settled exit.',
    'You will receive 140.50 USDC for your shares.',
    // Queuing is a TIMING mechanic (Mode F) and says nothing about which currency pays — this is
    // still the unconditional claim, not a qualified one (see EXIT_USDC_QUALIFIER's header note).
    'Exits are queued and pay USDC.',
    // Markup splitting the claim across a tag boundary must not defeat the guard (stripTags).
    'Exits pay <strong>USDC</strong>.',
    'You will <em>receive</em> USDC for your shares.',
    // ADVERSARIAL: real vocabulary-dense neighbourhood. `exit-preview.mjs`'s own docstrings use
    // "in kind" and "pro rata" repeatedly to EXPLAIN the settlement math, not to qualify a claim —
    // this is exactly the file the banned claim is most likely to get written into, and this case
    // is why QUALIFIER_WINDOW is 40 rather than wide enough to span a whole comment block.
    'This module mirrors VaultCore._settleExit in kind, pro rata, term for term, in BigInt so a preview never drifts from settlement. Exits pay USDC for your shares.',
    // ATTRIBUTE VALUE: stripTags blanks a real attribute's value WHOLE (see its own doc) — the
    // raw-text pass is what has to catch this, and this case exists to prove it still does.
    '<span title="Exits pay USDC">x</span>',
  ]) {
    assert.equal(caught(bad), true, `the guard no longer catches: ${bad}`);
  }
  for (const ok of [
    'Settles in kind.',
    'Paid in cirBTC and USDC, not cash alone.',
    'You will receive 3.2 cirBTC and 140 USDC. Not cash for the whole amount — the vault pays you your share of what it actually holds.',
    'Estimated USDC out: $500 — an estimate, not a promise. If the market is moving too far from the vault’s price floor, you are paid in cirBTC and USDC instead.',
    'Paid in cirBTC and USDC. The market could not fill at a fair price, so the vault paid you your share directly instead.',
  ]) {
    assert.equal(caught(ok), false, `the guard reds the approved, qualified copy: ${ok}`);
  }
});

test('probe: shape B catches the claim and spares the correction that denies it', () => {
  // Checks BOTH the raw and the stripped text, same reasoning as shape A's probe above.
  const caught = (s) => exitSwapReplacedCapHits(flat(s)).length > 0 || exitSwapReplacedCapHits(flat(stripTags(s))).length > 0;
  for (const bad of [
    'The exit swap replaced the deposit cap.',
    'The exit swap replaces the cap.',
    'The deposit cap was superseded by the exit swap.',
    'There is no longer a need for a deposit cap now that we have the exit swap.',
    'The exit swap makes the deposit cap unnecessary.',
    // ATTRIBUTE VALUE: same reasoning as shape A's attribute-value case above.
    '<p aria-label="The exit swap replaced the deposit cap">x</p>',
  ]) {
    assert.equal(caught(bad), true, `the guard no longer catches: ${bad}`);
  }
  for (const ok of [
    'The exit swap did not replace this cap.',
    'The exit swap never replaced the deposit cap — it bounds the price of converting a position, not its size.',
    'The cap bounded the position; the exit swap bounds the price of converting one.',
  ]) {
    assert.equal(caught(ok), false, `the guard reds the correction that DENIES the claim: ${ok}`);
  }
});

test('probe: stripTags joins a claim split across markup, and does not swallow one sitting beside a comparison', () => {
  // The failure mode this guards against: NOT stripping tags means "Exits pay <strong>USDC</strong>."
  // reads as two runs ("Exits pay" / "USDC") and the shape never matches at all.
  assert.equal(stripTags('Exits pay <strong>USDC</strong>.'), 'Exits pay  USDC .');
  // THE HOLE THIS FUNCTION USED TO HAVE, closed rather than merely documented (see the export's own
  // note in claims-shapes.mjs): a permissive attribute span read `<max ? '...' : n>` as one tag and
  // swallowed a claim living inside the string literal between the comparison operators. The
  // attribute-list form must leave this untouched — the claim stays fully visible, verbatim.
  const adversarial = "const ok = n<max ? 'Exits pay USDC' : n>0;";
  assert.equal(stripTags(adversarial), adversarial, 'a comparison expression must not be read as a tag');
  assert.ok(stripTags(adversarial).includes('Exits pay USDC'), 'the claim inside it must stay visible');
  // A single-word generic IS still blanked (an accepted, bounded-cost limit — see the export's own
  // note), and a comma-bearing one is left untouched. Both are asserted directly, not through a
  // vacuous "no USDC in the output" check on an input that never contained USDC.
  assert.equal(stripTags('type Balances = Array<string>;'), 'type Balances = Array ;');
  assert.equal(stripTags('type Balances = Record<Asset, bigint>;'), 'type Balances = Record<Asset, bigint>;');
});

test('probe: this guard throws rather than passing if a root yields zero files', () => {
  const emptyDir = path.join(REPO, 'apps/site', '__does-not-exist__');
  assert.throws(
    () => readdirSync(emptyDir, { withFileTypes: true }),
    /ENOENT/,
    'sanity check on the probe itself: a missing directory must throw, not return []',
  );
  const assertNonEmpty = (root, found) => {
    assert.ok(found.length > 0, `${root} yielded zero .ts/.tsx/.mjs/.js/.html/.txt files`);
  };
  assert.throws(() => assertNonEmpty('apps/site', []), /zero \.ts\/\.tsx\/\.mjs\/\.js\/\.html\/\.txt files/);
  assertNonEmpty('apps/site', ['apps/site/index.html']); // the non-empty case stays green
});
