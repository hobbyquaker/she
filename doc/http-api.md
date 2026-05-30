# HTTP API

The HTTP server is optional. Enable it with `--port <n>` on the command line.  
Use `--port 0` to let the OS assign a free port — the actual port is logged at startup:

```
INFO: http server listening on :8080
```

---

## URL scheme

| Prefix | Purpose |
|---|---|
| `/she/*` | Internal system endpoints (config management, future: script management, WebSocket) |
| `/api/*` | User-script endpoints registered via `she.api.*` |

---

## Authentication

Set `--api-key <token>` (or `MQTTSCRIPTS_API_KEY`) to require a Bearer token on **all** requests to both `/she/*` and `/api/*`.

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

## System endpoints — `/she/`

### GET /she/config

Returns the currently active config file as JSON.  
If no config file has been written yet, returns `{}`.

**Response (HTTP 200):**

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "name": "logic",
  "port": 8080
}
```

---

### PUT /she/config

Writes a new config file. All CLI option keys are accepted (camelCase or kebab-case).

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
{
  "ok": true,
  "restartRequired": true,
  "configPath": "/home/user/.she/config.json"
}
```

**Error response (HTTP 500):**

```json
{ "error": "EACCES: permission denied, open '...'" }
```

The file is written to the path that was loaded at startup (from `--config` or the default `~/.she/config.json`).  
**A daemon restart is required for the new config to take effect.**

---

## Script endpoints — `/api/`

Scripts register their own routes with `she.api.*`.  
All routes for a given script are scoped under `/api/<scriptName>/`, where `scriptName` is the filename without the `.js` extension.

See [sandbox-api.md](sandbox-api.md#sheapi--http-endpoint-registration) for the full `she.api` reference.

### Example

Script: `controller.js`

```js
she.api.get('/status', () => ({ ok: true, uptime: process.uptime() }));

she.api.post('/light/:room', (req, body) => {
    setValue('home/light/' + req.params.room, body.value);
    return { ok: true };
});
```

Resulting endpoints:

```
GET  /api/controller/status
POST /api/controller/light/:room
```

### Response format

Handlers return a value (or a Promise resolving to one) which is sent as JSON.  
Returning `undefined` sends `null`.

### Error handling

| Condition | HTTP status | Body |
|---|---|---|
| Handler throws or returns rejected Promise | `500` | `{ "error": "<message>" }` |
| Route not found | `404` | Express default |
| Wrong / missing auth token | `401` | `{ "error": "Unauthorized" }` |

### Duplicate route guard

Registering the same method + path twice (e.g. across two script reloads without a process restart) throws an error and logs it — the duplicate is not registered.

---

## curl examples

```bash
# Read current config (no auth)
curl http://localhost:8080/she/config

# Read config with Bearer auth
curl -H "Authorization: Bearer my-secret" http://localhost:8080/she/config

# Write new config
curl -X PUT -H "Content-Type: application/json" \
     -H "Authorization: Bearer my-secret" \
     -d '{"url":"mqtt://newbroker","dir":"/opt/scripts"}' \
     http://localhost:8080/she/config

# Call a script endpoint
curl http://localhost:8080/api/controller/status

# POST to a script endpoint
curl -X POST -H "Content-Type: application/json" \
     -d '{"value":1}' \
     http://localhost:8080/api/controller/light/kitchen
```
