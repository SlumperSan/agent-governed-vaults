# Builder-code referral rail — findings (2026-07-31)

Manager: this task. Read-only against the live sweep (`x402_index.db`, snapshot id 6,
`is_complete=1`, 15,524 rows, fetched 2026-07-31T03:07:00Z). All numbers below are re-derived
directly from that snapshot, not carried over from the brief.

## 1. Prevalence — re-verified, matches the brief

- **2,670 / 15,524 routes (17.2%)** carry `extensions['builder-code']` in snapshot 6. Exact match
  to the brief's figure — re-derived independently, not assumed. Checked precisely: **2,670 routes
  have the `builder-code` key present at all**, and **2,670 of those have a populated `a` (App)
  field** — the same number, so no route declares the extension with only `s`/`w` and no `a`. The
  `builder_code` column and the "17.2%" figure both describe the same set.
- **44 distinct builder codes.**
- Field shape confirmed from raw JSON: `extensions['builder-code']` is a **top-level sibling of
  `extensions['bazaar']`**, not nested inside it. Schema declares three fields — `a` (App), `s`
  (Service, array), `w` (Wallet) — but **only `a` is ever populated**: 0/2,670 records have a
  non-empty `s` or `w`. See §3 for why that's expected, not a data gap.
- **Column vs. raw data mismatch caught and worked around:** `catalog_resource.builder_code IS NOT
  NULL` returns 0 rows for snapshot 2 and 2,670 for snapshots 5 and 6 — but snapshot 2's `raw_json`
  contains the identical extension for the identical 2,670 routes. `catalog_snapshot.
  captured_fields_json` confirms it: `NULL` for snapshot 2, `["builder_code",...]` for snapshot 5.
  The extraction code that populates the column didn't exist yet when snapshot 2 was fetched — this
  is the exact "field added mid-history" trap the repo's own diff logic already guards against
  (README, trap 3). It means the *column* is only safe to trust from snapshot 5 onward; the
  underlying *data* was present from the first complete fetch (snapshot 2, 2026-07-31T02:50:19Z).
  The persistence code in §4 reads from `raw_json` directly for exactly this reason.

## 2. What a builder code actually is — primary sources

**Direct hit:** `docs.x402.org/extensions/builder-code` documents this extension explicitly (this
is the primary source; nothing was reconstructed from the field name or a blog post):

