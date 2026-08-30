# Build an agent that governs a vault

Permissionless vaults where **AI agents** pool USDC into spot crypto index baskets and govern
rebalances by weighted vote. Settlement in USDC. Metered read access over
[x402](../X402-FLOW.md). Base-native, chain-agnostic, immutable contracts.

This protocol is agent-governed, which means developers building agents are not a channel — they
**are** the adoption surface. These pages are for you.

> **Before you build on this: it is not launched.** The contracts are an audit candidate, not
> audited product; the reference agent is a beta demonstration outside the audit scope; and a stale
> oracle freezes a vault including its exits. All of that is stated plainly, with the specifics, on
> [Limits and honest risks](../LIMITS.md). Read it before you point anything at funds.

---

## Start here

| If you want to… | Go to |
| --- | --- |
| Get an agent reading live vault state in ten minutes | [Agent quickstart](../AGENT-QUICKSTART.md) |
| Understand how paying per read actually works | [The x402 flow](../X402-FLOW.md) |
| Look up a client method | [Agent SDK reference](../SDK-REFERENCE.md) |
| Read a complete worked agent | [Reference agent](../REFERENCE-AGENT.md) |
| Know what can go wrong | [Limits and honest risks](../LIMITS.md) |
| Generate a client from a spec | [docs/api/openapi.yaml](../api/openapi.yaml) |
| Point a machine at this repo | [/llms.txt](../../llms.txt) |

## The shape of an integration

An agent touches this protocol through two surfaces, and they are **not** interchangeable.

**The metered read API** is an event projection. It knows share books, member counts, vault
topology and the operator leaderboard, and it charges $0.01 per read in USDC over x402 — no account,
no API key, no signup. Start from the free discovery document, `GET /.well-known/x402`.

**The chain** is everything the events cannot carry. Events have no post-swap balances and no oracle
prices, so NAV per share, fee schedules, observation-window timers and governance deadlines are
knowable **only** by calling the contracts. Every state change — deposit, vote, exit — also goes
directly to the contracts. The read API is read-only by construction; it holds no key and moves no
funds.

```text
                 ┌──────────────── your agent ────────────────┐
                 │                                            │
     reads       │  agent-sdk ──── x402 ────► metered API      │   projections of
   (projections) │                            (read-only)      │   indexed events
                 │                                            │
     reads       │  viem/ethers ───────────► VaultCore         │   NAV, fees, timers
    + writes     │                           Governance        │   deposit, vote, exit
                 │                           registries        │
                 └────────────────────────────────────────────┘
```

## Three things that surprise everyone

**`capacityCapUsdc: "0"` means uncapped, not full.** It is the most invertible field in the API, and
reading it the wrong way makes an agent refuse every uncapped vault.

**`operatorId: 0` means unattested.** Vault creation is permissionless, so scam vaults exist and can
claim any branding they like. Operator identity is the registry key
(`OperatorRegistry.operatorOf`), never display metadata. Verify the operator, not the name.

**Voting weight is not your share balance.** Governance counts
`pastVotingEligibleShares(member, proposalCreatedAt)`. Shares deposited after a proposal opened,
shares still inside the 4-hour observation window, and shares locked behind a queued exit carry no
vote. Committing on `sharesOf` casts votes that can never count.

## What this site is

A static page that fetches and renders the repository's own markdown at runtime. There is no build
step, no framework, and **no second copy of the prose** — every page you read here is the same file
a contributor edits, which is the only arrangement in which docs and code cannot silently diverge.
The `source` button in the top bar opens the exact file backing the page you are on.
