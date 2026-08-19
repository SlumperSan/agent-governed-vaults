# Single image for all three runtime processes (indexer + API + canary). Pick which to run via
# the compose service command or a `docker run` override. All three are non-custodial: no keys,
# no fund movement. The canary is additionally read-only against the chain — it never sends.
#
#   docker build -t vault-runtime .
#   docker run --env-file .env vault-runtime npm run start:indexer
#   docker run --env-file .env -p 8402:8402 vault-runtime npm run start:api
#   docker run --env-file .env vault-runtime npm run start:canary
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

# Default to the API; override the command to run the indexer.
EXPOSE 8402
CMD ["npm", "run", "start:api"]
