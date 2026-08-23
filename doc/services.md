# Services — managing xyz2mqtt adapters

she can optionally show and operate the `xyz2mqtt` adapter instances of your home — the small daemons that bridge a device or cloud service to MQTT (lgtv2mqtt, cul2mqtt, alexa-remote-mqtt, …). Adapters built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) get the full feature set; anything that only publishes a `<name>/connected` topic — older adapters, but also ESPHome devices and similar firmware — is a *legacy* row, hidden by default (tick *show legacy* on the Instances tab).

Enable it under **Settings → Services**; the **Services** page then appears in the navigation. Nothing else in she depends on it.

## What you get

| Tier | Needs | Gives |
| --- | --- | --- |
| **MQTT** (always) | nothing — she already sees every retained topic on the broker | inventory of all instances (adapter, version, host, pid, uptime, connected state), restart and log level over the adapters' maintenance topics, "update available" badge (npm registry, checked once a day), wiping the retained topics of an instance that is gone |
| **Host** | the `she-servicectl` helper on the host — installed by `sudo she --install` on the she host, deployed over SSH to other hosts | systemd control (start/stop/restart/enable/disable), journal logs (tail + live follow), editing the instance's env file with a form generated from the adapter's `--config-schema` (with a *use she's broker settings* switch), installing and uninstalling instances, updating adapters via npm |

| **Catalog** | the npm registry (cached a day) | the adapters you can install: the trusted publishers' packages whose latest version depends on mqtt-interfaces-core; one click installs them on a host |

## How adapters look to she

Every core adapter instance publishes two retained topics:

- `<name>/connected` — `0` (down, LWT), `1` (MQTT only), `2` (MQTT and device online)
- `<name>/info` — `{ "name": "<npm package>", "version", "spec", "node", "host", "pid", "started", "maintenance", … }`

and, unless started with `--no-maintenance`, listens on `<name>/maintenance/set/loglevel` and `<name>/maintenance/set/restart`. The instance name `<name>` is the topic prefix and the systemd instance (`<adapter>@<name>`).

On a host the core's `--install` leaves:

| Path | Purpose |
| --- | --- |
| `/etc/systemd/system/<adapter>@.service` | template unit (one per adapter; she recognises it by its `EnvironmentFile=/etc/<adapter>/%i.env` line). Units written by early core versions do not read the shared `broker.env`; the Hosts tab marks those *no broker.env* — reinstalling one instance of the adapter rewrites the unit |
| `/etc/<adapter>/<name>.env` | the instance's options as `<ADAPTER>_*` variables — what the config form edits |
| `/etc/mqtt-interfaces/broker.env` | optional `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS_CA` shared by all instances on the host — a core convention she does not manage; use the *use she's broker settings* switch per instance instead |
| `/var/lib/<adapter>/<name>/` | per-instance state (pairing keys, cookies) — shown, never touched |

An MQTT instance and a host instance are the same row when the instance names match and `info.host` equals the host's hostname.

**Old units.** An adapter installed before the core — a plain `<adapter>.service` with its env file in `/etc/default/<adapter>` (or a core adapter still running under such a unit) — is recognised too (helper v5+): it appears on the Instances tab marked *old unit*, matched to the MQTT instance of the same adapter on that host, with start/stop/restart, logs and the config form (editing `/etc/default/<adapter>`), but no Files tab and no Uninstall. **Migrate** turns it into a proper instance: she runs the adapter's own `--install --name <n>` with the old settings as environment (the adapter carries its state over — alexa-remote-mqtt copies the login cookie, lgtv2mqtt the pairing key), then disables the old unit and keeps its files as `.migrated`. The instance name defaults to the MQTT topic prefix so nothing changes on the broker.

## The Services page

- **Instances** — one row per instance: adapter and version (with the npm update badge), host, state (connected dot plus the systemd state when the host is managed), uptime, a log-level selector, and the actions the row supports: *Config / Logs* (opens the drawer), *Restart*, *Stop*/*Start*, *Enable*, *Uninstall*, *Wipe* (only while `connected = 0`). The nav dot is the worst case over all instances.
- **Hosts** — per managed host: helper status with *Test* (runs `she-servicectl version`), *Deploy helper* / *Update helper* and *Remove…* (see [Remote hosts](#remote-hosts)); installed adapters with version and origin, *Update* (`npm install -g <adapter>@latest`, then restarts the adapter's instances). An adapter installed with npm (Catalog → *Install*) that has no instance yet is listed too — the helper finds it by the `mqttInterfaces` field in its package.json — with a *+ add instance* button; its template unit appears with the first `--install`. Hosts that adapters report in `info.host` but that are not configured are listed underneath as *seen on MQTT, not managed*, with their instances. Adapters that were deployed manually (a tarball extracted to `/usr/local/lib/node_modules`, e.g. by an adapter's `deploy.sh`) are marked *manual*; updating them asks first because the npm version replaces the manual deploy.
- **Catalog** — the adapters on npm you can install: every package of the *trusted publishers* (Settings → Services, default `hobbyquaker`) whose latest version depends on `mqtt-interfaces-core` — depending on the core is the membership criterion, nothing else is needed. Shows version, publisher, host prerequisites (`needs` from the package's `mqttInterfaces` field), where it is already installed, and *Install*/*Update on <host>* (`npm install -g <adapter>@latest` through the helper). The registry is asked once a day; ↺ refreshes; when it is unreachable the last list is kept and marked stale.
- **+ Add instance** (a panel in the Instances tab; the Hosts tab and the Catalog open it with host and adapter preselected) — pick host and adapter, choose the instance name, fill in the options (required ones first, the shared MQTT options collapsed; *Use she's broker settings* is on by default so the instance connects to the same broker as she), *Install*. The wizard runs `<adapter> --install --name <instance>` with the options passed as environment variables, so secrets never show up in a process list.

The drawer's **Config** tab edits `/etc/<adapter>/<name>.env`. Secrets (`x-secret` in the schema, or names containing password/token/secret/cookie/key) are masked; they stay unchanged unless you type a new value. *Save & restart* applies immediately.

**Broker credentials** (in the MQTT section) is a three-way choice per instance:

| Mode | What she writes into the env file | Marker |
| --- | --- | --- |
| **own values** | nothing — the URL/username/password you type | — |
| **she's settings** | she's own broker URL, username and password (`<PREFIX>_MQTT_URL`, `…_USERNAME`, `…_PASSWORD`; a loopback URL is rewritten to she's hostname for remote hosts), re-applied on every save | `SHE_USE_BROKER=1` |
| **dedicated identity** | a dynsec client and role `svc-<instance>` of its own with a random password; the role's ACL allows exactly what an adapter needs — publish/receive/subscribe under `<instance>/#` and publish under `homeassistant/#` (discovery). Shown before saving; the password lives only in the env file. *Rotate password* sets a new one and restarts; switching the mode or uninstalling the instance deletes client and role again. Needs Mosquitto management with the dynamic security plugin | `SHE_DYNSEC_CLIENT=svc-<instance>` |

The Add-instance wizard offers the same choice (default: she's settings).

**Files** — the drawer's Files tab edits the files an instance maintains, in Monaco: the options the adapter declares as files (`x-file` in its `--config-schema` — cul2mqtt's `--map-file`, for example; older adapters are guessed from `…-file`/`…-path` option names plus the extension of the value) and everything under `/etc/<adapter>/` and `/var/lib/<adapter>/<instance>/`. JSON is validated against the schema the adapter ships (`map.schema.json` → per-key completion and errors), YAML is linted, the env file itself stays with the Config tab. *Create from example* puts a missing file at `/etc/<adapter>/<instance>.<option>.<ext>` from the adapter's example and points the option at it. she only reads and writes inside those two directories — a file elsewhere is shown with its path and a hint to move it. **Logs** shows the last 200 journal lines and can follow the journal live.

## Configuration

```json
{
  "services": {
    "enabled": true,
    "hosts": [
      { "name": "local" },
      { "hostname": "zigbee", "ssh": { "host": "zigbee.lan", "port": 22, "user": "she", "identityFile": "~/.she/ssh/services_id_ed25519" } }
    ]
  }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `services.enabled` | `false` | show the Services page |
| `services.hosts[]` | `[{ "name": "local" }]` | managed hosts; an entry without `ssh` is the she host itself (untick *This host* in Settings when she runs in Docker). Remote entries are identified by their ssh host; an optional `name` overrides the label |
| `services.hosts[].ssh` | — | `host` (required), `port` (22), `user` (the daemon's OS user), `identityFile` (the services key) — same shape as `broker.ssh` |
| `services.hosts[].hostname` | — | filled automatically on first contact; what the host's adapters report as `info.host`; edit it when the two differ |
| `services.trustedPublishers` | `["hobbyquaker"]` | npm user names whose packages the Catalog lists and she may install |

Settings → Services holds the enable switch, the host list and the SSH key; everything operational is on the Services page.

## Remote hosts

Adapter hosts other than the she host are reached over SSH with the system `ssh`/`scp` clients (`BatchMode`, `StrictHostKeyChecking=accept-new` — the same way the Broker page deploys Mosquitto files), as a dedicated user `she-services` that may run exactly one command with sudo: the helper.

**Recommended: the setup command.** Settings → Services → *Set up a remote host* → *Create setup command* gives you one line to run as root on the target:

```
curl -fsSL 'http://she:8080/she/services/setup.sh?token=…' | sudo bash
```

The script (POSIX sh, everything embedded, no downloads at run time) creates the system user `she-services`, puts she's public key into its `authorized_keys`, installs `/usr/local/bin/she-servicectl`, writes `/etc/sudoers.d/she-services` (`she-services ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl`, checked with `visudo -c`) and calls she back; she then adds the host entry (ssh host = the address the call came from, user `she-services`, hostname from the host) and the Settings list refreshes. It is idempotent — run it again after a she update to refresh the helper. The token is valid for 15 minutes and works once; the script is served once; the sha256 shown next to the command lets you download and read the script before running it. Prefer HTTPS (a reverse proxy in front of she) when the LAN is not fully trusted — the token protects the endpoint from strangers, not the transfer from tampering.

**By hand** (existing SSH access): generate the key under Settings → Services, put the public key into `~/.ssh/authorized_keys` of the SSH user on the host (`root` needs nothing else; another user needs the sudoers line), add the host (ssh host, port, user — empty user = the user she runs as), *Test connection*, save, then Services → Hosts → *Deploy helper*. she never edits sudoers on a remote host; when sudo refuses it prints the two commands for the admin.

**Removing a host** (*Remove…* in Services → Hosts, or *Remove from host…* on the host's card in Settings) undoes what the setup command did, in one of two degrees. *Disconnect* removes only this she's public key from the SSH user's `authorized_keys` — helper, sudoers rule and the `she-services` user stay, so another she instance (a production one taking over from a test one, say) keeps managing the host; run the new instance's setup command on the host first, then disconnect the old one. *Remove everything* removes the key, the sudoers rule (the whole `/etc/sudoers.d/she-services`, or just the helper line from a file that allows other things too), `/usr/local/bin/she-servicectl` and the `she-services` user with its home directory; it refuses while other keys are still in that user's `authorized_keys` unless you confirm *Remove everything anyway*. Adapters, their instances, units and config files, and `/etc/mqtt-interfaces/broker.env` are never touched — everything keeps running, the host simply is not managed by she any more, and its entry disappears from Settings. On the she host itself only *Remove everything* applies (helper and its sudoers line; the `she` user is not touched); `sudo she --install` brings it back.

On first contact she stores the host's hostname in the host entry; adapter instances whose `info.host` matches are shown as running on that host.

## The helper: `she-servicectl`

she runs as its own system user and never gets a blanket `sudo`. All privileged host operations go through one shell script, [`service/she-servicectl`](../service/she-servicectl), installed to `/usr/local/bin/she-servicectl` by `sudo she --install` together with the sudoers line

```
she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl
```

The script validates every argument against fixed patterns (adapter name = a template unit with the core's `/etc/<adapter>/%i.env` layout, instance name = letters, digits, `_ . -`, actions from a short list) before it executes anything; free-form data (env files, install options) is passed on stdin. Reading it tells you exactly what she can do on the host:

```
she-servicectl list                                        JSON: hostname, node, adapters, instances, unit states
she-servicectl unit   <adapter> <instance> start|stop|restart|enable|disable|status
she-servicectl logs   <adapter> <instance> [-n N] [--follow]
she-servicectl env    <adapter> <instance> read|write       write: new file on stdin (0640 root:<adapter>, .bak kept)
she-servicectl broker-env read|write
she-servicectl schema <adapter>                             <adapter> --config-schema
she-servicectl install|uninstall <adapter> <instance>       install: options as KEY=VALUE lines on stdin
she-servicectl npm    <adapter> version|origin|install|update
she-servicectl files  <adapter> <instance>                  JSON listing of /etc/<adapter>/ and /var/lib/<adapter>/<instance>/
she-servicectl file   <adapter> <instance> read|write <path> a file inside those two directories (write: content on stdin, .bak kept)
she-servicectl asset  <adapter> <relpath>                   a file shipped in the adapter package (example, schema)
she-servicectl self-update                                  replace the script with the one on stdin (checked: header, VERSION, sh -n; .bak kept)
she-servicectl remove-key                                   drop the public key on stdin from the calling user's authorized_keys
she-servicectl teardown [--force]                           remove she from the host: that key, the sudoers rule, the script, the she-services user
she-servicectl migrate <adapter> <name>                     legacy <adapter>.service → <adapter>@<name> via the adapter's --install; old unit kept as .migrated
                                                            (unit / logs / env accept "-" as the instance for a legacy unit)
she-servicectl version
```

For adapters that run with a non-system Node (a wrapper in `/usr/local/bin` pointing at e.g. `/opt/node22/bin/node`), the helper uses that node and its npm.

**Updating the helper.** she ships a new helper version now and then; the Hosts tab marks older ones *outdated* and offers *Update helper*. The installed helper replaces itself with the copy she sends (`self-update`, through the one sudo rule it already has — no root login, no second rule), on the she host and on remote hosts alike. Only a helper older than v4 cannot do that yet: run the setup command on the host once more (or `sudo she --install` on the she host). Existing installations: re-run `sudo she --install` once to get the helper and the sudoers line. Inside the she Docker image there is no local helper — untick *This host* in Settings, or leave it and the host tier reports "helper not installed"; remote hosts work from Docker as long as `ssh`/`scp` are in the image.

## For adapter authors

Everything she needs is part of the mqtt-interfaces-core convention; an adapter has to do three things to work well here (see the core's README):

1. `parseConfig()` gives you `--config-schema` for free; mark credential options with `secret: true` so they are masked in the form.
2. Put the npm keyword `mqtt-interfaces` in `package.json`.
3. Add a `mqttInterfaces` field (`spec`, `envPrefix`, `needs`, `serviceExtra`) — used by the upcoming catalog.
4. Declare options that hold a user-maintained file with `file: {format, example, schema}` (core 0.6.0 → `x-file`), and ship the example and schema in the package, so the Files tab can edit the file with validation and create it from the example.
