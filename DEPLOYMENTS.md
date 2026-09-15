# Deployments

This page consolidates the real deploy commands for each surface, organized by the
[README's Production Map](README.md#production-map), which is the single source of truth for
"what is live where." If this page ever disagrees with a sub-README, the Production Map in the
README wins; this page exists to gather the commands in one place, not to replace that table.

Every command below is copied from the surface's own README/config — none are invented here.

## Marketing site — `apps/site-next/` → `rwally.com` (live, canonical)

Build, then deploy from inside `apps/site-next` (Pages bundles `./functions` relative to the
working directory, so the deploy must run from here):

```bash
cd apps/site-next
npm run build          # tsc -b && vite build && vite build --ssr && node scripts/prerender.mjs
npx wrangler@4 pages deploy dist --project-name rwally --branch protocol/main
```

Notes carried over from [`apps/site-next/README.md`](apps/site-next/README.md) and
[`docs/REVENUE.md`](docs/REVENUE.md):

- **Wrangler 4 or newer is required.** Wrangler 3's bundled esbuild cannot parse the JSON import
  attribute (`with { type: 'json' }`) that one of the Pages Functions needs; it fails the build
  loudly rather than shipping something broken.
- `wrangler.toml` sets `pages_build_output_dir = "dist"` and `compatibility_flags =
  ["nodejs_compat"]` — the latter is required, not optional, for the Functions bundle.
- No secrets or prices are committed in `wrangler.toml` by design; environment variables are set
  on the Cloudflare Pages project itself (Settings → Environment variables → Production), then the
  site is redeployed for them to take effect.
- Sign off against the **served, built `dist/`**, never the dev server — the CSP and asset paths
  differ, and the network panel must show zero non-`self` hosts.

**The paid vault-snapshot endpoint that used to live in this directory
(`functions/api/vaults.js`) has been removed.** It settled on Base mainnet, which conflicted with
the Robinhood-Chain-only direction, and duplicated `apps/api`'s own metered server. A parallel
cleanup PR removes it; do not describe deploying it, and do not re-add a paid endpoint under
`apps/site-next` — `apps/api` is the one metered read API going forward.

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
x402-metered (re-enabled in [PR #294](https://github.com/SlumperSan/agent-governed-vaults/pull/294),
draft/unmerged as of this writing) and has **no public domain chosen yet** — it is not deployed
publicly today. Run it locally/operationally with:

```bash
npm run start:api      # node apps/api/src/serve.mjs
```

See [`docs/RUNTIME.md` §8](docs/RUNTIME.md#8-operations) for operating it (log format, rate
limits, metrics, backups, restore) once a public deploy target exists. Do not stand up a second,
competing paid endpoint elsewhere (see the site-next note above) — route new paid-read work through
this app.

## Allocator front end — `apps/web/` ("Vault Atlas") — no assigned domain

Not deployed. No production domain has been decided. Do not deploy this to any of the domains
above without an explicit owner decision and a Production Map update.

## `apps/site/` — retired. **Do not deploy.**

`apps/site` is the retired nine-page static site. It is **not** what `rwally.com` serves —
`apps/site-next` is — and deploying it to the `rwally` Cloudflare Pages project replaces the live
site with this retired build. This already almost happened once: see
[PR #267](https://github.com/SlumperSan/agent-governed-vaults/pull/267) and
[issue #268](https://github.com/SlumperSan/agent-governed-vaults/issues/268), where a runbook
shipped alongside a new feature told the owner to run `wrangler pages deploy . --project-name
rwally` from `apps/site` — a reviewer caught it before it published.

**Never run a Pages deploy from `apps/site`.** If you find any script, runbook, or doc instructing
otherwise, treat it as a bug and fix it — see `apps/site/README.md`'s own retirement banner for the
canonical warning text.

## Planned, not built

- **`status.rwally.com`** — spec drafted (`agent-pilot-and-status-spec.md`), not implemented.
- **`docs.rwally.com`** — spec exists (`docs/api/openapi.yaml`), no hosting/domain set up yet.

Nothing to deploy for either yet; listed here so this page stays a complete map of the Production
Map's domains, built or not.
