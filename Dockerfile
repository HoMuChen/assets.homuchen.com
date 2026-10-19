# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Taipei \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN mkdir -p /data && chown node:node /data
# The SinoPac sidecar (sinopac/server.py) runs from this same image with its own command; see infra/compose.prod.yml.
# shioaji ships an abi3 manylinux wheel with no dependencies, so Debian's python3 is enough.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/sinopac && /opt/sinopac/bin/pip install --no-cache-dir shioaji==1.7.8
COPY --chown=node:node sinopac/server.py ./sinopac/server.py
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# infra/deploy/deploy.sh extracts the compose file from the image it is about to run
COPY --chown=node:node infra/compose.prod.yml ./infra/compose.prod.yml
USER node
VOLUME ["/data"]
EXPOSE 3000
# Last, so a new commit does not invalidate earlier layers; reported by /api/health
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
CMD ["node", "server.js"]
