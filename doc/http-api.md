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
| `GET` | `/she/health` | Health probe — see [below](#get-shehealth) |
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

### GET /she/matter/devices/:nodeId/dcl

What the CSA Distributed Compliance Ledger (the public registry of certified Matter products) says about the device's vendor and product IDs, next to what the device reports about itself. Vendor names come from a bundled snapshot (`@matter/dcl-data`) refreshed daily from the ledger; product details are fetched on demand and cached for 30 days in the Matter storage directory, so the answer works offline once seen. With `--matter-dcl-offline` the ledger is never contacted.

**Response (HTTP 200):**

```json
{
  "vendorId": 4874,
  "productId": 16641,
  "vendor": { "vendorId": 4874, "vendorName": "IKEA of Sweden AB", "companyPreferredName": "IKEA", "companyLegalName": "IKEA of Sweden AB", "vendorLandingPageUrl": "https://www.ikea.com" },
  "vendorName": "IKEA",
  "product": { "productName": "TRADFRI bulb E27", "productLabel": null, "partNumber": null, "deviceTypeId": 257, "productUrl": "https://…", "userManualUrl": null, "supportUrl": null, "commissioningFallbackUrl": null },
  "productStatus": "found",
  "fetchedAt": 1760000000000,
  "offline": false,
  "live": true,
  "reported": { "vendorName": "IKEA of Sweden AB", "productName": "TRADFRI bulb E27 WW 806lm", "softwareVersionString": "1.0.21", "...": "…" }
}
```

`product` is `null` when the ledger has no entry (`productStatus` says why: `not in the ledger`, `offline — not cached`, `ledger not reachable yet`).

---

### GET /she/matter/thread/networks

The Thread networks on the LAN, from the border agents' `_meshcop._udp` mDNS announcements (passive discovery on the controller's mDNS): per network (extended PAN ID) its border routers — Apple TV, HomePod, OpenThread border routers, the ESP router — with vendor, model, Thread version, the decoded state bitmap (role, interface status, connection mode, BBR flags, ePSKc), addresses, partition ID and last seen; border routers that name no PAN ID under `unknown`. A border router with the classic OpenThread REST API (OTBR on 8081, esp-thread-br on 80) is probed once and shows `rest.manageable` with its role, RLOC16 and leader data. Nothing is written to any border router.

**Response (HTTP 200):**

```json
{
  "running": true,
  "networks": [
    { "extPanId": "1122334455667788", "networkName": "Home", "routerCount": 2, "partitions": ["0a0b0c0d"], "datasetKnown": false,
      "borderRouters": [
        { "extAddress": "AABBCCDDEEFF0011", "vendorName": "Apple Inc.", "modelName": "AppleTV14,1", "hostname": "Wohnzimmer.local.", "addresses": ["192.168.1.20"], "meshcopPort": 49153, "threadVersion": "1.3.0",
          "state": { "connectionMode": "PSKc", "interfaceStatus": "active", "availability": "high", "bbrActive": false, "bbrPrimary": true, "role": "leader", "epskcSupported": false, "threadActive": true },
          "lastSeen": 1760000000000, "rest": { "manageable": false, "port": null, "node": null, "probedAt": 1760000000000, "error": null } }
      ] }
  ],
  "unknown": []
}
```

### POST /she/matter/thread/refresh · POST /she/matter/thread/routers/:extAddress/probe

Probe every border router's REST API again, or one. **Response (HTTP 200):** as `GET …/networks`, or the border router.

### GET /she/matter/thread/datasets

