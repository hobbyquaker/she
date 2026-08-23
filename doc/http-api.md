# HTTP API

The HTTP server is always started. Control the port with `--port <n>` (default `8080`).  
Use `--port 0` to let the OS assign a free port — the actual port is logged at startup:

```
INFO: http server listening on :8080
```

The built-in web UI is served from the same port as an SPA (Single-Page Application).

---

## URL scheme

| Prefix | Purpose |
|---|---|
| `/she/*` | System endpoints: scripts, MQTT, Matter, DB, config, WebSocket |

---

## Authentication

she supports three authentication modes, configured via `auth` in `config.json` (or `--auth` on the CLI):

| Mode | Description |
|------|-------------|
| `none` | No authentication — all `/she/*` endpoints are open. **Default.** Suitable for a private LAN. |
| `password` | Single-user login. A hashed password is stored in `config.json`. The web UI shows a login form; successful login sets an HttpOnly session cookie valid for 7 days. |
| `proxy` | Trust an HTTP header set by an upstream reverse proxy (e.g. nginx + authentik). The header name defaults to `X-Remote-User` and is configurable via `proxyHeader`. |

**Important:** Routes under `/api/*` (user-script endpoints) are intentionally **not** covered by she-level auth — scripts are responsible for their own access control on those paths.

### Auth endpoints (always public)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/she/auth/mode` | Returns `{ "mode": "none" \| "password" \| "proxy" }` |
| `POST` | `/she/auth/login` | `{ "password": "..." }` — sets `she_session` cookie on success |
| `POST` | `/she/auth/logout` | Clears the session cookie |
| `POST` | `/she/auth/setup` | Change auth mode / password / proxyHeader at runtime (see Config tab in web UI) |

### Setting up password mode

Use the **Config → Authentication** section in the web UI to set a password and switch to `password` mode. Changes take effect immediately without a restart.

Alternatively, set the hashed password in `config.json` directly:

```bash
node -e "const b=require('bcryptjs');console.log(b.hashSync('my-password',10))" 
```

Then in `config.json`:

```json
{
  "auth": "password",
  "password": "$2a$10$..."
}
```

### Setting up proxy mode

Configure nginx (or another proxy) to authenticate requests and forward the username in a header. Set she to bind on `127.0.0.1` so only the proxy can reach it:

```json
{
  "auth": "proxy",
  "proxyHeader": "X-Remote-User",
  "bindAddress": "127.0.0.1"
}
```

See [nginx.conf](nginx.conf) for a full example with TLS and authentik forward auth.

### Unauthorized response

```
HTTP 401
{ "error": "Unauthorized" }
```

---

## Scripts — `/she/scripts`

### GET /she/scripts

List all files in the script directory, recursively. Includes `.js` scripts and any other stored files (markdown, yaml, json, etc.).

**Response (HTTP 200):**

```json
[
  { "path": "lights.js", "size": 512, "mtime": 1718000000000 },
  { "path": "lib/utils.js", "size": 128, "mtime": 1718000000000 }
]
```

### GET /she/scripts/:path

Read a script file.

**Response (HTTP 200):**

```json
{ "path": "lights.js", "content": "she.log('hello');" }
```

### PUT /she/scripts/:path

Create or overwrite a file. Any file extension is accepted. The daemon only auto-loads `.js` files; other file types are stored for manual use.

**Request body:**

```json
{ "content": "she.log('updated');" }
```

**Response (HTTP 200):**

```json
{ "ok": true, "path": "lights.js", "size": 20, "mtime": 1718000000000 }
```

### DELETE /she/scripts/:path

Delete a script file.

**Response (HTTP 200):** `{ "ok": true }`

### POST /she/scripts/:path/rename

Rename or move a script file within the script directory.

**Request body:**

```json
{ "newPath": "archive/lights.js" }
```

**Response (HTTP 200):** `{ "ok": true, "path": "archive/lights.js" }`

---

## MQTT — `/she/mqtt`

### GET /she/mqtt/state

Returns all known MQTT topic states, sorted alphabetically.

**Response (HTTP 200):**

```json
[
  { "topic": "home/light/hall", "val": 1, "ts": 1718000000000 },
  { "topic": "home/sensor/temp", "val": 21.5, "ts": 1718000000000 }
]
```

