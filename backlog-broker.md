# Backlog: Broker Integration

Optional management of a Mosquitto broker's configuration from within `she`.
The broker is always installed and owned by the user — `she` only manages its config files.

---

## The Core Idea

`she` gets a new **Broker** tab in the web UI. It lets the user:

- Manage Mosquitto users (create / delete / change password).
- Manage ACLs per user and for anonymous/pattern rules.
- Edit general broker config (`mosquitto.conf`) with a nice form or editor.
- Apply changes (write files → reload broker).

Two deployment modes:

| Mode | How she writes config | How she reloads broker |
|------|-----------------------|------------------------|
| **Local** | Writes `.conf`, `.passwd`, `.acl` directly on disk | Sends `SIGHUP` to the mosquitto process (or `systemctl reload mosquitto`) |
| **Remote** | Copies files to broker host via SSH (`scp`/SFTP) | Runs `ssh broker-host sudo systemctl reload mosquitto` (or sends SIGHUP via SSH) |

---

## Files she would manage

| File | Purpose | Notes |
|------|---------|-------|
| `mosquitto.conf` | Main broker config | Point `password_file` and `acl_file` at the managed files |
| `passwd` (via `mosquitto_passwd`) | Hashed credentials | Mosquitto uses its own hash format — must call `mosquitto_passwd` binary to add/change passwords, not write raw hashes |
| `acl` | Topic ACL rules | Plain text; parseable with `mosquitto-acl-parser` (prior art) |

**Important**: The `password_file` format requires hashes produced by `mosquitto_passwd -b`. `she` cannot hash passwords itself and write them directly — it must shell out to `mosquitto_passwd` (local mode) or scp + run remotely (remote mode). This is a real implementation constraint.

**Alternative**: Use the **Dynamic Security plugin** (`mosquitto-dynsec`) instead of static files — see discussion below.

---

## UI Sketch

### Users Panel
- Table: username | actions (edit password, delete)
- "Add user" button → dialog: username + password (with show/hide toggle)
- Password strength indicator (optional, cosmetic)

### ACL Panel
- Leverages `mosquitto-acl-parser` (your prior art) for parse/stringify
- Three sections mirroring the ACL file structure:
  - **Anonymous topics** (no-username clients)
  - **Per-user topics** — user selector → topic list with permission (read/write/readwrite/deny)
  - **Pattern rules** (`%u`, `%c` substitution) — global, shown separately
- Each topic row: topic string | permission dropdown | delete button
- "Add topic" per section

### General Config Panel
- Curated form for the most-used options: `allow_anonymous`, listener port, TLS cert paths, `log_type`, `persistence`, etc.
- "Advanced" toggle opens a raw text editor for the full `mosquitto.conf`

### Apply / Reload
- "Apply" button writes all managed files, then triggers reload
- Status indicator: last applied timestamp, whether broker responded to SIGHUP

---

## SSH / Remote Mode

Config options to add to `config.json`:

```json
{
  "broker": {
    "mode": "local",               // "local" | "remote"
    "local": {
      "configDir": "/etc/mosquitto",
      "passwdBin": "mosquitto_passwd",
      "reloadCmd": "systemctl reload mosquitto"
    },
    "remote": {
      "host": "192.168.1.10",
      "port": 22,
      "user": "she",
      "identityFile": "~/.she/broker_id_ed25519",
      "configDir": "/etc/mosquitto",
      "reloadCmd": "sudo systemctl reload mosquitto"
    }
  }
}
```

### SSH Key Management in Config UI

A dedicated **SSH Keys** section on the Broker config page:

- **Generate keypair** button → `ssh-keygen -t ed25519 -f ~/.she/broker_id_ed25519 -N ""` → shows public key in a readonly textarea.
- **Copy public key** button — copies the pubkey to clipboard.
- **Install key on broker** helper — shows the exact command to paste in the broker terminal: `ssh-copy-id -i ~/.she/broker_id_ed25519.pub she@broker-host` (or `cat pubkey >> ~/.ssh/authorized_keys`).
- **Test connection** button — runs `ssh -i ... she@broker-host echo ok` and reports success/failure.
- Note that password-based SSH auth is explicitly not supported (no interactive password prompts in a web UI — security risk and UX nightmare).

### File transfer approach
- Use `node-ssh` or `ssh2` npm package for SFTP file upload.
- Upload to a temp path, then `mv` to final path (atomic), then reload.
- Alternatively, write locally to a staging dir under `~/.she/broker/` and push on Apply.

---

## Alternatives & Discussion Points

### A) Static files (`password_file` + `acl_file`) — the "traditional" approach
**Pros**: Simple, well-understood, what your `mosquitto-acl-parser` already handles.
**Cons**: Password management requires calling the `mosquitto_passwd` binary. Can't hash passwords without it (the format is bcrypt but with a non-standard salt prefix). Reload via `SIGHUP` works, but in-flight connections are unaffected (ACL changes don't kick out existing sessions).

