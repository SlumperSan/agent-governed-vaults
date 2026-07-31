"""
Shared foundation for the x402 index: SQLite schema, asset decimals, config.

WHAT THIS IS
------------
Storage layer for "CoinMarketCap for x402" — a market-data index over the x402
paid-API economy. Two data sources, deliberately kept separate in the schema:

  1. The CDP Bazaar catalog: what operators DECLARE about themselves, plus the
     only popularity/revenue signal anyone publishes (`quality`).
  2. Our own unpaid probes: what the endpoint ACTUALLY does when you knock.

Keeping those apart is the entire product. Coinbase publishes (1). Nobody
publishes (2). Every interesting question — "is the listed price the real
price?", "what fraction of listings are dead?" — is a JOIN across the two, and
that join only exists if they were never merged at write time.

WHY EVERYTHING IS INSERT-ONLY
-----------------------------
The moat is time series: price changes, call-volume trends, new listings, dead
listings. That only accumulates if every run APPENDS. `catalog_resource` rows
are scoped to a `catalog_snapshot`; `probe` rows are scoped to a `probe_run`.
There is no UPDATE against either table anywhere in this codebase.

The failure mode being prevented: a future agent "tidying up" by upserting on
resource_url. The moment that happens, every historical answer to "when did this
route go dark / when did this price move?" is destroyed and is not
reconstructible from anything else. If you are reading this while about to write
an UPDATE against `probe` or `catalog_resource`: don't. Insert a new snapshot.

(`resource_dim` is the one exception and it is safe — see its comment. It holds
no observations, only a rebuildable index over them.)

SECOND RULE: store the raw blob, always.
`catalog_resource.raw_json` holds the entire verbatim catalog record;
`probe.challenge_json` / `response_headers_json` hold the verbatim wire data.
Derived columns exist for query speed only. If a question next year needs a
field nobody extracted today, the raw column answers it. A schema of only
derived columns throws that data away at write time, irreversibly.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "x402_index.db"
LOG_DIR = BASE_DIR / "logs"

CATALOG_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"

# Descriptive User-Agent. Hosts we probe deserve to know who is knocking and to
# be able to block us trivially if they want to.
#
# CONTACT is intentionally EMPTY. Filling it means broadcasting a real email
# address to ~1,576 third-party operators, and that is Michael's call, not a
# build agent's. See README before setting it.
CONTACT = ""  # e.g. "mailto:name@example.com"
USER_AGENT = (
    "x402-index/0.1 (independent x402 liveness and price survey; unpaid 402-challenge "
    "probe only, one request per route per run; never sends payment"
    + (f"; contact {CONTACT}" if CONTACT else "")
    + ")"
)

# ---------------------------------------------------------------------------
# Asset decimals
# ---------------------------------------------------------------------------
# `amount` is in ATOMIC units. Converting to USD needs the token's decimals, and
# the catalog does not carry decimals. Defaulting to 6 because "most things are
# USDC" would mis-price every other asset by orders of magnitude, and the error
# would be invisible in the output — a clean-looking wrong number.
#
# So: only assets we can name are converted. Everything else gets usd = NULL and
# decimals_unknown = 1, and the report states what share of the corpus that is.
#
# Keys are (network, asset) LOWERCASED. The catalog contains the same Base USDC
# contract in both checksummed and all-lowercase form; a case-sensitive lookup
# silently classifies ~2% of Base rows as unknown assets.
#
# EURC is deliberately ABSENT despite being common. It is not $1.00, and a
# EUR/USD rate is a live number we do not have. Inventing one would be exactly
# the fabricated precision this index exists to expose in other people's data.
_STABLE_6DP = {
    ("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),   # Base USDC
    ("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),           # v1 slug, same token
    ("eip155:84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"),   # Base Sepolia USDC
    ("base-sepolia", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
    ("eip155:137", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),     # Polygon USDC
    ("polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
    ("eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),   # Arbitrum USDC
    ("eip155:480", "0x79a02482a880bce3f13e09da970dc34db4cd24d1"),     # World Chain USDC
    ("solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp",
     "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"),                  # Solana USDC
}
ASSET_DECIMALS: dict[tuple[str, str], int] = {k: 6 for k in _STABLE_6DP}


def resolve_decimals(network: str | None, asset: str | None) -> int | None:
    """Decimals for (network, asset), or None when we genuinely do not know.

    Returning None rather than a default is the point. A default becomes a wrong
    dollar figure in a published report with no marker on it.
    """
    if not network or not asset:
        return None
    return ASSET_DECIMALS.get((str(network).strip().lower(), str(asset).strip().lower()))


def parse_amount_field(amount) -> tuple[str, bool, bool]:
    """Return (raw_string, is_decimal_string, is_json_number).

    Both booleans are x402 spec violations: `amount` (v2) and `maxAmountRequired`
    (v1) are defined as STRING integers of atomic units. They are counted
    separately because they are different defects — a JSON number loses
    precision in some parsers; a decimal string is a units misunderstanding
    (~137 of 15.5k catalog records do this, per prior research, reproduced here).
    """
    is_number = isinstance(amount, (int, float)) and not isinstance(amount, bool)
    raw = "" if amount is None else str(amount)
    low = raw.strip().lower()
    is_decimal = ("." in low) or ("e" in low and low not in ("", "e"))
    return raw, is_decimal, is_number


def atomic_to_usd(amount_raw, network: str | None, asset: str | None) -> float | None:
    """Atomic-unit amount -> USD, or None when not convertible.

    Deliberately refuses decimal strings rather than repairing them. "0.01" is
    ambiguous (one cent? or 0.01 atomic units, i.e. a rounding artefact?) and
    guessing would launder a spec violation into a clean number. Callers flag it
    via parse_amount_field instead.
    """
    dec = resolve_decimals(network, asset)
    if dec is None:
        return None
    s = str(amount_raw).strip()
    if not s or not s.isdigit():
        return None
    try:
        return int(s) / (10 ** dec)
    except (TypeError, ValueError, OverflowError):
        return None


def pick_amount(accept: dict) -> tuple[str, bool, bool, str]:
    """Extract the price from an accept object across every shape seen in the wild.

    Measured across a 2,000-record catalog sample, `accepts[]` objects are NOT
    uniform: 4,135 use v2 `amount`, 133 use v1 `maxAmountRequired`, and 50 use a
    non-spec `{currency, recipient}` shape that belongs to no published version
    of x402. Reading only `amount` silently drops ~4% of the corpus and biases
    every price statistic toward v2-compliant operators.

    Returns (raw, is_decimal_string, is_json_number, field_name_used).
    """
    for key in ("amount", "maxAmountRequired", "maxAmountRequiredUSD"):
        if key in accept and accept[key] is not None:
            raw, is_dec, is_num = parse_amount_field(accept[key])
            return raw, is_dec, is_num, key
    return "", False, False, ""


def pick_pay_to(accept: dict) -> str | None:
    """`payTo` is the spec field; `recipient` is the non-spec variant on the 50
    outlier records. Record whichever is present rather than reporting a null
    payee for a route that plainly has one."""
    return accept.get("payTo") or accept.get("recipient")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
# Column naming note: catalog-derived popularity columns keep the catalog's own
# semantics in their names (`l30d_total_calls`, not `calls`), because these are
# CDP's numbers, measured by CDP, over CDP's own 30-day window. If we ever
# measure call volume ourselves it must land in a differently-named column, not
# get silently mixed into these.

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS catalog_snapshot (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at      TEXT NOT NULL,          -- UTC ISO8601, start of fetch
    source_url      TEXT NOT NULL,
    total_reported  INTEGER,                -- pagination.total, as the API stated it
    rows_stored     INTEGER,
    pages_fetched   INTEGER,
    duration_s      REAL,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS catalog_resource (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id             INTEGER NOT NULL REFERENCES catalog_snapshot(id),
    resource_url            TEXT,
    host                    TEXT,
    url_path                TEXT,
    service_name            TEXT,
    resource_type           TEXT,
    description             TEXT,
    icon_url                TEXT,
    curated                 INTEGER,        -- 'curated' flag; undocumented, see README
    catalog_x402_version    INTEGER,
    last_updated            TEXT,           -- catalog 'lastUpdated'

    -- POPULARITY / REVENUE. These three are the ONLY activity fields the CDP
    -- catalog exposes (verified by enumerating keys over a 2,000-record sample:
    -- quality == {l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt}, no
    -- more). There is no revenue field; GMV below is DERIVED, not reported.
    l30d_total_calls        INTEGER,
    l30d_unique_payers      INTEGER,
    last_called_at          TEXT,
    -- Derived: calls x cheapest listed price. Stored for query speed only; both
    -- inputs are kept above so the math is always re-derivable if the method
    -- changes. NULL whenever price is NULL (unknown decimals) - never 0.
    est_gmv_30d_usd         REAL,

    is_templated            INTEGER,        -- path contains a ':param' segment
    accepts_count           INTEGER,
    -- "cheapest accept" summary: a record may list several payment options, and
    -- the minimum is the honest headline price a caller would actually pay.
    min_amount_raw          TEXT,
    min_amount_field        TEXT,           -- which key held it: amount|maxAmountRequired|...
    min_amount_network      TEXT,
    min_amount_asset        TEXT,
    min_amount_scheme       TEXT,
    min_amount_pay_to       TEXT,
    catalog_price_usd       REAL,           -- NULL when decimals unknown
    decimals_unknown        INTEGER,
    amount_format_violation INTEGER,        -- decimal string / JSON number in an atomic field
    has_bazaar_ext          INTEGER,
    has_bazaar_schema       INTEGER,
    bazaar_method           TEXT,           -- declared HTTP method; drives probe method
    bazaar_route_template   TEXT,
    tags_json               TEXT,
    referral_json           TEXT,           -- reserved: any referral/affiliate metadata
                                            -- observed in the record. Always NULL today;
                                            -- exists so referral capture needs no migration.
    raw_json                TEXT NOT NULL   -- verbatim catalog record
);
CREATE INDEX IF NOT EXISTS ix_cat_snap   ON catalog_resource(snapshot_id);
CREATE INDEX IF NOT EXISTS ix_cat_host   ON catalog_resource(host);
CREATE INDEX IF NOT EXISTS ix_cat_url    ON catalog_resource(resource_url);
-- Composite index is what makes "price history for resource X" a cheap query.
CREATE INDEX IF NOT EXISTS ix_cat_urlsnap ON catalog_resource(resource_url, snapshot_id);

-- resource_dim: the ONE table that gets UPDATEd, and it is safe because it
-- holds no observations. It is a rebuildable index over catalog_resource,
-- maintained so that "what is new / what disappeared" does not require a
-- self-join over the full history on every API call. Dropping and rebuilding it
-- from catalog_resource loses nothing.
CREATE TABLE IF NOT EXISTS resource_dim (
    resource_url        TEXT PRIMARY KEY,
    host                TEXT,
    first_seen_snapshot INTEGER,
    first_seen_at       TEXT,
    last_seen_snapshot  INTEGER,
    last_seen_at        TEXT,
    times_seen          INTEGER
);
CREATE INDEX IF NOT EXISTS ix_dim_host ON resource_dim(host);

CREATE TABLE IF NOT EXISTS probe_run (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id      INTEGER REFERENCES catalog_snapshot(id),
    started_at       TEXT NOT NULL,
    finished_at      TEXT,
    planned_count    INTEGER,
    completed_count  INTEGER,
    host_concurrency INTEGER,
    per_host_delay_s REAL,
    timeout_s        REAL,
    user_agent       TEXT,
    sample_mode      TEXT,                  -- 'host-diverse:N' | 'all' | 'host:<name>'
    notes            TEXT
);

CREATE TABLE IF NOT EXISTS probe (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                      INTEGER NOT NULL REFERENCES probe_run(id),
    snapshot_id                 INTEGER REFERENCES catalog_snapshot(id),
    catalog_resource_id         INTEGER REFERENCES catalog_resource(id),
    probed_at                   TEXT NOT NULL,
    resource_url                TEXT,
    host                        TEXT,
    request_method              TEXT,
    request_url                 TEXT,       -- what we actually dialled
    final_url                   TEXT,       -- after redirects; differs => 3xx chain
    redirect_count              INTEGER,
    is_templated                INTEGER,

    http_status                 INTEGER,    -- NULL only on transport failure
    latency_ms                  INTEGER,
    transport_error_class       TEXT,       -- dns|connect|tls|timeout|redirects|protocol|other
    transport_error             TEXT,

    -- RAW SIGNALS, written before any interpretation, so that a future re-read
    -- of history can re-derive conclusions we did not think to draw today.
    payment_required_header_b64 TEXT,       -- verbatim PAYMENT-REQUIRED header (v2)
    has_payment_required_header INTEGER,
    body_x402_version           INTEGER,    -- x402Version found in the JSON body (v1)
    challenge_json              TEXT,       -- decoded challenge object, verbatim
    response_headers_json       TEXT,
    body_snippet                TEXT,       -- first 2000 chars, for forensics

    -- DERIVED
    is_valid_402                INTEGER,    -- parseable challenge with >=1 usable accept
    detected_version            INTEGER,    -- 1 | 2 | NULL
    version_source              TEXT,       -- 'header' | 'body' | NULL
    probed_scheme               TEXT,
    probed_network              TEXT,
    probed_asset                TEXT,
    probed_pay_to               TEXT,
    probed_amount_raw           TEXT,
    probed_price_usd            REAL,       -- NULL when decimals unknown
    probed_decimals_unknown     INTEGER,
    probed_accepts_count        INTEGER,
    bazaar_ext_present          INTEGER,
    bazaar_schema_present       INTEGER,
    bazaar_schema_valid         INTEGER,    -- NULL = absent, so not checked
    spec_violations             TEXT,       -- JSON array of violation codes
    violation_count             INTEGER,
    referral_json               TEXT        -- reserved: referral/affiliate hints seen on
                                            -- the wire (headers or challenge extensions).
                                            -- Always NULL today; no migration needed later.
);
CREATE INDEX IF NOT EXISTS ix_probe_run  ON probe(run_id);
CREATE INDEX IF NOT EXISTS ix_probe_host ON probe(host);
CREATE INDEX IF NOT EXISTS ix_probe_url  ON probe(resource_url);
CREATE INDEX IF NOT EXISTS ix_probe_urlrun ON probe(resource_url, run_id);

-- referral_event: reserved and intentionally unused. It exists now so that when
-- x402 referral/affiliate programmes appear, recording "we referred this call"
-- is an INSERT and not a schema migration against a table with history in it.
-- Nothing in this codebase writes to it.
CREATE TABLE IF NOT EXISTS referral_event (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at   TEXT,
    resource_url  TEXT,
    host          TEXT,
    program       TEXT,
    referral_code TEXT,
    direction     TEXT,       -- 'outbound_referral' | 'inbound_credit'
    amount_raw    TEXT,
    asset         TEXT,
    network       TEXT,
    raw_json      TEXT
);

-- ---------------------------------------------------------------------------
-- VIEWS: the read surface a future HTTP API / MCP server sits on. Keeping the
-- product's questions expressed as views means the API layer is a thin
-- serializer over SQL, not a rewrite of the storage model.
-- ---------------------------------------------------------------------------

-- Latest catalog state per resource. `v_latest_catalog` is the "current market"
-- table an API's /resources endpoint would page over.
--
-- NOTE: the canonical, up-to-date definition of this view lives in
-- _apply_view_fixes() below, not here. It is DROPPED and re-CREATEd there on
-- every connect() (metadata-only, cheap) so an existing DB's stored view text
-- can actually change -- `CREATE VIEW IF NOT EXISTS` cannot fix a view that
-- already exists with an old definition. The line below only bootstraps a
-- BRAND NEW empty DB before _apply_view_fixes runs; SQLite resolves view
-- references lazily (a CREATE VIEW does not require its referenced objects to
-- exist yet), so this placeholder never actually serves a query in practice.
CREATE VIEW IF NOT EXISTS v_latest_catalog AS
SELECT c.*
FROM catalog_resource c
JOIN (SELECT resource_url, MAX(snapshot_id) AS s
      FROM catalog_resource GROUP BY resource_url) m
  ON c.resource_url = m.resource_url AND c.snapshot_id = m.s;

-- Price + popularity time series. One row per resource per snapshot. This is
-- the /history endpoint and the input to any price-change scanner.
CREATE VIEW IF NOT EXISTS v_price_history AS
SELECT c.resource_url, c.host, c.snapshot_id, s.fetched_at,
       c.min_amount_raw, c.min_amount_asset, c.min_amount_network,
       c.catalog_price_usd, c.l30d_total_calls, c.l30d_unique_payers,
       c.last_called_at, c.est_gmv_30d_usd
FROM catalog_resource c
JOIN catalog_snapshot s ON s.id = c.snapshot_id;

-- ---------------------------------------------------------------------------
-- CHURN. This is the moat, and it exists because of a specific, verified
-- property of the upstream source: CDP recomputes quality metrics every ~6
-- hours and OVERWRITES them, and it REMOVES a resource entirely if it has not
-- settled a payment in 30 days. Coinbase therefore structurally cannot answer
-- "what died?", "what is decaying?", or "what did this cost last week?" — the
-- data is gone the moment it changes.
--
-- We keep it. A disappeared resource is NEVER deleted from this database; its
-- catalog_resource rows stay, resource_dim.last_seen stops advancing, and a
-- 'disappeared' change_event marks the moment. Their deletion is our dataset.
CREATE TABLE IF NOT EXISTS change_event (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at    TEXT NOT NULL,
    from_snapshot  INTEGER REFERENCES catalog_snapshot(id),
    to_snapshot    INTEGER REFERENCES catalog_snapshot(id),
    resource_url   TEXT,
    host           TEXT,
    event_type     TEXT NOT NULL,   -- listed | disappeared | price_change |
                                    -- calls_change | payers_change | curation_change |
                                    -- deprecated_change | metadata_change
    field          TEXT,            -- which field moved
    old_value      TEXT,            -- always stored as text; NULL means "absent", not zero
    new_value      TEXT,
    delta_num      REAL,            -- new - old when both are numeric, else NULL
    ratio_num      REAL             -- new / old when both numeric and old <> 0
);
CREATE INDEX IF NOT EXISTS ix_chg_time ON change_event(detected_at);
CREATE INDEX IF NOT EXISTS ix_chg_url  ON change_event(resource_url);
CREATE INDEX IF NOT EXISTS ix_chg_type ON change_event(event_type);
-- The composite index is what makes "what changed since T" a range scan rather
-- than a full table scan once this table has millions of rows.
CREATE INDEX IF NOT EXISTS ix_chg_typetime ON change_event(event_type, detected_at);

-- Catalog claim vs measured reality, latest of each. The differentiation claim
-- of this whole project is a single SELECT against this view.
CREATE VIEW IF NOT EXISTS v_claim_vs_reality AS
SELECT lc.resource_url, lc.host, lc.service_name,
       lc.min_amount_raw      AS catalog_amount_raw,
       lc.catalog_price_usd   AS catalog_price_usd,
       lc.min_amount_network  AS catalog_network,
       lc.l30d_total_calls, lc.l30d_unique_payers, lc.est_gmv_30d_usd,
       p.probed_at, p.http_status, p.latency_ms, p.transport_error_class,
       p.is_valid_402, p.detected_version,
       p.probed_amount_raw, p.probed_price_usd, p.probed_network,
       p.bazaar_ext_present, p.bazaar_schema_valid,
       p.spec_violations, p.violation_count,
       CASE
         WHEN p.probed_price_usd IS NULL OR lc.catalog_price_usd IS NULL THEN NULL
         WHEN ABS(p.probed_price_usd - lc.catalog_price_usd) < 1e-9 THEN 0
         ELSE 1
       END AS price_mismatch
FROM v_latest_catalog lc
LEFT JOIN (SELECT pr.* FROM probe pr
           JOIN (SELECT resource_url, MAX(id) AS mid FROM probe GROUP BY resource_url) mm
             ON pr.id = mm.mid) p
  ON p.resource_url = lc.resource_url;
"""


