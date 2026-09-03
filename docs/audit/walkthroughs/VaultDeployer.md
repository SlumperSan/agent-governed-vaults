# Walkthrough — VaultDeployer.sol

**Risk: Medium.** ~60 LoC (of which ~25 are assembly). `contracts/src/VaultDeployer.sol`.
New in Sprint 7 — see [issue #10](https://github.com/SlumperSan/agent-governed-vaults/issues/10)
and §"Deployment shape" in [AUDIT-HANDOFF.md](../../AUDIT-HANDOFF.md).

## Why this contract exists at all

Not a design choice — an EIP-170 forced move. Solidity embeds a callee's full creation code in the
caller's runtime code, so **any** contract containing the expression `new VaultCore(...)` carries
that whole blob, and the sum does not fit: `VaultCore`'s creation code measures **22,391 B**
(2026-09-02), leaving 2,185 B under the 24,576 B cap for a factory whose own logic is 3,572 B. That
is why `VaultFactory` measured 27,241 B and could not be deployed to any chain.

This paragraph read "the creation code is 24,731 B, which is larger than the runtime cap *by
itself*" until 2026-09-02. That was true when written; the figure has since moved below the cap and
the comparison went with it. **Re-measure rather than copy either number** — nothing guards a byte
count.

The consequences worth internalizing before reviewing:

- Moving `new VaultCore(...)` into a minimal helper does **not** work on its own. That was
  measured: 25,100 B, still 524 B over.
- Optimizer tuning cannot close the gap either. The full ladder `optimizer_runs` 800 → 50
  moves VaultCore's runtime only 23,016 → 22,787 B (229 B).

So the creation code cannot live in **any** contract's runtime. It lives here in *creation*
code instead, where the applicable cap is EIP-3860's 49,152 B.

## Mechanism

1. **Compile time.** `type(VaultCore).creationCode` is embedded in this contract's own
   creation code (26,148 B — 23,004 B under the EIP-3860 cap).
2. **Construction.** The constructor splits the blob in half and writes each half as the
   runtime code of a fresh contract, via the SSTORE2 convention: an 11-byte header that
   `CODECOPY`s the payload and `RETURN`s it, with a leading `00` (`STOP`) so the stored data
   can never be executed as a program. The two addresses are stored as **immutables**
   (`codeChunkA`, `codeChunkB`).
3. **`deploy(bytes ctorArgs)`.** `EXTCODECOPY`s both chunks (skipping the `STOP` byte),
   appends the caller's ABI-encoded constructor arguments, and `CREATE`s.

The bytes reaching `CREATE` are therefore fixed at compile time and supplied by nobody. They
are checkable on-chain: `creationCode()` reassembles both chunks and must equal the compiled
`type(VaultCore).creationCode` — asserted in
`Eip170::test_deployerCreationCodeIsTheCompiledVaultCore`.

## Trust: this contract holds no authority

This is the sentence to hold onto: **`VaultDeployer` confers nothing on anyone.**

- No owner, no admin, no pause, no setters. No storage at all after construction — only
  immutables.
- No privileged relationship with any protocol singleton. It never calls `OperatorRegistry`,
  `SubVaultRegistry`, `Governance` or `FeeEngine`, and none of them know it exists.
- `deploy` is permissionless **by design, not by omission**. A direct caller gets an
  **unattested** `VaultCore` — precisely what they could already obtain before this contract
  existed, by deploying `VaultCore` themselves. The attestation anchor is unmoved:
  `OperatorRegistry.attestVault` is still callable only by the one-shot-wired `VaultFactory`
  (CM-5), which never delegates that call.

What the factory's immutable `vaultDeployer` pin buys is the *other* direction: the factory can
only ever `CREATE` through this one code path, chosen at factory-construction time and
unchangeable after.

`Eip170::test_deployingDirectlyThroughTheDeployerIsNeverAttested` asserts both halves — the
bypass vault and a factory vault created by the same address with the same config have
**byte-identical runtime code**, immutables included, and differ only in that one is attested.

### Why not gate `deploy` to the factory?

Because it would cost the immutability posture and buy nothing. The factory pins the deployer
at construction, so the deployer necessarily exists **first** and cannot know the factory
address as an immutable. Gating would need a one-shot `setFactory` — mutable state plus a
claim/front-run surface — to defend an ability that grants no privilege. Left ungated
deliberately.

## Review focus

1. **The 11-byte SSTORE2 header in `_writeChunk`.** `PUSH2 <len+1>` `DUP1` `PUSH1 0x0a`
   `RETURNDATASIZE` `CODECOPY` `RETURNDATASIZE` `RETURN` `STOP`. The header is exactly 10
   executable bytes, so the `00` at index 10 is simultaneously the last header byte and the
   first byte of the returned runtime; `CODECOPY` reads from `0x0a` for `len+1` bytes. Walk
   the off-by-one — a mistake here corrupts the blob, though every vault-creating test would
   fail loudly and immediately. The `uint16(len + 1)` length would truncate silently above
   65,534 B per chunk, i.e. a creation code over ~131 KB — unreachable behind the EIP-3860
   bound already asserted in review focus 5, and constructor-only code that could not survive
   a single test run.
2. **Memory handling in `deploy`.** The free-memory pointer is advanced *before* the copies,
   so the `memory-safe` annotation holds. Length arithmetic is `extcodesize - 1` per chunk to
   skip the `STOP`.
3. **Revert bubbling.** `CREATE` returning zero copies the child's returndata out verbatim, so
   a failing `VaultCore` constructor still surfaces as `VaultCore.BadConfig()` through
   `factory.createVault`, exactly as `new VaultCore(...)` did. `DeployFailed()` is used only
   when there is no returndata to bubble.
4. **Chunk durability.** Chunk runtime begins with `STOP`, so execution halts on byte 0 and no
   `SELFDESTRUCT` is reachable — and post-Cancun EIP-6780 restricts `SELFDESTRUCT` to
   same-transaction creation regardless. There is no `DELEGATECALL` and no proxy anywhere in
   this path: the vault that gets created is a plain, fully immutable `VaultCore`, so the
   package's "no proxies, no upgrade path" claim is unaffected.
5. **The cap this design trades onto.** VaultCore's creation code no longer needs a runtime
   slot, but it must still fit inside this contract's initcode (EIP-3860, 49,152 B; currently
   26,148 B used). Two chunks accommodate a creation code up to ~47.7 KB, which is where
   EIP-3860 binds anyway — there is no hidden cliff between the two limits.
   `Eip170::test_vaultCoreCreationCodeFitsInsideTheDeployersInitcode` guards it.

## Accepted risks here (do not re-report)

- **Permissionless `deploy` is intentional** (see "Trust" above). Anyone can create an
  unattested `VaultCore` through it; anyone could already do so without it.
- **A direct caller bumps the deployer's nonce**, changing the addresses of subsequently
  created vaults. Nothing predicts vault addresses — there is no `CREATE2`, no
  `computeCreateAddress` anywhere in the contracts, scripts, or indexer, and the indexer
  discovers vaults from `VaultCreated` logs.
- **Vault creation costs marginally more gas** (one external call plus two `EXTCODECOPY`s)
  against a ~5M-gas creation. Recorded in `.gas-snapshot`.
