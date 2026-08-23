# syntax=docker/dockerfile:1

# ── Frontend build ────────────────────────────────────────────────────────────
# Pinned to the builder's own architecture: bundling the web UI (vite + monaco) is
# the slow part of this image and its output is plain JS, so emulating the target
# CPU for it would cost minutes per architecture and buy nothing.
FROM --platform=$BUILDPLATFORM node:24-slim AS webbuilder

WORKDIR /app

# install all dependencies (including devDeps for the web build)
COPY package*.json ./
RUN npm ci

COPY web/package*.json ./web/
RUN cd web && npm ci

COPY . .
RUN npm run build:web

# ── Runtime dependencies ──────────────────────────────────────────────────────
# Built for the *target* architecture. Every dependency is pure JS today, but a
# native addon appearing later must not silently ship the wrong binary.
FROM node:24-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Final image ───────────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=webbuilder /app/dist ./dist
COPY src ./src

ENV SHE_DATA_DIR=/var/lib/she
VOLUME /var/lib/she

EXPOSE 8080

# GET /she/health is public and answers 503 while the daemon is still starting or
# a configured MQTT broker is disconnected. Override with --health-cmd when the
# container runs she on a port other than 8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/she/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "src/index.js"]
