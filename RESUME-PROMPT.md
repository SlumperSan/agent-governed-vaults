Work in the repo at C:\Users\Micha\desktop\x402 (remote `origin` = github.com/SlumperSan/agent-governed-vaults). `gh` CLI at `C:\Program Files\GitHub CLI\gh.exe`.

**CRITICAL — WHERE TO WORK.** Do NOT work in the shared checkout `C:\Users\Micha\desktop\x402`: it is on branch `sprint-13/prod-ops` with uncommitted files, and concurrent sessions share it (never `git add -A` there). All Sprint-9 work happens in the SEPARATE git worktree **`C:\Users\Micha\desktop\x402-testnet`**, which is checked out on branch `sprint-9/testnet-run` (PR #18), has `npm ci` done and contracts built. `cd` there for everything.

**READ FIRST:** `docs/TESTNET-REPORT.md` (the run record so far — sections 1–8 are complete and verified), `docs/TESTNET-CHECKLIST.md`, `scripts/smoke-test.mjs`, `docs/RUNTIME.md`, `docs/CANARY.md`, `contracts/config/deployments/base-sepolia.json` (the committed address book).

## Where the run stands

**The protocol IS deployed and verified on Base Sepolia** (2026-08-21, block **45784186**, 17 txs, 13,158,066 gas = 0.000078948396 ETH, all 14 contracts Basescan-verified). Deployer `0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35`, foundry keystore alias `deployer`. Smoke vault **`0x97025d1c60a24ce3811dcb3be4529c5e1c6a6330`**.

Smoke lifecycle progress (`scripts/.smoke-state.json`, resumable):

| Phase | State |
| --- | --- |
| preflight, createVault, registerGov, deposit | ✅ done + independently verified |
| activate | ✅ done — navWad 0→5e18, totalShares 0→5e18, pending→0, navPerShareWad exactly 1e18 |
| propose (pid 1), commit | ✅ done |
| **reveal** | ❌ **MISSED — the operator's machine restarted during the 1h commit phase** |
| finalize, execute, exit | ⬜ not reached |

`Governance.proposals(1)` reads status `Active` with `revealedWeight 0`, and chain time is now ~68h past `revealDeadline` (1787368590) and past the 24h execution window. Per TESTNET-CHECKLIST §6 this is the documented EE-10 path: re-running the smoke script should `markExpired` the dead proposal and repeat propose→commit→reveal→finalize (~2h: 1h commit + 1h reveal). Nothing is stuck — shares, NAV and the deposit are all intact.

## YOUR JOB

1. **Restart the read-only runtime services** (they died with the machine). From `C:\Users\Micha\desktop\x402-testnet`, `.env` already exists with the live addresses and `START_BLOCK=45784186`:
   - indexer: `node --env-file=.env packages/indexer/src/index-runner.mjs`
   - API: `node --env-file=.env apps/api/src/serve.mjs` (FACILITATOR=stub, port 8402)
   - canary: `node --env-file=.env packages/canary/src/canary-runner.mjs`
   These already ran green once (report §8). Restarting them lets you watch the remaining transitions — in particular the canary's **exit-liveness** signal, which was correctly DEGRADED while no member held shares and should now read OK since shares exist. **Capture that transition — it is a genuine recovery worth recording.**

2. **Have the HUMAN re-run the smoke test** (they sign; you never do). Give them these, and note PowerShell env vars die with the window so all three lines are needed in the SAME terminal every time:
   ```
   cd C:\Users\Micha\desktop\x402-testnet
   $env:CAST = "$env:USERPROFILE\.foundry\bin\cast.exe"
   $env:SMOKE_SIGNER_ARGS = "--account deployer"
   node scripts/smoke-test.mjs
   ```
   It prompts for the keystore password per signed step. Suggest a `--password-file` outside the repo to avoid ~10 prompts over the ~2h governance leg (their file; never read it or ask for the password).

3. **Verify every remaining transition independently via `cast call`** against `https://base-sepolia-rpc.publicnode.com` — never trust the runner's own output. Remaining: proposal expiry/re-propose, commit, reveal (`revealedWeight` becomes non-zero), finalize (status → `Passed`, signer regime 1-of-1), execute (`RebalanceExecuted` emitted, pending execution clears), and the **Mode-I exit** — all shares burned, `holderCount`→0, and an **exact** USDC round trip (sole-holder fee waiver, so the signer should end at 20 USDC again).

4. **Complete `docs/TESTNET-REPORT.md`** — append the remaining phases with their verification, the canary transition, updated gas actually paid, and any deviations. Sections 1–8 are already written and verified; extend, don't rewrite.

5. **File a GitHub issue per genuine bug.** Contracts are post-freeze (`v0.2.0-audit`) — bugs get issues, never hotfixes. Nothing so far has warranted one. If a SCRIPT (not contract) bug blocks the run, fix it on the branch with a test and note it in the report.

6. **Close issue #15** once the report documents the full green lifecycle, and make sure PR #18 is up to date.

## Already-known findings (do NOT re-derive or "fix")

- **forge mislabels contracts in its own deploy output.** Per-transaction console lines pair contract NAMES with the WRONG ADDRESSES; the broadcast JSON has the same problem between `contractName` and the receipt reached via `transactions[i].hash`. Build address books from the `== Return ==` block plus on-chain `codesize`. **BUT** the JSON's `contractName`↔`contractAddress` *within one tx object* is CORRECT, which is what `smoke-test.mjs:127-129` uses — the smoke runner is unaffected, do not patch it. Recorded in report §6.3.
- The two "no matching bytecode" addresses (`0xf449c167…`, `0x896114ba…`) are VaultDeployer's SSTORE2 data contracts: 12,366 + 12,367 − 2 STOP bytes = 24,731 = VaultCore's initcode size. Expected. Report §6.4.
- The reference agent needs `--subvault-registry` or its fee gate always blocks with "stacked performance fee unreadable" (it fails safe). Report §8.4.
- The oracle lists the same Chainlink feed 3× per asset — the documented, deliberate testnet compromise, NOT SF-1 mechanism diversity.

## HARD CONSTRAINTS

You never run a `--broadcast`, never handle a key or password, never ask the human to paste a key. All your chain interaction is read-only (`cast call` / `getLogs`) plus the local read-only services. Contract bugs get issues, not hotfixes. If the human is unavailable for a signed step, prepare everything and stop with clear instructions.

**DONE** = TESTNET-REPORT.md documents a full green lifecycle on Base Sepolia with independent verification of every phase, the indexer/API/canary/agent all ran against it, findings filed as issues, and issue #15 closed.
