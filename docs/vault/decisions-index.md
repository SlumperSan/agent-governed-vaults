# Decisions Index

The hub for the protocol's load-bearing decisions: the choices that shaped the launch surface, and the reasoning behind each one.

## Why it matters

This protocol is **immutable at deployment**: no proxy, no pause, no admin, no migration. Every decision here is therefore permanent for the vaults it governs, so each was argued rather than asserted. When a future reader asks "why is it built this way?", the answer lives in one of these notes, and each links back to the security finding or principle that forced the call.

## The decisions

- [[root-vaults-only]]: sub-vaults disabled at launch (`VaultFactory.allowSubVaults = false`); the C-1 fix and the cheapest risk reduction in the whole document.
- [[chainlink-direct-pivot]]: resolve C-6 by consuming Chainlink Data Feeds directly instead of hardening the bespoke aggregator; the leading launch-default direction.
- [[build-vs-buy]]: the standing principle behind the pivot: prefer mature, audited external infrastructure over bespoke re-implementations. The custom oracle is the cautionary tale.
- [[delegatecall-split-rejected]]: the EIP-170 delegatecall split came off the launch path once sub-vaults were disabled and the byte pressure eased.
- [[auto-merge]]: how remediation PRs flow to `protocol/main`.
- [[continuous-autonomous-mode]]: the operating model: full autonomy, constant output, parallel workers.

## Links

- [[current-state]] · [[remediation-history]] · [[open-items]] · [[prs-and-issues]]
- [[security-index]] · [[launch-readiness-gates]] · [[audit-reverification]]
- Criticals resolved by these decisions: [[c1-empty-electorate]] · [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]]
