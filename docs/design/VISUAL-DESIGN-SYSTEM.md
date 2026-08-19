# Visual Design System — Consumer Front End

Agent-Governed Index Vault Protocol · "Vault Atlas" consumer product

Companion artifact: [`style-tile.html`](./style-tile.html) — a static component sheet that
renders the tokens below. Design-direction document, not an app spec.

---

## 0. Who this is for, and what we inherited

**The reader is a human. The actor is often their agent.** The protocol is agent-governed —
agents deposit, vote by commit-reveal, and irrevocably opt in to skipping the observation
window (ARCHITECTURE §5, §8). But the person reading this screen is a human whose money the
agent is moving. Every design decision serves the moment where a person has to understand,
reconstruct, or authorize something an autonomous agent did or is about to do. That split is
the product's defining tension and the source of Principle 1.

**We are evolving, not replacing, the existing dashboard.** The current `apps/web/index.html`
is a dark "instrument panel" — Archivo + IBM Plex trio, violet accent, hairline borders, tight
density. That was correct for a data demo. The consumer product keeps its engineering
credibility (this is real infrastructure moving real USDC) and inherits its token names and its
IBM Plex numeric backbone. It changes **one** thing to become warmer and more approachable: it
trades the industrial grotesk headline for an editorial serif, and it lets the layout breathe.
We change the temperature with a single lever, not five.

---

## 1. Design principles

Five, specific to money + AI agents + on-chain governance.

1. **Auditable by the human.** A person must always be able to reconstruct what their agent did
   or is about to do, in plain words, without reading a contract. Governance timelines,
   irreversible-action confirmations, and fee math are shown as *reconstructions of consequence*,
   not as raw event logs. If the human can't narrate it back, the component has failed.