# ---------------------------------------------------------------------------
# Additive migrations
# ---------------------------------------------------------------------------
# Columns added AFTER a database already holds history. ALTER TABLE ADD COLUMN
# is used deliberately: it backfills NULL and touches no existing row, so old
# snapshots keep meaning exactly what they meant. The alternative — dropping and
# re-fetching — would silently reset every first_seen date in the dataset, which
# is the one thing we can never recover.
#
# NULL in one of these columns on an old snapshot means "not captured yet", NOT
# "absent from the record". Any query that treats NULL as absence will misreport
# history; filter by snapshot_id when you need a clean comparison.
MIGRATIONS = [
    # Which optional columns were actually CAPTURED when a snapshot was written.
    # Without this the churn diff cannot tell "this field just changed" from
    # "this field only started being collected" — and the difference is 2,701
    # fake metadata_change events, which is exactly what the first run produced.
    ("catalog_snapshot", "captured_fields_json", "TEXT"),
    # Did the fetch actually reach the end of the catalog? This CANNOT be
    # inferred from `rows_stored >= total_reported`: the upstream `total` drifts
    # UPWARD while a fetch is in flight (observed 15520 -> 15522 -> 15524 across
    # runs minutes apart), so a perfectly complete 15,522-row fetch compares as
    # short against a total that grew after page 1. Completeness is an explicit
    # fact recorded by the loop that terminated, not arithmetic on a moving
    # number. Everything downstream (churn diff, report diffing) gates on this.
    ("catalog_snapshot", "is_complete", "INTEGER"),
    ("catalog_resource", "skill_url", "TEXT"),
    ("catalog_resource", "builder_code", "TEXT"),
    ("catalog_resource", "extension_names_json", "TEXT"),
    ("catalog_resource", "is_deprecated", "INTEGER"),
    ("catalog_resource", "has_discount_ext", "INTEGER"),
    # --- Multi-source dimension (ORG-BACKLOG.md #Phase-2 "schema migration",
    # design in notes-cross-facilitator.md). Every row in this DB today came
    # from exactly one catalog (CDP/Coinbase), so DEFAULT 'cdp' is not a guess
    # backfilled after the fact -- it is the true value for every existing row,
    # and SQLite applies a constant DEFAULT to old rows without rewriting them
    # (metadata-only ALTER), so this is behavior-neutral on data that already
    # exists. Two tables get it, not one, because notes-cross-facilitator.md
    # itself contradicts its own placement -- section 1 puts `source` on
    # catalog_snapshot only, but section 4.3 specifies an index
    # ON catalog_resource(source, host), which is impossible without the
    # column existing there too. Resolved by denormalizing onto both:
    # catalog_snapshot.source describes "which catalog this fetch run hit",
    # catalog_resource.source is a fast copy of its own snapshot's source so
    # per-resource queries (the index, v_latest_catalog's partition key) never
    # need a join back to catalog_snapshot just to know provenance. A future
    # non-CDP ingester (Ecosystem dept) sets both explicitly per fetch run;
    # nothing in this codebase does that yet.
    ("catalog_snapshot", "source", "TEXT NOT NULL DEFAULT 'cdp'"),
    ("catalog_resource", "source", "TEXT NOT NULL DEFAULT 'cdp'"),
    # --- Backlog #18: extend the same source dimension to change_event and
    # resource_dim. Same justification as above (every existing row is 'cdp',
    # so DEFAULT 'cdp' is the true value, not a backfill guess) and same
    # additive/metadata-only ALTER TABLE idiom. This closes the schema half of
    # #18 only -- it does NOT repartition resource_dim's PRIMARY KEY or
    # fetch_catalog.py's diff_snapshots()/rebuild_resource_dim() logic to key
    # on (source, resource_url); see notes-source-migration-2.md for exactly
    # what was and wasn't done and why that remains Ecosystem's job at #12.
    ("change_event", "source", "TEXT NOT NULL DEFAULT 'cdp'"),
    ("resource_dim", "source", "TEXT NOT NULL DEFAULT 'cdp'"),
]