The Thread datasets (network credentials) she knows, one per extended PAN ID, kept encrypted in the Matter storage (`thread-datasets.enc`, the secrets store's key) and never handed to scripts. Listed **redacted**: name, channel, PAN ID, mesh-local prefix, active timestamp, channel mask, security policy, whether a network key and a PSKc are present — never the key or the PSKc. A known dataset marks its network on the Thread tab and, with `meshcop` switched on, lets she ask the network's nodes for their diagnostics through a border router (as the network's commissioner — one at a time per network, so it is off by default).

**Response (HTTP 200):** `{ "available": true, "error": null, "datasets": [ { "extPanId": "DEAD00BEEF00CAFE", "networkName": "Lab", "channel": 25, "panId": 4660, "meshLocalPrefix": "FD00DEAD00BEEF00", "activeTimestamp": "0000000000010000", "channelMask": null, "securityPolicy": null, "hasNetworkKey": true, "hasPskc": true, "source": "pasted", "note": "", "added": 1760000000000, "meshcop": false } ] }`

### POST /she/matter/thread/datasets

Import a dataset: `{ "tlv": "0e080000…", "source": "pasted", "note": "" }` — the hex TLV (as `ot-ctl dataset active -x` prints it, or decoded from a border router's dataset QR; `0x`, spaces and colons are tolerated). **Response (HTTP 201):** the redacted entry. **HTTP 400** when it does not decode.

### PUT /she/matter/thread/datasets/:extPanId · DELETE /she/matter/thread/datasets/:extPanId

`{ "meshcop": true }` switches the MeshCoP diagnostics for that network on or off; `DELETE` forgets the dataset.

### POST /she/matter/thread/datasets/:extPanId/reveal

The full TLV — the UI asks for a confirmation first. **Response (HTTP 200):** `{ "extPanId": "…", "tlv": "0e08…" }`

### POST /she/matter/thread/routers/:extAddress/import-dataset

Read the active dataset from a border router with the OpenThread REST API (probed as manageable) and import it. **HTTP 409** when the router has no REST API.

### GET /she/matter/thread/health

Thread health alerts, evaluated once a minute from the border routers and the mesh: a leader change (`leader_changed`, a one-off event), a network whose border routers or devices announce more than one partition ID (`partition`), a border router not seen for 15 minutes or gone from mDNS (`border_router_offline`), a router that dropped to a child or end device (`role_dropped`), a neighbour link whose quality fell from good to poor (`link_degraded`). Raised alerts are logged at warn, cleared ones at info; the state is published retained on `<name>/status/thread/health` as `{ "val": "ok" | "warning", "ts", "lc", "alerts": [ { kind, subject, message, since, network } ] }` for scripts and notifications.

**Response (HTTP 200):** `{ "val": "ok", "active": [], "history": [ { "key": "partition:…", "kind": "partition", "subject": "…", "message": "…", "since": 1760000000000, "event": "raised", "at": 1760000000000 } ], "checkedAt": 1760000000000, "topic": "she/status/thread/health" }`

### POST /she/matter/thread/health/check · DELETE /she/matter/thread/health/history

Evaluate now; forget the history. **Response (HTTP 200):** as `GET`.

### GET /she/matter/thread/mesh

The Thread mesh as a graph: every Thread device in she's fabric (role, RLOC16, extended address, channel, partition, the sizes of its neighbour and route tables), the Wi-Fi devices (RSSI, access point), the border routers from mDNS joined by extended address, neighbours nobody in the fabric knows as `external` nodes; `links` from the neighbour tables (LQI, average RSSI, child flag, whether both sides see it) and the bindings as `binding` links. The neighbour and route tables come from the subscriptions until they are re-read (most devices report them only when a subscription is set up).

**Response (HTTP 200):** `{ "nodes": [ { "id": "node:4", "kind": "thread", "nodeId": "4", "name": "Bulb", "online": true, "role": "router", "roleCode": 5, "rloc16": 21504, "extAddress": "0011223344556677", "channel": 25, "partitionId": 7, "networkName": "Home", "neighbours": 2, "routes": 1, "readAt": null } ], "links": [ { "kind": "neighbour", "source": "node:4", "target": "br:AABBCCDDEEFF0011", "lqi": 3, "lqiBack": null, "rssi": -60, "isChild": false, "bidirectional": false, "quality": "good" } ], "networks": [ { "networkName": "Home", "partitions": ["7"], "channel": 25, "nodes": 2 } ], "lastRefresh": null, "nodeCount": 3 }`

### POST /she/matter/thread/mesh/refresh · POST /she/matter/thread/mesh/refresh/:nodeId

Re-read the neighbour and route tables of every online Thread device, or of one (sleepy devices answer slowly); for every network whose dataset is known with `meshcop` on, the nodes are also asked through a border router (MeshCoP) — those appear as `meshcop` nodes with `meshcop.{vendorName, vendorModel, version, children}`, non-Matter nodes included. **Response (HTTP 200):** as `GET …/mesh`, with `meshcop: { nodes, networks: [ { extPanId, nodes, readAt, via, error } ], enabled: [extPanId…] }`. The tables are also re-read once a day.

### GET /she/matter/bridge

The Matter ↔ MQTT bridge: every paired node's application attributes (endpoints ≥ 1, the diagnostics and commissioning clusters left out) published to MQTT, cluster events too, commands and writes accepted on `set`, reads on `get`. Off until switched on. Defaults are mqtt-smarthome: `matter/connected` (2 while she runs, 0 on shutdown), `matter/status/<device>/<endpoint>/<cluster>/<attribute>` retained as `{ "val", "ts", "lc" }` (`lc` = last change), `matter/status/<device>/online`, `matter/set/<device>/<endpoint>/<cluster>/<attribute-or-command>`, `matter/get/<device>/<endpoint>/<cluster>/<attribute>`. Cluster, attribute, event and command names are matter.js's camelCase turned into snake_case (`level_control/current_level`), values in Matter's own units. `<device>` is the node's MQTT name — its device name as snake_case when it first appears, kept across renames in Apple Home or she, editable here; inbound topics accept the MQTT name or the node ID.

**Response (HTTP 200):**

```json
{
  "enabled": true, "format": "basic",
  "templates": { "connected": "matter/connected", "attribute": "matter/status/${device}/${endpoint}/${cluster}/${attribute}", "event": "matter/status/${device}/${endpoint}/${cluster}/${event}", "online": "matter/status/${device}/online", "set": "matter/set/${device}/${endpoint}/${cluster}/${attributeOrCommand}", "get": "matter/get/${device}/${endpoint}/${cluster}/${attribute}" },
  "defaults": { "…": "the same set" },
  "placeholders": ["device", "nodeId", "endpoint", "cluster", "attribute", "event", "attributeOrCommand"],
  "formats": ["plain", "basic", "extended"],
  "devices": [ { "nodeId": "4", "deviceName": "Bad Licht", "online": true, "name": "bad_licht", "publish": true, "assigned": true } ],
  "status": { "started": true, "connected": true, "published": 23 }
}
```

### PUT /she/matter/bridge

`{ "enabled": true, "format": "basic", "templates": { "attribute": "…" } }` — any subset. Formats: `plain` (the value; structs and lists as JSON), `basic` (`{ val, ts, lc }`, the default), `extended` (`{ val, ts, lc, matter: { nodeId, device, endpoint, cluster, attribute | event } }`). Inbound payloads are accepted plain or as `{ "val": … }` in every format. A template is validated (known placeholders only, no wildcards, an inbound template must not overlap an outbound one; an empty template disables that topic); a changed template or format clears the bridge's old retained topics and republishes. On `set`, an attribute with a mapped command runs the command (`on_off/on_off` true/false → `on`/`off`, `"toggle"` → `toggle`; `level_control/current_level` → `moveToLevel`; `window_covering/current_position_lift_percent100ths` → `goToLiftPercentage`; `color_control/color_temperature_mireds` → `moveToColorTemperature`), a command name runs that command with the payload object as its fields, anything else is an attribute write (the device refuses non-writable ones — logged at warn). **Response (HTTP 200):** as `GET`. **HTTP 400** with the validation problems.

### PUT /she/matter/bridge/devices/:nodeId

`{ "name": "licht_bad", "publish": false }` — the MQTT name (lower-case letters, digits, underscores, unique) and whether the node is bridged at all. A rename moves the topics and clears the old retained ones. **Response (HTTP 200):** as `GET`.

Note: she's MQTT last will covers her own `<name>/connected` topic only; after a crash `matter/connected` keeps its `2` until she is back.

### GET /she/matter/groups

she's Matter groups: one multicast command reaches every member. A group has an application group ID, a name, a key set (the shared one by default, or its own — devices hold only a few key sets, often 3 including the fabric's IPK) and members (endpoints). The derived state comes from the members' subscribed attributes — groups cannot be read. The key sets are listed without their keys (they are kept encrypted in the Matter storage, `groups.enc`, with the secrets store's key).

**Response (HTTP 200):**

```json
{
  "available": true, "error": null, "sharedKeySetId": 1,
  "keySets": [ { "id": 1, "name": "shared", "shared": true, "created": 1760000000000 } ],
  "groups": [
    { "id": 1, "name": "Wohnzimmer", "keySetId": 1, "keySet": { "id": 1, "name": "shared", "shared": true, "created": 1760000000000 },
      "members": [ { "nodeId": "4", "endpointId": 1, "name": "Bulb", "endpointName": null, "online": true, "paired": true, "clusters": [6, 8], "clusterNames": ["onOff", "levelControl"], "status": "ok", "error": null, "state": { "onOff": true, "level": 200 } } ],
      "state": { "on": "all", "onCount": 1, "memberCount": 1, "level": 200 }, "created": 1760000000000 }
  ]
}
```

### POST /she/matter/groups

Create a group. **Request body:** `{ "name": "Wohnzimmer", "keySet": "shared" }` (`"own"` for a key set of its own). **Response (HTTP 201):** the group.

### PATCH /she/matter/groups/:id · DELETE /she/matter/groups/:id

Rename (`{ "name": "…" }`; the name devices hold is cosmetic and stays) or delete a group. Deleting deprovisions every online member (an offline one keeps the group until it is removed again — listed in `problems`) and drops an own key set no other group uses. **Response (HTTP 200):** the group, or `{ "ok": true, "problems": [] }`.

### POST /she/matter/groups/:id/members

Add an endpoint: `KeySetWrite` when the device lacks the key set, the `groupKeyMap` entry, Groups `AddGroup` on the endpoint, and an ACL entry (auth mode Group, Operate on the endpoint's controllable clusters — guarded like a binding's). Refused (HTTP 409) when the device's `maxGroupKeysPerFabric` or `maxGroupsPerFabric` would be exceeded; a failed step is recorded on the member (`status: "error"`).

**Request body:** `{ "nodeId": "4", "endpointId": 1, "clusters": ["onOff", "levelControl"] }` (`clusters` optional: every controllable server cluster of the endpoint). **Response (HTTP 201):** the group.

### DELETE /she/matter/groups/:id/members/:nodeId/:endpointId

Remove a member; the device is cleaned (`RemoveGroup`, the ACL entry, the map entry and the key set when nothing else uses them) — best effort, `problems` lists what did not work. **Response (HTTP 200):** `{ "ok": true, "problems": [], "group": { … } }`

### POST /she/matter/groups/:id/command

One multicast command to the group: `{ "clusterName": "onOff", "command": "on" }` or `{ "clusterName": "levelControl", "command": "moveToLevel", "args": { "level": 128 } }`. No device answers a group message — best effort; on Thread a lost multicast is not retried. Scripts do the same with `she.matter.send('group:Wohnzimmer', null, 'onOff', 'on')`. **Response (HTTP 200):** `{ "ok": true }`

A **group binding** is `POST /she/matter/bindings` with `"target": { "group": 1 }`: the source gets the group's key set and map entry and a `{ group, cluster }` binding entry; the members already grant the group.

### GET /she/matter/updates

Firmware state of every paired node and the updates the CSA ledger offers. she runs a Matter OTA provider (matter.js's `SoftwareUpdateManager`): the ledger is asked daily and on request, the image is served to the device over BDX when the user starts the update — **never automatically**. Not available with `--matter-dcl-offline`.

**Response (HTTP 200):**

```json
{
  "available": true,
  "nodes": [
    { "nodeId": "4", "name": "Bulb", "online": true, "vendorId": 4874, "productId": 7, "softwareVersion": 10021, "softwareVersionString": "1.0.21", "hasRequestor": true,
      "available": { "softwareVersion": 10030, "softwareVersionString": "1.0.30", "releaseNotesUrl": "https://…", "vendorId": 4874, "productId": 7, "source": "ProductionDcl" },
      "checkedAt": 1760000000000, "updateState": 1, "updateStateName": "idle", "updateStateProgress": null, "pending": null, "outcome": null }
  ]
}
```

`updateState` is the device's OTA requestor state (0 unknown, 1 idle, 2 querying, 3 delayed on query, 4 downloading, 5 applying, 6 delayed on apply, 7 rolling back, 8 delayed on user consent); `pending` describes she's queue entry while an update runs (`queued`, `in-progress`, `stalled`); the requestor's attributes also arrive as `matter:attr` websocket events.

### POST /she/matter/updates/check · POST /she/matter/devices/:nodeId/update/check

Ask the ledger now, for every online node or for one. **Response (HTTP 200):** as `GET /she/matter/updates`.

### POST /she/matter/devices/:nodeId/update

Start the update to the version the ledger offered (or `{ "softwareVersion": N }`). Refused (HTTP 409) when the device is offline, busy, has no OTA requestor, no update is known, or an update is already queued. The device fetches the image from she and restarts at the end — 10–30 minutes on Thread, 5–15 on Wi-Fi.

**Response (HTTP 202):** `{ "ok": true, "nodeId": "4", "targetSoftwareVersion": 10030 }`

### DELETE /she/matter/devices/:nodeId/update

Cancel a queued or running update (possible while querying or downloading). **Response (HTTP 200):** `{ "ok": true, "nodeId": "4" }`

### GET /she/matter/devices/:nodeId/fabrics

The controllers (fabrics) a device belongs to — Apple Home, Home Assistant, she, … — read from its Operational Credentials cluster with fabric filtering off, each named after its fabric label or its vendor (from the CSA ledger), she's own marked; plus the device's pairing-window state.

**Response (HTTP 200):**

```json
{
  "nodeId": "4", "fresh": true, "supportedFabrics": 5, "commissionedFabrics": 2,
  "fabrics": [
    { "fabricIndex": 1, "fabricId": "1", "nodeId": "100", "vendorId": 4937, "vendorName": "Apple", "label": "Apple Home", "own": false, "name": "Apple Home" },
    { "fabricIndex": 2, "fabricId": "2", "nodeId": "4", "vendorId": 65521, "vendorName": "matter.js (test vendor)", "label": "", "own": true, "name": "she" }
  ],
  "window": { "status": 0, "adminFabricIndex": null, "adminVendorId": null, "codes": null }
}
```

`window.status`: `0` closed, `1` enhanced window open, `2` basic window open; `codes` holds the codes of a window she opened while it lasts.

### POST /she/matter/devices/:nodeId/commissioning-window

Open an enhanced commissioning window on the device so another app can add it: she generates a passcode and discriminator, computes the PAKE verifier and sends the timed `OpenCommissioningWindow` command. The device stays in she; the other app gets a fabric of its own.

**Request body:** `{ "timeoutSeconds": 900 }` (optional, 180 … 900)

**Response (HTTP 201):** `{ "passcode": 20202021, "discriminator": 3840, "qrCode": "MT:…", "manualCode": "34970112332", "openedAt": 1760000000000, "expiresAt": 1760000900000, "timeoutSeconds": 900 }`

### DELETE /she/matter/devices/:nodeId/commissioning-window

Close the window early (`RevokeCommissioning`). **Response (HTTP 200):** `{ "ok": true }`

### DELETE /she/matter/devices/:nodeId/fabrics/:fabricIndex

Remove another controller's fabric from the device (`RemoveFabric`); that controller loses the device. she's own fabric cannot be removed this way (HTTP 409) — unpair the device instead.

**Response (HTTP 200):** `{ "ok": true, "fabricIndex": 1 }`

---

### GET /she/matter/bindings

Every binding of every paired node. A binding lets one device (a switch) drive another (a light) directly, without she in the loop. Entries of she's own fabric are resolved to device names; entries made by other controllers (Apple Home, Home Assistant, …) are listed with `own: false` and node IDs in that fabric's numbering — she shows them but cannot edit them.

**Response (HTTP 200):**

```json
[
  { "sourceNodeId": "2", "sourceName": "Wall switch", "sourceEndpointId": 1, "sourceEndpointName": null, "own": true, "fabricIndex": 1,
    "node": "4", "group": null, "endpoint": 1, "cluster": 6, "clusterName": "onOff", "targetName": "Kitchen light", "targetEndpointName": null }
]
```

### GET /she/matter/bindings/candidates

Which endpoints can be binding sources (a Binding cluster plus an On/Off, Level Control, Color Control, Window Covering, Thermostat, Fan Control or Door Lock *client*), which can be targets (the matching *server* cluster), and which cannot bind — Generic Switch devices only send button events; use `she.matter.sub` for those.

**Response (HTTP 200):** `{ "sources": [ { "nodeId", "nodeName", "online", "endpointId", "name", "deviceTypes", "deviceTypeName", "clusters": [ { "name": "onOff", "id": 6, "label": "on/off" } ] } ], "targets": [ … ], "notBindable": [ { …, "reason": "…" } ] }`

### POST /she/matter/bindings

Create a binding. she reads the target's Access Control list fresh, adds an *Operate* grant for the source node on the bound clusters of that endpoint (never *Administer*), refuses to write a list that lost she's own Administer entry, writes it and reads it back; then appends the entries to the source's Binding list and reads that back. A failed binding write rolls the grant back. Both devices must be online and in she's fabric.

**Request body:**

```json
{ "source": { "nodeId": "2", "endpointId": 1 }, "target": { "nodeId": "4", "endpointId": 1 }, "clusters": ["onOff", "levelControl"] }
```

Clusters are named (`onOff`, `levelControl`, `colorControl`, `windowCovering`, `thermostat`, `fanControl`, `doorLock`) or numeric IDs.

**Response (HTTP 201):** `{ "ok": true, "clusters": [6, 8], "aclChanged": true, "bindingsAdded": [6, 8] }`

**Errors:** `400` bad body · `404` unknown node · `409` a device offline, different fabrics, same endpoint, or the device's access-control limits reached · `500` the device refused a write (the message says which).

### DELETE /she/matter/bindings

Remove a binding (same body as `POST`). The entries leave the source's Binding list; the target's grant is revoked for the clusters no other binding of that source still needs. An offline target keeps its grant until the binding is removed again (`warning` says so).

**Response (HTTP 200):** `{ "ok": true, "clusters": [6], "bindingsRemoved": [6], "aclRevoked": true, "warning": null }`

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

### PATCH /she/config

Writes a single branch of the config and leaves the rest of the file untouched. Pages that
edit one section use this instead of PUT: sending the whole document back would carry the
snapshot the page loaded when it was opened and silently revert what another page saved in
the meantime.

**Request body (JSON):** `{ "path": "broker.ssh", "value": { "host": "192.168.1.10", "user": "she" } }`

`path` is a dotted key path (at most five segments, each `[A-Za-z0-9_-]+`); missing parents
are created. Omitting `value` deletes the key. The response is the same as PUT's.

---

## Daemon — `/she/health`, `/she/status`, `/she/restart`

### GET /she/health

Liveness/readiness probe for Docker `HEALTHCHECK`, nginx upstream checks and monitoring agents. **Public** — it answers in every auth mode without a session, because a probe cannot log in.

**HTTP 200** while the daemon can do its job, **HTTP 503** while it cannot: still starting up (waiting for the retained MQTT state or, when enabled, for the Matter controller), or an MQTT broker is configured but not connected. Never cached.

```json
{ "status": "ok", "uptime": 3812, "started": true, "mqtt": "connected", "scripts": 7, "version": "1.36.1" }
```

| Field | Description |
|-------|-------------|
| `status` | `ok` (200) or `degraded` (503) |
| `uptime` | Seconds since the HTTP server started |
| `started` | Whether scripts have been started (`false` while the startup gates are still closed) |
| `mqtt` | `connected`, `disconnected`, or `disabled` when no broker URL is configured |
| `scripts` | Number of loaded user scripts |
| `safeMode` | Only present, and `true`, in [safe mode](script-engine.md#safe-mode) |
| `version` | Only for authenticated callers — an unauthenticated probe gets no version to fingerprint |

Safe mode answers **200**: it is a state the user has to reach the web UI to get out of, so a probe must not pull the daemon out of an upstream pool while it lasts. Watch the `safeMode` field to alert on it.

```bash
curl -fsS http://localhost:8080/she/health   # exit code 22 when degraded
```

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
| `safeMode` | `true` when the daemon runs in [safe mode](script-engine.md#safe-mode) — the web UI shows a banner |

### POST /she/restart

Sends a graceful shutdown signal. The process exits with code 0 so the process manager (systemd, Docker restart policy, etc.) restarts it automatically.

**Response (HTTP 200):**

```json
{ "ok": true }
```

The connection will drop immediately after the response. The daemon is typically back within a second or two.

---

## Secrets — `/she/secrets`

Store for values scripts read with `she.secrets` ([sandbox-api.md](sandbox-api.md#shesecrets)). Fields are **secret** (write-only: names and change times come back, the value never does — there is no GET for it, by design) or **plain** (a user name, a host: listed in clear). The kind is chosen when a field is created; marking a plain field secret is one-way.

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/she/secrets` | | `{ status: "empty" \| "ok" \| "locked" \| "error", error, keySource: "env" \| "file" \| null, file, keyFile, groups: [{ name, changed, fields: [{ name, changed, secret, value? }] }] }` — `value` only for plain fields |
| PUT | `/she/secrets/:group/:field` | `{ value, secret? }` | create or replace; `secret` (default `true`) sets the kind of a *new* field and can only raise an existing one; names `[A-Za-z0-9_.-]{1,64}`, value a non-empty string up to 64 KB (400 `INVALID_NAME` / `INVALID_VALUE`); 409 `LOCKED` when the key is missing |
| POST | `/she/secrets/:group/:field/secret` | | mark a plain field secret — one-way (404 when absent) |
| DELETE | `/she/secrets/:group` · `/she/secrets/:group/:field` | | remove a group or one field (404 when absent) |

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

Every configured host (`services.hosts`, default the she host as `local`) with the helper's `list`: `{ "hosts": [ { "name": "local", "local": true, "ok": true, "hostname": "zigbee", "helper": 1, "helperOutdated": false, "node": "v22.12.0", "brokerEnv": true, "adapters": [ { "name": "cul2mqtt", "version": "1.1.1", "origin": "registry" | "manual", "path": "/usr/local/lib/node_modules/cul2mqtt", "node": "/usr/bin/node" } ], "instances": [ { "adapter": "cul2mqtt", "instance": "cul", "active": "active", "sub": "running", "unitFile": "enabled", "since": "…", "restarts": 0 } ] } ] }`; unreachable hosts carry `ok: false, code, error`. instances carry `pid`, `memory` (systemd MemoryCurrent) and `cpuNs` (CPUUsageNSec) from helper v10, plus `cpu` — the share of one core between this and the previous listing (`null` on the first). `legacy` lists pre-core single-instance units (`{ adapter, unit, active, sub, unitFile, since, restarts, envFile }`); the unit, logs and env routes accept `-` as `:instance` for them. Adapters carry `latestVersion` / `updateAvailable` (npm registry, cached 24 h) and `unit: false` when the package is installed with npm but has no template unit — no instance — yet. A remote entry without `name` is addressed by its ssh host. Cached for a minute; `?refresh=1` asks every host again.

### Host routes

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/she/services/hosts/:host/adapters/:adapter/schema` | `?refresh=1` | `{ schema, secrets, envPrefix, sheBroker, dynsec: { available } }` — the adapter's `--config-schema` (cached 10 min), the env variable names to mask, she's broker settings as the host would need them (`{ url, username, hasPassword }`), whether dynsec identities can be created |
| POST | `/she/services/hosts/:host/adapters/:adapter/discover` | `{ timeout?: 1-120, address?: "10.0.1.5" \| "10.0.1.0/24" \| [...], needs?: { option: value } }` | scan for devices with the adapter's own `--discover --discover-json` **on that host** (helper v11; `needs` v12) — see [below](#device-discovery); **400** `{ code: "NO_DISCOVERY" }` unless the schema marks a property with `x-discover`, **400** `{ code: "DISCOVERY_NEEDS", needs: [...] }` when a `cloud` scan is missing the options it signs in with |
| POST | `/she/services/hosts/:host/adapters/:adapter/install` | `{ instance, env: { "<ADAPTER>_X": "…" }, brokerMode?, acl? }` | `<adapter> --install --name <instance>` with the options as environment; `brokerMode` `own` (default) \| `she` (she's broker URL/username/password + `SHE_USE_BROKER=1`) \| `dynsec` (creates client + role `svc-<instance>`, default or given `acl`, writes the credentials + `SHE_DYNSEC_CLIENT`); `{ ok, output }` |
| POST | `/she/services/hosts/:host/adapters/:adapter/update` | `{ force? }` | `npm install -g <adapter>@latest`, then restarts the adapter's active instances; **409** `{ code: "MANUAL_DEPLOY" }` for manually deployed adapters unless `force` |
| POST | `/she/services/hosts/:host/adapters/:adapter/uninstall` | | every instance of the adapter (`--uninstall` + dynsec identity), then `npm uninstall -g`, the template unit, `/etc/<adapter>`, `/var/lib/<adapter>`; `{ ok, removedInstances, output }`; **409** `LEGACY` while a pre-core `<adapter>.service` exists |
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


#### Device discovery

`POST /she/services/hosts/:host/adapters/:adapter/discover` runs the scan where the devices are: broadcast, multicast, ARP and `/dev/serial` only reach the network and the usb bus of the machine running it, which is the adapter's host, not necessarily she's. The adapter owns the protocols (mqtt-interfaces-core 0.9 discovery hints); she shapes the answer.

```json
{
  "property": "address",
  "envName": "WIIM2MQTT_ADDRESS",
  "kinds": ["network"],
  "devices": [
    {
      "value": "kueche.lan",
      "address": "10.0.1.5",
      "fqdn": "kueche.lan",
      "name": "Küche",
      "model": "WiiM Pro Plus",
      "sources": ["ssdp"],
      "services": { "upnp": true },
      "suggestName": "kueche",
      "usedBy": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `property` / `envName` | the schema property marked `x-discover` and its environment variable — where `value` belongs |
| `kinds` | `network`, `serial`, `cloud`, or several: what the adapter's hint asks for. `cloud` scans nothing — it lists the devices a vendor account owns, which is the only discovery for hardware that never speaks to the LAN (an EcoFlow inverter talks to EcoFlow and to nobody else), so `value` is a serial number rather than an address and none of the cross-subnet options apply |
| `needs` | option keys the scan signs in with, from `x-discover-needs` on the marked property (core 0.12+). Send them as `needs: { email, password }`; they are options of the instance being created, so the form has them already. They reach the helper on **stdin** as an env file — the same channel `install` uses — and never in argv, where a process list would show them. A `cloud` scan without them is refused before the host is touched (`DISCOVERY_NEEDS`), and only the options the schema itself named are forwarded, under the env names it gave them |
| `value` | the identity of the result and the default to configure: the qualified DNS name when the device has one (it outlives a DHCP lease), the address otherwise; for a serial scan the stable `/dev/serial/by-id/…` path, which survives a replug where `/dev/ttyACM0` may not |
| `address` / `fqdn` / `hostname` | the forms the device answers to; `fqdn` and `hostname` only when they round-trip (reverse the address, resolve the name back, find the address among the answers) as checked on the host that ran the scan. The UI offers them as `IP` / `host` / `FQDN`; the short name resolves through the search list of whoever asks, so it is offered but never preselected |
| `name` | the name the *user* gave the device (UPnP `friendlyName`, Chromecast label); `model`/`type` say what it is |
| `suggestName` | a free instance name derived from `name` (slugged: *"Küche Oben"* → `kueche-oben`), unique against every instance she knows of — an instance name is an MQTT topic prefix — falling back to the schema's `name` default |
| `usedBy` | the instance on that host already configured with this device, matched against every identifier it answers to (by-id path *and* device node, name *and* address) |

Everything a device sent is untrusted: strings are capped and stripped of control characters, service values coerced to booleans, unknown fields dropped, at most 50 devices.
| GET | `/she/services/hosts/:host/adapters/:adapter/asset` | `?path=` | a file shipped in the adapter package (example, JSON schema); relative path, no `..` |
| GET | `/she/services/catalog` | `?refresh=1` | `{ packages: [{ name, version, coreRange, publisher, description, homepage, repository, mqttInterfaces, maintainers, published }], publishers, errors, fetchedAt, cached, stale? }` — the trusted publishers' npm packages whose latest version depends on `mqtt-interfaces-core` (registry search + packuments, cached 24 h) — answered from the cache (memory + `<data-dir>/services/catalog.json`) at once; `refreshing: true` = a sweep runs in the background (ask again), `fetchedAt`, `stale` when the last sweep failed; the daemon sweeps once a day |
| POST | `/she/services/hosts/:host/adapters/:adapter/install-package` | | `npm install -g <adapter>@latest` on the host; **403** `{ code: "NOT_IN_CATALOG" }` for anything that is not a catalog member |
| POST | `/she/services/ssh/test` | `{ host, port?, user?, identityFile? }` | test unsaved host settings: always 200 with `{ ok, helper }` or `{ ok: false, code, error }` |
| POST | `/she/services/setup/token` | `{ origin }` | mint a one-time remote-host bootstrap: `{ token, command, scriptUrl, sha256, expires, user }` (valid 15 min) |
| GET | `/she/services/setup/token/:token` | | `{ status: "pending" \| "fetched" \| "done" \| "expired", host? }` |
| GET | `/she/services/setup.sh?token=…` | **no auth** | the generated POSIX bootstrap script, served once; 410 afterwards |
| POST | `/she/services/setup/done?token=…` | **no auth**, `{ hostname, user }` | callback from the script: adds `{ hostname, ssh: { host: <caller address>, user: "she-services" } }` to `services.hosts` (or updates an existing entry); single use |
| POST | `/she/services/hosts/:host/test` | | always 200: `{ ok: true, helper }` or `{ ok: false, code, error }` |
| GET | `/she/services/node/releases` | `?refresh=1` | what a node update would install: `{ lts, ltsName, latest, fetchedAt, stale }` from nodejs.org's `index.json`, cached 6 h; `stale` = the fetch failed and these are the last known versions (or nulls) |
| POST | `/she/services/hosts/:host/node/update` | `{ channel?: "lts" \| "latest" }` | update Node.js on the host with [tj/n](https://github.com/tj/n) (the pinned `n` script is downloaded and verified when the host does not have it — no npm involved): `{ ok, spec, before, after, installed, installedPath, activePath, mismatch, n, nInstalled, restartRequired }`; `mismatch` = another node still wins on PATH; `stable` is accepted as n's old alias for `lts`; **400** `{ code: "HELPER_OUTDATED" }` below helper v13 |
| POST | `/she/services/hosts/:host/instances/restart-all` | | restart every *running* instance on the host (what a node update needs afterwards): `{ ok, restarted: [{ adapter, instance }], failed: [{ adapter, instance, error }] }` |
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

