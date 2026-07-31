# Salvage scan — Celestials → 402cap

Source: `C:\Users\Micha\Desktop\Celestials` (read-only, untouched). Target: `C:\Users\Micha\Desktop\x402`.
Nothing has been copied. This is inventory only — copying is a separate decision.

**Headline: 2 real LIFTs, ~4 ADAPTs, one important anti-lift warning, and one process finding
that changes what "LIFT the backlog tooling" even means.**

---

## Finding that changes everything else: `ORG-BACKLOG.md` doesn't exist yet

`x402\ORG-CHARTER.md` §5 reads `ORG-BACKLOG.md` as the very first step of every autonomous
loop tick. It is not in the directory — `ls C:\Users\Micha\Desktop\x402` shows only
`ORG-CHARTER.md`, `README.md`, the four `.py` files, `prune.py`, `run.ps1`, `logs\`, and the db.
So this isn't "retrofit a parser to an existing file" — it's "author `ORG-BACKLOG.md` in the
shape `backlog-index.py` already parses, from day one." That shape, concretely:
- `## <section heading>` lines to group rows
- a markdown table whose header row contains a literal `Status` column
- status cells that are **verdict-first** (`**shipped 2026-07-25** — ...`, `open, low priority`,
  `**open — needs Michael.**`) — the classifier only trusts the first ~40-90 chars

Get this right at file-creation time and both scripts below work with zero parser changes.

---

## 1. Public web front end

**Verdict: component patterns and honesty-UI conventions — ADAPT. Scaffolding and build
setup — SKIP, and the build setup is actively the WRONG direction for what 402cap needs.**

- **Anti-lift warning (read this first):** `celestials\vite.config.js` uses
  `vite-plugin-singlefile` with `assetsInlineLimit: 100000000` — the whole app (JS/CSS/fonts/
  sprites) inlines into one HTML file, designed to open from `file://` with zero network. That is
  a client-rendered SPA with **one HTML document and no per-route URLs**. Its own
  `celestials\src\lib\seo.js` says so explicitly in a header comment: swapping
  `document.title`/description per view "does NOT create new indexable search results... It is
  not a substitute for real per-route static pages." 402cap needs the opposite: a crawlable,
  search-indexed site over ~15,500 routes with real per-resource detail pages. Do not start from
  this Vite config — it optimizes for the one thing 402cap doesn't want.
- **ADAPT — component pattern for browse+detail:** `celestials\src\components\ItemsDatabase.jsx`
  is the closest existing analog to "searchable listings + detail page with history": an
  `ItemsListPanel` (search input, `useMemo`-filtered list, empty-state message) next to an
  `ItemDetailPanel` (current listings + sale history + a fair-value cell). Maps directly onto
  `GET /resources` (browse/filter) + `GET /resources/{id}/history` from the x402 README's planned
  API. The demo/API-mode duality in the same file is also worth the pattern (never silently
  render stale data as if live — see next item).
- **ADAPT — honesty-in-UI pattern (this is the real find here):** `celestials\src\components\
  ConfidenceBadge.jsx` and `celestials\src\components\DataSourceNotice.jsx`. `ConfidenceBadge`
  never renders a confidence percentage without its reason string next to it (`data-testid=
  "confidence-reason"`), with a `glossReason()` translator from technical backend language to
  plain English. `DataSourceNotice` distinguishes "demo/offline build" from "live fetch actually
  failed, showing stale data" so a fetch failure can never silently look like live data — built
  after a real incident where the owner mistook a CORS-blocked fallback for live state. This is
  the exact UI discipline 402cap's backend already has (`NULL` never `0`, `decimals_unknown`
  flags, `spec_violations` arrays) but has no frontend yet to express it in. Small, generic,
  domain-free components — port the pattern, not the MapleStory copy.
- **SKIP:** `celestials\src\styles\app.css` and the rest of `src/styles/` — confirmed (read) to
  be fantasy-game branding (gild/glow color tokens, MapleStory-themed header). Not appropriate for
  a financial data dashboard. The CSS-custom-property + documented-rationale-comment *habit* is
  good practice but there's no literal code worth lifting.
- **SKIP:** `celestials\src\lib\economy.js`, `hyperstat.js`, `legionJobs.js`, `starforce`-adjacent
  libs, and all `*-fixture.json` data — 100% MapleStory game mechanics.

---

## 2. Data pipeline patterns

**Verdict: SKIP. x402's own `fetch_catalog.py` is already more mature than what Celestials has.**

