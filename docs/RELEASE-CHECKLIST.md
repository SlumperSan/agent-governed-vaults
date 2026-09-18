# Release checklist

A concrete pre-release checklist for anything shipping from this repository — a contract change,
a deploy of `apps/site-next` or `apps/app`, or a change to `apps/api`. Not every release touches
every item; check off what applies and say explicitly why an item doesn't apply rather than
silently skipping it.

## 1. Tests and gate

- [ ] `npm run gate` passes locally, clean, on the commit being released. If it doesn't pass and
      the release is going out anyway, say why in the release notes/PR — don't ship a silently red
      gate.
- [ ] Contract tests pass: `cd contracts && forge build && forge test` (also covered by
      `npm run gate`, called out separately here because contract changes get extra scrutiny below).
- [ ] `npm run test:backend` and `npm run test:app` both pass if the release touches those
      surfaces.
- [ ] Any test that was skipped, xfail'd, or weakened to make this release green is flagged
      explicitly — see the escalation norm in `docs/SWARM.md` §10. Weakening a gate to pass it is
      not the same as passing it.

## 2. Soak / canary re-run (contract changes only)

- [ ] If `contracts/` changed since the last soak/canary run: **re-run gate 3 (soak) and gate 6
      (canary)** rather than relying on prior evidence — both are marked STALE in
      [`docs/LAUNCH-READINESS.md`](../docs/LAUNCH-READINESS.md) whenever the evidence behind them
      predates the current bytecode. See [`docs/SOAK-REPORT.md`](../docs/SOAK-REPORT.md) and
      [`docs/CANARY.md`](../docs/CANARY.md) for how to run and record each.
- [ ] If contracts did **not** change, say so explicitly (e.g. "no `contracts/src/` diff since
      commit X — soak/canary re-run not required for this release") rather than leaving the box
      ambiguous.
- [ ] Check [`docs/LAUNCH-READINESS.md`](../docs/LAUNCH-READINESS.md)'s gate board for current
      status of all nine gates before treating any one of them as satisfied by an old run.

## 3. Versioning and changelog

- [ ] Version tag applied, following this repo's existing pattern (`v0.1.0-rc1`, `v0.4.0-audit`,
      etc. — see `git tag`). Pick a suffix that says what the tag is *for* (an audit freeze, a
      release candidate, etc.), consistent with prior tags.
- [ ] **Add a CHANGELOG entry.** As of this writing there is no `CHANGELOG.md` in this repository —
      if this is the first release since this checklist was adopted, create one (top-level,
      Keep-a-Changelog-style is fine) and start it with this release; if one already exists by the
      time you read this, append to it instead of duplicating history elsewhere.

## 4. Security review sign-off

- [ ] For any contract change: confirm the change has had an adversarial review pass (internal
      review round, or the external audit if the change is large enough to warrant it) and that
      findings are fixed, replaced, or explicitly dispositioned — not silently left open. See
      [`docs/AUDIT-HANDOFF.md`](../docs/AUDIT-HANDOFF.md) and
      [`docs/CHANGES-SINCE-REVIEWS.md`](../docs/CHANGES-SINCE-REVIEWS.md) for the pattern this
      repo already follows for audit-facing deltas.
- [ ] For any change to `apps/api`'s payment path or to a live payment surface: explicit owner
      sign-off, not just a passing test suite — payment-gating logic gets treated like a contract
      change for review purposes even before a mainnet deployment exists to move real funds on.
- [ ] Note any *open* findings that remain unresolved at release time (e.g. High **H-8**'s
      partial-fix-by-configuration status) in the release notes rather than letting a reader assume
      "released" means "no known issues." See [`SECURITY.md`](../SECURITY.md) for current audit
      status.

## 5. Scope: which domains/deploys are part of this release

State explicitly which of the Production Map's surfaces this release touches — silence here is how
a deploy target gets missed or an unintended one gets hit:

- [ ] `rwally.com` (`apps/site-next`) — deploying? Y/N.
- [ ] `app.rwally.com` (`apps/app`) — deploying? Y/N.
- [ ] `apps/api` — deploying/changing its running config? Y/N. (No public domain yet; still worth
      stating if its deployed behavior changes.)
- [ ] Contracts — new deployment, or code-only release with no new on-chain deployment? The
      protocol is built for Arc but has no mainnet deployment anywhere today — treat any mainnet
      contract deployment step as irreversible and confirm it is intentional, not a side effect of
      running a script.
- [ ] Confirm `apps/site` is **not** part of this release and is not being deployed — see
      [`DEPLOYMENTS.md`](../DEPLOYMENTS.md) and issue
      [#268](https://github.com/SlumperSan/agent-governed-vaults/issues/268).

## 6. Rollback plan

- [ ] For a **site/app deploy** (`apps/site-next`, `apps/app`): confirm the previous Cloudflare
      Pages deployment can be re-promoted from the dashboard, and note its deployment id/commit
      before deploying the new one.
- [ ] For an **API change** (`apps/api`): confirm the previous version can be redeployed/restarted
      from its last known-good commit, and that no in-flight payment state depends on the new
      version's schema.
- [ ] For a **contract deployment**: state plainly that contracts are immutable — there is no
      upgrade or pause admin — so "rollback" means either (a) this is a fresh, unfunded deployment
      that can simply be abandoned if something is wrong, or (b) it is a change to a contract that
      already holds funds, in which case there is no code-level rollback and the plan must say what
      the actual mitigation is (e.g. governance action, a documented incident response per
      [`docs/INCIDENTS.md`](../docs/INCIDENTS.md), or a restore drill per
      [`docs/RESTORE-DRILL.md`](../docs/RESTORE-DRILL.md)).

## 7. Draft PR sign-off

- [ ] Every draft PR that this release depends on, or that changes behavior this release ships,
      has **explicit owner sign-off** before it is merged — a passing gate is necessary but not
      sufficient. This repo's norm is that PRs open as drafts pending that sign-off (see
      [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/reviews/MERGE-POLICY.md`](../docs/reviews/MERGE-POLICY.md),
      which notes merge policy here is convention, not (yet) mechanically enforced).
- [ ] If this release depends on a PR that reverses a prior owner decision, confirm that reversal
      has been explicitly re-affirmed by the owner as part of *this* release, rather than assumed
      from the PR having landed.
      [PR #294](https://github.com/SlumperSan/agent-governed-vaults/pull/294), which re-enabled
      x402 metering on a since-abandoned mainnet deployment, merged on 2026-09-15 and is the worked
      example: it reversed an earlier owner decision and its own description asked that it not be
      merged without review.
- [ ] List the draft PRs this release depends on, by number, in the release notes so a reviewer can
      check each one's sign-off status directly rather than trusting a summary.
