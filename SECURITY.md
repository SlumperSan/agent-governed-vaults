# Security Policy

This repository ships an **immutable** on-chain protocol (no proxies, no admin upgrade path) plus
a small set of off-chain surfaces that read from it. Please read this before filing anything, so
your report reaches the right scope.

## Reporting a vulnerability

**Contact: `<SECURITY-CONTACT-EMAIL — owner to fill in>`.**

Do **not** open a public GitHub issue for a security finding, and do not disclose it on social
media, Discord, or anywhere else public before the process below has run. If email is
unavailable, open a private security advisory via GitHub's "Report a vulnerability" flow on this
repository instead of a public issue.

Include, as far as you can:

- A clear description of the issue and its impact (funds at risk, data exposure, availability).
- Steps to reproduce, or a proof-of-concept (a Foundry test, an HTTP request, a transcript).
- The commit hash, contract address, or deployed chain (mainnet is **Robinhood Chain, chain id
  4663**; see `contracts/config/deployments/robinhood-mainnet.json`) the finding applies to.
- Whether the issue is, to your knowledge, being actively exploited.

## Scope

In scope:

- `contracts/` — `VaultCore`, `Governance`, `FeeEngine`, `OperatorRegistry`, `ChainlinkOracle`, the
  execution adapters, `SubVaultRegistry`, `VaultFactory`/`VaultDeployer`, and their deployed
  bytecode on Robinhood Chain mainnet (chain 4663) and Base Sepolia testnet.
- `apps/api/` — the metered read API (x402 payment gate, facilitator integration, rate limiting).
  This is the one paid API surface going forward; a duplicate paid endpoint that previously lived
  under `apps/site-next` (settling on Base mainnet) has been removed as part of a parallel cleanup
  so that `apps/api` is the single paid API.
- The live public sites: `apps/site-next/` (serves `rwally.com`) and `apps/app/` (serves
  `app.rwally.com`).
- `packages/` supporting the above (`indexer`, `agent-sdk`, `canary`, `reference-agent`, `oplog`).

Out of scope:

- `apps/site/` — **retired**, not deployed anywhere, and must never be deployed (see
  [#267](https://github.com/SlumperSan/agent-governed-vaults/pull/267) and
  [#268](https://github.com/SlumperSan/agent-governed-vaults/issues/268)). If you find a way this
  directory *could* be deployed by accident (tooling, docs, CI), that is in scope as a process
  finding even though the code itself is not a live target.
- `apps/web/` (Vault Atlas) — has no assigned production domain yet; not a live target.
- `status.rwally.com` and `docs.rwally.com` — planned, not built.
- `contracts/test/retired/` — the retired multi-source oracle stack, kept solely as exploit
  evidence for Critical **C-6**; it is not deployable and not selectable through the factory
  allowlist. Findings against it are not actionable unless they show it is reachable in the
  current tree.
- Third-party infrastructure this project depends on but does not control (Chainlink feeds,
  Cloudflare Pages, RPC providers, x402 facilitators) — report those upstream.

## Current audit status

Read this section together with the README's [Status](README.md#status) section, which is the
authority if the two ever disagree.

- **Internal review:** three internal adversarial review rounds plus an AI pre-audit, documented
  in [`docs/AUDIT-HANDOFF.md`](docs/AUDIT-HANDOFF.md) and
  [`docs/audit/AI-AUDIT-REPORT.md`](docs/audit/AI-AUDIT-REPORT.md), with per-sprint writeups under
  [`docs/reviews/`](docs/reviews/) (`SPRINT1-SECURITY-REVIEW.md`, `SPRINT6-EXECUTION-REVIEW.md`,
  `SPRINT6-GOVERNANCE-REVIEW.md`, `SPRINT10-DEPLOYMENT-REVIEW.md`, `SLITHER-TRIAGE.md`, and
  `MERGE-POLICY.md`). Every finding from those rounds was fixed, replaced, or explicitly
  dispositioned — see [`docs/CHANGES-SINCE-REVIEWS.md`](docs/CHANGES-SINCE-REVIEWS.md) for what
  changed between those reviews and the audited tree.
- **External audit:** an external audit was commissioned against the launch tree at tag
  `v0.4.0-audit`. On 2026-08-29 the owner attested, having read the report, that it surfaced **no
  major issues**. **The report itself is held privately** and is deliberately not reproduced or
  linked in this repository. That is an owner attestation, not something independently verifiable
  from this repo — do not describe the protocol as "audited" without that qualifier. The
  audit-firm-facing entry point and scope notes live at
  [`docs/audit/README.md`](docs/audit/README.md); note its own banner that scope moved after
  Critical **C-6** (the oracle was replaced, not patched — see below).
- **One finding remains open at the launch configuration:** High **H-8** (the stake-blind
  `<5`-member quorum regime) is partially fixed in code, with its regime-flip mitigated only by
  configuration; it is not closed. A further class (**H-5/H-6/H-7**) is dormant only because
  `VaultFactory.allowSubVaults = false` — not repaired in code, and live again if sub-vaults are
  ever enabled. Details and current disposition: [`docs/AUDIT-HANDOFF.md`](docs/AUDIT-HANDOFF.md)
  and [`docs/LAUNCH-READINESS.md`](docs/LAUNCH-READINESS.md).
- **The original multi-source oracle design was replaced, not patched**, after Critical **C-6**
  showed it could not be made Byzantine-safe by curation alone. The retired stack lives under
  `contracts/test/retired/` as exploit evidence and must not be deployed. The current oracle is one
  genuine Chainlink Data Feed per asset, fail-closed; see the README's Contracts section and
  [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
- **Named residual risk:** single-oracle-provider dependency — there is no second source to
  cross-check a Chainlink answer that is wrong but inside its band and heartbeat. See the README's
  "Named residual" paragraph and [`docs/LAUNCH-READINESS.md`](docs/LAUNCH-READINESS.md) (residual
  12, "curation immobility").
- **Launch verdict:** as of this writing the board in
  [`docs/LAUNCH-READINESS.md`](docs/LAUNCH-READINESS.md) is the authority on go/no-go; `npm run cc`
  prints the current computed state. A clean security posture does not by itself mean "launched
  with no open gates" — read the board, not just this file.

## Bug bounty

There is currently **no bug bounty program** for this repository. If one is stood up, it will be
documented here with its scope, reward structure, and rules of engagement; until then, do not
expect payment for a report, and please still report responsibly under the process above.

## Responsible disclosure timeline

We ask reporters to give us the chance to fix an issue before any public disclosure, and in
exchange we commit to the following:

1. **Acknowledgement within 3 business days** of your report reaching the contact above.
2. **Initial triage and severity assessment within 7 days** — confirming reproduction, scoping
   affected contracts/surfaces/chains, and telling you what we think the severity is.
3. **A remediation plan or timeline within 14 days** of triage for anything rated Medium or
   higher. Given the protocol's contracts are immutable once deployed, a contract-level fix may
   mean a new deployment plus a migration/pause-equivalent plan rather than a patch — timelines for
   those are communicated as soon as they're known, not guessed at up front.
4. **Coordinated disclosure**: we ask you to hold public disclosure for **90 days** from your
   report, or until a fix has shipped and had time to propagate, whichever is sooner. We'll tell
   you as soon as a fix is out so you can plan disclosure around it.
5. **Credit**: with your permission, we will credit you by name or handle once the issue is
   resolved and disclosed.

If you believe an issue is being actively exploited, say so explicitly in your first message —
that changes our response priority regardless of the severity rating.
