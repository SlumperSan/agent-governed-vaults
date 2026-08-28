# Build vs. Buy

A standing owner principle: **prefer mature, audited external infrastructure over bespoke re-implementations** — especially for security-critical primitives where a network of independent operators already exists.

## Why it matters

The most expensive finding class in the entire audit — C-3, C-4, C-6, H-1, H-2, H-3, M-1, M-14 — all lives inside **one bespoke component**: the custom multi-source median [[oracleaggregator]] and its TWAP/Pyth source adapters. A per-vault 5-source median tried to re-implement, from scratch, the Byzantine-fault-tolerant price aggregation that Chainlink's node-operator network already provides at scale. It competed with mature infrastructure and lost: the code cannot enforce source independence, so `quorum ≥ 2a+1` is unenforceable in-contract (see [[c6-oracle-byzantine]]).

## The principle and rationale

A bespoke oracle aggregator competing with Chainlink's node-operator network is exactly the kind of surface to **outsource rather than harden**. Chainlink Data Feeds bring, at the network layer, what the custom aggregator could only approximate: many independent, reputation-staked operators; published deviation-threshold + heartbeat guarantees; years of mainnet Byzantine-fault tolerance — and they are **free to consume on-chain**.

The [[chainlink-direct-pivot]] is the direct application of this principle: consuming the feed directly deletes the custom-aggregation attack surface and most of the oracle findings **by deletion** rather than by patch. The cautionary tale is generalizable — bespoke re-implementation of a well-solved, security-critical primitive concentrates risk in code that a small team must review alone, against adversaries the mature service has already survived.

**Scope of the principle:** it argues for buying mature infrastructure for hard, adversarial, well-solved primitives (oracles, math libraries) — not for outsourcing the protocol's own novel mechanisms (the vault/governance/x402 core, which is the product). The test is whether a battle-tested external network already exists that you would be re-inventing.

## Links

- Applied in: [[chainlink-direct-pivot]] · cautionary tale: [[oracleaggregator]] · [[oracle-layer]]
- Findings it explains: [[c6-oracle-byzantine]] · [[c4-depressed-price-theft]] · [[c3-oracle-brick]] · [[highs]]
- Related decisions: [[decisions-index]] · [[delegatecall-split-rejected]]
- Contracts: [[chainlinkoracle]] · [[safetransferlib]]
