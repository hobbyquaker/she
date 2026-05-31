# GitHub Copilot Instructions

## Project Overview

**she** (smart-home-engine) is a Node.js CLI daemon (`she`) that loads user `.js` scripts into a sandboxed VM, connects to an MQTT broker, and exposes a web UI for editing scripts and browsing device state. It targets smart-home environments.

- **Binary**: `she` (npm package `she`, installs globally)
- **Entry point**: `src/index.js` (CommonJS, runs as a daemon)
- **Web frontend**: `web/` — Svelte 5 + Vite 6 + TypeScript, package `she-her`
- **Config**: `src/config.js` (yargs v17, `.parseSync()`); config.json loaded from `~/.she/config.json` by default
- **Active branch**: `main`

## Stack

| Concern | Library |
|---------|---------|
| MQTT client | mqtt v5 |
| File watching | chokidar v4 (`usePolling: true` required for WSL2/NTFS paths) |
| Scheduling | node-schedule v2 |
| Solar events | suncalc |
| Logging | pino v9 + pino-pretty v13, **no ANSI colors** (`colorize: false`), `sync: true` (same-thread stream, not worker-thread transport) |
| CLI args | yargs v17 |
| HTTP server | Express v5 |
| WebSocket | ws v8 |
| Frontend | Svelte 5 + Vite 6 + TypeScript |
| Matter | @matter/main v0.17 |
| Database | sheDB (built-in JSON document store, `src/web/shedb.js`) |
| Cache | ioredis v5 (optional Redis write-through) |
| Time series | @influxdata/influxdb-client v1 (optional) |
| Search | @elastic/elasticsearch v9 (optional) |

## Sandbox API Surface

Scripts run in a VM sandbox and receive a `she` object:

### MQTT (primary interface)
- `she.mqtt.sub(topic, [options], callback)` — subscribe; `+//` shorthand for `+/status/`
- `she.mqtt.pub(topic, payload, [options])` — publish
- `she.mqtt.get(topic)` → current value
- `she.mqtt.set(topic, val)` — publish retained value
- `she.mqtt.link(src, target, [transform])` — forward value changes
- `she.mqtt.getProp(topic, ...props)` — read state property (`val`, `ts`, `lc`)
- `she.mqtt.age(topic)` → seconds since last change
- `she.mqtt.on('connect'|'disconnect', cb)` — lifecycle events

### Universal key-based API
- `she.on(key, callback)` — subscribe; key namespaces: `mqtt::`, `var::`, `matter::`
- `she.set(key, val)` — write; supports `mqtt::` and `var::` namespaces
- `she.get(key)` → current value (any namespace)
- `she.getObject(key)` → `{ val, ts, lc }` state object

### Scheduling
- `she.schedule(pattern, [options], callback)` — cron string, Date, or suncalc event name (e.g. `'sunrise'`, `'sunset'`); options: `shift` (seconds offset), `random` (random delay in seconds)

### sheDB (document store)
- `she.db.get(id)` → document or undefined
- `she.db.set(id, doc)` — create/overwrite
- `she.db.extend(id, partial)` — deep merge
- `she.db.delete(id)`
- `she.db.prop(id, method, prop, val)` — nested property mutation (`method`: `'set'|'create'|'del'`)
- `she.db.sub(pattern, callback)` — subscribe to document changes (MQTT wildcard pattern)
- `she.db.query(filter, mapFn, [reduceFn])` → Array (ad-hoc synchronous query)

### Matter
- `she.matter.sub(nodeId, endpointId, clusterName, attrName, cb)` → listenerId
- `she.matter.unsub(listenerId)`
- `she.matter.get(nodeId, endpointId, clusterName, attrName)` → Promise\<value\>
- `she.matter.send(nodeId, endpointId, clusterName, command, [args])` → Promise\<result\>

### Stdlib helpers
- `she.link(src, target, [transform])` — shorthand for `she.mqtt.link`
- `she.combineBool(srcs[], target)` — publish OR of source values
- `she.combineMax(srcs[], target)` — publish maximum of source values
- `she.timer(src, target, ms)` — publish 1 on `target` for `ms` after `src` goes truthy
- `she.getValue(topic)` / `she.setValue(topic, val)` / `she.getProp(topic, ...props)` — legacy MQTT helpers
- `she.now()` → ms since epoch
- `she.age(topic)` → seconds since topic last changed
- `she.debug/info/warn/error(...args)` — structured logging (prefixed with script name)
- `she.global` — shared mutable object across all scripts

