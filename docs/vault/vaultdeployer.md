# VaultDeployer

The factory's one and only vault construction path. It holds `type(VaultCore).creationCode` as
on-chain data and `CREATE`s new vaults from it. `contracts/src/VaultDeployer.sol`.

## Why it matters

It exists for exactly one reason: **EIP-170**. *Any* contract that writes `new VaultCore(...)`
embeds VaultCore's whole creation code in its own runtime, and the sum does not fit: the initcode
measures **22,391 B** (2026-09-02), leaving 2,185 B under the 24,576 B cap for a factory whose own
logic is 3,572 B. This paragraph said the creation code was 24,731 B and exceeded the cap *by
itself*; that was true when written and the figure has since moved below the cap. [[vaultfactory]] was 2,665 B over the cap for this
reason (#10). Splitting the creation code into a dedicated deployer is what made the factory
deployable at all. It is the newest contract in the package (Sprint 7).

## How it works

- **Constructor** takes `type(VaultCore).creationCode` (initcode is capped at 49,152 B by EIP-3860,
  so it fits there) and copies it into **two immutable, non-executable data contracts** (`codeChunkA`,
  `codeChunkB`) via the SSTORE2 convention — each chunk is prefixed with a `STOP` byte so it can
  never be executed.
- **`deploy(bytes ctorArgs)`** reads both chunks back, appends the caller's ABI-encoded constructor
  arguments, and `CREATE`s. The bytes that reach `CREATE` are therefore fixed at compile time and
  verifiable on-chain. A failing VaultCore constructor bubbles its own revert data unchanged (so
  callers still observe `VaultCore.BadConfig()`).
- **`creationCode()`** reassembles both chunks — a verification aid that must equal the compiled
  `type(VaultCore).creationCode`.

## Trust — none

This contract holds **no authority**: no owner, no state after construction, no privileged
relationship with any singleton. Calling `deploy` directly yields an **unattested** VaultCore —
exactly what anyone could already obtain by deploying VaultCore themselves. Attestation stays
anchored in [[operatorregistry]], whose `attestVault` is callable only by the wired
[[vaultfactory]] (CM-5). What the factory's immutable `deployer` pin buys is the *other* direction:
the factory can only ever `CREATE` through this one code path.

## Findings

No standalone security findings live here — it is a mechanical byte-plumbing contract. It is
relevant to the [[delegatecall-split-rejected]] decision (an alternative way to relieve VaultCore's
EIP-170 pressure that was considered and rejected) and it is the reason the factory's own size is
comfortable (see [[vaultfactory]]).

## Size — EIP-170

Runtime tiny (~60-line contract); its *initcode* is the large artifact (it carries VaultCore's
creation code), which fits under the EIP-3860 initcode cap. VaultCore itself remains the binding
constraint — see [[vaultcore]].

## Links

- [[contracts-index]] · [[vaultfactory]] · [[vaultcore]]
- Decision: [[delegatecall-split-rejected]]
- [[launch-readiness-gates]]
