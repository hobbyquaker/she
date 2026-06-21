# Broker Management

she can optionally manage a local or remote [Mosquitto](https://mosquitto.org/) broker — configuration files, user accounts, access control lists, TLS certificates, and more. Everything is accessible from the **Broker** tab in the web UI and from scripts via `she.broker.*`.

> **Prerequisites**
> - Mosquitto must already be installed and running. she does not install Mosquitto for you.
> - For the Setup Wizard in **local mode**: `mosquitto_ctrl` must be installed on the she host. In **remote mode**: `mosquitto_ctrl` must be installed on the remote broker host — she invokes it via SSH. `mosquitto_ctrl` is part of the `mosquitto` package (not `mosquitto-clients`).
> - For CA and certificate operations: `openssl` CLI (standard on Linux/macOS).
> - For SSH/remote mode: `ssh` and `scp` must be available in PATH on the she host, plus `ssh-keygen` for keypair generation.

---

## Architecture

Two subsystems handle different concerns:

| Subsystem | Manages | How |
|-----------|---------|-----|
| **Dynamic Security plugin (dynsec)** | Users, passwords, roles, ACLs, groups | MQTT control channel — changes are instant, no restart needed |
| **`mosquitto.conf`** | Listeners, TLS cert paths, plugin line, logging | Written by she directly (local) or via SFTP (remote), then reloaded |
| **Local CA** | CA keypair, server cert, client certs, CRL | `openssl` CLI, cert metadata stored in sheDB |

### Deployment modes

Remote mode is activated automatically when `broker.ssh.host` is set. No separate `mode` field is needed.

| Mode | Config files | Users/ACLs |
|------|-------------|------------|
| **Local** (no `ssh.host`) | Written directly to disk (e.g. `/etc/mosquitto/`) | dynsec over MQTT |
| **Remote** (`ssh.host` set) | Uploaded via SCP, reload/restart via SSH | dynsec over MQTT (no SSH needed for day-to-day operation) |

---

## Setup

### Option A — Setup Wizard (new installations)

1. Open the **Broker** tab in the web UI.
2. Click **Run Setup Wizard**.
3. The wizard probes whether dynsec is already active, then:
   - Generates a `she-admin` service account with a random strong password.
   - Writes `dynamic-security.json` to your mosquitto config directory.
   - Adds the `plugin` line to `mosquitto.conf`.
   - Saves the credentials to `~/.she/config.json` automatically.
4. Click **Restart mosquitto** to activate the plugin (a full restart is required when enabling a new plugin for the first time).

### Option B — Manual (existing dynsec installations)

Add the following to `~/.she/config.json`:

```json
{
  "broker": {
    "dynsec": {
      "adminUsername": "she-admin",
      "adminPassword": "your-admin-password"
    }
  }
}
```

Then restart she. Use the **Test dynsec connection** button on the Status tab to verify connectivity.

### Full config reference

```json
{
  "broker": {
    "configDir": "/etc/mosquitto",
    "reloadCmd": "sudo systemctl reload mosquitto",
    "restartCmd": "sudo systemctl restart mosquitto",
    "apiTimeout": 5000,
    "dynsec": {
      "adminUsername": "she-admin",
      "adminPassword": "..."
    },
    "caDir": "~/.she/broker/ca",
    "caCertsDir": "~/.she/broker/ca-certs",
    "ssh": {
      "host": "192.168.1.10",
      "port": 22,
      "user": "root",
      "identityFile": "~/.she/ssh/broker_id_ed25519"
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `configDir` | `/etc/mosquitto` | Directory containing `mosquitto.conf` |
| `reloadCmd` | `sudo systemctl reload mosquitto` | Command to send SIGHUP / reload |
| `restartCmd` | `sudo systemctl restart mosquitto` | Command for a full restart |
| `apiTimeout` | `5000` | Timeout in ms for dynsec requests |
| `dynsec.adminUsername` | — | Username of the dynsec admin account |
| `dynsec.adminPassword` | — | Password of the dynsec admin account |
| `caDir` | `~/.she/broker/ca` | Directory for CA keypair and issued certs |
| `caCertsDir` | `~/.she/broker/ca-certs` | Directory of trusted CA certs for client auth (`capath`) |
| `ssh.host` | — | Broker host. When set, **remote mode is active** — SSH is used for all file operations and service control. |
| `ssh.port` | `22` | SSH port |
| `ssh.user` | current OS user | SSH login user |
| `ssh.identityFile` | `<data-dir>/ssh/broker_id_ed25519` | Path to SSH private key |

---

## Web UI

The **Broker** tab has five sub-tabs:

### Status

- dynsec connection state (connected / not configured / error) with a wizard button when not yet configured.
- Live `$SYS` broker stats: version, uptime, connected clients, total clients, messages received/sent.
- A "Test dynsec connection" flow is available via the Setup Wizard's manual path.

### Users & Roles

Manage dynsec users, roles, and groups. All changes take effect immediately — no restart or reload needed.

- **Users** — create/delete users, set passwords, see assigned roles and groups.
- **Roles** — create/delete roles, edit ACL rules per role (type, topic pattern, allow/deny).
- **Groups** — create/delete groups, add/remove users, assign roles to groups.

ACL types supported by dynsec:

| Type | Direction |
|------|-----------|
| `publishClientSend` | Client → broker |
| `publishClientReceive` | Broker → client |
| `subscribeLiteral` | Subscribe (exact topic) |
| `subscribePattern` | Subscribe (wildcard) |
| `unsubscribeLiteral` | Unsubscribe (exact) |
| `unsubscribePattern` | Unsubscribe (wildcard) |

### Listeners

Card-per-listener editor for `mosquitto.conf` listener blocks. Each card exposes:

- Port, protocol (`mqtt` / `websockets`), bind address.
- TLS toggle — when enabled: `certfile`, `keyfile`, `cafile`, `capath`, `crlfile`, TLS version, `require_certificate`, `use_identity_as_username`.

Click **Save** then **Apply & Reload** to write the config and send a SIGHUP.

Before every write a timestamped backup is created (e.g. `mosquitto.conf.bak-2026-06-18T14-30-00`). The **Advanced** sub-tab (planned) will expose the raw config editor and backup restore.

### Certificates

Four sections:

**Local CA** — generate an Ed25519 CA keypair + self-signed certificate. The CA private key is stored at `~/.she/broker/ca/ca.key` (chmod 600, unprotected on disk — acceptable for home use).

**Server Certificate** — generate a server keypair + CSR signed by the local CA. Specify Common Name and optional Subject Alternative Names (IPs or hostnames). she reports the cert/key paths so you can paste them into your listener config.

**Trusted CA Certs** — paste or upload PEM certificates into `~/.she/broker/ca-certs/`. she runs `openssl rehash` after each change so Mosquitto can discover them via `capath`.

**Issued Client Certs** — issue certificates for IoT devices:

1. Enter a Common Name (e.g. `esp32-bedroom`) and validity period.
2. she generates an Ed25519 client keypair + CSR + signs with the local CA.
3. Bundles to a `.p12` file with a random passphrase (displayed once — save it).
4. Download `.p12`, `.crt`, `.key`, and `ca.crt` individually.
5. Revoke a cert at any time — she regenerates `crl.pem` automatically.

Cert metadata is stored in sheDB under `she/broker/cert/<serial>` for querying from scripts.

---

## mTLS client authentication with dynsec

When a listener has both `require_certificate true` and `use_identity_as_username true`, Mosquitto maps the TLS client certificate's Common Name (CN) to the MQTT username. Combined with dynsec, this lets IoT devices authenticate with certificates instead of passwords — no shared secrets.

Both options are exposed in the Listeners tab → **TLS** sub-section (visible after enabling the TLS toggle on a listener).

### Step-by-step

1. **Add the issuing CA to Trusted CAs.**  
   In the Certificates tab, paste or upload the PEM of the CA that issued your client certificates (`cafile` or `capath`). This is the CA used by step-ca, XCA, or whichever tool issued your client certs — _not_ necessarily she's own local CA.  
   Then set `cafile` (single CA cert) or `capath` (directory, populated by she via `openssl rehash`) on the listener.

2. **Enable client cert requirements on the listener.**  
   Open the Listeners tab, find your TLS listener, expand the TLS section and enable:
   - `require_certificate` — rejects clients that present no certificate.
   - `use_identity_as_username` — maps the cert CN to the MQTT username (replaces `MQTT CONNECT` username/password).

   Click **Save** → **Apply & Reload**.

3. **Create a matching dynsec user.**  
   In the Users tab, add a user whose username matches the client cert's CN exactly (case-sensitive).  
   Assign it to whatever role grants the necessary topic ACLs.

4. **Test.**  
   Connect with the client cert. Mosquitto will verify the cert chain, extract the CN, and look it up as a dynsec username. If no matching user exists the connection is rejected even if the cert is valid.

### Notes

- This flow works with any external CA — step-ca, XCA, openssl self-signed, etc. she does not need to be the issuer.
- `use_subject_as_username` (also available in the Listeners UI) is an alternative: it uses the full Subject DN rather than just the CN. Useful when CNs are not unique across your CA.
- If you also use she's own local CA for client certs, the cert CN is set at issuance time from the Common Name field in the Issued Client Certs section.

---

### SSH / Remote

Only relevant when `broker.ssh.host` is set (remote mode).

- Configure host, port, user, and identity file.
- **Generate keypair** — creates `<data-dir>/ssh/broker_id_ed25519` via `ssh-keygen`. Displays the public key and the exact `ssh-copy-id` command to install it on the broker host.
- **Test SSH connection** — runs a remote `echo ok` to verify the key is accepted.

---

## `she.broker.*` Script API

All methods return Promises. The default timeout is 5 seconds (configurable via `broker.apiTimeout`). All methods throw a descriptive error if `broker.dynsec` is not configured.

### User management

```js
// Create a new broker user
await she.broker.createUser(username, password)

// Delete a user
await she.broker.deleteUser(username)

// Change a user's password
await she.broker.setPassword(username, newPassword)

// List all users (verbose — includes roles and groups)
const users = await she.broker.listUsers()
// → [{ username, roles: [{ rolename }], groups: [{ groupname }] }, ...]

// Get a single user
const user = await she.broker.getUser(username)
// → { username, roles, groups, clientid }
```

### Role management

```js
// Create a role
await she.broker.createRole(rolename)

// Delete a role
await she.broker.deleteRole(rolename)

// List all roles (verbose — includes ACLs)
const roles = await she.broker.listRoles()
// → [{ rolename, acls: [{ acltype, topic, allow, priority }] }, ...]

// Get a single role
const role = await she.broker.getRole(rolename)

// Add an ACL rule to a role
// type: 'publishClientSend' | 'publishClientReceive' |
//       'subscribeLiteral'  | 'subscribePattern'     |
//       'unsubscribeLiteral'| 'unsubscribePattern'
await she.broker.addACL(rolename, { type, topic, allow: true })

// Remove an ACL rule
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

const groups = await she.broker.listGroups()
// → [{ groupname, roles: [...], clients: [...] }]

// Add a user to a group
await she.broker.addToGroup(username, groupname)

// Remove a user from a group
await she.broker.removeFromGroup(username, groupname)

// Assign a role to a group (all group members inherit the role's ACLs)
await she.broker.assignRoleToGroup(groupname, rolename)
```

### Example — auto-provisioning IoT devices

```js
// When a new device announces itself, create a broker user and assign a role
she.mqtt.sub('devices/new/+', async (topic, payload) => {
    const deviceId = topic.split('/')[2]
    const password = require('crypto').randomBytes(16).toString('hex')

    await she.broker.createUser(deviceId, password)
    await she.broker.assignRole(deviceId, 'iot-device')

    // Store credentials retained so the device can fetch them
    she.mqtt.pub(`devices/${deviceId}/credentials`, { username: deviceId, password }, { retain: true })
    she.info(`Provisioned broker user for ${deviceId}`)
})

// When a device decommissions, clean up
she.mqtt.sub('devices/remove/+', async (topic) => {
    const deviceId = topic.split('/')[2]
    await she.broker.deleteUser(deviceId)
    she.info(`Removed broker user for ${deviceId}`)
})
```

### Example — setting up an ACL role from a script

```js
// Create a role that allows devices to publish sensor data and subscribe to commands
she.schedule('0 3 * * *', async () => {
    try {
        await she.broker.createRole('iot-device')
    } catch { /* already exists */ }

    await she.broker.addACL('iot-device', { type: 'publishClientSend',    topic: 'sensors/#',  allow: true })
    await she.broker.addACL('iot-device', { type: 'subscribePattern',      topic: 'commands/+', allow: true })
    await she.broker.addACL('iot-device', { type: 'publishClientReceive',  topic: 'commands/+', allow: true })

    she.info('iot-device role refreshed')
})
```

### Example — query issued client certs expiring soon

```js
// Alert when a client cert expires within 30 days
she.schedule('0 8 * * *', () => {
    const soon = Date.now() + 30 * 86400_000
    const expiring = she.db.query(
        (doc) => doc._id && doc._id.startsWith('she/broker/cert/') && !doc.revoked && new Date(doc.expires).getTime() < soon,
        (doc) => doc,
    )
    for (const cert of expiring) {
        she.warn(`Client cert for "${cert.cn}" (serial ${cert.serial}) expires ${cert.expires}`)
        she.mqtt.pub(`she/broker/cert/expiring/${cert.cn}`, cert, { retain: true })
    }
})
```

---

## HTTP API

All endpoints are mounted at `/she/broker/*` and require Bearer token authentication.

### Status

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/she/broker/status` | dynsec connection state + `$SYS` stats |

### mosquitto.conf

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/she/broker/config` | Read parsed config (listeners, managed keys, passthrough, checksum) |
| `PUT` | `/she/broker/config` | Write structured config |
| `PUT` | `/she/broker/config/raw` | Write raw config text |
| `GET` | `/she/broker/config/backups` | List backup filenames |
| `POST` | `/she/broker/config/restore` | Restore a backup `{ backup: filename }` |
| `POST` | `/she/broker/reload` | Send SIGHUP / `systemctl reload` |
| `POST` | `/she/broker/restart` | `systemctl restart` |

### dynsec — Users

| Method | Path | Body / Notes |
|--------|------|-------------|
| `GET` | `/she/broker/users` | List all users (verbose) |
| `POST` | `/she/broker/users` | `{ username, password }` |
| `DELETE` | `/she/broker/users/:user` | |
| `PUT` | `/she/broker/users/:user/password` | `{ password }` |
| `POST` | `/she/broker/users/:user/roles` | `{ rolename }` |
| `DELETE` | `/she/broker/users/:user/roles/:role` | |

### dynsec — Roles

| Method | Path | Body / Notes |
|--------|------|-------------|
| `GET` | `/she/broker/roles` | List all roles (verbose) |
| `POST` | `/she/broker/roles` | `{ rolename }` |
| `DELETE` | `/she/broker/roles/:role` | |
| `POST` | `/she/broker/roles/:role/acls` | `{ acltype, topic, allow, priority? }` |
| `DELETE` | `/she/broker/roles/:role/acls` | `{ acltype, topic }` |

### dynsec — Groups

| Method | Path | Body / Notes |
|--------|------|-------------|
| `GET` | `/she/broker/groups` | |
| `POST` | `/she/broker/groups` | `{ groupname }` |
| `DELETE` | `/she/broker/groups/:group` | |
| `POST` | `/she/broker/groups/:group/clients` | `{ username }` |
| `DELETE` | `/she/broker/groups/:group/clients/:user` | |
| `POST` | `/she/broker/groups/:group/roles` | `{ rolename }` |
| `DELETE` | `/she/broker/groups/:group/roles/:role` | |

### Local CA

| Method | Path | Body / Notes |
|--------|------|-------------|
| `GET` | `/she/broker/ca` | CA cert info (CN, fingerprint, expiry) |
| `POST` | `/she/broker/ca/generate` | `{ cn?, days? }` — generate CA keypair |
| `GET` | `/she/broker/ca/server` | Server cert info |
| `POST` | `/she/broker/ca/server/generate` | `{ cn, san?, days? }` |
| `GET` | `/she/broker/ca/certs` | List issued client certs (from sheDB) |
| `POST` | `/she/broker/ca/certs` | `{ cn, days? }` — issue client cert |
| `DELETE` | `/she/broker/ca/certs/:serial` | Revoke + regenerate CRL |
| `GET` | `/she/broker/ca/certs/:serial/download` | `?type=p12\|crt\|key\|ca` |
| `GET` | `/she/broker/ca/trusted` | List trusted CA certs in capath dir |
| `POST` | `/she/broker/ca/trusted` | `{ pem }` — add trusted CA cert |
| `DELETE` | `/she/broker/ca/trusted/:fingerprint` | |

### Bootstrap Wizard

| Method | Path | Body / Notes |
|--------|------|-------------|
| `POST` | `/she/broker/wizard/probe` | Check if dynsec is already active |
| `POST` | `/she/broker/wizard/bootstrap` | `{ adminUsername?, adminPassword?, configDir? }` |

### SSH

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/she/broker/ssh/keygen` | Generate Ed25519 keypair, return public key |
| `POST` | `/she/broker/ssh/test` | Test SSH connection, return `{ ok, error? }` |

---

## sheDB namespaces

| Key pattern | Content |
|-------------|---------|
| `she/broker/ca` | CA metadata: CN, fingerprint, expiry, generated-at |
| `she/broker/cert/<serial>` | Issued cert: `{ cn, serial, fingerprint, issued, expires, revoked, revokedAt }` |

---

## External references

- [Mosquitto documentation](https://mosquitto.org/documentation/)
- [Mosquitto Dynamic Security plugin](https://mosquitto.org/documentation/dynamic-security/) — full command reference, role/ACL semantics, default ACL behaviour
- [mosquitto.conf man page](https://mosquitto.org/man/mosquitto-conf-5.html) — all configuration directives
- [`mosquitto_ctrl` man page](https://mosquitto.org/man/mosquitto_ctrl-1.html) — CLI tool used for dynsec bootstrap (part of the `mosquitto` package; in remote mode she invokes it on the broker host via SSH)
- [openssl genpkey](https://www.openssl.org/docs/man1.1.1/man1/genpkey.html), [openssl req](https://www.openssl.org/docs/man1.1.1/man1/req.html), [openssl x509](https://www.openssl.org/docs/man1.1.1/man1/x509.html) — used for CA operations
- [OpenSSH](https://www.openssh.com/) — SSH client (`ssh`, `scp`) used for remote mode; must be available in PATH on the she host
