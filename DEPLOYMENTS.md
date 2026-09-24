# Deployments

This page consolidates the real deploy commands for each surface, organized by the
[README's Production Map](README.md#production-map), which is the single source of truth for
"what is live where." If this page ever disagrees with a sub-README, the Production Map in the
README wins; this page exists to gather the commands in one place, not to replace that table.

Every command below is copied from the surface's own README/config — none are invented here.

## Marketing site — `apps/site/` → `rwally.com` (live, canonical)

**This said `apps/site-next` until 2026-09-18.** That directory was deleted in
[#304](https://github.com/SlumperSan/agent-governed-vaults/pull/304); `apps/site` is what carries
`name = "rwally"` in its `wrangler.toml` today.

Build, then deploy from inside `apps/site` (Pages bundles `./functions` relative to the
working directory, so the deploy must run from here):

```bash
cd apps/site
npm run build          # tsc -b && vite build && vite build --ssr && node scripts/prerender.mjs
npx wrangler@4 pages deploy dist --project-name rwally --branch protocol/main
```

Notes carried over from the header comment in
[`apps/site/wrangler.toml`](apps/site/wrangler.toml) and
[`docs/REVENUE.md`](docs/REVENUE.md):

- **`functions/` holds one Function, `_middleware.js`, and it imports nothing.** It uses no Node
  built-in and no import attribute, so no wrangler version and no compatibility flag is load-bearing
  for what this directory ships today.
- `wrangler.toml` sets `pages_build_output_dir = "dist"` and `compatibility_flags =
  ["nodejs_compat"]`. The flag is left in place for a future Function that needs it; check before
  relying on it, and read the comment at the top of that file for what it was carrying.
- No secrets or prices are committed in `wrangler.toml` by design; environment variables are set
  on the Cloudflare Pages project itself (Settings → Environment variables → Production), then the
  site is redeployed for them to take effect.
- Sign off against the **served, built `dist/`**, never the dev server — the CSP and asset paths
  differ, and the network panel must show zero non-`self` hosts.

**The paid vault-snapshot endpoint that used to live in this directory
(`functions/api/vaults.js`) has been removed from this repository, and is still live in
production.** It settled on Base mainnet, which conflicted with the Robinhood-Chain-only direction,
and duplicated `apps/api`'s own metered server, so
[PR #298](https://github.com/SlumperSan/agent-governed-vaults/pull/298) deleted it along with
`functions/.well-known/x402.js`, and merged on 2026-09-15. The Pages project has not been
redeployed since, so both are still answering: `GET https://rwally.com/api/vaults` returns **402**
and `GET https://rwally.com/.well-known/x402` returns **200**, read 2026-09-16.

**So the next deploy of this directory removes the paid endpoint and the discovery document from
production.** That is the intended end state, but it must not happen by accident while `apps/api`
has nowhere to serve from. Check before and after any deploy:

```bash
curl -s -o /dev/null -w "%{http_code}
" https://rwally.com/api/vaults
```

Do not describe deploying the removed endpoint, and do not re-add a paid endpoint under
`apps/site` — `apps/api` is the one metered read API going forward.

## Member surface — `app.rwally.com` — TWO directories claim this address, and only one may deploy

`apps/vaults-ui/wrangler.toml` and `apps/app/` both carry the Cloudflare Pages project
**`rwally-app`**, production branch `protocol/main`, and they point at different source directories.
The owner decided on 2026-09-19 that **`apps/vaults-ui` takes the address and `apps/app` retires
into it** — one member surface, one address. The DNS is already pointed, so whichever directory
deploys last is what members see, immediately, with no staging step.

**This page carried a copy-pasteable `apps/app` production deploy command until 2026-09-21.** It is
removed rather than annotated, because the command was correct when written and became a way to
silently revert the member surface: same project, same production branch, no warning, no
confirmation. Running it after the cutover puts the retired explorer — reading chain 4663, which the
protocol is no longer on — back on `app.rwally.com`, and nothing reds.

### `apps/vaults-ui/` — the member surface

Built by `npm run gate`. **The cutover is the owner's call, not a deployer's**, and the deploy
command lives with the owner rather than on this page for the reason above: the next
`pages deploy` against `rwally-app` replaces what is live the instant it finishes.

- Project `rwally-app`, production branch `protocol/main`, `pages_build_output_dir = "dist"`.
- `public/_headers` is copied into `dist/` by the build and read by Pages from the root of the
  SERVED directory; `test/csp.test.mjs` asserts it lands at `dist/_headers` byte-identically, so a
  deploy that would have shipped no policy reds in the gate instead.
- `connect-src` names the one RPC origin this app reads, and must change in the SAME commit as any
  code that calls a different one — or every read is refused by the browser and the page renders
  empty with no build-time warning.
- `functions/` holds one Function, `_middleware.js` — the sanctions-jurisdiction geofence (card
  212), refusing a comprehensively-sanctioned request with a plain HTTP 451 before anything else
  runs. It imports nothing and uses no Node built-in. Pages bundles Functions from `./functions`
  relative to the directory wrangler runs in, not from inside the uploaded assets, which is why it
  sits beside this file's own `wrangler.toml` rather than under `public/` or `dist/` — see that
  file's own header for the "must not appear casually" history this directory used to be an
  exception to.

See [`apps/vaults-ui/wrangler.toml`](apps/vaults-ui/wrangler.toml)'s own header, which is the source
for every line above.

### `apps/app/` — retiring, do not deploy

Still live at `app.rwally.com` until the cutover, and **reading chain 4663, which the protocol is no
longer on** — its live reads were never re-pointed at Arc and, per the decision above, will not be.
Deploying it is the revert described above, not a rollback anyone has asked for. If a genuine
rollback is ever needed it is the owner's decision, made with the knowledge that it restores a
chain the protocol left.

Build details are kept in [`apps/app/README.md`](apps/app/README.md) for whoever has to read the
directory; they are not repeated here, so this page stops being somewhere the revert command can be
copied from.

## Metered read API — `apps/api/` (the one paid API — not yet publicly deployed)

`apps/api` is the **one** metered read API going forward, per the Production Map. It is chain-4663
x402-metered — [PR #294](https://github.com/SlumperSan/agent-governed-vaults/pull/294) re-enabled
that and merged on 2026-09-15 — and has **no public domain chosen yet**, so it is not deployed
publicly today. Note that no public facilitator settles on chain 4663, so a 4663 deployment needs
its own settler before it can take a payment. Run it locally/operationally with:

```bash
npm run start:api      # node apps/api/src/serve.mjs
```

See [`docs/RUNTIME.md` §8](docs/RUNTIME.md#8-operations) for operating it (log format, rate
limits, metrics, backups, restore) once a public deploy target exists. Do not stand up a second,
competing paid endpoint elsewhere (see the marketing-site note above) — route new paid-read work through
this app.

## Allocator front end — `apps/web/` ("Vault Atlas") — no assigned domain

Not deployed. No production domain has been decided. Do not deploy this to any of the domains
above without an explicit owner decision and a Production Map update.

## The `apps/site` deploy warning that used to be here — inverted, and why the lesson survives

**This section said `apps/site` was retired and must never be deployed. That is now backwards** and
the correction is recorded rather than quietly dropped, because the warning was load-bearing for a
year and someone will remember it.

`apps/site-next` was the canonical site until [#304](https://github.com/SlumperSan/agent-governed-vaults/pull/304)
**deleted that directory**. `apps/site` is now what `rwally.com` serves — its `wrangler.toml` carries
`name = "rwally"` — so the old banner pointed a deployer at a path that no longer exists and
forbade the only one that works.

**The near-miss it cited was real and its lesson still stands, for a different reason.** In
[PR #267](https://github.com/SlumperSan/agent-governed-vaults/pull/267) /
[issue #268](https://github.com/SlumperSan/agent-governed-vaults/issues/268) a runbook told the
owner to run `wrangler pages deploy . --project-name rwally` from `apps/site`, and a reviewer caught
it before it published. That command is **still wrong today**, and not because of the directory:
it deploys `.` — the source tree — rather than `dist`, the prerendered build output. Deploying the
source publishes TypeScript and templates in place of the rendered site.

So the rule that survives is about the argument, not the path: **deploy `dist`, never `.`**, and run
wrangler from `apps/site` so Pages resolves `./functions` to `apps/site/functions`. The commands at
the top of this page are the ones to copy.

## Planned, not built

- **`status.rwally.com`** — spec drafted (`agent-pilot-and-status-spec.md`), not implemented.
- **`docs.rwally.com`** — spec exists (`docs/api/openapi.yaml`), no hosting/domain set up yet.

Nothing to deploy for either yet; listed here so this page stays a complete map of the Production
Map's domains, built or not.
