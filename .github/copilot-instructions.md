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
| Logging | pino v9 + pino-pretty v13, `colorize: true`, `sync: true` (same-thread stream, not worker-thread transport) |
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
- `she.mqtt.sub(topic, [options], callback)` — subscribe
- `she.mqtt.pub(topic, payload, [options])` — publish
- `she.mqtt.get(topic)` → current value
- `she.mqtt.link(src, target, [transform])` — forward value changes
- `she.mqtt.getProp(topic, ...props)` — read state property (`val`, `ts`, `lc`)
- `she.mqtt.age(topic)` → seconds since last change

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
- `she.mqtt.link(src, target, [transform])` — forward value changes; `target` is topic string or array
- `she.mqtt.or(srcs[], topicOrCb)` — publish 1 if any source truthy, else 0
- `she.mqtt.and(srcs[], topicOrCb)` — publish 1 if all sources truthy, else 0
- `she.mqtt.max(srcs[], topicOrCb)` — publish maximum of source values
- `she.mqtt.min(srcs[], topicOrCb)` — publish minimum of source values (0 if no values)
- `she.mqtt.timer(src, ms, topicOrCb)` — publish 1 for `ms` after `src` goes truthy, then 0
- All `topicOrCb` params accept a topic string or `callback(topic, val)`
- `she.getValue(topic)` / `she.setValue(topic, val)` / `she.getProp(topic, ...props)` — legacy MQTT helpers
- `she.now()` → ms since epoch
- `she.debug/info/warn/error(...args)` — structured logging (prefixed with script name)
- `she.global` — shared mutable object across all scripts
- `she.http.fetch(url, [opts])` → Promise — HTTP/HTTPS fetch; auto-parses JSON by Content-Type; throws on non-OK status
- `she.http.sub(path, callback)` — register a POST webhook at `/api/<scriptName><path>`; `callback(body, { params, query, headers })`
- `she.config.latitude` / `she.config.longitude` — read-only geographic coordinates from daemon config (frozen object)

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
| GET | `/she/status` | Runtime counters `{ scripts, topics }` |
| POST | `/she/restart` | Graceful restart (exits 0) |

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
- Only `.js` scripts are **executed** by the daemon — CoffeeScript support has been removed
- The web UI / HTTP API supports editing **any** file type (markdown, yaml, json, shell, etc.)

## Important Constraints

- **Preserve full stack traces** in domain error handler
- **chokidar v4** (not v5) — v5 is ESM-only; this project uses CJS `require()`
- **`usePolling: true`** in all `chokidar.watch()` calls — required for WSL2 NTFS paths
- pino must use **same-thread sync stream** (`PinoPretty({ sync: true })`), not the worker-thread transport, so the last log line before `process.exit(0)` is not lost

## Versioning Policy

- Use **semantic versioning** (`MAJOR.MINOR.PATCH`)
- **Patch** (`x.y.Z+1`): bug fixes, minor non-breaking changes
- **Minor** (`x.Y+1.0`): new features
- **Major** (`X+1.0.0`): only when introducing a breaking change that has no automatic migration strategy
- **Keep `she` (root `package.json`) and `she-her` (`web/package.json`) versions in sync**
- **After bumping** the version: create a git tag for the new version (`git tag v{new}`, `git push origin v{new}`)

## Broker Management — Mosquitto & Dynamic Security

### Reference documentation
- **Dynamic Security plugin**: https://mosquitto.org/documentation/dynamic-security/
- **mosquitto.conf(5)**: https://mosquitto.org/man/mosquitto-conf-5.html
- **mosquitto_ctrl(1)**: https://mosquitto.org/man/mosquitto_ctrl-1.html

### Key architecture facts

**Two separate MQTT connections in the daemon**
- **Main client** (`src/index.js`): uses `config.url` credentials; subscribes to `#` and `$SYS/#`; drives all script callbacks and the state store.
- **Dynsec client** (`src/lib/dynsec.js`): dedicated connection using `config.broker.dynsec.{adminUsername,adminPassword}`; serialises all `$CONTROL/dynamic-security/v1` commands through a single-inflight queue.

**Dynsec topic protocol**
- Commands are published to `$CONTROL/dynamic-security/v1` as `{ commands: [{ command, ...payload }] }`.
- Responses arrive on `$CONTROL/dynamic-security/v1/response` as `{ responses: [{ command, data: { ... } }] }`.
- **Critical**: list/get responses wrap their payload in a `data` field — e.g. `listClients` returns `{ command, data: { clients: [...], totalCount: N } }`. Accessing `r.clients` directly returns `undefined`; the correct path is `r.data?.clients`.
- Simple mutating commands (`createClient`, `deleteClient`, etc.) return `{ command }` on success or `{ command, error: "..." }` on failure — no `data` wrapper.

**Default ACLs after `mosquitto_ctrl dynsec init`**
- `publishClientSend`: **deny** — clients cannot publish unless explicitly allowed by a role ACL.
- `publishClientReceive`: **allow** — clients receive matching messages by default.
- `subscribe`: **deny** — clients cannot subscribe unless explicitly allowed.
- `unsubscribe`: **allow**
- Consequence: the main she MQTT client (if it lacks a dynsec role) cannot publish the retained-state sentinel → sentinel times out; and `$SYS/#` messages are never delivered even though the subscription appears to succeed.

**Admin role ACLs (created by `mosquitto_ctrl init`)**
The `admin` role grants:
- `publishClientSend` + `publishClientReceive` + `subscribePattern` for `$CONTROL/dynamic-security/#`
- `publishClientReceive` + `subscribePattern` for `$SYS/#`
- `publishClientReceive` + `subscribePattern` + `unsubscribePattern` for `#`
- The admin user intentionally has **no `publishClientSend` for `#`** — it cannot publish to normal topics. Keep the admin user purely for plugin administration.

**$SYS data in the broker status endpoint**
Because the main client may lack subscribe ACLs, the dynsec client subscribes to `$SYS/#` on connect (admin role allows it) and caches values in `_sysData`. `GET /she/broker/status` reads from `dynsec.getSysData()` first, with the main client's state store as fallback when dynsec is not configured.

**`mosquitto_ctrl init` behaviour**
- Refuses to overwrite an existing `dynamic-security.json` — exits 0 but writes a warning to stderr: _"Unable to open '…' for writing (File exists)"_. Always `sudo rm -f` the file before running init to guarantee fresh credentials.
- Creates the file owned by the calling user (e.g. the SSH user), not by the `mosquitto` system user. Follow init immediately with `sudo chown mosquitto:mosquitto` and `sudo chmod 644` so mosquitto can read it.

**mosquitto.conf plugin keys**
- Correct key: `plugin_opt_config_file` (not `plugin_opt_dynsec_config_file`).
- `plugin` line must point to the full `.so` path, e.g. `/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so`.
- Use `per_listener_settings false` so all listeners share the same auth plugin.

**`mosquitto_ctrl` exits 0 on silent failure** — always verify the `dynamic-security.json` file contents after init rather than relying solely on the exit code.
