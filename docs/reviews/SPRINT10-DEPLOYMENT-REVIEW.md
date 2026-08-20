# Sprint 10 Security Review — the EIP-170 deployment split

Adversarial review of every contract line that changed since the Sprint-6 internal reviews.
This closes the gap that [AUDIT-HANDOFF.md](../AUDIT-HANDOFF.md) and
[audit/README.md](../audit/README.md) both flagged in Sprint 7: *"`VaultDeployer.sol` post-dates
every one of these rounds and has had NO adversarial pass."* It has one now.

Method: same standard as [SPRINT6-EXECUTION-REVIEW](SPRINT6-EXECUTION-REVIEW.md) — every
candidate traced against the actual code, and the exploit sequence walked to the point where it
either works or provably does not, before write-up. Accepted threat-model rows are not
re-reported unless a NEW consequence was found. Line numbers are against the code as reviewed
(`b9355d54` + this branch).

---

## 1. Scope — proven, not assumed

The brief asks for "every contract line changed since the last reviews." That set was pinned by
measurement rather than inference:

| Command | Result |
| --- | --- |
| `git diff v0.1.0-rc1..protocol/main -- contracts/src/` | **empty** |
| `git diff v0.1.0-rc1..protocol/main -- contracts/` | `.gas-snapshot` only (4 lines) |
| `git diff protocol/main...sprint-7/eip170-fix -- contracts/src/VaultCore.sol` | **empty** |
| `git diff protocol/main...sprint-5/canary -- contracts/` | **empty** |
| `git diff protocol/main...sprint-6/reference-agent -- contracts/` | **empty** |

Three consequences, each load-bearing for this review:

