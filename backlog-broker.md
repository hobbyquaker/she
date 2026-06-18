# Backlog: Broker Integration

Optional management of a Mosquitto broker from within `she`.
The broker is always installed and owned by the user — `she` manages config files, users/ACLs, and TLS certificates.

---

## Architecture: Hybrid Approach

Two subsystems with a clean division of responsibility:

| Subsystem | What it manages | How |
|-----------|----------------|-----|
| **Dynamic Security plugin (dynsec)** | Users, passwords, roles, ACLs, groups | MQTT control channel (`$CONTROL/dynamic-security/v1/`). No files, no SSH, no binary. Works for local and remote broker identically via she's existing MQTT connection. Changes take effect immediately. |
| **`mosquitto.conf` (static file)** | Listeners, ports, TLS cert paths, logging, persistence, the `plugin` line that loads dynsec | Written by she directly (local) or via SFTP (remote), then broker reloaded. |
| **Local CA manager** | CA keypair, server cert, issued client certs, CRL | she shells out to `openssl`. Cert metadata tracked in sheDB. |

### Why not static `password_file` + `acl_file`?

The traditional approach requires calling the `mosquitto_passwd` binary to hash passwords — she cannot hash passwords itself without it. The dynsec approach removes this dependency entirely and gives real-time effect on user/ACL changes without SIGHUP.

---

## Deployment Modes

Two modes, both supported from v1:

| Mode | mosquitto.conf + certs | Users/ACLs |
|------|------------------------|------------|
| **Local** | Written directly to disk by she (e.g. `/etc/mosquitto/`) | dynsec over MQTT (already works, no extra config) |
| **Remote** | Copied via SFTP, reload via SSH (`sudo systemctl reload mosquitto`) | dynsec over MQTT (already works, she is already connected to the remote broker) |

SSH is only required for `mosquitto.conf` and cert file changes. User/ACL management works for remote brokers the moment she connects — no SSH needed for day-to-day operation.

---

## dynsec Bootstrap

Two paths, both surfaced in the UI:

### Path A: Guided Setup Wizard (new installs)

UI step-by-step flow in the Broker tab:

1. **Check**: she probes `$CONTROL/dynamic-security/v1/` — if it responds, dynsec is already active → skip to step 5.
2. **SSH check** (remote mode): require SSH to be configured and test connection before proceeding.
3. **Generate config**: she generates a `dynamic-security.json` with a `she-admin` service account (random strong password, stored in `config.json`, never shown in UI after setup).
4. **Write & enable**: she writes `dynamic-security.json` to the broker config dir, adds the `plugin mosquitto_dynamic_security.so` line to `mosquitto.conf`, copies via SFTP if remote.
5. **Full restart**: enabling a new plugin requires a full mosquitto restart (not just SIGHUP). she runs `sudo systemctl restart mosquitto` (or the configured restart command).
6. **Verify**: she publishes a dynsec `listClients` command and confirms a valid response. Green checkmark shown.

The `she-admin` account:
- Dedicated service account, auto-generated, never appears in the Users UI.
- Credentials stored under `broker.dynsec.adminUsername` / `broker.dynsec.adminPassword` in `config.json`.
- Has the built-in `admin` role (full dynsec control).

### Path B: Manual (existing dynsec installs)

User configures in `config.json` (or via Config page form):

```json
{
  "broker": {
    "dynsec": {
      "adminUsername": "she-admin",
      "adminPassword": "..."
    }
  }
}
```

she skips the wizard and connects directly. A "Test dynsec connection" button in the UI verifies it works.

---

## `mosquitto.conf` Management

she owns a single managed config file. On first use (or wizard), she reads the existing `mosquitto.conf`, merges its non-managed options, and takes ownership of the sections it understands.

Managed keys: all `listener` blocks, `plugin` (dynsec), `log_dest`, `log_type`, `persistence`, `persistence_location`, `allow_anonymous`.  
Non-managed keys: everything else is preserved verbatim in an "advanced" passthrough block.

**Safety**: before every write, a timestamped backup is created (`.conf.bak-<iso8601>`). If the file has been modified outside she since the last read (checksum mismatch), she warns before overwriting.

---

## Local CA & Certificate Manager

### Local CA

she manages a local CA at `~/.she/broker/ca/`:

```
~/.she/broker/ca/
  ca.key          ← CA private key (Ed25519, unprotected on disk, chmod 600)
  ca.crt          ← CA self-signed certificate
  ca.srl          ← serial number file
  crl.pem         ← certificate revocation list (regenerated on every revocation)
```

