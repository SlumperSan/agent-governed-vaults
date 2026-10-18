# Activity leaderboard

A measurement of on-chain activity in the registered-agent vaults, recomputable from chain logs by anyone. It confers nothing: it is a ranking of a measured quantity and is not tied to any right, fee, asset or vote.

## What it measures

Phase 1 ranks addresses by **USDC-days held**: the cost basis an address has in a vault, integrated over time.

- Cost basis is what the vault contract itself keeps in `costBasisUsdc(member)`: USDC put in, reduced pro rata when shares are burned on exit. It does not move with the basket price.
- One USDC-day is one USDC of cost basis held for 86,400 seconds. The unit is exact to six decimals and floored.
- Each address is measured the same way. Splitting capital across several addresses does not raise the total: a split made of deposits never measures more than one address would, and on exits the contract's own rounding can differ by at most one millionth of a USDC per address and exit. Depositing and exiting repeatedly measures only the time the capital was actually held.
- An epoch is seven days, counted from the deploy block timestamp of the first registered-agent vault. A change stamped at the epoch start belongs to the new epoch.
- Each chain has its own board, and a global row sums an address across chains only where its deployed code is identical on every chain counted, because the same address can be different parties on different chains. Identical code does not prove one party: a wallet with the same bytecode and different owners on two chains, or an address delegated with EIP-7702 on one chain only, cannot be told apart by this rule.
- Addresses on `docs/seeded-addresses.json`, and each vault's creator and deployer, are measured like the rest, labelled `teamOperated`, left out of ranks, and totalled apart from everyone else.
- Later phases add counted governance actions. They are not in this package yet.

## Chains

Arc, Base, Arbitrum, Ethereum and Polygon. `src/chains.mjs` lists the vaults for each. It lists none: no registered-agent vault is deployed yet, so a run with no `--vault` refuses to start. Nothing is invented for chains whose RPC endpoints this repository does not record.

## Run it

```
node packages/activity-leaderboard/src/cli.mjs --chain arc --epoch 0 \
  --anchor <unix seconds of the first vault deploy block> \
  --vault <vault address>@<first block to read> [--rpc <url>] [--out <dir>]
```

Reads only. No key is used and no transaction is sent. The log reader pages `eth_getLogs` in 10,000-block windows, takes block timestamps from the chain, and finishes with a head-state check at the confirmed head block. For each configured vault, the sum of the ledger's shares must equal the vault's `totalShares()`; for every address the reducer holds, `sharesOf` and `costBasisUsdc` must equal the ledger. The share total is what catches an address whose logs were missed altogether, whether the read started after its deposit or an endpoint answered with an empty list. A mismatch aborts the run before anything is written.

The output is canonical JSON with a `contentSha256` over everything above it. The same logs and the same code commit always give the same bytes, whatever the window size or order. The commit is inside the hashed body, so a later re-run of a closed epoch from another commit gives different bytes and the publisher refuses to replace the existing epoch file. A closed epoch is final once 24 hours have passed since it ended; before that, a board is marked `provisional`.

## One endpoint or two

Logs are read from one RPC endpoint. When a second endpoint is recorded for the chain (Arc has two), or passed with `--rpc2`, the run also requires it to report the same block hash at the head block and the same `totalShares()` for every vault, and aborts otherwise. The second endpoint is not used for logs; agreement on them rests on the ledger matching the share total, which both endpoints must report alike. A run with one endpoint is single-source: its head-state check reads the same provider it checks, nothing in the code detects a provider that is consistently wrong about both logs and state, and the diagnostics print `secondEndpointChecked: false`. Base, Arbitrum, Ethereum and Polygon have no endpoint recorded in this repository, so their runs are single-source until one is added. The chain-binding error prints the endpoint URL, so do not pass a URL containing a key to a run whose output is logged.

## Publishing is off by default

`src/publish.mjs` prints a dry run unless the environment variable `LEADERBOARD_PUBLISH` is exactly `yes`. With it set, it writes one commit to the local branch `leaderboard-data` of the repository it runs in, using git plumbing only: no checkout, no change to the working tree, no push. The first commit has no parent, so the branch shares no history with the code branches. Files are `epochs/NNNN.json` for a closed epoch (never rewritten with different bytes) and `latest.json`. Pushing and serving that branch are separate steps and are not done here. No scheduled workflow exists.

## The event field the reducer does not trust by its name

`DepositActivated` carries `(member, amountUsdc, sharesMinted)`, but the third field is the member's share balance after the deposit, not the amount minted: both emit sites in `contracts/src/VaultCore.sol` pass `sharesOf[member]` read after the mint. The reducer sets the balance to it and never adds it. `test/abis.test.mjs` pins both emit sites, the cost-basis rule and the two places `totalShares` changes to the contract source, so a change there turns a test red. The pins read `contracts/src/VaultCore.sol`; a registered-agent vault that overrides the deposit path needs its own pins in the change that adds it to `src/chains.mjs`.

## Tests

```
node --test packages/activity-leaderboard/test/*.test.mjs
```

No test touches the network. The acceptance run against Arc mainnet is a manual step described in the pull request.
