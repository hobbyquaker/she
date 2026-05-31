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

Set `--api-key <token>` (or `SHE_API_KEY`) to require a Bearer token on **all** requests to `/she/*`.

**Request header:**

```
Authorization: Bearer <token>
```

Requests without the header, or with the wrong token, receive:

```
HTTP 401
{ "error": "Unauthorized" }
```

Omit `--api-key` entirely to disable authentication (suitable for a private LAN).

---

## Scripts — `/she/scripts`

### GET /she/scripts

List all `.js` files in the script directory, recursively.

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

Create or overwrite a script file. Only `.js` files are accepted.

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
  "apiKey": "change-me"
}
```

**Response (HTTP 200):**

```json
{ "ok": true, "restartRequired": true, "configPath": "/home/user/.she/config.json" }
```

A daemon restart is required for the new config to take effect.

---

## WebSocket — `ws://host/she/ws`

Connect to the WebSocket endpoint for a live stream of logs, MQTT state changes, and sheDB events.

**Optional authentication:** append `?token=<apiKey>` to the URL when `--api-key` is set.

```js
const ws = new WebSocket('ws://localhost:8080/she/ws?token=my-secret');
```

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

# Read config (with auth)
curl -H "Authorization: Bearer my-secret" http://localhost:8080/she/config

# Write config
curl -X PUT -H "Content-Type: application/json" \
     -H "Authorization: Bearer my-secret" \
     -d '{"url":"mqtt://newbroker","dir":"/opt/scripts"}' \
     http://localhost:8080/she/config
```

