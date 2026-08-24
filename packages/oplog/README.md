# `oplog` — operational plumbing for the runtime stack

Four small, dependency-free modules shared by the indexer, the API and the canary. Nothing here
knows about vaults, chains or payments; it is the layer that makes those three processes
*operable* by one person.

| Module | What it gives you |
|---|---|
| [`src/logger.mjs`](src/logger.mjs) | JSON-lines logging (`ts`/`level`/`service`/`event` + fields), with a pretty mode when stdout is a TTY |
| [`src/heartbeat.mjs`](src/heartbeat.mjs) | atomic `<service>.heartbeat.json` files, each stamped with the writer's own staleness budget |
| [`src/ops-check.mjs`](src/ops-check.mjs) | reads those files, exits nonzero listing anything stale — cron job and compose healthcheck |
| [`src/shutdown.mjs`](src/shutdown.mjs) | ordered, once-only SIGTERM hooks with a force-exit watchdog |

No `package.json`: like every other package in this repo it is imported by relative path, which
keeps `npm ci` and the root lockfile untouched. **No runtime dependency** — viem stays the only
one in the tree, and none of these four modules import it.

Operator-facing documentation (log format, backup/restore, rate limits, metrics, the incident
table) lives in [docs/RUNTIME.md §8](../../docs/RUNTIME.md).

```bash
node packages/oplog/src/ops-check.mjs --dir=./data       # all three services
node packages/oplog/src/ops-check.mjs indexer            # just one (what compose runs)
```

Tested by `packages/oplog/test/*.test.mjs`, included in `npm run test:backend`.