### Variable system
Topics prefixed with `config.variablePrefix` (default `var`) are tracked in the `var::` store namespace and published retained.

## Web UI

Built with Svelte 5 + Vite 6, served as an SPA from `dist/web/`. Build: `npm run build:web`.

Tabs (in nav order): **Scripts** → **MQTT** → **Matter** → **DB** → **Logs** → **Config**

### HTTP API (all under `/she/*`, Bearer token auth via `apiKey`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/she/scripts` | List `.js` files `[{path, size, mtime}]` |
| GET | `/she/scripts/:path` | Read file `{path, content}` |
| PUT | `/she/scripts/:path` | Write file `{content}` |
| DELETE | `/she/scripts/:path` | Delete file |
| POST | `/she/scripts/:path/rename` | Rename `{newPath}` |
| GET | `/she/db/docs` | List document IDs |
| GET | `/she/db/docs/:id` | Get document |
| PUT | `/she/db/docs/:id` | Create/overwrite document |
| PATCH | `/she/db/docs/:id` | Deep-merge document |
| DELETE | `/she/db/docs/:id` | Delete document |
| GET | `/she/db/views` | List view IDs |
| GET | `/she/db/views/:id` | Get view definition |
| PUT | `/she/db/views/:id` | Create/update view |
| DELETE | `/she/db/views/:id` | Delete view |
| GET | `/she/db/views/:id/result` | Execute view, return results |
| GET | `/she/mqtt/state` | Sorted `[{topic, val, ts}]` of all known MQTT topics |
| POST | `/she/mqtt/publish` | Publish `{topic, payload, retain?, qos?}` |
| GET | `/she/matter/devices` | List paired Matter nodes |
| POST | `/she/matter/commission` | Commission `{passcode, discriminator?}` or `{pairingCode}` |
| GET | `/she/matter/devices/:nodeId` | Node detail |
| DELETE | `/she/matter/devices/:nodeId` | Unpair node |
| POST | `/she/matter/devices/:nodeId/command` | Invoke command `{endpointId, clusterName, command, args?}` |
| GET | `/she/config` | Read `config.json` |
| PUT | `/she/config` | Write `config.json` |

### WebSocket `ws://host/she/ws`
Optional auth via `?token=<apiKey>` query param.

Server → client message types:
- `{type:'log', level, msg, ts}` — live log line
- `{type:'ping'}` — keepalive
- `{type:'mqtt', topic, val, ts}` — MQTT state change
- `{type:'db:ids', ids}` — document ID list update
- `{type:'db:change', id, doc}` — document created/updated/deleted

## Testing

- Framework: **Jest 29** (`testTimeout: 180000`, `forceExit: true`)
- Unit tests: `test/unit/` — run with `npm test`
- Integration tests: `test/integration/` — run with `npm run test:integration`
- In-process MQTT broker: **aedes 0.50** on a random port (`:0`)
- Fake time: **@sinonjs/fake-timers v11** — fakes only `Date`, `shouldAdvanceTime: true`
- The daemon is spawned as a child process via `child_process.spawn`; stdout consumed line-by-line with `readline`

## Code Conventions

- **ESLint**: flat config in `eslint.config.mjs` (v9)
- **Prettier**: v3, config in `prettier.config.js`
- Format before committing: `npm run format`
- Lint: `npm run lint`
- Only `.js` scripts are loaded — CoffeeScript support has been removed

## Important Constraints

- **No ANSI colors** in log output — `colorize: false` in pino-pretty
- **Preserve full stack traces** in domain error handler
- **chokidar v4** (not v5) — v5 is ESM-only; this project uses CJS `require()`
- **`usePolling: true`** in all `chokidar.watch()` calls — required for WSL2 NTFS paths
- pino must use **same-thread sync stream** (`PinoPretty({ sync: true })`), not the worker-thread transport, so the last log line before `process.exit(0)` is not lost

## Versioning Policy

- Use **semantic versioning** (`MAJOR.MINOR.PATCH`), major stays at `0` for now
- **Patch** (`0.x.y+1`): bug fixes, minor non-breaking changes
- **Minor** (`0.x+1.0`): new features
- **Keep `she` (root `package.json`) and `she-her` (`web/package.json`) versions in sync**
- **After bumping** the version: create a git tag for the new version (`git tag v{new}`, `git push origin v{new}`)