### POST /she/mqtt/publish

Publish a message to the MQTT broker.

**Request body:**

```json
{ "topic": "home/light/hall", "payload": "1", "retain": false, "qos": 0 }
```

`retain` and `qos` are optional (default `false` and `0`).

**Response (HTTP 200):** `{ "ok": true }`

### GET /she/mqtt/ha-discovery

Analyse the retained Home Assistant MQTT discovery announcements (`<prefix>/<component>/[<node_id>/]<object_id>/config`, plus the device-level `<prefix>/device/<id>/config` format) and group them by device. Query parameter `prefix` (default `homeassistant`) selects the discovery prefix; wildcards are rejected.

**Response (HTTP 200):**

```json
{
  "prefix": "homeassistant",
  "entityCount": 2,
  "devices": [
    {
      "id": "zigbee2mqtt_0x00124b001f8e2a11",
      "name": "Kitchen Lamp",
      "manufacturer": "IKEA", "model": "LED1545G12",
      "identifiers": ["zigbee2mqtt_0x00124b001f8e2a11"],
      "entities": [ { "component": "light", "objectId": "light", "name": "Kitchen Lamp", "uniqueId": "…", "configTopic": "homeassistant/light/0x00124b001f8e2a11/light/config", "ts": 1700000000000, "topics": ["zigbee2mqtt/kitchen_lamp", "zigbee2mqtt/kitchen_lamp/set"] } ],
      "configTopics": ["homeassistant/light/0x00124b001f8e2a11/light/config"],
      "refTopics": ["zigbee2mqtt/bridge/state", "zigbee2mqtt/kitchen_lamp", "zigbee2mqtt/kitchen_lamp/set"],
      "statePrefixes": ["zigbee2mqtt/kitchen_lamp"],
      "stateTopics": ["zigbee2mqtt/kitchen_lamp", "zigbee2mqtt/kitchen_lamp/availability"],
      "orphaned": false,
      "duplicate": false,
      "lastSeen": 1700000000000,
      "configTs": 1700000000000
    }
  ]
}
```

- `stateTopics` — retained topics that can be wiped together with the device: the device's own state/command topics plus everything below its derived topic prefix(es). Availability topics and any topic or prefix referenced by more than one device (e.g. `zigbee2mqtt/bridge/state`) are never included; prefixes must have at least two segments.
- `orphaned` — none of the device's own state/command topics exist in the retained state any more.
- `duplicate` — another announced device has the same name (typical after a `*2mqtt` base-topic change).

### DELETE /she/mqtt/ha-discovery

Clear retained messages by publishing an empty retained payload to every listed topic (used by the *HA Discovery* view of the MQTT page).

**Request body:** `{ "topics": ["homeassistant/light/0x…/light/config", "zigbee2mqtt/kitchen_lamp"] }` — topics must not contain wildcards.

**Response (HTTP 200):** `{ "ok": true, "cleared": 2, "errors": [] }` — `errors` lists `{ topic, error }` for topics whose publish failed; HTTP 503 when not connected to a broker.

---

## sheDB — `/she/db`

sheDB must be enabled via `--db-path`. All endpoints return HTTP 503 if sheDB is not initialised.

Document IDs may contain slashes (MQTT-topic style, e.g. `devices/kitchen/light`).

### GET /she/db/docs

List all document IDs.

**Response (HTTP 200):** `["devices/hall/pir", "devices/kitchen/light"]`

### GET /she/db/docs/:id

Get a document.

**Response (HTTP 200):** `{ "name": "Hall PIR", "location": "hall" }`

### PUT /she/db/docs/:id

Create or overwrite a document (full replace).

**Request body:** any JSON object  
**Response (HTTP 200):** `{ "ok": true }`

### PATCH /she/db/docs/:id

Deep-merge a partial update into an existing document.

**Request body:** partial JSON object  
**Response (HTTP 200):** `{ "ok": true }`

### DELETE /she/db/docs/:id

Delete a document.

**Response (HTTP 200):** `{ "ok": true }`

### GET /she/db/views

List all view IDs.

