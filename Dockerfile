FROM node:24-slim AS builder

WORKDIR /app

# install all dependencies (including devDeps for the web build)
COPY package*.json ./
RUN npm ci

COPY web/package*.json ./web/
RUN cd web && npm ci

COPY . .
RUN npm run build:web

# strip dev deps
RUN npm ci --omit=dev

# ---------------------------------------------------------

FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/dist ./dist

ENV SHE_DATA_DIR=/var/lib/she
VOLUME /var/lib/she

EXPOSE 8080
ENTRYPOINT ["node", "src/index.js"]
