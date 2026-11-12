# Security

## Trust model

**she is designed to run inside a trusted local network, accessed by trusted clients.**

It is generally not a good idea to expose she — or the MQTT broker it connects to, or the smart home devices behind it — directly to the internet, or to any environment where untrusted clients can reach it. This applies equally to the web UI, the HTTP API, and the WebSocket endpoint. If you need remote access, route it through a hardened intermediary rather than exposing she directly.

This does not mean she is insecure by design — it means the trust boundary is the network perimeter, and you are responsible for where you draw that line. A home automation system that talks to locks, alarms, presence sensors, and actuators deserves the same consideration as any other security-sensitive service you run at home.

## Auth modes

she has three auth modes, set via `auth` in `config.json`:

| Mode | Description |
|------|-------------|
| `none` | No authentication (default). Suitable for a local network where you trust all clients. |
| `password` | Session-based login with a bcrypt-hashed password. Sessions last 7 days and survive a restart of the daemon — see [Sessions](#sessions). |
| `proxy` | Trust an upstream reverse proxy to authenticate users via a configurable header (e.g. `X-Remote-User`). Recommended for internet-facing deployments. |

When auth is enabled, the `/she/*` API routes and the WebSocket endpoint are protected. See [Script API endpoints](#script-api-endpoints) below for an important caveat about script-registered routes.

### Sessions

A successful login in `password` mode sets the HttpOnly cookie `she_session`, a random 256-bit token that is valid for 7 days. she keeps the sessions in `~/.she/config/sessions.json` (in the data directory, see `--data-dir`), so a restart or an update of the daemon does not send everyone back to the login form. The file holds only the SHA-256 hash of each token and its creation time, is readable by the daemon's user only (`0600`), and is written atomically. A copy of it — in a backup, say — is therefore not a set of working cookies.

- **Logout** removes the session from the file, not only the cookie from the browser.
- **Switching away from `password` mode** — in the web UI or in `config.json` — discards all sessions and deletes the file.
- **Expired sessions** are dropped whenever the file is read or written.
- **A missing, unreadable or damaged file** means that nobody is logged in; the daemon starts regardless. If the file cannot be written (a read-only data directory), sessions last until the daemon stops.
- **A new password** ends every other session: set in the web UI, only the browser that changed it stays logged in; changed in `config.json` by hand, everybody logs in again after the restart.
- **To log everyone out**, set a new password, or stop the daemon, delete the file and start it again.

## HTTPS

Always terminate TLS when she is accessible beyond localhost. The recommended approach is a reverse proxy (nginx, Caddy) that handles TLS and forwards to she over HTTP on localhost. This also enables you to use a public CA certificate (e.g. Let's Encrypt) without she managing certificates itself.

An example nginx config is provided in [doc/nginx.conf](nginx.conf).

## Reverse proxy and auth proxy

For internet-facing deployments, `auth: 'proxy'` in combination with an authenticating reverse proxy is the recommended approach. The proxy handles login, MFA, and session management; she trusts the proxy-injected header and does not need to know about users or passwords at all.

Any reverse proxy that can inject a user-identity header after successful authentication works. Common choices:

- **[Authentik](https://goauthentik.io/)** — full OIDC/SAML identity provider with a built-in forward-auth proxy; suits households that also want SSO across multiple self-hosted services
- **[Authelia](https://www.authelia.com/)** — lightweight forward-auth proxy with MFA; integrates directly with nginx or Traefik
- **nginx `auth_basic`** — the simplest option for single-user access; no SSO, just an htpasswd file and a browser prompt

Set `authProxyHeader` in `config.json` to whichever header your proxy injects (default: `x-remote-user`).

## Network segmentation

Regardless of auth mode:

- Run your IoT devices on a **separate VLAN** isolated from your main network. MQTT traffic stays on the IoT VLAN; she bridges it to your personal devices but untrusted IoT devices cannot reach your laptops or NAS directly.
- Consider a **VPN** as an alternative to exposing she over the internet at all.
- Setup good firewall rules

## Script API endpoints

Scripts can register their own HTTP routes under `/api/<scriptName>/` using `she.api.*` and `she.http.sub()`. These routes are **intentionally not covered by she-level auth** — the design intent is that scripts control their own access, because some script endpoints are legitimate public webhook receivers (called by external services that cannot present a session cookie or proxy header).

In practice this means that even with `auth: 'password'` or `auth: 'proxy'` enabled, script-registered routes remain accessible without authentication unless the script implements its own access control. Be aware of this when writing scripts that expose sensitive state (presence, lock status, alarm state) via `she.api.*`.

A script can inspect `req.headers` to implement its own auth — for example, verify a shared secret in the `Authorization` header for webhook endpoints.

> This behaviour is tracked as a known limitation and a more ergonomic solution (auth inherited by default, with an explicit `{ public: true }` opt-out for webhook receivers) is planned.

## The script directory and symbolic links

The HTTP API reads and writes script files only inside the script directory. A path is checked the way the file system resolves it, not as a string: a symbolic link inside the script directory that points out of it — put there by hand, or checked out with a git repository — is not followed. `GET`, `PUT` and `mkdir` on `/she/scripts`, the text search, the AI assistant's `read_script` and its script proposals refuse such a path (the search skips the file). A link whose target is inside the script directory keeps working, as does a script directory that is itself a link. A link to a target that does not exist is refused as well, because writing to it would create the target. `DELETE` and rename act on the link, not on its target, so a link that leaves can still be removed in the web UI. The git routes take paths below the script directory only and hand them to git, which does not follow links.

The script engine follows the same rule: **a script that a symbolic link brings in from outside the script directory is not loaded.** That holds for a linked `.js` file, for a linked directory and everything below it, and for a file a script loads with a relative `require()` (a file in a `.shelib` library directory included). she writes one warning per entry to the log — `<path>: not loaded — the link points outside the script directory`, when it starts and when the watcher sees a new link — and the file tree on the Scripts page marks the entry "outside, not loaded". Before 3.0.0 such a script ran; it would now run without being readable or editable in the web UI, so it does not run at all. Copy the file into the script directory, or make the directory that holds it the script directory. A link whose target is inside the script directory is loaded and edited like any other file.

Two things this does not change. The script engine itself follows links: a linked script file is loaded and runs wherever its target is — only the API stops reading and writing it. And scripts are code with the daemon's rights; whoever may edit a script can read whatever the `she` user can. The check keeps the *file API* inside its directory; it is not a sandbox.

The broker page's config restore copies only a regular file named `mosquitto.conf.bak-…` from the config directory, never a link.

## Third-party npm packages in scripts

Scripts run inside a Node.js VM sandbox, but they can `require()` any package that is installed in the global Node.js environment or in the she package itself. This means that **whatever npm package you load into a script runs with the same privileges as the she process** — full filesystem access, network access, and access to all connected devices.

npm is a large, open ecosystem. The vast majority of packages are written in good faith, but the historical record includes a meaningful number of packages that were malicious (credential theft, crypto miners, backdoors) or simply of such low quality that they introduced severe vulnerabilities. Supply-chain attacks — where a legitimate package is later compromised — are a documented and recurring threat.

**Recommendations:**

- **Keep third-party dependencies at an absolute minimum.** Before reaching for an npm package, ask whether the task can be done with the built-in sandbox API (`she.mqtt`, `she.db`, `she.http.fetch`, …) or with a short piece of code you write yourself.
- **Read the code you introduce.** If you do use a package, read every line that will execute in your scripts. This is realistic for small, focused utilities (a handful of functions, no transitive dependencies); it is not realistic for large packages with deep dependency trees.
- **Prefer zero-dependency packages.** Each transitive dependency is an additional attack surface you did not review.
- **Pin exact versions.** Use `npm install --save-exact` so an update cannot silently swap in different code.
- **Check package provenance.** Look at download counts, publish history, the source repository, and when the last version was published. A package that was dormant for two years and suddenly received an update deserves extra scrutiny.
- **Never install a package solely because a tutorial or an AI assistant suggested it** without first reviewing what it actually does.

You are responsible for every piece of code that runs in your smart home. A compromised script has access to your presence sensors, locks, alarms, and anything else connected to your broker. Treat npm installs in this context with the same caution you would apply to running an unknown binary as root.

## Secrets

The **Secrets** tab stores values for scripts (`she.secrets.get('smtp/password')`) in `~/.she/config/secrets.enc`, AES-256-GCM, key from `SHE_SECRETS_KEY` or `~/.she/config/secrets.key` (generated `0600` on the first write). Be clear about what that buys: a backup, a copied `~/.she`, or the scripts repository holds no plaintext. It does **not** protect against a reader on the she host — the daemon user can read the key file, and so can root. Keep the key out of backups if the backups are what you worry about; pass it via `SHE_SECRETS_KEY` (systemd `LoadCredential`, Docker secrets) if the data directory is what you worry about.

Fields are *secret* or *plain*: for secret fields the HTTP API is write-only — names and change times are readable, the value is not, by any route; plain fields (a user name, a host) are listed in clear and are not redacted in logs. The kind is chosen at creation; a plain field can be marked secret (one-way), never the reverse — the only way back to readable is delete and re-create. With `--auth none` anyone who can reach she can *overwrite* secrets (as they can edit scripts, which can read them) — the trust model is the same as for scripts. Known secret values are redacted to `***` in the log sinks (Logs tab, `she.jsonl` — rotated at 10 MB, five files kept — and console; all three honour the configured verbosity) so a logged response body does not leak a token; that is a convenience, not a guarantee — a script can still publish a secret to MQTT or write it into sheDB.

## Service management helper (`she-servicectl`)

With the optional Services feature ([doc/services.md](services.md)) she manages xyz2mqtt adapter instances on the host: systemd units, env files under `/etc/<adapter>/`, `npm install -g`. The daemon user does **not** get a general `sudo` for this. `sudo she --install` installs one POSIX shell script, `/usr/local/bin/she-servicectl`, and writes `/etc/sudoers.d/she`:

```
she ALL=(root) NOPASSWD: /usr/bin/systemctl restart smart-home-engine
she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl
```

The first line is the UI's *Restart* button. The second is the helper, and with it everything else she does as root: the Services feature, and she's own update — the helper's `she-update <version>` accepts a release version (`3.0.0`, `3.0.0-beta.2`: digits, dots, a pre-release suffix) and nothing npm could read as a range, a tag, a URL or a second package, and the daemon restarts only after npm exited 0.

Installations set up before 3.0.0 have a third line, `she ALL=(root) NOPASSWD: <npm> install -g smart-home-engine`, which was she's own update until 3.0.0-beta.1. she no longer uses it and `she --install` no longer writes it; it goes away on its own with the next update through the web UI: since helper v17 (shipped with 3.0.0), `she-update` removes exactly that line once npm has succeeded. The helper writes the file without the line next to the original, has `visudo -c -f` check the copy and only then renames it over `/etc/sudoers.d/she`; every other line stays as it is, and if the check fails — or there is no `visudo` — the file is left untouched and the helper says so on stderr, without failing the update. The helper that runs an update is the one already installed, so an installation whose helper is older than v17 needs *Update helper* on the Services → Hosts tab first (the tab marks it *outdated*); the update after that removes the line. `sudo she --install` removes it as well (it writes the file anew), as does deleting the line with `sudo visudo -f /etc/sudoers.d/she`.

The script is the complete list of what she can do as root — including `self-update`, which replaces the script with the copy she sends after checking the header, the `VERSION` line and `sh -n` (a `.bak` is kept): she already runs adapter installers and `npm install -g` as root through this rule, so letting it refresh the helper adds no reach it did not have. It does mean the she user's trust level is "root on the managed hosts", which is why the Services feature belongs behind she's authentication. it accepts a fixed set of subcommands, validates every argument against a pattern (adapter names must correspond to a template unit with mqtt-interfaces-core's `/etc/<adapter>/%i.env` layout, instance names are `[A-Za-z0-9_.-]+`, actions come from a short allow-list) and takes free-form data — env files, install options — only on stdin. Review it once ([service/she-servicectl](../service/she-servicectl)); it has no dependencies beyond systemd, journalctl and npm.

Consequences to keep in mind:

- Whoever can use she's web UI can (re)configure, restart and uninstall adapter instances on the host and install newer adapter versions from npm — the Services feature is an admin feature; keep it behind she's authentication or a trusted network.
- Removing she from a host is the helper's job too (`remove-key`, `teardown`): the key it deletes is the one she sends on stdin, the only account it ever removes is `she-services` (the one the setup command created) and only when she logs in as that account, and it refuses a teardown while other keys remain in that account's `authorized_keys` unless told to force — so one she instance cannot silently cut off another. Adapters and their files are out of its reach in either mode.
- The Files tab reads and writes only inside `/etc/<adapter>/` and `/var/lib/<adapter>/<instance>/` — the helper checks the `realpath` of every path (symlinks out of those directories are refused) and the API rejects `..` and the env file; new files are `0640 root:<adapter>`, edits keep the owner/mode and a `.bak`. Package assets (examples, schemas) are read from the adapter's own directory only.
- Env files are written `0640 root:<adapter>`; the API masks secrets (`x-secret` in the adapter's schema plus a name heuristic) in its responses, and install options travel as environment variables, not command-line arguments.
- `npm install -g <adapter>@latest` runs as root on the host, like she's own self-update — for packages already installed as adapters (*Update*), and for catalog members (*Install*): packages of the npm publishers listed in `services.trustedPublishers` whose latest version depends on `mqtt-interfaces-core`. Nothing outside that set can be installed from she.
- **Remote hosts** are reached as the configured SSH user with the services key (`<data-dir>/ssh/services_id_ed25519`, unprotected on disk like the broker key). That user needs exactly one sudo rule — `<user> ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl` — which she prints but never writes; a `root` SSH user needs none. Host keys are trusted on first contact (`accept-new`) and verified afterwards.
- **The remote-host setup command** (`curl … /she/services/setup.sh?token=… | sudo bash`) runs a script as root on the target. What it does is fixed and embedded (user `she-services`, key, helper, one sudoers rule, callback) — nothing is downloaded at run time. `setup.sh` and the `setup/done` callback are the only unauthenticated routes besides login: both require a 24-byte random token minted from the (authenticated) Settings page, valid 15 minutes, script served once, callback accepted once. The token stops strangers from using the endpoint; it does not protect a plain-HTTP transfer from tampering on a hostile network — use HTTPS via a reverse proxy there, or download the script, compare the sha256 shown in Settings, and run the file.
- With Mosquitto management and dynsec, an instance can get a **dedicated broker identity** (`svc-<instance>`, role with an ACL for `<instance>/#` and `homeassistant/#` only) instead of she's own credentials — least privilege on the broker side, mirroring the helper on the host side. she creates and deletes those clients through the dynsec admin connection; their passwords are random and stored only in the instance's env file (`0640 root:<adapter>`).
- Adapters' maintenance topics (`<name>/maintenance/set/restart`, `…/loglevel`) are plain MQTT; restrict them with broker ACLs if the broker is reachable from untrusted networks, or run the adapter with `--no-maintenance` (she then hides those actions).

## Mosquitto Dynamic Security

If you run Mosquitto as your MQTT broker, the **Dynamic Security plugin** lets you define per-client ACLs that control which topics each client may publish or subscribe to. This limits blast radius if a script or IoT device misbehaves — a device that should only publish its own sensor data cannot subscribe to lock commands.

she includes built-in support for managing Mosquitto Dynamic Security: client and role management, ACL assignment, via a web UI in the Broker tab and with a script api.

See [Broker management](broker-management.md) for setup instructions and configuration details.