def _apply_migrations(conn: sqlite3.Connection) -> None:
    for table, col, decl in MIGRATIONS:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    # Indexes that reference migration-added columns must run AFTER the loop
    # above, not inside SCHEMA -- on a pre-existing DB, `source` does not exist
    # until the ALTER TABLE runs. Per notes-cross-facilitator.md #4.3: "which
    # sources know about host X" becomes a range scan instead of a full table
    # scan once non-CDP ingestion adds real row volume.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_catalog_resource_source_host "
        "ON catalog_resource(source, host)"
    )
    conn.commit()


# View text that must be able to CHANGE on a database that already exists,
# unlike every other view/table above which is created once with
# `IF NOT EXISTS` and assumed stable forever. `CREATE VIEW IF NOT EXISTS`
# cannot alter a view that is already present with an older definition, so a
# fix here would silently never apply to any DB file older than the fix
# itself -- exactly the trap that produced ORG-BACKLOG #11 in the first
# place (the bug was "fixed" once in api/db.py's Python CTE, but the actual
# stored view was untouched, so build_site.py/report.py/x402_common.py's own
# LATE_VIEWS consumers of v_latest_catalog stayed broken).
#
# DROP VIEW + CREATE VIEW is metadata-only (a view has no storage of its own),
# so running this unconditionally on every connect() is cheap and safe, and
# it is what makes the fix idempotent and re-runnable: run it once, twice, a
# hundred times, the schema converges to the same text every time.
def _apply_view_fixes(conn: sqlite3.Connection) -> None:
    conn.execute("DROP VIEW IF EXISTS v_latest_catalog")
    conn.execute("""
        CREATE VIEW v_latest_catalog AS
        SELECT c.*
        FROM catalog_resource c
        JOIN (
            SELECT cr.source, cr.resource_url, MAX(cr.snapshot_id) AS max_snapshot_id
            FROM catalog_resource cr
            JOIN catalog_snapshot cs ON cs.id = cr.snapshot_id
            WHERE cs.is_complete = 1
            GROUP BY cr.source, cr.resource_url
        ) m ON c.source = m.source AND c.resource_url = m.resource_url
           AND c.snapshot_id = m.max_snapshot_id
    """)
    # v_builder_codes is deliberately NOT redefined here. It is a live,
    # non-materialized view whose SELECT reads FROM v_latest_catalog by name
    # (see LATE_VIEWS below) -- SQLite re-resolves that reference on every
    # query, so correcting v_latest_catalog above corrects what
    # v_builder_codes returns with zero risk of the two definitions drifting
    # apart. Verified: see notes-source-migration.md for the before/after
    # query diff proving this.
    conn.commit()


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=60)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _apply_migrations(conn)
    # Views are created after migrations because some of them select columns
    # that migrations add. CREATE VIEW does not validate columns at creation
    # time, so a stale view definition fails only at SELECT — the confusing
    # kind of failure that shows up days later in a report.
    conn.executescript(LATE_VIEWS)
    # Runs last and unconditionally: fixes view TEXT on a pre-existing DB,
    # which the IF-NOT-EXISTS statements above cannot do.
    _apply_view_fixes(conn)
    return conn