**Response (HTTP 200):** `["by-location", "by-type"]`

### GET /she/db/views/:id

Get a view definition.

**Response (HTTP 200):**

```json
{
  "filter": "devices/#",
  "map": "function(doc, emit) { emit({ name: doc.name }); }",
  "reduce": null
}
```

### PUT /she/db/views/:id

Create or update a view.

**Request body:**

```json
{
  "filter": "devices/#",
  "map": "function(doc, emit) { emit({ name: doc.name }); }"
}
```

**Response (HTTP 200):** `{ "ok": true }`

### DELETE /she/db/views/:id

Delete a view.

**Response (HTTP 200):** `{ "ok": true }`

### GET /she/db/views/:id/result

Execute a view and return its results.

**Response (HTTP 200):** `[{ "name": "Hall PIR" }, { "name": "Kitchen Light" }]`

---

## Matter — `/she/matter`

Matter must be enabled via `--matter-storage`. All endpoints return HTTP 503 if the Matter controller is not initialised.

### GET /she/matter/devices

List all paired Matter nodes.

**Response (HTTP 200):**

```json
[
  { "nodeId": "1", "name": "Bulb A" }
]
```

### POST /she/matter/commission

Commission a new Matter device.

**Request body (manual code):**

```json
{ "passcode": 20202021, "discriminator": 3840 }
```

**Request body (QR pairing code):**

```json
{ "pairingCode": "MT:Y.K9042C00KA0648G00" }
```

**Response (HTTP 200):** `{ "nodeId": "2" }`

### GET /she/matter/devices/:nodeId

Get details for a paired node.

**Response (HTTP 200):**

```json
{ "nodeId": "1", "name": "Bulb A", "endpoints": [...] }
```

### DELETE /she/matter/devices/:nodeId

Unpair a Matter device.

**Response (HTTP 200):** `{ "ok": true }`

### POST /she/matter/devices/:nodeId/rename

Rename a device by writing `basicInformation.nodeLabel` (the Matter-standard writable user label, max 32 characters) on the device. she prefers `nodeLabel` over `productName` wherever device names are shown or matched, so scripts can address the node by the new name (or, as always, by node id).

**Request body:**

```json
{ "name": "Hexagon Panels" }
```

**Response (HTTP 200):** `{ "ok": true }`

### POST /she/matter/devices/:nodeId/command

Invoke a cluster command on a device endpoint.

**Request body:**

```json
{
  "endpointId": 1,
  "clusterName": "onOff",
  "command": "toggle",
  "args": {}
}
```

**Response (HTTP 200):** `{ "result": null }`

---

## Config — `/she/config`

### GET /she/config

Returns the currently active config file as JSON. Returns `{}` if no config file exists yet.

**Response (HTTP 200):**

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "name": "logic",
  "port": 8080
}
```

### PUT /she/config

Writes a new config file. All CLI option keys are accepted (camelCase).

**Request body (JSON):**

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "verbosity": "debug",
  "port": 8080,
  "auth": "none"
}
```

**Response (HTTP 200):**

```json
{ "ok": true, "restartRequired": true, "configPath": "/home/user/.she/config.json" }
```

A daemon restart is required for the new config to take effect.

---

## Daemon — `/she/status`, `/she/restart`

### GET /she/status

Returns a snapshot of runtime counters.

**Response (HTTP 200):**

```json
{ "scripts": 3, "topics": 142 }
```

| Field | Description |
|-------|-------------|
| `scripts` | Number of user scripts currently loaded |
| `topics` | Number of MQTT topics tracked in the state store |

### POST /she/restart

Sends a graceful shutdown signal. The process exits with code 0 so the process manager (systemd, Docker restart policy, etc.) restarts it automatically.

**Response (HTTP 200):**

```json
{ "ok": true }
```

The connection will drop immediately after the response. The daemon is typically back within a second or two.

---

## Services — `/she/services`

