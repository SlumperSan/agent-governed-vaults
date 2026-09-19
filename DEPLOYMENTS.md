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

## Vault explorer — `apps/app/` → `app.rwally.com` (live)

```bash
node apps/app/build.mjs
cd apps/app && npx wrangler@latest pages deploy dist --project-name=rwally-app --branch=protocol/main
```

From [`apps/app/README.md`](apps/app/README.md):

- Cloudflare Pages project `rwally-app`, production branch `protocol/main`.
- Run the deploy from `apps/app`. There is no `functions/` directory here and there should not be
  one — Pages would otherwise pick up a Functions bundle from the working directory.
- The page reads chain 4663 live, in-browser (`connect-src` names exactly one origin,
  `https://rpc.mainnet.chain.robinhood.com`); nothing server-side to deploy beyond the static
  build.
- There is no `package.json` in this directory on purpose (npm workspace glob concerns) — build
  with `node apps/app/build.mjs`, not `npm run build`.

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
