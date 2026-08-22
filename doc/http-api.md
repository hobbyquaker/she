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