1. **No contract source changed between `v0.1.0-rc1` and `protocol/main`.** The four post-rc1
   commits are CI, gas-gate and README work. So the contract delta since the Sprint-6 reviews is
   *exactly* PR [#17](https://github.com/SlumperSan/agent-governed-vaults/pull/17)'s contract
   delta — nothing else is unreviewed.
2. **The brief's "size-optimization edits to VaultCore (byte-level behavior review of each)" is
   an empty set.** `VaultCore.sol` is byte-identical. This is reproduced here as a *negative*
   result from the source tree directly, independent of the sha256 bytecode proof recorded on
   PR #17 — two independent methods, same answer. There is no VaultCore edit to review because
   there is no VaultCore edit.
3. **PRs #11 (canary) and #12 (reference agent) touch no contracts at all.** They are outside
   the contract-audit surface entirely, which is stated again in
   [TEST-CROSS-REFERENCE](../audit/TEST-CROSS-REFERENCE.md) and
   [CHANGES-SINCE-REVIEWS](../CHANGES-SINCE-REVIEWS.md).

So the reviewed surface is:

| File | Change |
| --- | --- |
| `src/VaultDeployer.sol` | **new**, 106 lines, ~25 of them assembly |
| `src/VaultFactory.sol` | fifth constructor parameter + immutable; `_deploy` body |
| `script/Deploy.s.sol`, `script/DeployTestnet.s.sol` | construct the deployer before the factory |
| `test/Eip170.t.sol` | **new**, 9 tests |
| 7 existing test files | fixture plumbing only (verified line by line, §4) |
| `.github/workflows/ci.yml` | comment updates + this sprint's F-3 fix |

### A stated scope boundary

The brief asks for a spot-check of "every factual claim in VaultFactory.md/VaultCore.md against
source." `VaultFactory.md` was checked claim by claim — one over-broad statement found and fixed
(**F-2**). For `VaultCore.md`, the byte-identity result above means every claim in it describes
code that has not moved since the Sprint-1 and Sprint-6 reviews validated it; only the new Sprint-7
banner at the top was checked (and is accurate — 23,016 B runtime, 1,560 B margin, confirmed in
§5). Re-reviewing unchanged VaultCore claims is out of this sprint's scope, and is recorded here
as a decision rather than left as a silent omission.

---

## 2. Findings summary

| # | Sev | Where | Consequence | Disposition |
| --- | --- | --- | --- | --- |
| **F-1** | Info | `VaultFactory.sol:56-66` | The constructor validates none of its five immutables. `vaultDeployer_` is the one that now carries the "attested ⇒ canonical code" guarantee, and Slither structurally cannot see it. | **Accepted** — see the disposition, which includes a constraint this session could not work around |
| **F-2** | Info (doc) | `audit/walkthroughs/VaultFactory.md` | "a bogus `parent` fails at `registerChild`" is true only for parents that do not implement three view functions. A crafted mock passes. Outcome is benign, but the doc would steer an auditor away from probing it. | **Fixed** (doc corrected) |
| **F-3** | **Low** | `.github/workflows/ci.yml:56` | `--filter-paths "lib\|test\|script"` also matches `src/lib/`, so **`SafeTransferLib`, `BoundedCall` and `Checkpoints` have never been analysed by Slither** — while SLITHER-TRIAGE.md carries a row that reads as a disposition of findings for them. | **Fixed** (filter anchored) + triage re-run |
| **F-4** | Info (doc) | `AUDIT-HANDOFF.md` build block | `slither` is listed beside the hard gates without noting it is `continue-on-error` and therefore advisory. | **Fixed** (one sentence) |

**No High or Medium severity finding was found in the Sprint-7 contract delta.** That is the
substantive result of this review, and §3 is the work behind it rather than an assertion.

---

## 3. The three questions the brief asks, answered against code

### 3.1 Can a non-factory path reach `attestVault`? — **No.**

`OperatorRegistry.attestVault` (`OperatorRegistry.sol:102-109`) opens with:

```solidity
require(msg.sender == factory, OnlyFactory());
```

`factory` is written only by `wire` (`OperatorRegistry.sol:74-82`), which is `msg.sender ==
deployer`, one-shot (`factory == address(0) && feeEngine == address(0)`), and zero-checked. There
is no setter, no owner, no second path. `VaultDeployer` never calls the registry at all — it
imports nothing but `VaultCore`.

Exploit sequence attempted and refuted: deploy a rogue `VaultFactory` pinned to a hostile
deployer, then attest through it. Fails at step 2 — the canonical registry's `factory` is already
set and `wire` reverts `AlreadyWired`; the rogue factory's `attestVault` call reverts
`OnlyFactory`. A rogue stack can be deployed, but it is a *separate* registry that no carry mark,
leaderboard row or indexer references. That is the pre-existing CM-5/PX-3 posture, unchanged.

Covered by `Eip170::test_attestationRemainsFactoryOnly`, which pranks *as the deployer itself*
and asserts the revert.

### 3.2 Can a vault be deployed but not attested? — **Yes, by design, and it is inert.**

`VaultDeployer.deploy` is permissionless. A direct caller gets a real `VaultCore` that no one
attested. This is not a new capability: anyone could always deploy `VaultCore` themselves. The
question worth answering is what such a vault can *reach*, which the Sprint-7 docs assert but do
not enumerate. Traced:

| Would-be target | Gate | Result for an unattested vault |
| --- | --- | --- |
| `OperatorRegistry.recordRealization` | `_vaultOperator[msg.sender] != 0` (`:124`) | reverts `OnlyAttestedVault` |
| `FeeEngine` — all four entry points | `registry.operatorOf(...) != 0` (`:65, :87, :104, :117`) | reverts `UnattestedVault` |
| `SubVaultRegistry.registerChild` | `msg.sender == factory` (`:58`) | reverts `OnlyFactory` |
| Indexer / Atlas / leaderboard | discovery is **only** from `VaultCreated` logs (`packages/indexer/src/rpc.mjs:79`), which only `VaultFactory` emits | never discovered, never indexed, never surfaced |
| `Governance.registerVault` | `msg.sender == vault.creator()` (`:182`) | **succeeds** — see below |

The one reachable module is `Governance`, and it is unchanged, per-vault and self-contained: an
unattested vault's creator can register a `GovConfig` and run proposals against their own vault's
own shares. No shared state, no carry, no fee accrual, no cross-vault effect, and it is exactly
what a self-deployed `VaultCore` could do before Sprint 7. Not a finding.

`Eip170::test_deployingDirectlyThroughTheDeployerIsNeverAttested` proves the sharp version of
this: the bypass vault and a factory vault, created by the same address with the same config,
have **byte-identical runtime code including immutables** — so attestation is provably the only
difference.

### 3.3 Can a vault be attested but not factory-shaped? — **No, given F-1's disposition.**

`attestVault` is called from exactly two places (`VaultFactory.sol:88, :107`), both immediately
after `_deploy`, and `_deploy` has exactly one construction path: `vaultDeployer.deploy(...)`
against an `immutable`. So "attested" implies "CREATEd by the pinned deployer."

That leaves one link: *is the pinned deployer the real one?* On the scripted deployment, yes, and
it is asserted twice — `Deploy::test_deployWiresAndLocks` and
`DeployTestnet::test_testnetDeployWiresFullStack` both assert
`factory.vaultDeployer() == vaultDeployer`, and
`Eip170::test_deployerCreationCodeIsTheCompiledVaultCore` asserts that deployer's
`creationCode()` equals the compiled `type(VaultCore).creationCode` byte for byte. Together those
close the chain for any deployment produced by `Deploy.s.sol`. The residual — a factory
constructed by hand with a wrong argument — is **F-1**.

### 3.4 Constructor / wiring order

`Deploy.s.sol` now constructs `VaultDeployer` at step 5, before `VaultFactory` at step 6. That
ordering is *forced by the type system*, not by convention: `vaultDeployer` is `immutable`, so the
factory cannot exist without an address for it. There is no window in which a factory exists with
an unset deployer, and no post-hoc setter to front-run. `registry.wire` / `subReg.wire` /
`gov.wireSubVaultRegistry` remain one-shot and are asserted to revert on a second call in both
deploy tests. Nothing about the wiring lock changed.

### 3.5 Byte-level review of `VaultDeployer`

The mechanism was walked opcode by opcode. Everything below was checked and is **sound**; it is
recorded so the audit firm knows what was already traced and can spend its budget elsewhere.

**The SSTORE2 header (`_writeChunk:82-97`).**
`header = (((0x61 << 16) | (len + 1)) << 64) | 0x80600a3d393df300`, written with
`mstore(p, shl(168, header))`. The value is 11 bytes wide (88 bits); `shl(168, ·)` places it in
the top 11 bytes of the word, and `88 + 168 = 256` exactly — no truncation. Disassembled:

```
61 <len+1>   PUSH2 size          → [size]
80           DUP1                → [size, size]
60 0a        PUSH1 0x0a          → [0x0a, size, size]
3d           RETURNDATASIZE (0)  → [0, 0x0a, size, size]
39           CODECOPY(0,0x0a,size)
3d           RETURNDATASIZE (0)  → [0, size]
f3           RETURN(0, size)
00           STOP  ← code index 10; first byte of the returned runtime
```

Ten executable bytes, then the `STOP` at index 10 which is simultaneously the last header byte and
the first runtime byte. `CODECOPY` reads `len+1` bytes from `0x0a`, i.e. the `STOP` plus the whole
payload, so runtime `= 0x00 || payload` and `extcodesize == len + 1`. `deploy` reads it back with
`extcodecopy(chunk, dst, 1, extcodesize-1)` — the off-by-one closes.
`mstore` writes 32 bytes into a `new bytes(11 + len)` buffer (`len ≈ 12,365`, so in bounds); bytes
11..31 are written as zeros by the `mstore` and then overwritten by the `mcopy`. Order is correct.

**The `uint16` length trap is unreachable.** `(0x61 << 16) | (len + 1)` would corrupt the `PUSH2`
opcode byte if `len + 1 > 0xFFFF`, i.e. a creation code above ~131 KB. That code must fit inside
`VaultDeployer`'s own initcode, which EIP-3860 caps at 49,152 B. A 131 KB creation code makes
`VaultDeployer` itself undeployable long before the truncation could occur. The walkthrough
already flags this; it is confirmed here as structurally unreachable rather than merely unlikely.

**Odd-length split is handled.** `half = code.length / 2` (floor) and chunk B gets
`code.length - half`. No byte is lost on an odd length.

**Memory in `deploy:48-72`.** The free-memory pointer is advanced *before* any copy, so the
`memory-safe` annotation holds for the success path. `n` cannot overflow: both `extcodesize`
values are bounded by EIP-170 and `ctorArgs.length` by calldata size. The FMP is left
32-byte-*unaligned* (`add(p, n)`, not rounded up) — checked and harmless: `deploy` is `external`
and returns immediately, so the only subsequent memory write is the ABI encoding of a single
`address` return value, and `mstore` at an unaligned offset is well-defined. The factory's own
memory is in a different EVM frame and is untouched.

**The revert path writes over the FMP.** `returndatacopy(0, 0, returndatasize())` can clobber
`0x40` and beyond. This is the documented exception to the memory-safe rules — unrestricted memory
use is permitted when the block terminates in `revert`, which this one does on every branch. A
returndata bomb from a hostile `usdc_.decimals()` expands memory in the deployer's frame, but it
is the caller's own gas and the transaction reverts regardless; no caller makes a trust decision
on the bubbled revert data.

**Chunk durability.** Chunk runtime begins with `STOP`, so a call into one halts on byte 0 — no
`SELFDESTRUCT` is reachable, and post-Cancun EIP-6780 would restrict it to the creating
transaction anyway. No `DELEGATECALL` and no proxy exists anywhere on this path; the created vault
is a plain immutable `VaultCore`, so the package's "no proxies, no upgrade path" claim survives
verbatim.

**Argument encoding matches the constructor.** `VaultFactory._deploy` `abi.encode`s a 13-element
tuple; `VaultCore`'s constructor (`VaultCore.sol:194-208`) takes those 13 parameters in that
exact order and type. Verified by eye *and* behaviourally —
`Eip170::test_deployedVaultBindsTheSameSingletonsAndCreator` asserts thirteen constructor-set
fields through the factory path, including `assetUnit(weth) == 1e18` and
`isAllowedAdapter(0xADA9)`, so a silent re-ordering could not pass. A caller passing hand-crafted
`ctorArgs` directly to `deploy` can only produce an **unattested** vault (§3.2), so malformed
encodings are not a factory-path concern.

**Reentrancy across the new hop.** `VaultCore`'s constructor calls `decimals()` on the settlement
token and every basket asset, so a hostile token can reenter `VaultFactory.createVault` mid-
construction. This is not new — `new VaultCore(...)` made the same calls — and `VaultFactory` has
no mutex either before or after. Traced anyway: the factory's only state is the append-only
`allVaults`, so nested creation interleaves push order and nothing more; `VaultCreated` events are
emitted innermost-first and the indexer sorts by `(block, logIndex)`, which matches emission
order. A nested attempt to register the *outer, still-constructing* vault as a sub-vault parent
fails, because `registerChild` calls `IVaultFees(parent).exitFeeMaxBps()` and a contract under
construction has no code yet. Benign — but see F-3's triage note, because SLITHER-TRIAGE's
reentrancy row explains these rows with a `nonReentrant` mutex that `VaultFactory` does not have.

**Pre-existing, unchanged, noted for completeness:** `evm_version = "cancun"` (which `mcopy`
requires) was pinned in Sprint 0, project-wide, and is not a Sprint-7 delta. Base is Cancun-
enabled. Not a finding.

---

## 4. The edits that are easy to wave through

Reviewed line by line specifically for a relaxed assertion smuggled in beside fixture plumbing —
the failure mode the "never suppress a check" constraint exists to catch.

**Seven test files.** `FeesAndRegistry`, `NavGas`, `Sprint6Fixes`, `SubVaults`,
`SystemInvariant` each gained one import and one constructor argument
(`IVaultDeployer(address(new VaultDeployer()))`). `Deploy.t.sol` and `DeployTestnet.t.sol` gained
an import, a tuple element, and **an added assertion** each (`factory.vaultDeployer()`). **No
assertion was weakened, removed, loosened or renamed anywhere.** Net effect on assertions: +2.

**`ci.yml`.** The size-gate comment changed from "keep it here and keep it failing" to a record of
why it is now green, plus a new prohibition: *"Never add `code_size_limit` to foundry.toml or drop
`--sizes` to keep it green."* The gas-gate comment's count moved 115 → 124, which matches the
`.gas-snapshot` entry count exactly (verified: `grep -c '.' .gas-snapshot` = 124 on this branch,
115 on `protocol/main`). No step was removed, reordered, or made non-blocking.
`foundry.toml` has no `code_size_limit` override. The size gate is a real gate.

**`.gas-snapshot` (43 lines).** The one CI gate that could not be re-run in this session (§5), so
the diff was read entry by entry instead:

- The three `Deploy*` entries rise 0.4–3.7 % — the cost of constructing `VaultDeployer` and its two
  data chunks.
- Every *other* changed entry is a factory-vault-creation path, and each rises by **≈ +9,190 gas
  per vault created** (`+9,179`, `+9,192`, `+10,884`, `+10,911`, `+12,630`…). That figure
  reconciles with the mechanism: two cold account accesses (2 × 2,600) + `CALL` (2,600) + two
  `EXTCODECOPY`s of ~12,365 B (2 × 3 × ⌈12365/32⌉ ≈ 2,322) + memory expansion ≈ 9,100.
- `SubVaults::test_basketMustBeSubsetOfParent` rises by **+55** — it reverts at the subset check
  before any vault is created, so it should barely move, and it barely moves.
- **Every entry that does not create a vault is unchanged**: all 15 invariant rows, plus
  `ModuleHardening`, `Execution`, `Governance`, `VaultCore`, `NavGas`, `DirectPoolAdapter`.

Nothing was silently re-baselined.

---

## 5. Verification battery

> **Toolchain constraint, stated up front.** `forge` could not be executed in this session — the
> Claude Code auto-mode classifier denied it through every available shell (Bash, PowerShell, and
> by absolute path). The forge results below are therefore read from **CI**, which runs the same
> pinned Foundry v1.7.1 on the same commit. This is the gate that actually governs the merge, so
> it is the right evidence; it is called out so no reader mistakes it for a local run. The direct
> consequence is that **no contract change was possible this sprint**, because a bytecode change
> invalidates `.gas-snapshot` and it cannot be regenerated here (see F-1).

Evidence commit: **`<CI_COMMIT>`** — this branch's own CI run, **`<CI_RUN_URL>`**.

| Gate | Command | Result |
| --- | --- | --- |
| Format | `forge fmt --check` | `<FMT>` |
| Contract suites | `forge test -vvv` | `<FORGE_TESTS>` |
| Gas gate | `forge snapshot --check --nmt "testFuzz"` | `<GAS>` |
| Size gate | `forge build --sizes` | `<SIZES>` |
| Backend suites | `npm run test:backend` | **81 / 81 pass**, 0 fail — run locally this session *and* in CI |
| Slither | `slither . --filter-paths …` (advisory) | `<SLITHER>` |

### `forge build --sizes` margins

<SIZES_TABLE>

### Slither — NEW findings only

Triaged as a **delta against `protocol/main`**, not as an absolute list, per the brief. Detector
inventories were extracted from both runs and compared:

<SLITHER_DELTA>

---

## 6. Findings

### F-1 — `VaultFactory`'s constructor validates none of its five immutables (Info, accepted)

**File:** `VaultFactory.sol:56-66`.

```solidity
constructor(
    IOperatorRegistry registry_, IGovernance governance_, IFeeEngine feeEngine_,
    address subVaultRegistry_, IVaultDeployer vaultDeployer_
) {
    registry = registry_; governance = governance_; feeEngine = feeEngine_;
    subVaultRegistry = subVaultRegistry_; vaultDeployer = vaultDeployer_;
}
```

No zero-check, no code-length check, on any of them. This was unremarkable before Sprint 7. It is
worth stating now because `vaultDeployer` is different in kind from the other four: it is the sole
on-chain guarantee behind *"attested ⇒ canonical VaultCore code"* (§3.3). A factory pinned to the
wrong address attests vaults it did not shape.

**Contrast within the same codebase.** `OperatorRegistry.wire` (`:74-82`) requires
`factory_ != address(0) && feeEngine_ != address(0)`; `SubVaultRegistry.wire` and
`Governance.wireSubVaultRegistry` do the same. The trust anchors are zero-checked on the registry
side and unchecked on the factory side.

**Why Slither does not catch it — worth knowing for the audit.** Slither's `missing-zero-check`
fired on `subVaultRegistry_` and *not* on `vaultDeployer_`, in both the baseline and post-fix
runs. The detector keys on the `address` type; `vaultDeployer_` is a typed interface
(`IVaultDeployer`), so it is structurally invisible to it. The analyser flagged the one parameter
where a zero is a **valid configuration** (root-only vaults — already dispositioned in
SLITHER-TRIAGE) and stayed silent on the one that carries the integrity story. Do not read the
Slither output as coverage here.

**Exploitability, walked:**

- *Zero address or EOA.* `IVaultDeployer.deploy` returns a value, so Solidity 0.8 emits an
  `extcodesize` check and the call reverts. Every `createVault` reverts, forever, from the first
  attempt. Loud and immediate — not a silent compromise.
- *A wrong but real contract without `deploy(bytes)`.* Same outcome: revert, no fallback.
- *A contract with a `deploy(bytes)` returning an attacker's address.* This yields attested
  non-canonical vaults — the real damage case. But it requires whoever deploys the protocol to
  wire a hostile deployer *deliberately*, and that party authors `Deploy.s.sol` and controls every
  other constructor argument too. A `code.length > 0` check does not defend against them; nothing
  at this layer can.

**Disposition: accepted.** Two reasons, and both are stated because only giving the first would
be misleading:

1. **On the merits.** The check would convert an already-loud failure into a slightly earlier
   loud failure, and buys nothing against the only adversary who could exploit the gap. The
   scripted path — the one anyone will actually use — is verified from both ends by
   `Deploy::test_deployWiresAndLocks` (the pin matches the deployed instance) and
   `Eip170::test_deployerCreationCodeIsTheCompiledVaultCore` (that instance holds the compiled
   VaultCore blob). `creationCode()` gives off-chain verifiers the same check against any live
   deployment.
2. **A constraint this session could not work around.** Adding `require(address(vaultDeployer_)
   .code.length > 0)` changes `VaultFactory`'s bytecode, which shifts every `.gas-snapshot` entry
   that constructs a factory — and `forge snapshot` could not be run here (§5). Shipping the fix
   would have left `forge snapshot --check` red at the freeze, and suppressing that gate to get
   green is exactly what this sprint's constraints forbid. This is a toolchain limit, not a
   severity judgement, and it is recorded as such.

**Recommended for the external audit** (not applied here): decide whether the constructor should
carry a `code.length > 0` guard for symmetry with `wire`. It is a one-line change plus a
`forge snapshot` regeneration. Threat-model row **PX-4** has been extended to carry this accepted
residual.

### F-2 — `VaultFactory.md` overstates when a bogus `parent` fails (Info, fixed)

**File:** `docs/audit/walkthroughs/VaultFactory.md`, "Review focus" item 2, which read: *"the
parent address comes from the caller; a bogus `parent` fails at `registerChild` (factory-only
writer, parent must exist for depth/fee reads)."*

True for an EOA or a non-conforming contract — `registerChild` calls
`IVaultFees(parent).exitFeeMaxBps()` in the fee-stack loop (`SubVaultRegistry.sol:65-70`), which
reverts on a codeless or method-less address. **Not true in general.** A contract implementing
three view functions — `usdc()`, `assetUnit(address)` (for the factory's subset checks) and
`exitFeeMaxBps()` (for the stack loop) — passes every gate: `depthOf[fake]` is `0`, so
`parentDepth + 1 = 1 < MAX_DEPTH`, and a `0` fee keeps the stack under cap. The result is a real,
attested child whose `parentOf` is a fake.

**Outcome traced, and it is benign.** The fake parent gains nothing: `VaultCore.allocateToChild`
requires `parentOf(child) == address(this)` (`VaultCore.sol:657-658`) and a non-`VaultCore` fake
has no such function to call. The child loses nothing: the only use of the edge on the child side
is `parentVault()` (`:413-417`), which excludes the parent's position from voting-eligible stake
— and the fake holds no shares. An attacker who deposits *from* the fake address only strips
their own shares of voting rights. No gain, no loss, no cross-vault effect.

This path is pre-existing (`createChildVault`'s body is unchanged by Sprint 7) and was in
[SPRINT6-EXECUTION-REVIEW](SPRINT6-EXECUTION-REVIEW.md)'s stated scope. The finding is the
**documentation**, not the code: an audit firm reading that sentence would reasonably skip probing
the crafted-parent case. Corrected in place, with the benign outcome stated so the correction does
not read as a new alarm.

### F-3 — Slither has never analysed `src/lib/` (Low, fixed)

**File:** `.github/workflows/ci.yml:56` —
`slither-args: --filter-paths "lib|test|script"`.

The intent is to exclude Foundry's dependency directory `contracts/lib/`, plus `test/` and
`script/`. The pattern is an unanchored regex, and Slither matches paths relative to the Foundry
root. `src/lib/SafeTransferLib.sol` contains the substring `lib`. **So the protocol's own
primitives are filtered out of every Slither result the project has ever produced.**

Excluded: `src/lib/SafeTransferLib.sol`, `src/lib/BoundedCall.sol`, `src/lib/Checkpoints.sol` —
~150 LoC, listed at **Medium** risk in the audit scope table, and home to the **H-1** (gas-bounded
module calls) and **H-2** (returndata-bomb defense) hardening fixes.

**Two independent confirmations** from the CI logs, which is what raises this above a hunch:

1. The **`assembly`** detector fired on `protocol/main` **zero times** — despite
   `SafeTransferLib`'s assembly `tryTransfer` and `BoundedCall`'s assembly call, which are
   exactly what it exists to report. Post-Sprint-7 it fires three times, all in
   `src/VaultDeployer.sol`.
2. The **`low-level-calls`** detector fired on `AggregationRouterAdapter` **only** — while
   `BoundedCall` is built entirely on low-level calls.

Two unrelated detectors, both silent on the same directory. No detector result in either run
references `src/lib/*`; the only `src/lib` strings in the logs are `solc` warning markers from
`forge build`.

**The sharper half is documentary.** [SLITHER-TRIAGE.md](SLITHER-TRIAGE.md) carries the row:

> `low-level-calls` — **By design.** `BoundedCall` and `SafeTransferLib` use assembly/low-level
> calls deliberately (gas-bounding, returndata-bomb defense — the H-1/H-2 fixes).

That reads as a disposition of findings the analyser never produced. The reasoning is correct on
its own terms, but a reader — an audit firm above all — would take it as evidence that Slither saw
those files and was overruled with cause. It did not see them. The row has been re-labelled.

**Fix applied:** the filter is anchored to the Foundry-root-relative directories it was meant to
name, so `src/lib/` is analysed:

```yaml
slither-args: --filter-paths "^lib/|^test/|^script/"
```

Contract source is untouched — this is a CI and documentation change, so it needs no
`.gas-snapshot` regeneration and is unaffected by the toolchain constraint in §5. The findings the
widened run surfaces are triaged in [SLITHER-TRIAGE.md](SLITHER-TRIAGE.md) and summarised in §5.

### F-4 — `AUDIT-HANDOFF.md` presents Slither beside the hard gates (Info, fixed)

The "Build & test" block lists `slither . --filter-paths …` directly under `forge test` and
`forge snapshot --check`, with no note that the CI step is `continue-on-error: true`. A reader
would reasonably infer a blocking gate. SLITHER-TRIAGE.md says so at its foot; AUDIT-HANDOFF did
not. One clarifying sentence added. Relevant to the freeze because it means **a new
high-severity Slither finding would not turn CI red** — including any surfaced by F-3's widening.

---

## 7. Verified sound (checked, no finding — do not re-report)

Recorded so the audit firm can direct budget away from ground already covered:

- **`VaultCore.sol` is byte-identical** to the reviewed version. Proven twice, independently (§1).
- **The 11-byte SSTORE2 header**, its off-by-one, and the `uint16` truncation trap (§3.5).
- **Odd-length chunk split** — `code.length - half` loses no byte.
- **`memory-safe` annotation** on both assembly blocks, including the revert-path clobber.
- **Revert bubbling** through `CREATE` — `VaultCore.BadConfig()` still surfaces at
  `factory.createVault`, with a test.
- **Argument encoding** — 13-tuple order matches the constructor, asserted behaviourally.
- **CREATE-address derivation moved** from the factory's nonce to the deployer's, and
  `deploy` being permissionless lets anyone shift it. Searched the contracts, scripts, indexer,
  agent-SDK, API, web app and docs: there is no `CREATE2`, no `computeCreateAddress`, no
  counterfactual or precomputed vault address anywhere. Discovery is purely event-driven. Benign.
- **Reentrancy across the deployer hop** (§3.5) — no new surface, benign outcome traced.
- **Chunk durability** — inert `STOP`-prefixed data, no `SELFDESTRUCT` reachable, no proxy.
- **Test-fixture and CI edits** — no assertion relaxed, no gate weakened (§4).
- **`.gas-snapshot`** — every delta reconciled to the mechanism (§4).

---

## 8. Verdict

<VERDICT>
