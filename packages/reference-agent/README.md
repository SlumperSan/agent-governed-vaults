# reference-agent

A policy-driven autonomous vault member — **dry-run by default**. It perceives the protocol through
the x402-metered API (via [`agent-sdk`](../agent-sdk)) plus direct chain reads, decides via pure
policy functions, and then *describes* the transactions it would send. Execute mode requires both an
operator-injected account and an explicit environment flag.

Full documentation, policy knobs, the salt scheme, and an honest risks section:
**[docs/REFERENCE-AGENT.md](../../docs/REFERENCE-AGENT.md)**.

```bash
node packages/reference-agent/src/run.mjs --api=http://127.0.0.1:8402 --demo-wallet --chain-id=84532
```

| Module | Responsibility |
| --- | --- |
| `src/config.mjs` | policy defaults, the dry-run/execute gate, `redact()` |
| `src/budget.mjs` | per-session x402 spend cap (pre-call gate + signer backstop) |
| `src/salt.mjs` | deterministic wallet-derived reveal salt — the S-4 mitigation |
| `src/chain.mjs` | direct contract reads; embedded ABI fragments, drift-tested against `contracts/out` |
| `src/evaluators.mjs` | pluggable proposal evaluators (ships a naive drift band) |
| `src/policy.mjs` | **pure** join / vote / exit / entry / settle decisions |
| `src/plan.mjs` | decisions → risk-ordered, schedulable intents |
| `src/act.mjs` | intents → transactions (or a description of them) |
| `src/perceive.mjs` | metered API + chain reads, under budget |
| `src/agent.mjs` | the perceive→decide→act loop |
| `src/run.mjs` | CLI entrypoint (dry-run only, by construction) |

Tests: `node --test packages/reference-agent/test/*.test.mjs` (also part of `npm run test:backend`).