# Views that reference migration-added columns. Kept separate from SCHEMA and
# executed after _apply_migrations so they never reference a column that does
# not exist yet on an older database file.
LATE_VIEWS = """
-- "What changed since last run" — one of the two queries this product sells.
CREATE VIEW IF NOT EXISTS v_recent_changes AS
SELECT ce.*, s.fetched_at AS to_snapshot_at
FROM change_event ce
LEFT JOIN catalog_snapshot s ON s.id = ce.to_snapshot;

-- "Full history for resource X" — the other one. Everything we have ever
-- observed about a route, catalog side and probe side, in one time-ordered
-- stream. Deliberately includes rows for resources that no longer exist
-- upstream; that is the whole point.
CREATE VIEW IF NOT EXISTS v_resource_history AS
SELECT c.resource_url, c.host, 'catalog' AS source, s.fetched_at AS observed_at,
       c.snapshot_id AS ref_id,
       c.catalog_price_usd AS price_usd, c.min_amount_raw AS amount_raw,
       c.min_amount_network AS network,
       c.l30d_total_calls, c.l30d_unique_payers, c.last_called_at,
       c.curated, c.is_deprecated, c.builder_code, c.skill_url,
       NULL AS http_status, NULL AS is_valid_402, NULL AS spec_violations
FROM catalog_resource c JOIN catalog_snapshot s ON s.id = c.snapshot_id
UNION ALL
SELECT p.resource_url, p.host, 'probe', p.probed_at, p.run_id,
       p.probed_price_usd, p.probed_amount_raw, p.probed_network,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       p.http_status, p.is_valid_402, p.spec_violations
FROM probe p;

-- Builder-code inventory. `extensions['builder-code'].info.a` is a live
-- attribution primitive already deployed on ~17% of the catalog ("App builder
-- code", pattern ^[a-z0-9_]{1,32}$). It is the closest thing to a referral rail
-- that exists in x402 today, so we track who carries which code over time.
CREATE VIEW IF NOT EXISTS v_builder_codes AS
SELECT builder_code, COUNT(*) AS routes, COUNT(DISTINCT host) AS hosts,
       SUM(l30d_total_calls) AS l30d_calls, SUM(est_gmv_30d_usd) AS est_gmv
FROM v_latest_catalog
WHERE builder_code IS NOT NULL
GROUP BY builder_code;
"""


def jdump(obj) -> str:
    """Compact, stable JSON for storage. sort_keys makes stored blobs diffable
    across snapshots — without it, dict key-order churn makes every record look
    changed and 'what moved since last run' returns noise."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