2. **Trust is shown, not asserted.** No "bank-grade," no lock icons as decoration. Trust comes
   from precision: real addresses (truncated but copyable), tabular-aligned numbers that don't
   jump, explicit timestamps on every valuation, and stated denominators (a quorum figure always
   shows what it's a percentage *of*). We never round away a number that affects what someone pays.

3. **Calm under volatility.** The interface must read the same when NAV is down 12% as when it's
   flat. Loss is communicated with a sign glyph and tabular numerals first, color second — never
   with alarm-red fills, pulsing, or upward-only chart framing. Motion is reserved for
   confirmations and state changes, never for drama. A falling number should feel *legible*, not
   *urgent*.

4. **Consequence before action.** Irreversible operations — a Mode-F queued exit, an
   observation-window skip, a full-consensus rule change — are gated by a confirm step that
   restates the *specific* consequence in plain language ("this exit settles at the price *after*
   the rebalance, and cannot be cancelled"), followed by a persistent, visible pending state.
   The UI never lets a one-way door look like a two-way door.

5. **The instrument stays honest.** Inherited from the instrument-panel equity: dense where
   density serves comprehension (leaderboards, fee stacks, NAV history), monospaced and
   tabular-aligned for anything numeric, and never decorated past the point of legibility.
   Warmth is added by typography, spacing, and elevation — never by softening the data.

---

## 2. Color system

Cool violet-indigo neutral family (retained from the instrument panel — this is the equity),
lifted and softened for a consumer register. Warmth is *not* carried by the neutral hue; it is
carried by the serif display face, generous spacing, soft elevation, and plain copy. This is a
deliberate choice: warm-cream neutrals plus a soft serif plus an earthy accent is the
AI-generated-design cluster (see §7), so we take exactly one warmth lever and keep the neutrals
serious.

### 2.1 Accent vs. semantics — kept separate on purpose

- **Iris** (`--accent`, violet-indigo) is *brand and interaction only*: primary buttons, active
  states, selection, links, focus rings. It never means "good."
- Five **semantic** families each own one job and one hue, none of them Iris:

| Family | Hue | Means | Used for |
| --- | --- | --- | --- |
| `--good` | green | positive / healthy / passed | NAV up, quorum met, proposal executed |
| `--warn` | amber | caution / attention | approaching capacity, timelock window closing, stale-ish data |
| `--crit` | red | loss / danger / failed | NAV down, proposal rejected, over-cap deposit |
| `--frozen` | ice-cyan | halted / suspended | **oracle breaker tripped** — deliberately cold, not alarm-red (§4.8) |
| `--accent` (Iris) | violet | brand / interaction | not a status |

The ice-cyan `--frozen` is the most deliberate token in the set. A tripped oracle breaker is not
an *error* (red) and not a *warning* (amber) — it is a designed, temporary suspension where every
NAV-reading function reverts by design (ARCHITECTURE §4.2). Cold cyan says "held, not broken."
It must never be confused with the green of health or the violet of the brand.

### 2.2 Tokens

Theme-aware, 3-state (bare `:root` = light default → `@media (prefers-color-scheme: dark)`
guarded with `:root:not([data-theme="light"])` → explicit `:root[data-theme="dark"]`). Light and
dark stay in the **same hue family** so the toggle never reads as two brands. Every token carries
its light value on bare `:root`; the media/attr blocks hold overrides only. `body` gets an
explicit token background.

**Neutrals & brand**

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` | `#f2f2f7` | `#0e0e16` | app background |
| `--surface` | `#ffffff` | `#17171f` | card / panel |
| `--surface-2` | `#eaeaf1` | `#20202c` | inset / total row / code |
| `--line` | `#dbdbe6` | `#2b2b3a` | primary hairline |
| `--line-soft` | `#e8e8f0` | `#22222e` | secondary divider |
| `--ink` | `#17171f` | `#eaeaf3` | primary text |
| `--muted` | `#5f5f72` | `#9393ab` | secondary text |
| `--faint` | `#9494a8` | `#616178` | labels, meta, addresses |
| `--accent` | `#5a4ce0` | `#8a7cf6` | Iris — brand / interaction |
| `--accent-soft` | `#ece9fd` | `#211d3a` | Iris tint (selection, active bg) |
| `--accent-ink` | `#ffffff` | `#14121f` | text/icon on Iris fill |

**Semantics** (each has a base + a `-soft` chip background per theme)

| Token | Light base | Light soft | Dark base | Dark soft |
| --- | --- | --- | --- | --- |
| `--good` / `--good-soft` | `#178a4c` | `#e4f2ea` | `#45c883` | `#123020` |
| `--warn` / `--warn-soft` | `#a56a09` | `#f6ecd7` | `#f0b429` | `#312608` |
| `--crit` / `--crit-soft` | `#c23b3b` | `#f7e2e2` | `#f2726a` | `#331a17` |
| `--frozen` / `--frozen-soft` | `#1c8aa6` | `#dcf0f4` | `#5fc9de` | `#0f2f39` |

**Elevation** (soft shadow replaces hairline-everywhere; this is a primary warmth lever)

| Token | Light | Dark |
| --- | --- | --- |
| `--shadow-1` | `0 1px 2px rgba(24,24,40,.05), 0 1px 3px rgba(24,24,40,.04)` | `0 1px 2px rgba(0,0,0,.4)` |
| `--shadow-2` | `0 4px 16px rgba(24,24,40,.08), 0 1px 3px rgba(24,24,40,.05)` | `0 6px 24px rgba(0,0,0,.5)` |

**Contrast note.** All `--ink`/`--muted` on `--surface`/`--ground` pairs clear WCAG AA (≥4.5:1).
`--faint` is metadata-only (≥3:1, never body copy). Semantic bases are text-legible on their own
`-soft` chip. Status is **never** encoded by color alone — see §4.2 and §5.

---

## 3. Typography

A three-face system. Two faces are retained equity; one changes to set the new temperature.

- **Display — Newsreader** (`--display`). *This is the change.* A transitional editorial serif
  built for on-screen reading, with true italic, real weight range, and optical sizing. It reads
  "institution of record / financial paper," not "DTC startup." It replaces Archivo's industrial
  grotesk to add warmth and gravitas at once. Deliberately **not** Fraunces or any soft-quirk
  serif — quirk is a liability on people's money. Fallback stack: `Source Serif 4, Georgia, serif`.
  **Scoped tightly:** page title, panel headings (H1–H3), and editorial lede only. Never used for
  numbers, never for UI labels.

- **Body / UI — IBM Plex Sans** (`--sans`). Retained. A humanist-leaning grotesque with genuine
  engineering provenance; neutral, legible workhorse for all running text, controls, and table
  cells. Fallback: `system-ui, sans-serif`.

- **Data / numeric — IBM Plex Mono** (`--mono`). Retained, and load-bearing. Every number a user
  might compare, add, or be charged — NAV, fees, percentages, addresses, timestamps, quorum —
  is monospaced with `font-variant-numeric: tabular-nums`. This is the single strongest "real
  infrastructure" signal we own; we do not dilute it. Fallback: `ui-monospace, monospace`.

**Why keep IBM Plex.** Avoiding the AI-default faces (Inter / Space Grotesk) doesn't mean
discarding equity. Plex is purpose-built, not defaulted, and its mono is one of the best numeric
faces on the free tier. Swapping only the display face is the minimum, most-honest evolution.

### 3.1 Type scale

~1.2 modular ratio. Serif for structure, mono for data, sans for everything read as language.

| Token | Size / line-height | Face | Use |
| --- | --- | --- | --- |
| `--fs-display` | 34 / 1.15 | Newsreader 500 | page title |
| `--fs-h1` | 26 / 1.2 | Newsreader 500 | panel / detail heading |
| `--fs-h2` | 20 / 1.25 | Newsreader 500 | section heading |
| `--fs-h3` | 16 / 1.3 | Newsreader 600 | card title |
| `--fs-lede` | 17 / 1.5 | Newsreader 400 italic | editorial lede |
| `--fs-body` | 15 / 1.55 | Plex Sans 400 | running text, controls |
| `--fs-sm` | 13 / 1.5 | Plex Sans 400/500 | table cells, secondary |
| `--fs-label` | 11.5 / 1.4 | Plex Mono 500, `.14em` upper | section labels, keys |
| `--fs-num-xl` | 32 / 1.1 | Plex Mono 500 tnum | hero NAV |
| `--fs-num` | 20 / 1.2 | Plex Mono 500 tnum | stat values |
| `--fs-num-sm` | 14 / 1.4 | Plex Mono 400 tnum | inline figures, addresses |

Numeric rule: **all figures use `tabular-nums`** so columns and updating values never reflow.
Currency shows a thin space group separator and never truncates a fractional cent that changes
what someone pays.

---

## 4. Component direction

Nine core components. Radius scale: `--r-sm 8`, `--r-md 12`, `--r-lg 16`, `--r-pill 999`. Cards
use `--r-md` (12) — softened from the instrument panel's 12px squareness toward consumer
comfort, but never "rounded-lg everywhere." Elevation (`--shadow-1/2`) replaces hairline borders
as the default separation; borders return only where a hairline is genuinely more legible
(tables, fee stacks).

### 4.1 Vault card

The primary object. On `--surface`, `--r-md`, `--shadow-1` at rest → `--shadow-2` + Iris border
on hover; selection = 1px Iris ring + `--accent-soft` wash. Contents, top to bottom:

- Title (H3, Newsreader) + truncated address (mono, `--faint`, copy-on-click).
- **Status pill row** (§4.9) — root/sub, Mode, operator-verified.
- **NAV** as `--fs-num-xl` mono, with a small signed delta chip beside it (glyph + tnum, §4.2).
- One-line meta row: `N members · Operator`.
- **Capacity meter** — a calm horizontal bar (§5), Iris fill on `--surface-2` track, with the
  percentage stated in mono. Turns `--warn` only above ~90%.

A **frozen** vault card renders in the §4.8 frozen treatment, not as a normal card with a badge.

### 4.2 NAV / number display

- Hero NAV: `--fs-num-xl` mono tnum. Always accompanied by an **explicit "as of" timestamp** in
  `--faint` mono — a valuation with no time is a lie.
- Deltas and gain/loss are **never color-only.** Format: sign glyph (`+` / `−`, the true minus
  U+2212) + tabular number + optional `--good`/`--crit` color. Remove the color and the sign
  still tells the story. No arrows-up-only framing.
- Updating values transition with a 120ms opacity/tint settle, never a count-up animation
  (count-ups read as marketing and undermine calm).

### 4.3 Governance-proposal timeline

A vertical, four-node timeline reconstructing the commit-reveal lifecycle:
**Commit → Reveal → Timelock → Execute** (ARCHITECTURE §8). Each node states, in plain words,
what the phase *means for the human's money*, not just its name — e.g. Reveal reads "Votes
revealed; from here Mode-F exits price forward." Done nodes fill Iris; the active node gets an
Iris focus halo; future nodes are `--line`. The proposal's quorum is shown *with its denominator*
("38% of voting-eligible stake · 25% floor"). Standing-default and delegated votes are labelled
as such because they count toward tally but not quorum (§8) — the human should see why the math
looks the way it does.

### 4.4 Risk-disclosure panel

Not fine print. A first-class, always-present panel using a left `--warn` (or `--frozen` when
relevant) rule, `--surface-2` ground, and plainly-worded rows — each risk stated as a concrete
consequence, not a legal hedge: forward-pricing on Mode-F exits, irreversibility of the window
skip, oracle-breaker halts, sub-vault fee stacking, `<5`-member signer-count governance. Uses
Plex Sans at `--fs-sm`, mono only for the figures inside it. It is calm, not scary — grey and
amber, never a red wall. See the style tile for the canonical treatment.

### 4.5 Fee breakdown

A stacked, bordered list (retained from the instrument panel; borders earn their place here).
One row per level (root + sub-levels, depth ≤ 3), each showing that level's 10% perf + exit fee,
then a **total row** in `--surface-2`, emphasised.

**The rule:** perf fees compound multiplicatively, not additively —
`keep = floor(keep × 0.9)` per level (SubVaultRegistry). The **largest, most prominent number in
this component is the effective stacked total the depositor actually pays** — e.g. a two-level
vault shows **19%** effective, never a headline "10%." Exit fees sum toward a stated **2.5% cap**.
The component's job is to prevent a depositor from anchoring on the per-level rate. A one-line
plain-language summary restates it: "you pay 19% of net-of-fee gains across 2 levels — fees
compound, never add."

### 4.6 Deposit / exit flow controls

Buttons (§4.7 in the tile) plus the **consequence-before-action** pattern (Principle 4):

- **Deposit** into a first-time vault surfaces the **observation window** (§4.9) inline before
  confirm.
- **Exit** detects Mode I vs Mode F and changes its own copy: Mode I confirms "settles now at
  current NAV"; **Mode F** confirms "queued — settles at the price *after* the pending rebalance,
  and **cannot be cancelled**," then shows a persistent pending row until settlement.
- **Window skip** and **full-consensus rule change** use the same irreversible pattern: a confirm
  step restating the exact, specific consequence, then a visible standing state. Destructive/
  irreversible confirms use a `--crit`-outlined (not filled) button so the weight is felt without
  alarm.

### 4.7 Buttons & controls

Three weights: **Primary** (Iris fill, `--accent-ink` text) for the one main action per view;
**Secondary** (`--surface`, `--line` border) for alternates; **Ghost** (text + Iris) for tertiary.
`--r-sm` (8). Focus: 2px Iris ring, 2px offset — always visible, never removed. Disabled buttons
**state their reason inline** ("NAV unavailable — oracle held"), never a bare greyed control.
Height and hit-target ≥ 40px for a consumer touch register.

### 4.8 Oracle-frozen state — a *mode*, not a badge

The most consequential state in the product. When the breaker trips, every NAV-reading function
reverts by design (ARCHITECTURE §4.2), so the **whole surface changes**, not one pill:

- **NAV renders as *unavailable*** — not zero, not a stale number with a tooltip. Show the
  last-known value struck-through or dimmed, labelled "last known," with its explicit timestamp,
  in the `--frozen` treatment (ice-cyan rule + `--frozen-soft` wash).
- **Every primary CTA disables with the reason stated inline** — "Deposits and exits are held
  while the oracle is frozen." No live actions are offered.
- A surface-level banner explains *why* in one sentence and *what clears it* (breaker resets when
  sources agree within tolerance).

**Three distinct treatments — never collapsed:**

| State | Meaning | Treatment |
| --- | --- | --- |
| **Stale** | data older than target but still valid | `--warn` timestamp, actions still live |
| **Frozen** | oracle breaker tripped, NAV reads revert | `--frozen` whole-surface mode, actions held |
| **Paused** | governance/operator halt | `--muted` mode, distinct copy, actions held |

### 4.9 Pills & badges

Small mono uppercase, `--r-pill`, `.04em` tracking. Semantic, never decorative:

- **Mode-I** → `--good-soft` / `--good` ("instant exits").
- **Mode-F** → `--warn-soft` / `--warn` ("forward-priced exits") — caution, because it removes the
  free exit option.
- **root** → `--line` outline, `--muted`. **sub · L2 / L3** → `--accent-soft` / `--accent`.
- **operator-verified** → `--good` with a check glyph; **unverified** → `--muted` outline. The
  verified state is earned (OperatorRegistry identity), so it is never applied by default.
- **observation-window** → `--frozen`-adjacent info treatment with a live countdown (mono), shown
  on first-time deposit; states that skipping is once-per-agent-per-vault and irreversible.

---

## 5. Data visualization

Calm, legible, tabular. The house style is *editorial chart*, not *trading terminal*.

- **NAV history** — a single hand-authored line/area sparkline (inline SVG, no libraries). One
  Iris stroke, a faint `--accent-soft` area fill, a dotted `--line` baseline at the entry NAVps.
  No gridlines beyond the baseline, no gradient drama, no candlesticks. Down-periods are the same
  weight as up-periods (Principle 3) — the line is not recolored red on decline; the signed delta
  label carries direction. Y-axis is annotated at two points only (min/max), in `--faint` mono.
  Symmetric framing — never a truncated axis that exaggerates gains.

- **Fee stack** — the §4.5 list *is* the visualization; if a bar is used, it is a single
  horizontal 100%-stacked bar segmented by level in tints of `--muted`→`--ink`, with the total
  called out. Not a pie.

- **Leaderboard** — a dense table, retained from the instrument panel and the strongest data
  surface we have. Right-aligned mono tnum columns; net realized shown with sign glyph + color;
  operator name in Plex Sans; rank in `--faint` mono. "All vaults, no cherry-picking" is a
  stated column-header ethic. Zebra striping via `--line-soft`, no heavy fills. Sortable columns
  keep numbers tabular so rows never reflow on sort.

- **Global rules:** every axis label and value is mono tnum; category color comes from the
  semantic set only; a chart never uses Iris to mean "good." Loss is legible, not loud.

---

## 6. Motion & tone

Restrained. Motion confirms and orients; it never entertains.

**Motion earns its place for:**
- State transitions — a card entering the frozen mode, a proposal advancing a phase, an exit
  moving to pending. 150–200ms ease, opacity + small transform.
- Confirmations — a deposit/exit confirm settling with a brief check and a 120ms tint.
- Value settles — 120ms opacity/tint when a number updates (not a count-up).
- Focus/hover — 120–150ms border/shadow, matching the inherited dashboard.
- All of the above respect `prefers-reduced-motion: reduce` → transitions collapse to none.

**Motion that reads as AI-generated filler — banned:**
- Count-up/odometer animations on money (marketing tell, undermines calm).
- Pulsing/breathing glows, animated gradient backgrounds, parallax, floating blobs.
- Entrance animations that stagger every card on load.
- Skeleton shimmer as decoration where a plain "as of —" placeholder is honest.
- Confetti / celebratory motion on deposits. This is people's money, not a game.

**Tone of copy:** plain, specific, calm. "Settles at the price after the rebalance" beats
"forward-priced execution event." State consequences, not features. Never exclamatory.

---

## 7. Do-not — anti-patterns

The AI-generated-design cluster, and product-specific traps:

- **The warm-generic cluster:** cream/beige ground **+** soft-quirk serif (Fraunces & friends)
  **+** terracotta/earthy accent. We take exactly one warmth lever (the editorial serif) and keep
  cool serious neutrals. Never all three.
- **AI-default faces** as the "safe pick" — Inter, Space Grotesk. (And their serif equivalent,
  Fraunces, as the "safe warm pick.")
- **Lone acid-green pop** on a dark hero. Our greens are calm and semantic; no neon.
- **Purple gradient hero.** Iris is a flat brand accent, never a hero gradient wash.
- **Emoji as section markers** or status. Status is typographic + semantic color + glyph.
- **Everything centered.** Data products are left-aligned and grid-anchored; numbers right-align.
- **`rounded-lg` / pill-everything.** Radius is a deliberate 8/12/16 scale; tables and stacks stay
  near-square.
- **Rounded, glowing "AI" motifs** — no sparkles, no gradient orbs, no chat-bubble mascots. The
  agents are governance actors, not a chatbot.
- **Color-only status.** Every good/warn/crit/frozen state also carries a glyph or label.
- **Green-up-only / truncated axes** that flatter performance. Symmetric, honest framing always.
- **Confetti or celebration** on money movement.
- **Hairline-everything** carried over uncritically — the consumer register leads with soft
  elevation; hairlines are used where they out-legible a shadow (tables, fee stacks), not by reflex.

---

## 8. Token quick-reference for implementation

Extend the existing `apps/web/index.html` `:root` — **keep** `--ground --surface --surface-2
--line --ink --muted --faint --accent --accent-soft --good --warn --crit`; **add** `--line-soft
--accent-ink --good-soft --warn-soft --crit-soft --frozen --frozen-soft --shadow-1 --shadow-2`
plus the `--fs-*`, `--r-*`, and font tokens. Replace `--display` with Newsreader; keep `--sans`
(Plex Sans) and `--mono` (Plex Mono). The canonical, copy-pasteable definitions live in the
`:root` block of [`style-tile.html`](./style-tile.html).