- Codes are minted through any ERC-8021 implementation; **the primary production implementation is
  `base.dev`** (Coinbase's Base L2 dashboard).
- Three parties, three fields, each set by a different actor at a different point in the flow:
  - **`a` (App)** — set by the **resource server**; identifies the app exposing the paid endpoint.
  - **`w` (Wallet)** — set by the **facilitator**; identifies who settled the payment on-chain.
  - **`s` (Service)** — set by the **client**; one or more client-provided attribution codes.
- Codes are CBOR-encoded as an **ERC-8021 Schema 2** suffix appended to the settlement
  transaction's calldata.

**Inference (mine, not a docs quote, but directly follows from the above):** the CDP Bazaar
catalog is a **static server-side listing**. `a` is the only field the server can declare ahead of
time — `w` (facilitator) and `s` (client) only exist once an actual payment settles, so they
structurally cannot appear in a discovery catalog. That is the likely reason `s`/`w` are 0/2,670,
not evidence the fields are unused in practice.

**Cross-checked against `base/builder-codes` (GitHub, primary):** codes are ERC-721 NFTs, "1-32
characters, lowercase letters, digits, underscore" — matches the catalog schema's regex exactly.
Each code has a configurable payout address; minting is via `register()` (authorized registrar) or
gasless EIP-712 signature, both requiring `REGISTER_ROLE`.

*(Retrieval note: the docs.x402.org and base/builder-codes content above came back through the
fetch tool's own summarizer, not a raw dump I read character-by-character, so treat it as "per the
page as retrieved" rather than a hand-checked verbatim quote. It's reported as established, not
unverified, because two independent sources — the x402 extension docs and the separate Base repo —
corroborate the same mechanics.)*

**Revenue share: NOT ESTABLISHED.** Checked `blog.base.dev`'s own Builder Codes / ERC-8021 post
directly — it describes rewards as **protocol-discretionary** ("Protocols can query where rewards
credited to a code should be sent to... Base aims for every transaction to be attributed... to
inform how we prioritize... rewards for the teams that grow Base's global economy") — i.e. a
framework for *future*, per-protocol incentive programs, not an automatic, documented revenue
split. That blog post makes **zero mention of x402** — the on-chain standard and its x402
application are covered by different sources. No CDP-facilitator fee-share to builder-code holders
was found anywhere. The only place the x402↔ERC-8021 link is stated together with settlement
mechanics is `docs.x402.org/extensions/builder-code` itself (primary, cited above) — a July 2026
CryptoTimes/TronWeekly news write-up of the Base rollout exists but cites only a Base team X/Twitter
post as its source, not a doc or repo, so it's included here for context only, not as evidence.

## 3. What's in the data

**Route concentration — real, but not what it first looks like.** Top code by route count:

| code | routes | hosts (raw) |
|---|---|---|
| `bc_gxy6qn5p` | 1,587 (59.4% of builder-coded routes) | 144 |
| `bc_b4aw4uzd` | 524 (19.6%) | 1 |
| `bc_awpbwsy3` | 119 (4.5%) | 2 |

Top 2 codes = **79.1%** of all builder-coded routes. **Checked before reporting** (per
ORG-LESSONS's "four outliers invented a headline number"): the 144 "hosts" under `bc_gxy6qn5p`
collapse to **2 registrable domains** — `theaslangroupllc.com` (951 routes across ~70 subdomains
like `onchainpulse.`, `travelpulse.`, `debtpulse.`) and `vercel.app` (636 routes, matching
`*-nu.vercel.app` / `*-xi-blond.vercel.app` deploy-preview names for the same "pulse" site family).
**This is one operator running a templated multi-site farm, not a shared devtool adopted by many
independent builders.** 59.4% "route share" is one actor's deployment pattern.

**Call-volume concentration — checked, and it changes the headline finding.** I initially found
"builder-coded routes average 58 calls/30d vs 17 for non-coded" (3.4x) and almost reported it as
"builder-coded routes are more active." Before writing it down I checked internal concentration —
correctly flagged by review as the exact failure mode in ORG-LESSONS ("$62.8k headline was 82% four
outliers"):

- Top code **by calls**, `bc_qobj93ib`, has only **16 routes** but **120,890 of the 154,654 calls**
  attributed to all builder-coded routes combined — **78.2%**, almost entirely one host,
  `x402.twit.sh` (a paid Twitter/X data API; 15 of its 16 routes carry this code, plus one route on
  `api.aidress.ai` whose path literally contains `agent_x402_twit_sh`).
- **Median calls: 2 (with builder code) vs 1 (without)** — a small, real difference.
- **Mean with the top code stripped: 12.7** (still above the no-code population, but the two means
  aren't computed on matched bases and I did not strip outliers symmetrically from both sides).
- **Correct statement: builder-code presence does not demonstrate higher route activity.** The
  "3.4x more active" figure was a single-operator (`x402.twit.sh`) artifact, not a property of
  carrying a builder code. Do not repeat the 58-vs-17 figure.

**Curated correlation:** zero overlap. 122 routes are `curated=1` catalog-wide; **0 of those 122
carry a builder code**, and 0 of the 2,670 builder-coded routes are curated. Genuinely disjoint
sets in this snapshot — reported as observed, no interpretation offered (curated's own selection
criteria are undocumented, per README).

**Host↔code fidelity:** only **2 hosts** (`api.aidress.ai`, `402.com.tr`) carry more than one
distinct builder code; every other host with a builder code uses exactly one. Attribution is
almost always 1:1 per host, consistent with `a` being a static per-app declaration.

**One naming anomaly:** the code `modelprices` (host `modelprices.xyz`, 6 routes) does not follow
the `bc_` prefix every other code uses, though it satisfies the schema regex
(`^[a-z0-9_]{1,32}$`). Nothing in the docs found requires a `bc_` prefix — this looks like a
self-chosen code, not proof the registry enforces a naming convention. Flagged, not resolved.

**No trend exists yet.** Snapshots 2, 5, and 6 (the three complete ones so far) were all fetched
within ~20 minutes of each other on 2026-07-31 — **today is t=0** for this rail. Nothing here is a
time-series trend yet; it's a same-day baseline that later runs will turn into one.

## 4. Persistence — implemented, tested read-only against a copy, NOT run against production

The live sweep holds the write lock on `x402_index.db`, per the task's standing instruction. All
of the following was verified against a **byte-copy** of the db in scratch, never against
production:

1. **`fetch_catalog.py` fixed going forward** (`C:\Users\Micha\Desktop\x402\fetch_catalog.py`,
   `row_from_record`): `referral_json` was hardcoded `None` even though `catalog_resource` reserved
   it for exactly this. Changed to store the **full** `extensions['builder-code']` object (all of
   `a`/`s`/`w`, not just the `a` the `builder_code` column captures), so if `s`/`w` start appearing
   no schema or code change is needed to see them. **Tested in isolation** by calling
   `row_from_record()` directly against real `raw_json` samples pulled read-only from the live db —
   confirmed correct output — without running the fetch loop or opening the db for writing.

2. **`backfill_referral_json.py`** (new,
   `C:\Users\Micha\Desktop\x402\backfill_referral_json.py`) — a standalone script for the rows
   already stored under the old (always-`NULL`) logic, plus seeding `referral_event`:
   - **referral_json backfill:** re-derives the value from each row's own `raw_json` (no re-fetch
     needed). Tested against a copy: **8,107 rows** across all snapshots gained a value,
     `PRAGMA integrity_check` returned `ok` after commit.
   - **referral_event seed:** `referral_event` is shaped for *observed payments*
     (`direction`/`amount_raw`/`asset`/`network`) — data an unpaid prober structurally cannot see,
     and the CDP catalog exposes no revenue field at all (confirmed: `quality` ==
     `{l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt}`, nothing else, per README). Rather
     than skip the table silently, the script inserts **one row per (resource_url, referral_code)
     the first time it's observed** — `program='builder-code'`, `referral_code`, `resource_url`,
     `host`, `observed_at`, `raw_json` = the verbatim extension object — with
     `direction`/`amount_raw`/`asset`/`network` explicitly `NULL` because settlement was never
     observed. It reads presence from each row's `raw_json` directly (not the `builder_code`
     column) restricted to **complete snapshots only** (`is_complete=1`), for two reasons caught
     during testing: (a) the column is `NULL` on snapshot 2 even though snapshot 2's `raw_json`
     already has the same 2,670 routes — using the column would have wrongly anchored `observed_at`
     to snapshot 5's fetch time instead of the true earliest one; (b) snapshot 1 is a partial,
     aborted fetch (1,000/15,520 rows, `is_complete=0`) and including it would risk anchoring to an
     unreliable source. Tested against a copy: **2,670 rows inserted, all at
     `observed_at='2026-07-31T02:50:19Z'`** — snapshot 2's fetch time, the first *complete*
     snapshot — verified via `COUNT(DISTINCT resource_url||'|'||referral_code)` matching the row
     count exactly (no duplicates), `PRAGMA integrity_check` = `ok`.
   - **Safety:** an initial version guarded against writes by checking whether the `--db` path
     *string* ended in `\x402_index.db` — testing surfaced that a bare relative filename
     (`--db x402_index.db`, exactly how every other script in this repo is documented to be
     invoked, e.g. `python fetch_catalog.py` from the x402 directory) does not end in that string
     and would have slipped past the guard. Fixed to compare the **resolved absolute basename**
     instead. Re-tested against both the full production path and a bare `x402_index.db` filename
     (copied into a throwaway directory, run with `--apply` and no `--sweep-is-finished`): both
     correctly printed the refusal and the script returned before opening a connection — no write
     was attempted in either case. This makes the documented post-sweep command
     (`--db C:\...\x402_index.db --apply --seed-referral-events --sweep-is-finished`) real and
     runnable verbatim once Michael/the sweep owner confirms the sweep has actually finished — it
     is **not run against production by this task**.

## 5. What I did not do / could not verify

- **Did not run anything against the live `x402_index.db`.** Every test above ran against a
  byte-copy in the scratch directory; the copies and any accidentally-named test files in the
  project directory were deleted after verification.
- **Could not establish a revenue-share mechanism** from any primary source — marked NOT
  ESTABLISHED in §2, not guessed at.
- **Did not attempt on-chain verification** (reading actual Base settlement calldata for the
  ERC-8021 suffix) — that would require an on-chain indexer and is out of scope for a catalog/probe
  tool that never pays. The catalog-side attribution (`a` field) is the only side of the three-party
  scheme this system can ever observe.
- **Did not identify who operates `bc_gxy6qn5p`** beyond the two registrable domains
  (`theaslangroupllc.com`, a Vercel-hosted deploy family) — no further identity lookup was
  attempted (would require WHOIS/company lookups outside this task's data source).

## 6. Defect noticed in passing (not fixed — out of scope for this task)

`v_builder_codes` (and `v_latest_catalog`, which it reads) selects `MAX(snapshot_id)` per
`resource_url` **without filtering `catalog_snapshot.is_complete`**. Every query in this report
pinned `snapshot_id = 6` explicitly to sidestep this. If a partial/aborted catalog fetch ever gets
a higher snapshot id than the last complete one while a future API serves straight from these
views, results would silently mix in incomplete data. Worth a one-line `WHERE` fix
(`JOIN catalog_snapshot ON is_complete=1`) before `v_builder_codes` is exposed through any read API
(backlog item #6).
