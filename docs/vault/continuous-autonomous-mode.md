# Continuous Autonomous Mode

The operating model for this build: full autonomy, constant output, parallel workers — sprint approval gates lifted so work proceeds without a per-step human sign-off. **ACTIVE (approval gates lifted 2026-08-18).**

## Why it matters

The protocol was built and then hardened across fifteen sprints plus a security remediation arc without pausing for approval at each sprint boundary. This mode is what let the Phase-2 remediation close twelve findings, re-verify the Criticals, and pivot the oracle stack in a tight window — but it is also why discipline around the shared worktree and evidence integrity matters so much: nobody is gating each commit.

## The decision and rationale

**Full autonomy:** the owner lifted the sprint approval gates, so workers plan, implement, test, and merge without stopping for confirmation on routine steps. Human decisions are reserved for genuinely irreversible or judgment-bound calls (e.g. the [[chainlink-direct-pivot]] mechanism choice, supplying real mainnet feed addresses, commissioning the external audit).

**Constant output:** the expectation is continuous forward motion — a steady stream of focused, CI-gated PRs (see [[auto-merge]]) rather than large infrequent drops.

**Parallel workers:** multiple sessions run concurrently, each owning a finding or sprint. This is fast but has a sharp edge: **concurrent sessions share one git worktree**, so `git add -A` is banned — it once swept another sprint's contracts work into an unrelated PR. Staging is always explicit and per-file.

The guardrails that make autonomy safe here are the CI battery (gate 8), the preserved exploit tests in git history, and the discipline of re-marking evidence STALE when the tree moves ([[audit-reverification]]) — because in continuous mode there is no human checkpoint to catch a green board that has quietly stopped measuring the current code.

## Links

- Pairs with: [[auto-merge]] · [[decisions-index]]
- Evidence discipline it depends on: [[audit-reverification]] · [[launch-readiness-gates]]
- Output it produced: [[remediation-history]] · [[current-state]] · [[prs-and-issues]]
