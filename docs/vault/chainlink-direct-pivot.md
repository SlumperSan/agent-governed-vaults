# Chainlink-Direct Pivot

The resolution of C-6: price each asset from a single Chainlink Data Feed directly, instead of hardening the bespoke multi-source median aggregator. Shipped as `ChainlinkOracle.sol` (PR #49). **IMPLEMENTED / leading launch default.**

## Why it matters

C-6 ([[c6-oracle-byzantine]], issue #48) re-opened C-4's 88.9% theft: the custom aggregator's quorum prescription is a **fault-tolerance floor, silent on the Byzantine floor** `quorum ≥ 2a+1`. At `m=5`/`quorum=3` the two floors pull against each other — there is **no clean code fix at m=5** (tolerating `a=2` needs `quorum ≥ 5`, i.e. zero fault tolerance; genuine `a=2`-with-fault-tolerance needs `m ≥ 7`). The code cannot see how many sources a single actor controls, so hardening the aggregator only moves the problem.

## The decision and rationale

The entire oracle-finding class — C-3, C-4, C-6, H-1, H-2, H-3, M-1, M-14 — lives in the *custom* aggregation the protocol wrote. A Chainlink Data Feed is **itself** a decentralized aggregation of many independent, reputation-staked node operators with published deviation-threshold + heartbeat guarantees and years of mainnet Byzantine-fault tolerance: it already solves the `quorum ≥ 2a+1` problem at the network layer, far beyond a per-vault 5-source median.

`ChainlinkOracle.sol` is an **additive** `IOracleAggregator` (a VaultCore can be deployed with it in the `oracle_` slot, **no VaultCore change**) that prices each asset from ONE feed — no median, no quorum, no per-vault source set — so C-6's median-gaming has **no surface to exist**. It fails closed on every bad read (revert/zero/negative/unset/future/stale), enforces a per-asset **sane-price band** (depeg clamp, since Chainlink deprecated on-aggregator min/maxAnswer), a **Base L2 sequencer-uptime guard** (down/grace), decimals→WAD normalization, and a USDC pin; construction decode-proves every feed. 32 tests (`ChainlinkOracle.t.sol`), 1,532 B. Two adversarial reviews confirm it eliminates the finding class **by deletion** — the strongest form.

**Standard Chainlink Data Feeds are FREE to consume on-chain** (gas only; Data Streams / VRF / CCIP are the metered products), so cost is not an objection.

**Recommendation:** adopt Chainlink-direct as the **launch default**. The complementary factory oracle-gate — making the custom [[oracleaggregator]] non-deployable, since leaving it user-selectable re-imports C-6 for any vault that picks it — is now **DONE (PR #50)**: [[vaultfactory]] carries an immutable `allowedOracles_` allowlist that, when non-empty, reverts `OracleNotAllowed` for any non-blessed oracle in `createVault`/`createChildVault`. The C-6 remediation mechanism is therefore complete in code (safe oracle #49 + factory gate #50); what remains is populating the allowlist with real blessed-oracle addresses in the mainnet deploy config, plus the external audit. The mechanism choice (Chainlink-direct vs. curated custom aggregator with `quorum ≥ 2a+1`) is ultimately for the owner + external auditor.

Accepted tradeoffs, documented: single-provider dependency (a feed freeze fails that asset closed, no fallback), assets without a Chainlink feed cannot be listed, and the deviation-band NAV arb (bounded; the vault-side defence is M-15).

## Links

- Resolves: [[c6-oracle-byzantine]] · related: [[c4-depressed-price-theft]] · [[c3-oracle-brick]]
- Principle behind it: [[build-vs-buy]]
- Contracts: [[chainlinkoracle]] · [[oracleaggregator]] · [[oracle-sources]] · [[oracle-layer]] · [[vaultfactory]] · [[vaultcore]]
- State: [[current-state]] · [[open-items]] · [[prs-and-issues]] · [[decisions-index]]