**Generate CA** button in UI:
- Prompts for: CA Common Name (default `she-broker-ca`), validity in years (default 10).
- Shells out: `openssl req -x509 -newkey ed25519 -out ca.crt -keyout ca.key -days <days> -nodes -subj "/CN=<name>"`
- Stores metadata in sheDB at `broker::ca`.

### Server Certificate

she can generate a self-signed server cert for the broker:

- Prompts for: Common Name / SAN (hostname or IP — important for client verification), validity in days.
- Generates: server keypair + CSR + signs with local CA.
- Writes cert+key paths to `mosquitto.conf` (`certfile`, `keyfile`), triggers SIGHUP.
- Alternatively: user can point to externally managed certs (Let's Encrypt, etc.) — she just writes the paths.

### Trusted CA Certs (Client Auth)

she manages `~/.she/broker/ca-certs/` (or a configurable path). Each `.pem` file in this directory is a CA she trusts for incoming client certificate verification.

`mosquitto.conf` is written with:
```
capath /home/she/.she/broker/ca-certs
```

After adding/removing a cert: `openssl rehash <capath>` + SIGHUP.

UI shows for each cert: Subject, Issuer, Fingerprint (SHA-256), Expiry (with warning badge if < 30 days). Upload via textarea paste or file picker.

### Client Certificate Issuance

Issued for IoT devices — the device authenticates to the broker with a cert instead of a username/password.

**Issue cert** flow in UI:
1. Enter: Common Name (e.g. `esp32-bedroom`), validity in days (default 365).
2. she generates: `client.key` (Ed25519) + CSR + signs with local CA → `client.crt`.
3. Bundles to `.p12`: `openssl pkcs12 -export -in client.crt -inkey client.key -certfile ca.crt -out client.p12 -passout pass:<random>`
4. UI shows: download links for `.p12` (with passphrase displayed once), `client.crt`, `client.key`, `ca.crt` individually.
5. Metadata stored in sheDB at `broker::cert::<serial>`: `{cn, serial, issued, expires, revoked: false, revokedAt: null}`.

**Revoke cert** flow:
1. Mark `revoked: true` in sheDB.
2. Regenerate `crl.pem` from all revoked serials.
3. Write `crlfile` path to `mosquitto.conf` if not already set, trigger SIGHUP.

**Expiry warnings**: a she script (auto-loaded, not user-editable) queries sheDB for certs expiring within 30 days and publishes to `she/broker/cert/expiring/<cn>`. The Broker tab shows warning badges.

Note: `require_certificate true` must be set on the relevant listener to enforce client cert auth. she's listener config UI surfaces this as a toggle.

---

## UI: Broker Tab

Nav entry added between **Matter** and **DB**.

### Sub-tabs

#### 1. Status
- dynsec: connected / not configured / error (with setup wizard button if not configured).
- Broker uptime / version (if readable from `$SYS/broker/version`).
- Active connections count (`$SYS/broker/clients/connected`).
- Last config apply: timestamp + result.

#### 2. Users & Roles
- **Users table**: username | roles | groups | actions (edit password, manage roles, delete).
- **Roles panel**: role name | ACL count | assigned users — expandable to show ACL rules.
- **Groups panel**: group name | members | assigned roles.
- "Add user" → modal: username + password (show/hide toggle).
- Role ACL editor: type dropdown (`publishClientSend`, `publishClientReceive`, `subscribePattern`, etc.) | topic | allow/deny toggle | delete.
- All changes go directly to dynsec via MQTT — no "Apply" needed, effect is immediate. A spinner + success/error toast per operation.

#### 3. Listeners
- **Card per listener** (keyed by port number as title).
- Each card: Port | Protocol (`mqtt` / `websockets` / `http_api`) | Bind address | TLS toggle.
- TLS section (when toggled on): certfile path (or "Use managed cert" picker) | keyfile path | capath (links to CA cert manager) | `require_certificate` toggle | `use_identity_as_username` toggle.
- **"+ Add listener"** button at the bottom.
- Changes here require "Apply & Reload" (writes `mosquitto.conf`, SIGHUP).

#### 4. Certificates
- **Local CA** card: CA cert details (CN, expiry, fingerprint) | "Generate new CA" | "Download CA cert".
- **Server cert** card: current cert details | "Generate server cert" | "Use external cert" (path inputs).
- **Trusted CA certs** (for client auth): list of certs in `capath` dir | "Add CA cert" (paste/upload) | delete per cert.
- **Issued client certs**: table: CN | Serial | Issued | Expires | Status (valid/revoked/expiring) | actions: Download (.p12 / .pem) | Revoke.
- "Issue new client cert" button → modal: CN + validity.

#### 5. SSH / Remote
*(Only shown when `broker.mode === 'remote'`)*
- Host, port, user, identity file path.
- "Generate keypair" button → creates `~/.she/broker_id_ed25519` | shows pubkey in readonly textarea | "Copy" button.
- "Install key on broker" → displays exact command to run: `ssh-copy-id -i ~/.she/broker_id_ed25519.pub she@<host>`
- "Test SSH connection" button → runs `ssh -i ... she@host echo ok`, reports success/failure.
- Remote config dir, reload command (default `sudo systemctl reload mosquitto`), restart command (default `sudo systemctl restart mosquitto`).

#### 6. Advanced
- Raw `mosquitto.conf` text editor (Monaco, same as scripts editor).
- "Apply & Reload" / "Apply & Restart" buttons.
- Backup history: list of `.conf.bak-*` files with restore button.

---

## `she.broker.*` Sandbox API

Available to all scripts (same trust model as `she.mqtt`). All methods return Promises. Default timeout: 5 seconds (configurable via `config.json` `broker.apiTimeout`).

Requires `broker.dynsec` to be configured; if not, all methods throw a descriptive error.

### User management
```js
await she.broker.createUser(username, password)
await she.broker.deleteUser(username)
await she.broker.setPassword(username, password)
await she.broker.listUsers()                    // → [{username, roles, groups}]
await she.broker.getUser(username)              // → {username, roles, groups, clientid}
```

### Role management
```js
await she.broker.createRole(rolename)
await she.broker.deleteRole(rolename)
await she.broker.listRoles()                    // → [{rolename, acls}]
await she.broker.getRole(rolename)
// type: 'publishClientSend' | 'publishClientReceive' | 'subscribeLiteral' |
//       'subscribePattern' | 'unsubscribeLiteral' | 'unsubscribePattern'
await she.broker.addACL(rolename, { type, topic, allow: true|false })
await she.broker.removeACL(rolename, { type, topic })
```

### Role ↔ user assignment
```js
await she.broker.assignRole(username, rolename)
await she.broker.revokeRole(username, rolename)
```

### Group management
```js
await she.broker.createGroup(groupname)
await she.broker.deleteGroup(groupname)
await she.broker.listGroups()
await she.broker.addToGroup(username, groupname)
await she.broker.removeFromGroup(username, groupname)
await she.broker.assignRoleToGroup(groupname, rolename)
```

### Example use case (auto-provisioning)

```js
// When a new device announces itself, create a broker user and assign it a role
she.mqtt.sub('devices/new/+', async (topic, payload) => {
  const deviceId = topic.split('/')[2]
  const password = crypto.randomBytes(16).toString('hex')

  await she.broker.createUser(deviceId, password)
  await she.broker.assignRole(deviceId, 'iot-device')

  // Store credentials for the device to fetch
  she.mqtt.pub(`devices/${deviceId}/credentials`, { username: deviceId, password }, { retain: true })
  she.info(`Provisioned broker user for ${deviceId}`)
})
```

---

## Implementation Sketch

### New files (backend)
| File | Purpose |
|------|---------|
| `src/lib/dynsec.js` | dynsec client — wraps the MQTT pub/sub control channel into request-response Promises. |
| `src/lib/ca.js` | Local CA operations — shell out to `openssl` for keypair gen, cert signing, CRL generation. |
| `src/lib/ssh-deploy.js` | SSH/SFTP file deploy — uses `ssh2` npm package. Upload files, run remote commands. |
| `src/sandbox/broker-sandbox.js` | `she.broker.*` API — thin wrapper over `dynsec.js`. |
| `src/web/broker-api.js` | Express routes for the Broker tab UI. |

### New files (frontend)
| File | Purpose |
|------|---------|
| `web/src/pages/Broker.svelte` | Main Broker tab, sub-tab router. |
| `web/src/pages/broker/Users.svelte` | Users & Roles sub-tab. |
| `web/src/pages/broker/Listeners.svelte` | Listeners sub-tab. |
| `web/src/pages/broker/Certificates.svelte` | CA, server cert, client certs. |
| `web/src/pages/broker/SSH.svelte` | SSH / Remote sub-tab. |

### New `config.json` keys
```json
{
  "broker": {
    "mode": "local",
    "configDir": "/etc/mosquitto",
    "reloadCmd": "sudo systemctl reload mosquitto",
    "restartCmd": "sudo systemctl restart mosquitto",
    "dynsec": {
      "adminUsername": "she-admin",
      "adminPassword": "<auto-generated>"
    },
    "caDir": "~/.she/broker/ca",
    "caCertsDir": "~/.she/broker/ca-certs",
    "ssh": {
      "host": "",
      "port": 22,
      "user": "she",
      "identityFile": "~/.she/broker_id_ed25519"
    },
    "apiTimeout": 5000
  }
}
```

### HTTP API routes (all under `/she/broker/`, Bearer token auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/she/broker/status` | dynsec connection state, broker $SYS stats |
| GET | `/she/broker/config` | Read parsed mosquitto.conf |
| PUT | `/she/broker/config` | Write mosquitto.conf (with backup) |
| POST | `/she/broker/reload` | SIGHUP / systemctl reload |
| POST | `/she/broker/restart` | systemctl restart |
| POST | `/she/broker/wizard` | Run dynsec bootstrap wizard |
| POST | `/she/broker/test-ssh` | Test SSH connection |
| GET | `/she/broker/users` | dynsec listClients |
| POST | `/she/broker/users` | dynsec createClient |
| DELETE | `/she/broker/users/:user` | dynsec deleteClient |
| PUT | `/she/broker/users/:user/password` | dynsec setClientPassword |
| GET | `/she/broker/roles` | dynsec listRoles |
| POST | `/she/broker/roles` | dynsec createRole |
| DELETE | `/she/broker/roles/:role` | dynsec deleteRole |
| POST | `/she/broker/roles/:role/acls` | dynsec addRoleACL |
| DELETE | `/she/broker/roles/:role/acls` | dynsec removeRoleACL |
| POST | `/she/broker/users/:user/roles` | dynsec addClientRole |
| DELETE | `/she/broker/users/:user/roles/:role` | dynsec removeClientRole |
| GET | `/she/broker/groups` | dynsec listGroups |
| POST | `/she/broker/groups` | dynsec createGroup |
| DELETE | `/she/broker/groups/:group` | dynsec deleteGroup |
| GET | `/she/broker/ca` | CA cert info |
| POST | `/she/broker/ca/generate` | Generate new CA keypair |
| GET | `/she/broker/ca/certs` | List issued client certs (from sheDB) |
| POST | `/she/broker/ca/certs` | Issue new client cert |
| DELETE | `/she/broker/ca/certs/:serial` | Revoke client cert, regenerate CRL |
| GET | `/she/broker/ca/certs/:serial/download` | Download .p12 / .pem bundle |
| GET | `/she/broker/ca/trusted` | List trusted CA certs in capath dir |
| POST | `/she/broker/ca/trusted` | Add trusted CA cert |
| DELETE | `/she/broker/ca/trusted/:fingerprint` | Remove trusted CA cert |

### sheDB namespaces
| Key pattern | Content |
|-------------|---------|
| `broker::ca` | CA metadata: CN, fingerprint, expiry, generated-at |
| `broker::cert::<serial>` | Issued cert: CN, serial, issued, expires, revoked, revokedAt |

### dynsec request-response pattern

dynsec responses come back on `$CONTROL/dynamic-security/v1/response` as an array of results. she uses a pending-request map keyed by command type (requests serialized per command to avoid correlation ambiguity):

```js
async function dynsecRequest(command, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dynsec timeout')), apiTimeout)
    pending.set(command, (responses) => {
      clearTimeout(timeout)
      const r = responses.find(r => r.command === command)
      if (r?.error) reject(new Error(r.error))
      else resolve(r?.data ?? r)
    })
    mqttClient.publish(
      '$CONTROL/dynamic-security/v1/',
      JSON.stringify({ commands: [{ command, ...payload }] })
    )
  })
}
```

---

## Dependencies (new)

| Package | Use |
|---------|-----|
| `ssh2` | SFTP file upload, remote command execution (no native deps) |

`openssl` CLI is assumed available on the host (standard on Linux/macOS). No new Node packages needed for CA operations.

`mosquitto-acl-parser` (prior art) is **not needed** in the hybrid approach — dynsec replaces static ACL files. Keep it noted if a legacy static-files fallback mode is ever added.

---

## Not in Scope

- Installing Mosquitto (user's responsibility).
- Mosquitto bridge configuration.
- Let's Encrypt / ACME integration (user points she at existing certs).
- HA / clustered broker setups.
- OCSP stapling (CRL file is sufficient for home use).
- PSK (pre-shared key) auth — dynsec doesn't support it; niche use case.
- `per_listener_settings` with separate dynsec instances per listener (very advanced, defer).