Management of xyz2mqtt adapter instances (see [services.md](services.md)). Available whether or not `services.enabled` is set; the flag only controls the page. Host routes go through the `she-servicectl` helper — locally via `sudo`, on remote hosts via `ssh` — and answer **503** `{ code: "HELPER_MISSING" }` when it is not installed, **403** `{ code: "SUDO_DENIED" }` when sudoers does not allow it, **400** `{ code: "HELPER_FAILED" }` when the helper rejected the arguments, **502** `{ code: "SSH_FAILED" }` when the SSH connection fails. Instance names are `[A-Za-z0-9_.-]+`, adapter names lower-case npm names.

### GET /she/services/instances

Inventory derived from the retained `<name>/info` and `<name>/connected` topics, one entry per instance, sorted by name; `legacy` rows have only a `connected` topic. `latestVersion`/`updateAvailable` come from the npm registry (cached 24 h, `null` when unknown).

```json
{
  "enabled": true, "coreCount": 1, "legacyCount": 0,
  "instances": [ { "instance": "cul", "legacy": false, "adapter": "cul2mqtt", "version": "1.1.1", "spec": "2.0", "host": "zigbee", "node": "v22.12.0", "pid": 1234, "started": 1700000000000, "uptime": 5400000, "maintenance": true, "connected": 2, "connectedTs": 1700000000000, "connectedLc": 1700000000000, "infoTs": 1700000000000, "statusTopics": 12, "info": { "…": "…" }, "latestVersion": "1.2.0", "updateAvailable": true } ]
}
```

### POST /she/services/instances/:name/restart · POST /she/services/instances/:name/loglevel

Publish to `<name>/maintenance/set/restart` / `…/loglevel` (body `{ "level": "error" | "warn" | "info" | "debug" }`). **409** for legacy instances and instances running with `--no-maintenance`, **404** unknown instance, **503** without MQTT.

### GET /she/services/instances/:name/retained · DELETE /she/services/instances/:name/retained

What a wipe would clear — `{ "own": ["cul/connected", "cul/info", "cul/status/…"], "discovery": ["homeassistant/device/cul2mqtt_cul/config"] }` — and the wipe itself (empty retained publishes; body `{ "discovery": false }` keeps the HA announcements; `haPrefix` selects a non-default discovery prefix). **409** while the instance is connected.

### GET /she/services/hosts

Every configured host (`services.hosts`, default the she host as `local`) with the helper's `list`: `{ "hosts": [ { "name": "local", "local": true, "ok": true, "hostname": "zigbee", "helper": 1, "helperOutdated": false, "node": "v22.12.0", "brokerEnv": true, "adapters": [ { "name": "cul2mqtt", "version": "1.1.1", "origin": "registry" | "manual", "path": "/usr/local/lib/node_modules/cul2mqtt", "node": "/usr/bin/node" } ], "instances": [ { "adapter": "cul2mqtt", "instance": "cul", "active": "active", "sub": "running", "unitFile": "enabled", "since": "…", "restarts": 0 } ] } ] }`; unreachable hosts carry `ok: false, code, error`. `legacy` lists pre-core single-instance units (`{ adapter, unit, active, sub, unitFile, since, restarts, envFile }`); the unit, logs and env routes accept `-` as `:instance` for them. A remote entry without `name` is addressed by its ssh host. Cached for a minute; `?refresh=1` asks every host again.

