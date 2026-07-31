# PayAI Catalog — Fresh Refetch + Ingestion Mapping (fetch-only, zero DB writes)

**Researched:** 2026-07-31, ~08:51 UTC. **Scope:** refetch PayAI's live discovery catalog to a
durable file, map its actual field shape onto `catalog_resource`'s ~36 columns. **No rows were
inserted into `x402_index.db`.** Per the brief, actual ingestion is deferred until Data's
`resource_dim` repartitioning is confirmed landed (checked live below — see §5, Go/No-Go).

## 0. What was fetched

`GET https://facilitator.payai.network/discovery/resources?limit=1000&offset=N`, unauthenticated,
`Accept: application/json`, descriptive User-Agent (`402cap-research/0.1`, same convention as the
prior session and as `fetch_catalog.py`'s CDP fetcher). 26 pages, 1.2s between requests.

- **Total items fetched: 25,096** (`pagination.total` reported exactly `25096` on every one of the
  26 pages — static across the whole fetch, unlike CDP's and UVDAO's documented mid-fetch drift).
- `pagination.limit` was **not** clamped this time (echoed back `1000`, matched what was requested)
  — different from the UVDAO/Thirdweb clamp-to-100 behavior documented in
  `notes-cross-facilitator.md`. Paginated using the echoed limit regardless, per that file's
  convention.
- **Duplicate-key check (ORG-LESSONS.md standing rule):** 25,096 raw items, 25,096 distinct
  `resource` URLs, **0 duplicates.**
- Raw fetch saved to the repo (not scratchpad): `C:/Users/Micha/Desktop/x402/notes-payai-catalog-raw.json`,
  **18,776,523 bytes (~17.9 MB)**. Kept in-repo rather than scratchpad specifically because the
  brief's whole reason for existing is that the prior session's raw JSON evaporated with an
  expired scratchpad temp path — 18MB next to the existing 302MB `x402_index.db` is not a size
  problem, and a re-evaporating file would repeat exactly the failure this task was dispatched to
  fix.
- Fetch script: `C:/Users/Micha/AppData/Local/Temp/claude/C--Users-Micha-Slumper/8bc3b4e9-2af4-4e6a-9533-37054aa2b996/scratchpad/fetch_payai.py`
  (kept in scratchpad — it's a throwaway tool, not the deliverable).

## 1. Concentration check, re-run on the fresh fetch (ORG-LESSONS.md standing rule)

**Verdict: the 64% figure still holds**, with the exact denominator stated (the prior note's "64%
of non-game HTTP items" phrasing was ambiguous enough to invite a denominator error — spelling out
all three below):

| Denominator | Value | orbisapi.com share |
|---|---|---|
| All raw items | 25,096 | 14,247 / 25,096 = **56.77%** |
| HTTP(S)-scheme items only (excludes `monopoly://`, `transfer://`, `solana-transfer://`, etc.) | 22,279 | 14,247 / 22,279 = **63.95%** |
| Clean real-HTTP-host items (HTTP(S) minus 21 junk/local/IP hosts, 32 items) | 22,247 | 14,247 / 22,247 = **64.04%** |

The prior session's "64%" used the HTTP(S)-item denominator (row 2/3 above), not the raw-item count
— confirmed matching to within 0.1pp on a fresh, independently-refetched dataset a day later.

**URI scheme breakdown (raw 25,096):** `https` 19,339 (77.06%), `http` 2,940 (11.72%), `monopoly`
2,318 (9.24% — a game/prediction-market URI scheme, not HTTP, matches prior finding), `transfer`
277 (1.10%), `solana-transfer` 212 (0.84%), `pinocchio` 5, `inscribe` 4, `x402-wallet` 1.

**Host-level breakdown — top 10 by route count** (base: 723 distinct clean HTTP(S) hosts, 22,247
items after excluding 21 junk/local/IP hosts covering 32 items):

| Rank | Host | Routes | % of raw (25,096) | % of HTTP items (22,279) | % of clean-host items (22,247) |
|---|---|---|---|---|---|
| 1 | orbisapi.com | 14,247 | 56.77% | 63.95% | 64.04% |
| 2 | pinionos.com | 1,555 | 6.20% | 6.98% | 6.99% |
| 3 | agent402.tools | 1,241 | 4.95% | 5.57% | 5.58% |
| 4 | api.x402node.dev | 492 | 1.96% | 2.21% | 2.21% |
| 5 | payai.agentstools.dev | 350 | 1.39% | 1.57% | 1.57% |
| 6 | x402.asrai.me | 318 | 1.27% | 1.43% | 1.43% |
| 7 | x402.aurelianflo.com | 255 | 1.02% | 1.14% | 1.15% |
| 8 | mpp.hyreagent.fun | 181 | 0.72% | 0.81% | 0.81% |
| 9 | gpt55.558686.xyz | 141 | 0.56% | 0.63% | 0.63% |
| 10 | x402.tweetx402.com | 93 | 0.37% | 0.42% | 0.42% |

**A correction to the prior session's framing, found by inspection (not just recount):** the prior
note guessed orbisapi.com's 14,247 routes were "almost certainly a single templated API registering
thousands of path variants" (i.e., a `:param`-style route template). **That is not what the paths
look like.** Sample orbisapi.com paths: `/proxy/wallet-address-risk-api-c6680c`,
`/proxy/email-validator-v2-api-0e7e59`, `/proxy/phone-formatter-v2-api-83fff3` — every path is a
**distinct literal string** ending in a unique random hex suffix, not a placeholder segment. Running
the existing `is_templated()` heuristic (`:param`-prefixed path segment) against all 14,247
orbisapi.com routes: **0 fire as templated.** Across the whole 25,096-item corpus, only 295 routes
(1.2%) trip that heuristic at all. This means: (a) orbisapi.com's concentration is from bulk
auto-generated/registered literal proxy endpoints, not one parameterized template, and (b) the
existing `is_templated` code, ported unchanged, will silently classify PayAI's single largest
concentration source as "not templated" — worth knowing before anyone uses `is_templated` to argue
PayAI's concentration is a templating artifact the way CDP's AgentMail/OneSource cases were.

## 2. Schema shape (from the fresh raw data, not guessed from field names)

PayAI's discovery record is a **much thinner shape than CDP's**. Full top-level key set, observed
across all 25,096 records (100% coverage on every one, no partial keys):

`accepts, inputSchema, lastUpdated, metadata, method, outputSchema, resource, toolName, type,
x402Version`

That's it — **no top-level `serviceName`, `description`, `iconUrl`, `curated`, `quality`, `tags`,
or `extensions` object exists anywhere in the corpus**, confirmed by a structured per-key scan
(`Counter` over every record's keys, every `accepts[]` entry's keys, and every `extensions{}`
namespace) — not by grepping the raw text for those words. A raw-text substring search for
`"curated"`, `"serviceName"`, `"extensions"`, `"tags"` does find hits, but inspection shows every
hit is **incidental content inside an unrelated field** (e.g., a route's own `outputSchema` example
payload happens to contain a JSON key called `"tags"` because the *underlying API* returns tagged
data — not because PayAI's catalog schema has a `tags` field). Confirmed no real occurrence of
`skillUrl` or `builder-code` anywhere in the 18MB file (plain substring, zero hits for `skillUrl`).

`metadata` is `{}` on all 25,096 records. `toolName` is `null` on all 25,096. Both are dead fields
in the live catalog today.

**Two `accepts[]` shapes coexist** (x402 v1 vs v2, split by the record's own `x402Version` field —
25,096/25,096 have `accepts` length exactly 1, so there is never a "cheapest of several" choice to
make for PayAI, unlike CDP):

- **v2** (18,832 records, 75.04%): `{asset, payTo, amount, scheme, network, maxTimeoutSeconds,
  extra:{name,version}}`. No `resource`/`description`/`mimeType` inside the accept object.
- **v1** (6,264 records, 24.96%): `{asset, payTo, scheme, network, maxTimeoutSeconds, mimeType,
  resource, description, outputSchema, maxAmountRequired}` — a `description` field exists here,
  nested inside `accepts[0]`, not at top level.

`amount`/`maxAmountRequired` values are **100% clean string-integers** — 0 decimal-string
violations, 0 JSON-number violations, across all 25,096 (better hygiene than CDP's ~137/15.5k rate
per prior research — worth noting as a positive finding, not just a gap list).

**Network aliasing is real and measurable:** `network` values include both `eip155:8453` (17,492)
and its v1-slug alias `base` (3,408) for the *same chain*, and both a full CAIP-2 Solana string
(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, 1,282) and the bare alias `solana` (2,769) for the *same
chain* — plus a `solana-devnet` variant (22, genuinely different/testnet). `scheme` is `exact` on
25,095/25,096 records, `upto` on 1.

## 3. Column-by-column mapping onto `catalog_resource`

Three verdict classes, not two — most CDP columns are **derived by existing code**
(`row_from_record`/`summarise_accepts`/`pick_amount`/`atomic_to_usd` in `fetch_catalog.py` /
`x402_common.py`), not copied verbatim, so "maps / NULL" alone would mis-describe them.

| Column | Verdict | Detail |
|---|---|---|
| `resource_url` | **Direct** | PayAI top-level `resource`. 100% coverage, 25,096/25,096 unique. |
| `host` | **Derived, works unchanged** | `urlparse(resource).netloc` — same code as CDP. |
| `url_path` | **Derived, works unchanged** | `urlparse(resource).path` — same code. |
| `service_name` | **No PayAI equivalent** | No `serviceName` field anywhere (structured scan, 0/25,096). → NULL. |
| `resource_type` | **Direct, but degenerate** | PayAI `type` is `"http"` on all 25,096 — a single constant value, still a real field, still maps cleanly. |
| `description` | **Partial, needs adjusted extraction** | Only present nested at `accepts[0].description`, and only reachable for v1-shape records (6,264 of them, 24.96% of the corpus) — v2 records have no `description` field at all, anywhere. Of those 6,264 v1 records, 5,892 have a non-empty `description` and **372 have the key absent or empty** even within the v1 shape. So: 5,892/25,096 = 23.48% of the *whole corpus* is non-empty description, and 5,892/6,264 = 94.06% of the v1-only subset — both numbers are correct, cited against different denominators; the 372-record gap is inside the v1 group, not a separate mystery. `row_from_record` currently reads `rec.get("description")` (top-level) — that would read NULL for every PayAI record as-is. Needs a PayAI-specific extraction path pulling from `accepts[0]`, not a code change to the shared function (CDP's `description` really is top-level). |
| `icon_url` | **No PayAI equivalent** | → NULL. |
| `curated` | **No PayAI equivalent** | No curation flag exists (structured scan, 0/25,096). → NULL. |
| `catalog_x402_version` | **Direct, works unchanged — but flag a semantic collision** | PayAI top-level `x402Version` (1 or 2). Existing code (`rec.get("x402Version")`) reads this correctly already. For CDP this column is effectively constant; for PayAI it's a **load-bearing discriminator** — it's literally what determines which `accepts[0]` shape the record uses (see §2). Any future cross-source query that groups or filters on this column will be comparing "a near-constant" (CDP) against "the field that decides the schema" (PayAI) — same column, different role. |
| `last_updated` | **Direct field exists, but likely not the same fact** | `lastUpdated` is present and unique-per-record (25,096 distinct values, clustering tightly around each page's own fetch timestamp) — this looks like **when-the-server-served-this-row**, not **when-the-listing-last-changed** the way CDP's field is documented to mean. Flag before trusting it for churn/staleness comparisons; not verified against a second fetch in this task. |
| `l30d_total_calls` | **No PayAI equivalent** | No `quality` object or any calls/volume field exists anywhere (0/25,096). → NULL. |
| `l30d_unique_payers` | **No PayAI equivalent** | Same as above. → NULL. |
| `last_called_at` | **No PayAI equivalent** | Same as above. → NULL. |
| `est_gmv_30d_usd` | **Derivable in principle, but always NULL for PayAI** | Formula is `price × l30d_total_calls`; since calls is never available, this column would be NULL for every PayAI row, permanently, not just today. |
| `is_templated` | **Derived, works unchanged as code — but produces a false negative on PayAI's biggest concentration** | The `:param`-segment heuristic fires on only 295/25,096 (1.2%) and **0/14,247** on orbisapi.com specifically (see §1) — PayAI's dominant bulk-registration pattern uses literal random-suffixed paths, a shape this heuristic was never built to catch. No code change needed to port it, but its output will read as "PayAI has almost no templated routes," which is true of the *literal* `:param` convention and misleading about *the actual concentration pattern*. |
| `accepts_count` | **Direct, works unchanged, but degenerate** | `len(accepts)` — always exactly 1 for PayAI (25,096/25,096), vs. CDP's variable count. No "cheapest of several" logic ever triggers for this source. |
| `min_amount_raw` | **Direct, works unchanged** | `pick_amount()` already checks `amount`, `maxAmountRequired`, `maxAmountRequiredUSD` in that order — both PayAI shapes (v2 `amount`, v1 `maxAmountRequired`) are already handled by the existing function with zero changes. This was built more generically than the CDP-only docstring suggests. |
| `min_amount_field` | **Direct, works unchanged** | Same function, returns which field name was used. |
| `min_amount_network` | **Direct field exists; needs an alias-table addition to convert correctly for ~11% of records** | See §4 — the bare `"solana"` alias (2,769 records, 11.03%) is not in `_STABLE_6DP`/`ASSET_DECIMALS` even though `"eip155:8453"`/`"base"` and Base-Sepolia/Polygon aliases already are. `resolve_decimals()` needs one more tuple, not a rewrite. |
| `min_amount_asset` | **Direct, works unchanged** | `resolve_decimals()` already lowercases both network and asset before lookup, so the checksummed-vs-lowercase asset-address variance observed in the raw data (e.g. `0x833589fCD6e...` vs `0x833589fcd6e...`) is already handled — not a real gap, verified by testing against the actual data, not assumed from the code comment alone. |
| `min_amount_scheme` | **Direct, works unchanged** | `accepts[0].scheme`. `exact` 25,095, `upto` 1. |
| `min_amount_pay_to` | **Direct, works unchanged** | `pick_pay_to()` already checks `payTo` then `recipient`; PayAI only ever populates `payTo` (100%), no adjustment needed. |
| `catalog_price_usd` | **Derived, works unchanged EXCEPT for the same solana-alias gap as `min_amount_network`** | Ran `atomic_to_usd()` over the full fresh corpus, **unmodified**: prices **22,284/25,096 = 88.80%** as-is. Of the 2,812 unpriced, 2,769 (98.5% of the gap) are exactly the bare-`"solana"`-network records — same real USDC mint address (`EPjFWdd5Auf...`) as the already-recognized full-CAIP Solana entry, just under the unrecognized alias. Adding one alias tuple would take coverage to **25,053/25,096 = 99.83%**. The remaining ~43 unpriced records span 12 genuinely obscure/unrecognized networks (1-5 records each: `eip155:1187947933`, `xlayer`, `sei-testnet`, `peaq`, etc.) — correctly left as unknown, not a gap worth chasing. |
| `decimals_unknown` | **Derived, works unchanged** | Follows directly from the above once the alias is added. |
| `amount_format_violation` | **Derived, works unchanged — and PayAI is clean** | Checked directly: 0/25,096 decimal-string or JSON-number amount violations. Every value is a plain string integer. This column will simply be 0 for every PayAI row today; not a defect, a genuinely clean source on this axis. |
| `has_bazaar_ext` | **No PayAI equivalent** | No `extensions` object exists (0/25,096). Code (`1 if bazaar else 0`) will correctly and harmlessly evaluate to 0 for every row — not NULL, but truthfully "no bazaar extension present," which is accurate. |
| `has_bazaar_schema` | **No PayAI equivalent** | Same reasoning, always 0. |
| `bazaar_method` | **No PayAI equivalent under this name — but a real analog exists at top level** | CDP's `bazaar_method` is populated from `bazaar.info.input.method` — i.e., it exists to record "what HTTP method to call." PayAI carries the *same real-world fact* as a genuine top-level field: `method` (`GET` 20,045, `POST` 3,116, `HEAD` 16, missing/null 1,919). **Judgment call, flagged rather than silently decided:** either (a) map PayAI's top-level `method` into this column despite the name mismatch, since it is the same semantic fact under a different convention, or (b) leave it NULL and lose a real, 92%-populated field. Recommend (a), but this is a modeling decision for whoever ingests, not something this fetch-only task should decide unilaterally. |
| `bazaar_route_template` | **No PayAI equivalent** | No declared route-template string exists; PayAI never marks a path as parameterized (see `is_templated` note above). → NULL. |
| `tags_json` | **No PayAI equivalent** | No `tags` array at the catalog-schema level (see §2's substring-vs-structured-scan note). → NULL. |
| `referral_json` | **No PayAI equivalent** | No `builder-code`/referral extension construct exists (0/25,096, confirmed no `extensions` object at all). → NULL. |
| `raw_json` | **Direct, works unchanged** | The whole record, verbatim, regardless of schema shape — 100% coverage by construction. |
| `skill_url` | **No PayAI equivalent** | `_find_skill_url()`'s generic recursive scan would run fine against a PayAI record, but there is no `skillUrl` key anywhere in the corpus (confirmed: 0 hits in the full 18MB raw text). Will correctly return `None` for every row. |
| `builder_code` | **No PayAI equivalent** | Same reasoning as `referral_json` — no `extensions.builder-code` construct exists. → NULL. |
| `extension_names_json` | **No PayAI equivalent** | `ext.keys()` is always empty since `extensions` never exists. → empty list, not NULL — a real, accurate statement ("this record declares zero extensions"), not a missing value. |
| `is_deprecated` | **No PayAI equivalent, code already degrades correctly** | `ext.get("deprecated") is True else (0 if "deprecated" in ext else None)` — with `ext={}` always, `"deprecated" in ext` is always False, so this correctly falls through to `None` (not a false 0) with zero code changes needed. |
| `has_discount_ext` | **No PayAI equivalent, always a true 0, not NULL** | `1 if "discount" in ext else 0` — with `ext={}` always, this is always literally `0` ("no discount extension present," accurately) for every PayAI row. Not a gap, just an uninformative column for this source. |

## 4. PayAI-specific fields that have no home in the current schema

- **`x402 v1`-shape `accepts[0].mimeType`** (6,264 records, 24.96%) — the response content-type.
  CDP's schema has no equivalent column. Would need a new column if this is ever wanted.
- **`inputSchema`** (100% coverage, `{type, method, queryParams}` or `{type, method, body,
  bodyType}`) — a real, structured description of how to call the resource (query params vs. JSON
  body). Currently only reachable via `raw_json`. Not present as a first-class CDP concept at all.
- **`outputSchema`** (100% coverage; `null` on 6,264 v1 records, a `{type, example}` object on the
  rest) — a worked example of the response shape. Same situation as `inputSchema`: real, structured,
  no first-class column, only reachable via `raw_json` today.
- **`accepts[0].extra`** (`{name, version}`, 25,095/25,096) — this is the EIP-712 domain metadata
  for the asset (e.g., `{"name":"USD Coin","version":"2"}`), a genuinely different fact from
  anything CDP's schema captures. No home; low priority (redundant with `asset` address for known
  tokens).
- **Network-alias inconsistency itself** (`base` vs `eip155:8453`, `solana` vs full CAIP Solana) is
  not a "new field" but is a real PayAI-specific data-quality fact worth a first-class flag column
  (`network_alias_normalized` or similar) the way `amount_format_violation` flags a different class
  of spec noise, rather than being silently absorbed by `resolve_decimals()`'s alias table.

## 5. Go/No-Go for actual DB ingestion

**Live schema check, read-only (`file:x402_index.db?mode=ro`), run at the end of this task.**
`PRAGMA table_info`'s `pk` column is *ordinal position within the primary key*, not a boolean, so a
field-position read of it is an inference, not proof — verified against the authoritative source
instead (`sqlite_master.sql`, the literal `CREATE TABLE` text):

```sql
CREATE TABLE "resource_dim" (
    source              TEXT NOT NULL DEFAULT 'cdp',
    resource_url        TEXT NOT NULL,
    host                TEXT,
    first_seen_snapshot INTEGER,
    first_seen_at       TEXT,
    last_seen_snapshot  INTEGER,
    last_seen_at        TEXT,
    times_seen          INTEGER,
    PRIMARY KEY (source, resource_url)
)
```

**`resource_dim` already carries the compound `(source, resource_url)` PRIMARY KEY**, confirmed by
the literal DDL, not by a backlog cell, a code comment, or a PRAGMA field-position guess (2026-07-31,
checked live). **Note for whoever reads `fetch_catalog.py` next:** its comment at lines ~328-331
("This does NOT key resource_dim on (source, resource_url) -- it still dedupes on resource_url
alone") is now **stale relative to the live schema** — the migration landed and the comment did not
get updated. Small thing, but it's the exact "a code comment is a claim about the world, not the
world" trap ORG-LESSONS already names. `catalog_snapshot` and `catalog_resource` both already carry
a `source TEXT NOT NULL DEFAULT 'cdp'` column too (checked the same way), though — correctly —
neither needed a PK change (they're keyed on a surrogate `id`; only `resource_dim`'s natural key
needed the repartition, per the design in `notes-cross-facilitator.md` §4).

**Recommendation: conditional GO, with two things the ingestion task must do itself, not inherit
from this check:**
1. **Re-run this exact PRAGMA immediately before ingesting**, not rely on this snapshot — the brief
   itself warns Data's table-recreate (create-copy-drop-rename) could still be mid-flight this same
   sprint, and a PRAGMA result from earlier in the sprint is a claim about the world at that moment,
   not a standing guarantee.
2. **Verify the application-level logic**, not just the schema: `rebuild_resource_dim()`,
   `diff_snapshots()`, and `v_latest_catalog` all need to actually partition by `source` per the
   design doc — this task only checked the table's declared PK shape, not whether the Python that
   populates it has been updated to match. That verification belongs to whoever ships PayAI
   ingestion, or to a Data-department confirmation step, not to this fetch-only task.
3. Before ingesting, apply the two concrete, low-risk fixes identified above: (a) add
   `("solana", "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v")` to `_STABLE_6DP` in
   `x402_common.py` (takes price coverage from 88.80% to 99.83%, zero risk to any existing CDP row
   since it's a pure addition); (b) decide and document the `method` → `bazaar_method` mapping
   call from §3 before the first real ingest, so it isn't decided silently by whichever column
   order happens to get written first.

## 6. DB-write verification (zero writes, as required)

| Checkpoint | mtime | size (bytes) |
|---|---|---|
| Before this task started | 2026-07-31 03:32:03 | 345,034,752 |
| Mid-task (after PRAGMA check) | 2026-07-31 03:53:31 | 348,684,288 |
| End of task | 2026-07-31 03:54:24 | 348,684,288 |

The file's mtime and size **did move during this task's window** — but size was already stable
between the mid-task and end-of-task checks (both 348,684,288 bytes), and this task's only contact
with `x402_index.db` was three `sqlite3.connect(..., mode=ro)` reads (`PRAGMA table_info` /
`sqlite_master.sql` on `resource_dim`, `catalog_snapshot`, `catalog_resource`, plus one `SELECT` on
`catalog_snapshot` itself) — no `INSERT`/`UPDATE`/`DELETE`/`ALTER` anywhere in this session,
confirmed by re-reading every DB-touching line of code and command run.

Rather than just asserting an external writer, checked for one: `SELECT id, fetched_at, source,
is_complete FROM catalog_snapshot ORDER BY id DESC LIMIT 5` (read-only) shows **two new snapshot
rows, ids 7 and 8, both `source='cdp'`, `is_complete=1`, fetched at 2026-07-31T08:27:01Z and
08:27:47Z** — i.e. a real CDP catalog rebuild ran and committed rows during (or just before) this
task's window, on top of snapshot 6 (the 03:07Z daily cron) that already existed at baseline. That
is the writer: someone else's CDP fetch/rebuild, not this task, which never wrote a `catalog_snapshot`
row of any kind (this task fetched PayAI to a plain JSON file, never to the DB).

## Files

- Raw fetch (deliverable): `C:/Users/Micha/Desktop/x402/notes-payai-catalog-raw.json` (18,776,523 bytes, 25,096 items)
- This mapping doc: `C:/Users/Micha/Desktop/x402/notes-payai-ingestion-plan.md`
- Fetch script (throwaway): scratchpad `fetch_payai.py`, log `fetch_payai.log`
- Analysis scripts (throwaway): scratchpad `analyze_payai.py` and inline one-off checks (network
  coverage, skillUrl grep, is_templated recheck) — all re-runnable against the saved raw JSON for
  independent verification.
