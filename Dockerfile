# Single image for all three runtime processes (indexer + API + canary). Pick which to run via
# the compose service command or a `docker run` override. All three are non-custodial: no keys,
# no fund movement. The canary is additionally read-only against the chain — it never sends.
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

# Install runtime deps first for layer caching. No lockfile in this repo, so `npm install`
# (not `npm ci`). --omit=dev pulls only viem (the sole runtime dependency).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source (contracts/ and other heavy dirs excluded via .dockerignore).
COPY packages ./packages
COPY apps ./apps

# Snapshot lives on a mounted volume so indexer (writer) and API (reader) share it.
ENV STATE_PATH=/data/indexer-state.json
VOLUME /data

# Default to the API; override the command to run the indexer. `node` and not `npm run start:api`
# for the PID 1 / SIGTERM reason at the top of this file — compose overrides this CMD, but anyone
# running the image directly inherits it, and it must not teach the broken pattern.
EXPOSE 8402
CMD ["node", "apps/api/src/serve.mjs"]