### Host routes

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/she/services/hosts/:host/adapters/:adapter/schema` | `?refresh=1` | `{ schema, secrets, envPrefix, sheBroker, dynsec: { available } }` — the adapter's `--config-schema` (cached 10 min), the env variable names to mask, she's broker settings as the host would need them (`{ url, username, hasPassword }`), whether dynsec identities can be created |
| POST | `/she/services/hosts/:host/adapters/:adapter/install` | `{ instance, env: { "<ADAPTER>_X": "…" }, brokerMode?, acl? }` | `<adapter> --install --name <instance>` with the options as environment; `brokerMode` `own` (default) \| `she` (she's broker URL/username/password + `SHE_USE_BROKER=1`) \| `dynsec` (creates client + role `svc-<instance>`, default or given `acl`, writes the credentials + `SHE_DYNSEC_CLIENT`); `{ ok, output }` |
| POST | `/she/services/hosts/:host/adapters/:adapter/update` | `{ force? }` | `npm install -g <adapter>@latest`, then restarts the adapter's active instances; **409** `{ code: "MANUAL_DEPLOY" }` for manually deployed adapters unless `force` |
| POST | `/she/services/hosts/:host/units/:adapter/:instance/:action` | action `start|stop|restart|enable|disable` | `systemctl <action> <adapter>@<instance>` |
| DELETE | `/she/services/hosts/:host/units/:adapter/:instance` | | `<adapter> --uninstall --name <instance>`; a dynsec identity the instance had is deleted too (`dynsecRemoved`). **400** for the legacy sentinel |
| POST | `/she/services/hosts/:host/units/:adapter/-/migrate` | `{ name }` | legacy `<adapter>.service` → `<adapter>@<name>` (the adapter's own `--install` with the old env, old unit disabled and kept as `.migrated`) |
| GET | `/she/services/hosts/:host/units/:adapter/:instance/logs` | `?n=200` | `{ entries: [ { ts, level, msg, pid } ] }` from `journalctl -o json` |
| POST / DELETE | `/she/services/hosts/:host/units/:adapter/:instance/logs/follow` | | start/renew (expires after 10 min without renewal) / stop a journal follower; lines arrive on the WebSocket as `serviceLog` |
| GET | `/she/services/hosts/:host/units/:adapter/:instance/env` | | `{ env, secrets, schema, envPrefix, brokerMode, sheBroker, dynsec: { available, client, acl } }` — the env file with secrets masked as `***`, the current broker credentials mode and what a dynsec identity would look like |
| PUT | `/she/services/hosts/:host/units/:adapter/:instance/env` | `{ env, restart?, brokerMode?, acl?, rotate? }` | writes the env file (`***` keeps the stored secret, empty removes a variable). `brokerMode` (default: the stored one): `own` leaves the values; `she` overwrites the prefixed MQTT URL/username/password with she's; `dynsec` creates the identity on first use (or when `rotate`), else keeps it — leaving `dynsec` deletes client and role. **400** when dynsec is not available. Optional restart |
| GET / PUT | `/she/services/hosts/:host/broker-env` | `{ env }` | `/etc/mqtt-interfaces/broker.env` (core convention, not used by the UI), same masking rules |
| GET | `/she/services/hosts/:host/units/:adapter/:instance/files` | | `{ options: [{ key, envName, path, managed, editable, declared, format, example, schema, describe, exists }], files: [{ path, kind, size, mtime, format, editable }], dirs }` — file options (`x-file` or guessed) and the listing of `/etc/<adapter>/` + `/var/lib/<adapter>/<instance>/` |
| GET / PUT | `/she/services/hosts/:host/units/:adapter/:instance/file` | `?path=` · `{ path, content, restart? }` | read / write a file inside those two directories (**400** elsewhere, for `..`, or for the env file); write keeps a `.bak`; max 2 MB |
| POST | `/she/services/hosts/:host/units/:adapter/:instance/file/create` | `{ option, path? }` | create the option's file (from the adapter's example when it ships one, else empty) at `path` or `/etc/<adapter>/<instance>.<option>.<ext>`, and set the option to it |
| GET | `/she/services/hosts/:host/adapters/:adapter/asset` | `?path=` | a file shipped in the adapter package (example, JSON schema); relative path, no `..` |
| GET | `/she/services/catalog` | `?refresh=1` | `{ packages: [{ name, version, coreRange, publisher, description, homepage, repository, mqttInterfaces, maintainers, published }], publishers, errors, fetchedAt, cached, stale? }` — the trusted publishers' npm packages whose latest version depends on `mqtt-interfaces-core` (registry search + packuments, cached 24 h) |
| POST | `/she/services/hosts/:host/adapters/:adapter/install-package` | | `npm install -g <adapter>@latest` on the host; **403** `{ code: "NOT_IN_CATALOG" }` for anything that is not a catalog member |
| POST | `/she/services/ssh/test` | `{ host, port?, user?, identityFile? }` | test unsaved host settings: always 200 with `{ ok, helper }` or `{ ok: false, code, error }` |
| POST | `/she/services/setup/token` | `{ origin }` | mint a one-time remote-host bootstrap: `{ token, command, scriptUrl, sha256, expires, user }` (valid 15 min) |
| GET | `/she/services/setup/token/:token` | | `{ status: "pending" \| "fetched" \| "done" \| "expired", host? }` |
| GET | `/she/services/setup.sh?token=…` | **no auth** | the generated POSIX bootstrap script, served once; 410 afterwards |
| POST | `/she/services/setup/done?token=…` | **no auth**, `{ hostname, user }` | callback from the script: adds `{ hostname, ssh: { host: <caller address>, user: "she-services" } }` to `services.hosts` (or updates an existing entry); single use |
| POST | `/she/services/hosts/:host/test` | | always 200: `{ ok: true, helper }` or `{ ok: false, code, error }` |
| POST | `/she/services/hosts/:host/helper/deploy` | | remote hosts only: scp the shipped helper, try `sudo -n install`; `{ ok, uploaded, installed, sudoers, helper?, code?, instructions?, user }` — `instructions` are the commands an admin runs when sudo refused |
| POST | `/she/services/hosts/:host/helper/remove` | `{ mode: "key" \| "all", force? }` | remove she from the host: `key` = only this she's public key leaves the SSH user's `authorized_keys`; `all` = key, sudoers rule, helper and the `she-services` user (`{ ok: false, code: "OTHER_KEYS" }` while other keys remain, unless `force`); adapters and instances stay. On success the host entry is removed from config.json: `{ ok, mode, output, removedHost }` |
| GET / POST | `/she/services/ssh/pubkey` · `/she/services/ssh/keygen` | | the services SSH identity (`<data-dir>/ssh/services_id_ed25519`): read the public key / generate the keypair |

---

## WebSocket — `ws://host/she/ws`