### B) Dynamic Security Plugin (`mosquitto-dynsec`)
Mosquitto ships a built-in dynamic security plugin since v2.0. It exposes a control API via MQTT topics (`$CONTROL/dynamic-security/v1/...`). `she` could use its own MQTT connection to manage users/ACLs without touching any files or SSH.
**Pros**: No file writing, no SIGHUP, no SSH needed. Changes take effect immediately. Works local and remote identically. API is well-documented.
**Cons**: Requires mosquitto ≥ 2.0 with the plugin enabled. More complex to set up initially. The `$CONTROL` API is verbose. Debugging is harder (no plain-text files to inspect). You lose the "look at the file" debugging experience.
**Verdict**: worth considering as a second mode, or even the primary mode for new setups. The Static Files mode is simpler for users who already have mosquitto configured.

### C) Hybrid: dynsec for users/ACLs + static conf for listener/TLS settings
The dynsec plugin only handles auth/ACLs. `she` could manage `mosquitto.conf` via static files while delegating user/ACL management to the dynsec API. This gives the best of both: no `mosquitto_passwd` binary dependency, no SIGHUP for auth changes, but still a single place to manage the full config.

### D) No SSH: require broker on same host or shared filesystem
The simplest scope: **local mode only** for v1. Remote mode is a nice-to-have but adds significant complexity (SSH library dependency, key management, error handling for network failures during apply, etc.). Could defer remote mode to a follow-up.

---

## Open Questions / Things to Decide

1. **Static files vs dynsec**: Start with static files (lower broker version requirement, simpler logic) and add dynsec as an option later? Or go dynsec-first?

2. **Password hashing without `mosquitto_passwd`**: Could implement bcrypt hashing in Node.js ourselves — mosquitto uses bcrypt with a specific prefix (`$7$` for SHA512, historically `$6$`). Actually mosquitto uses its own format — needs more investigation. Calling the binary is safer.

3. **Remote mode scope**: Include in v1 or defer? SSH adds a lot of surface area (auth, error handling, key management UX).

4. **Reload mechanism**: `SIGHUP` requires `she` to have permission to signal the mosquitto process. In systemd environments `systemctl reload mosquitto` is cleaner. Should be configurable. For remote mode, the user will need to grant passwordless `sudo` for the reload command — this should be documented clearly.

5. **Config backup**: Before writing any file, `she` should create a timestamped backup (`.conf.bak-<timestamp>`). Important for safety since a bad config will prevent the broker from starting.

6. **Conflict detection**: If the user edits `mosquitto.conf` outside `she`, she's changes could overwrite them. Need a "last-known-good" checksum or a diff-and-merge strategy. At minimum, warn the user on Apply if the file has changed since she last read it.

7. **ACL `deny` rules**: `mosquitto-acl-parser` supports them. Make sure the UI exposes `deny` as a permission option — it's easy to miss and important for security.

8. **Multiple listeners**: `mosquitto.conf` supports multiple `listener` blocks with per-listener auth. The config form could start simple (single listener) and add multi-listener support later.

---

## Prior Art

- **`mosquitto-acl-parser`** (your own, https://github.com/hobbyquaker/mosquitto-acl-parser): parse/stringify the ACL file format. Already handles `topics`, `users`, and `patterns` sections. Can be used directly as a library in the backend ACL API. It's 9 years old but the format hasn't changed — still valid.

---

## Implementation Sketch (local static-files mode, minimal v1)

1. New `src/web/broker-api.js` — express routes:
   - `GET /she/broker/config` — read and parse all managed files
   - `PUT /she/broker/config` — write `mosquitto.conf` (with backup), `SIGHUP`/reload
   - `GET /she/broker/users` — parse `passwd` file (usernames only, no hashes)
   - `POST /she/broker/users` — add user (`mosquitto_passwd -b passwd user pass`)
   - `DELETE /she/broker/users/:user` — remove user (`mosquitto_passwd -D passwd user`)
   - `PUT /she/broker/users/:user/password` — change password (`mosquitto_passwd -b passwd user pass`)
   - `GET /she/broker/acl` — parse and return ACL as JSON (via `mosquitto-acl-parser`)
   - `PUT /she/broker/acl` — stringify and write ACL file (with backup), `SIGHUP`
   - `POST /she/broker/reload` — send `SIGHUP` / run reload command
   - `POST /she/broker/test-connection` — (remote mode) test SSH connectivity

2. New `web/src/pages/Broker.svelte` — the UI tab.

3. Config schema additions in `src/config.js` / `config.json`.

---

## Not in scope

- Installing Mosquitto (user does that themselves).
- Mosquitto bridges configuration (could be a follow-up item).
- TLS certificate generation (just point to existing certs).
- HA / clustered setups.
