# Single image for all three runtime processes (indexer + API + canary). Pick which to run via
# the compose service command or a `docker run` override. The indexer and the canary are
# non-custodial without qualification -- no keys,
# no fund movement. The canary is additionally read-only against the chain — it never sends.
# The API is the one that has a qualification: no key under `FACILITATOR=stub` and
# `FACILITATOR=http`, and a Solana fee-payer keypair read from `SVM_KEYPAIR` under the opt-in
# `FACILITATOR=svm`. Pass that env var only into the api container, and only when you mean to.
#
#   docker build -t vault-runtime .
#   docker run --env-file .env vault-runtime node packages/indexer/src/index-runner.mjs
#   docker run --env-file .env -p 8402:8402 vault-runtime node apps/api/src/serve.mjs
#   docker run --env-file .env vault-runtime node packages/canary/src/canary-runner.mjs
#
# RUN NODE DIRECTLY, NOT `npm run start:*`. npm would be PID 1, and npm does not forward SIGTERM:
# `docker stop` kills npm, node never sees the signal, and no shutdown hook runs. Measured A/B in
# docs/RESTORE-DRILL.md §10 finding 7; the reasoning is spelled out in docker-compose.yml.
#
# Two operational commands ship in the same image and need no env at all. Compose namespaces its
# volume as `<project>_vault-state`, and `docker run -v` CREATES a volume it cannot find rather
# than failing — so resolve the real name first, by Compose's own labels rather than by name
# (`--filter name=` is a substring match and also returns `vault-state-restored`; the full gated
# form, and why it matters, are in docs/RUNTIME.md §8.3):
#   docker volume ls -q --filter label=com.docker.compose.volume=vault-state
#   docker run -v <project>_vault-state:/data:ro vault-runtime node packages/oplog/src/ops-check.mjs --dir=/data
#   docker run -v <project>_vault-state:/data:ro vault-runtime node packages/indexer/src/index-runner.mjs verify /data/indexer-state.json
FROM node:24-slim

WORKDIR /app

# Install runtime deps first for layer caching. `npm ci` against the committed lockfile so the
# image resolves exactly what CI tested (security-ops §3). --omit=dev pulls the three declared
# runtime dependencies — viem, @solana/web3.js, @solana/spl-token — and their transitive closure.
# This comment said "only viem (the sole runtime dependency)" until 2026-09-13; the two Solana
# packages landed on protocol/main after this file was last touched, and nothing walks a
# Dockerfile, so the sentence went false with every guard green.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source (contracts/ and other heavy dirs excluded via .dockerignore).
COPY packages ./packages
COPY apps ./apps

# The per-chain configuration is runtime data, not only deploy input: the API resolves whether this
# chain meters reads over x402 from `contracts/config/<chain>.json` (packages/chain-config). Data
# only — no Solidity, no artifacts; .dockerignore re-includes exactly this subtree. Omit it and the
# lookup degrades to "x402 enabled", leaving the payment gate on for a chain that switched it off.
COPY contracts/config ./contracts/config

# The same argument, for the networks that have no EVM chain id. `config/networks/*.json` is where a
# payment network such as Solana declares whether it meters, and the resolver reads it at boot from
# the same process. Omit this line and the lookup degrades to "x402 enabled" for every one of them --
# the identical failure the paragraph above describes, on the identical code path, and just as silent.
# A review of the change that added the directory caught exactly this line missing.
COPY config ./config

# Snapshot lives on a mounted volume so indexer (writer) and API (reader) share it.
ENV STATE_PATH=/data/indexer-state.json
VOLUME /data

# Default to the API; override the command to run the indexer. `node` and not `npm run start:api`
# for the PID 1 / SIGTERM reason at the top of this file — compose overrides this CMD, but anyone
# running the image directly inherits it, and it must not teach the broken pattern.
EXPOSE 8402
CMD ["node", "apps/api/src/serve.mjs"]