Connect to the WebSocket endpoint for a live stream of logs, MQTT state changes, and sheDB events.

In `password` mode the WebSocket connection is authenticated via the same session cookie the browser sends automatically. No extra token parameter is needed.

### Messages from server

All messages are JSON.

| `type` | Fields | Description |
|--------|--------|-------------|
| `ping` | — | Keepalive; no reply needed |
| `log` | `level`, `msg`, `ts` | Structured log line from the daemon |
| `mqtt` | `topic`, `val`, `ts` | MQTT topic state changed |
| `db:ids` | `ids` | Full list of sheDB document IDs (sent on connect and on any change) |
| `db:change` | `id`, `doc` | A sheDB document was created, updated, or deleted (`doc` is `null` on delete) |
| `serviceLog` | `host`, `unit`, `level`, `msg`, `ts`, `pid` | Journal line of an adapter instance while a follower is active (`POST …/logs/follow`, see Services) |

### Example

```js
const ws = new WebSocket('ws://localhost:8080/she/ws');
ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'mqtt') console.log(msg.topic, '->', msg.val);
    if (msg.type === 'log')  console.log('[' + msg.level + ']', msg.msg);
};
```

---

## curl examples

```bash
# List scripts
curl http://localhost:8080/she/scripts

# Read a script
curl http://localhost:8080/she/scripts/lights.js

# Write a script
curl -X PUT -H "Content-Type: application/json" \
     -d '{"content":"she.log(\"hello\");"}' \
     http://localhost:8080/she/scripts/hello.js

# Get MQTT state
curl http://localhost:8080/she/mqtt/state

# Publish MQTT message
curl -X POST -H "Content-Type: application/json" \
     -d '{"topic":"home/light/hall","payload":"1","retain":true}' \
     http://localhost:8080/she/mqtt/publish

# List sheDB documents
curl http://localhost:8080/she/db/docs

# Read a document
curl http://localhost:8080/she/db/docs/devices/hall/pir

# List paired Matter devices
curl http://localhost:8080/she/matter/devices

# Read config (no auth / none mode)
curl http://localhost:8080/she/config

# Write config
curl -X PUT -H "Content-Type: application/json" \
     -d '{"url":"mqtt://newbroker","dir":"/opt/scripts"}' \
     http://localhost:8080/she/config

# Login and keep the session cookie
curl -c cookies.txt -X POST -H "Content-Type: application/json" \
     -d '{"password":"my-password"}' \
     http://localhost:8080/she/auth/login

# Use the session cookie for subsequent requests
curl -b cookies.txt http://localhost:8080/she/scripts
```