Read `Celestials\scripts\market-intel.py` (header/first 150 lines) and `backend\src\modules\
sync\resync.ts`. The pipeline shape (poll → snapshot to SQLite → dedupe) is superficially similar
to `fetch_catalog.py`, but the actual code is entirely msu.io/NESO/NXPC-specific (character vs.
item sale branching, a documented 100,000x currency-conversion bug that was fixed in place,
schema migrated live rather than insert-only). x402's `fetch_catalog.py` already has the harder,
more valuable disciplines this domain needed and market-intel.py didn't start with: insert-only
history (never `UPDATE` `catalog_resource`/`probe`), an explicit `is_complete` flag instead of
inferring completeness from a drifting `total`, and `captured_fields_json` to stop false-positive
churn events when a column is added later. There is nothing here worth backporting — if anything
the direction of learning would run the other way.

---

## 3. Price/valuation analysis

**Verdict: ADAPT the anti-circularity pattern from `truevalue\engine.py`. Do not port the file.**

`Celestials\scripts\truevalue\engine.py::_compute_listing_base_floor` (lines ~347-425) implements
exactly the "withhold below N comps" rule the brief asked about. The liftable artifact is small:

- A `BaseFloor` result shape: `(value, source_reason_string, confidence, circular: bool)` —
  confidence and its reason travel together, never separately (this is what `ConfidenceBadge.jsx`
  above renders).
- A `MIN_INDEPENDENT_COMPS` gate: below that count, the ranked/scored signal is **withheld** but
  an **informational** value is still shown, clearly labeled as unranked.
- Confidence is **tiered by evidence quality**, not just count: 0.90 (a clean, real comp
  exists) → 0.55 (derived/de-rated median across ≥2 comps) → 0.40 (exactly 1 usable comp) → 0.30/
  0.20 (N=2 market or self-referential — explicitly flagged `circular=True`) → 0.15 (category-level
  fallback, "weak anchor, NOT item-specific") → 0.0 (nothing).
- Comps explicitly **exclude the row being valued from its own comp set** — the circularity guard
  that stops a value from validating itself.

Maps onto 402cap's already-identified problem (4 outlier routes = 82% of derived GMV) as:
withhold a ranked/scored claim about a route's price trend or GMV contribution when it's backed
by too few independent snapshots/routes, but still surface the raw number with an explicit
low-confidence label and reason — never silently drop it, never present it at full confidence.
Everything else in `engine.py` (starforce cost recovery, potential-grade premiums, NESO/NXPC
math) is MapleStory-specific — SKIP, don't read past line 425 for this purpose.

- **SKIP:** `scripts\truevalue\flame_score.py`, `starforce_model.py`, `potential_lines.py`,
  `generate_golden.py`, `item_detail_fetch.py`, and `backend\src\modules\truevalue\*.ts` —
  all downstream of the same MapleStory-specific premium models.

---

## 4. Org/backlog tooling — the two real LIFTs

**Verdict: LIFT both. Verified by running, not just reading.**

### `Celestials\scripts\backlog-index.py` — LIFT
Parses a markdown backlog into an OPEN / BLOCKED-on-Michael / CLOSED / UNKNOWN index so an
autonomous tick can answer "what's unblocked?" without reading 60k+ tokens of backlog prose.
Copied to scratchpad and ran standalone (Celestials tree untouched):

```
python backlog-index.py --selftest
backlog-index selftest: 26/26 pass
```

26/26 — all classify() and row_status() edge cases pass, including the tricky ones (stray pipes
inside a status cell, extra columns, "not fixed" negation, section headings that carry their own
`Status:` verdict). Fully generic markdown-table parsing; nothing MapleStory-specific in the
logic itself. Edits needed for 402cap: none to the parsing logic. Only the `BLOCKED_MARKERS` list
(currently "needs michael", "michael's call", etc.) carries over **unedited** — same principal
(Michael), same escalation concept, works as-is. Point `SOURCE`/`OUTPUT` at
`x402\ORG-BACKLOG.md` / `x402\notes\backlog-open-index.md` (or wherever the org decides), and
**author `ORG-BACKLOG.md` in the shape this script expects** (see the finding above) rather than
writing free-form prose first and discovering the parser needs edits later.

### `Celestials\scripts\backlog-merge.py` — LIFT
Solves the exact gap ORG-CHARTER.md §4 already mandates but has no tooling for: *"Return ≤12
lines. Detail goes to a file; return the path."* Workers/managers write a backlog row to
`notes/backlog-inbox/<slug>.md` (a `## heading` + a markdown table) and return a short summary;
this script merges each inbox file into the real backlog under a matching heading (or inserts a
new section near the top) and deletes the inbox file. Keeps the coordinator from ever holding
backlog-row text in its own context three times over (agent's return + the write call + the
echoed result) — precisely the token-cost problem ORG-CHARTER.md's model-routing section is
trying to avoid. Two edits needed, both trivial: the `ANCHOR` string (currently a literal line
of Celestials' own backlog header) needs to match whatever line sits above 402cap's own backlog
table, and `BACKLOG`/`INBOX` paths need to point into `x402\notes\`. Has a `--dry-run` mode —
use it on the first real run.

---

## 5. Test harness patterns

**Verdict: ADAPT the harness, not the individual test files.**

The brief asked about "how frontend tests were structured" — the answer isn't any single
`partNN-*.mjs` file (those are the individual assertions, all `data-testid`-based, correctly
never counting elements), it's `celestials\tests\helpers.mjs`. Three genuinely portable, domain-
free pieces:
- `E2E`/`E2E_URL` toggle: same test file runs against a static `file://` build OR a live served
  API build, with `installWallet()`/`slowdown()` becoming no-ops in the former.
- `mintBuildDir()`/`cleanupBuildDir()` — a guarded throwaway-build-directory pattern built after
  a real near-miss (a test's cleanup step almost `rm -rf`'d the live production build because a
  throwaway dir name collided with it). `cleanupBuildDir` **throws** rather than silently
  no-oping if the resolved path isn't inside the guarded root. Directly relevant given
  ORG-CHARTER.md's own "never permanently delete" hard line — this is a concrete implementation
  of that discipline for test tooling specifically.
- `slowdown(page, factor)` — scales `page.waitForTimeout` calls by a factor only in live-API
  mode, so demo-tuned wait times absorb real network latency without touching every assertion.

All of it is Playwright-generic; nothing to strip out. Worth lifting once 402cap has a frontend
worth E2E-testing.

---

## 6. Deployment

**Verdict: ADAPT later, not now — premature until 402cap has a server.**

`backend\deploy\preflight.mjs` is a genuinely good pattern: a static, side-effect-free deploy
check (env completeness, DB reachability via `SELECT 1`, Redis `PING` if configured, pending-
migration detection) with exit code 0/1, runnable both pre-deploy and against a live app via
`fly ssh console`. `backend\fly.toml` + `Dockerfile` show a working Fly.io deploy shape (release
command runs migrations, health check endpoint, `auto_stop_machines`). None of this applies yet
— 402cap's README explicitly lists the HTTP API/MCP server under "Where this goes (not built
yet)." Worth a second look once that server exists; not worth acting on today.

---

## 7. x402 / payments / wallet / on-chain

**Verdict: SKIP for now, correctly out of scope per the charter's own hard lines.**

`backend\src\modules\deposits\{watcher.ts,blockTime.ts,chainClient.ts}` implements a real
deposit watcher against Henesys (a custom Avalanche L1, chain id 68414) — N-confirmation
gating, a live `getBlockNumber()` health check, a documented fallback block-time guess flagged
as an assumption. `notes\henesys-chain-risk-2026-07-26.md` is a solid piece of infra-risk
research on that chain specifically. None of it transfers: 402cap's hard lines (ORG-CHARTER.md
§4) are "never move money... never sign a payment authorization, or construct an X-PAYMENT/
PAYMENT-SIGNATURE header" — there is no deposit-watching task in 402cap's scope, and the chain
(Base) and asset (USDC) are both different from Henesys/NXPC anyway. The *pattern* (confirmation-
count gating, a live RPC health check folded into `/health`) is reasonable general Web3-backend
practice and could matter if 402cap ever needs to read on-chain settlement events for
verification — but that's speculative against a charter that currently forbids the money-moving
side of that entirely. Not worth carrying forward today.

---

## Paths referenced (for a follow-up agent — no re-scanning needed)

| What | Path |
|---|---|
| LIFT | `C:\Users\Micha\Desktop\Celestials\scripts\backlog-index.py` |
| LIFT | `C:\Users\Micha\Desktop\Celestials\scripts\backlog-merge.py` |
| ADAPT (pattern only) | `C:\Users\Micha\Desktop\Celestials\scripts\truevalue\engine.py` lines 308-425 (`BaseFloor`, `_compute_listing_base_floor`) |
| ADAPT | `C:\Users\Micha\Desktop\Celestials\celestials\src\components\ItemsDatabase.jsx` |
| ADAPT | `C:\Users\Micha\Desktop\Celestials\celestials\src\components\ConfidenceBadge.jsx` |
| ADAPT | `C:\Users\Micha\Desktop\Celestials\celestials\src\components\DataSourceNotice.jsx` |
| ADAPT | `C:\Users\Micha\Desktop\Celestials\celestials\tests\helpers.mjs` |
| ADAPT (later) | `C:\Users\Micha\Desktop\Celestials\backend\deploy\preflight.mjs`, `backend\fly.toml` |
| Anti-lift evidence | `C:\Users\Micha\Desktop\Celestials\celestials\vite.config.js`, `celestials\src\lib\seo.js` |
| SKIP (confirmed by reading) | `scripts\market-intel.py`, `backend\src\modules\{market-pulse,sync,truevalue}\*`, `bot\`, `guild-workspace\`, `backend\src\modules\deposits\*`, `celestials\src\styles\*`, all `*-fixture.json` |
