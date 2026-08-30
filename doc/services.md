# Services — managing xyz2mqtt adapters

she can optionally show and operate the `xyz2mqtt` adapter instances of your home — the small daemons that bridge a device or cloud service to MQTT (lgtv2mqtt, cul2mqtt, alexa-remote-mqtt, …). Adapters built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) get the full feature set; anything that only publishes a `<name>/connected` topic — older adapters, but also ESPHome devices and similar firmware — is a *legacy* row, hidden by default (tick *show unmanaged* on the Instances tab).

Enable it under **Settings → Services**; the **Adapters** page then appears in the navigation. Nothing else in she depends on it.

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
| `/etc/systemd/system/<adapter>@.service` | template unit (one per adapter; she recognises it by its `EnvironmentFile=/etc/<adapter>/%i.env` line). Units written by early core versions do not read the shared `broker.env`; the Installations tab marks those *no broker.env* — reinstalling one instance of the adapter rewrites the unit |
| `/etc/<adapter>/<name>.env` | the instance's options as `<ADAPTER>_*` variables — what the config form edits |
| `/etc/mqtt-interfaces/broker.env` | optional `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS_CA` shared by all instances on the host — a core convention she does not manage; use the *use she's broker settings* switch per instance instead |
| `/var/lib/<adapter>/<name>/` | per-instance state (pairing keys, cookies) — shown, never touched |

An MQTT instance and a host instance are the same row when the instance names match and `info.host` equals the host's hostname.

**Old units.** An adapter installed before the core — a plain `<adapter>.service` with its env file in `/etc/default/<adapter>` (or a core adapter still running under such a unit) — is recognised too (helper v5+): it appears on the Instances tab marked *old unit*, matched to the MQTT instance of the same adapter on that host, with start/stop/restart, logs and the config form (editing `/etc/default/<adapter>`), but no Files tab and no Uninstall. **Migrate** turns it into a proper instance: she runs the adapter's own `--install --name <n>` with the old settings as environment (the adapter carries its state over — alexa-remote-mqtt copies the login cookie, lgtv2mqtt the pairing key), then disables the old unit and keeps its files as `.migrated`. The instance name defaults to the MQTT topic prefix so nothing changes on the broker.

## The Adapters page

The main-menu entry is *Adapters* (the feature and its settings keep the name *Services*).

- **Instances** — one row per instance: adapter and version (with the npm update badge), host, state (connected dot plus the systemd state when the host is managed), uptime, a log-level selector, and the actions the row supports: *Config / Logs* (opens the drawer), *Restart*, *Stop*/*Start*, *Enable*, *Uninstall*, *Wipe* (only while `connected = 0`). The nav dot is the worst case over all instances. *Mem* and *CPU* per instance come from the adapter itself (`<name>/maintenance/stats`, core 0.8+: RSS, heap, share of one core over its stats interval, event loop lag) or, for instances on a managed host whose adapter does not publish them yet, from systemd's accounting via the helper (MemoryCurrent; CPU share between two host listings) — the tooltip says which.
- **Installations** — per managed host, the adapters installed there with version and origin, and *Update* (`npm install -g <adapter>@latest`, then restarts the adapter's instances). *Update all* in the toolbar walks every adapter that has a newer version, one package at a time, and says which one it is on; a manual deploy is skipped there rather than asked about (update it from its own row). Hosts with nothing installed are left out — the counter says how many — while a host she cannot reach keeps its card, since that card is where the error is explained. The helper itself is managed on the *Hosts* tab; an outdated one is only noted here. *Uninstall* removes the adapter from the host: the confirmation lists the instances that exist and, if you go ahead, each is removed first (`--uninstall`: unit, env file, dynsec identity), then the package, `/etc/<adapter>` and `/var/lib/<adapter>` — a pre-core unit of the adapter blocks it until migrated. An adapter installed with npm (Catalog → *Install*) that has no instance yet is listed too — the helper finds it by the `mqttInterfaces` field in its package.json — with a *+ add instance* button; its template unit appears with the first `--install`. Hosts that adapters report in `info.host` but that are not configured are listed underneath as *seen on MQTT, not managed*, with their instances. Adapters that were deployed manually (a tarball extracted to `/usr/local/lib/node_modules`, e.g. by an adapter's `deploy.sh`) are marked *manual* — recognised by the hidden lockfile that `npm install --prefix <dir>` leaves inside the package, which a registry `npm install -g` does not create; updating them asks first because the npm version replaces the manual deploy.
- **Install adapter** (button on the Installations tab; the catalog covers the tab, *← Installations* returns) — the adapters on npm you can install: every package of the *trusted publishers* (Settings → Services, default `hobbyquaker`) whose latest version depends on `mqtt-interfaces-core` — depending on the core is the membership criterion, nothing else is needed. Shows version, its author (linked to their GitHub profile), the repository's star count, host prerequisites (`needs` from the package's `mqttInterfaces` field) and where it is already installed. *Install* asks which host it should go on — a host that already has the adapter is listed but not selectable, because updating one is the Installations tab's job, not this one's — and then runs `npm install -g <adapter>@latest` there through the helper. The registry is asked once a day (and GitHub once per adapter in the same sweep, for the star count and the repository owner); ↺ refreshes; when either is unreachable the last list is kept and marked stale. The list comes from a cache (`<data-dir>/services/catalog.json`) so the page never waits for npm; the daemon sweeps the registry once a day, ↺ does it now, and the last known list stays visible meanwhile.
- **+ Add instance** (*+ instance* on the Installations tab, or right after a catalog install — the form covers the tab with host and adapter fixed, a spinner while the hosts and the adapter's schema are read) — pick host and adapter, choose the instance name, fill in the options (required ones first, the shared MQTT options collapsed; *Use she's broker settings* is on by default so the instance connects to the same broker as she), *Install*. The wizard runs `<adapter> --install --name <instance>` with the options passed as environment variables, so secrets never show up in a process list.
  - **Find the device** — an adapter whose schema marks a property with `x-discover` (core 0.9+) gets a scan step. For a **`cloud`** adapter (core 0.11+) this is not a scan at all: hardware like an EcoFlow inverter only ever talks to its vendor's servers, so nothing on the network could answer, and *Find the device* instead signs in to the vendor account and lists what it owns — the serial number is what gets configured. Such a scan is a login, so it needs the credentials the schema names in `x-discover-needs` (core 0.12+): the button stays disabled, saying which fields to fill in, until they are there. They are options of the instance being created anyway, so nothing extra is asked; they travel to the host on stdin, never on a command line. For the network and serial kinds: *Scan network* (or *Scan for devices* for a USB stick) runs the adapter's own `--discover` **on the target host** and lists what answered — the device's name, its address or `/dev/serial/by-id` path, the ports that answered, and which method found it. Picking one fills the marked option in; a device an instance already uses is marked *already configured as …* rather than hidden (a second instance against the same device is legitimate). The scan never starts on its own. A network result can carry three forms of the same device, and `IP` / `host` / `FQDN` on the row decides which one is configured: only forms that *round-trip* are offered — the core reverses the address, resolves the name back and checks that the address is among the answers, on the host that ran the scan, which is the host that will use the value. The FQDN is preselected where there is one, since it outlives a DHCP lease and an address does not; the short name is never preselected, because it resolves through the search list of whoever asks and may work on the scanning host and nowhere else — picking it says so. A device DNS knows nothing about simply shows its address. For a stick the value is the `/dev/serial/by-id` path, which survives a replug where `/dev/ttyACM0` can change. Devices behind a router answer no broadcast: *device on another network?* takes an address or a range (`172.16.20.0/24`) to sweep, and the scan timeout.
  - **The instance name follows the device.** When the device carries a name of its own — the WiiM's UPnP `friendlyName`, an LG soundbar's Chromecast label — it becomes the suggested instance name, transliterated and slugged into what an instance name may be (*"Küche Oben"* → `kueche-oben`), and made unique against every instance she knows of, on any host and any adapter, since an instance name is an MQTT topic prefix. It fills the name field until you type in it yourself; after that it is yours. Devices without a name (a CCU) keep the adapter's default.

The drawer's **Config** tab edits `/etc/<adapter>/<name>.env`. Secrets (`x-secret` in the schema, or names containing password/token/secret/cookie/key) are masked; they stay unchanged unless you type a new value. *Save & restart* applies immediately. An option that takes a **list** (`type: array` — influx4mqtt's `--subscribe`, govee2mqtt's `--address`) is edited as one row per entry with a × to remove and an always-empty row to type the next one into, rather than as a single comma-separated field: six MQTT topic patterns on one line are unreadable, and a stray comma silently splits an entry in two. The env file still holds the comma-separated list the core reads.

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
| `services.enabled` | `false` | show the Adapters page |
| `services.hosts[]` | `[{ "name": "local" }]` | managed hosts; an entry without `ssh` is the she host itself, always present and not removable. Remote entries are identified by their ssh host; an optional `name` overrides the label |
| `services.hosts[].ssh` | — | `host` (required), `port` (22), `user` (the daemon's OS user), `identityFile` (the services key) — same shape as `broker.ssh` |
| `services.hosts[].hostname` | — | filled automatically on first contact; what the host's adapters report as `info.host`; edit it when the two differ |
| `services.trustedPublishers` | `["hobbyquaker"]` | npm user names whose packages the Catalog lists and she may install |

Settings → Services holds the enable switch and the trusted publishers; the host list, the setup command and the SSH key are on the Adapters page, tab **Hosts** (edits there are saved with its own *Save*); everything operational is on the Installations tab.

## Remote hosts

Adapter hosts other than the she host are reached over SSH with the system `ssh`/`scp` clients (`BatchMode`, `StrictHostKeyChecking=accept-new` — the same way the Broker page deploys Mosquitto files), as a dedicated user `she-services` that may run exactly one command with sudo: the helper.

**Recommended: the setup command.** Adapters → Hosts → *+ Add remote host* → *Create setup command* gives you one line to run as root on the target:

```
curl -fsSL 'http://she:8080/she/services/setup.sh?token=…' | sudo bash
```

The script (POSIX sh, everything embedded, no downloads at run time) creates the system user `she-services`, puts she's public key into its `authorized_keys`, installs `/usr/local/bin/she-servicectl`, writes `/etc/sudoers.d/she-services` (`she-services ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl`, checked with `visudo -c`) and calls she back; she then adds the host entry (ssh host = the address the call came from, user `she-services`, hostname from the host) and the Settings list refreshes. It is idempotent — run it again after a she update to refresh the helper. The token is valid for 15 minutes and works once; the script is served once; the sha256 shown next to the command lets you download and read the script before running it. Prefer HTTPS (a reverse proxy in front of she) when the LAN is not fully trusted — the token protects the endpoint from strangers, not the transfer from tampering.

**By hand** (existing SSH access): generate the key on the Hosts tab, put the public key into `~/.ssh/authorized_keys` of the SSH user on the host (`root` needs nothing else; another user needs the sudoers line), add the host (ssh host, port, user — empty user = the user she runs as), *Test connection*, save, then Services → Adapters → *Deploy helper*. she never edits sudoers on a remote host; when sudo refuses it prints the two commands for the admin.

**Removing a host** (*Remove from host…* on the host's card, Hosts tab) undoes what the setup command did, in one of two degrees. *Disconnect* removes only this she's public key from the SSH user's `authorized_keys` — helper, sudoers rule and the `she-services` user stay, so another she instance (a production one taking over from a test one, say) keeps managing the host; run the new instance's setup command on the host first, then disconnect the old one. *Remove everything* removes the key, the sudoers rule (the whole `/etc/sudoers.d/she-services`, or just the helper line from a file that allows other things too), `/usr/local/bin/she-servicectl` and the `she-services` user with its home directory; it refuses while other keys are still in that user's `authorized_keys` unless you confirm *Remove everything anyway*. Adapters, their instances, units and config files, and `/etc/mqtt-interfaces/broker.env` are never touched — everything keeps running, the host simply is not managed by she any more, and its entry disappears from Settings. On the she host itself only *Remove everything* applies (helper and its sudoers line; the `she` user is not touched); `sudo she --install` brings it back.

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
she-servicectl discover <adapter> [--timeout <s>] [--address <a>]...   <adapter> --discover --discover-json
she-servicectl install|uninstall <adapter> <instance>       install: options as KEY=VALUE lines on stdin
she-servicectl npm    <adapter> version|origin|install|update|uninstall [--purge]
she-servicectl files  <adapter> <instance>                  JSON listing of /etc/<adapter>/ and /var/lib/<adapter>/<instance>/
she-servicectl file   <adapter> <instance> read|write <path> a file inside those two directories (write: content on stdin, .bak kept)
she-servicectl asset  <adapter> <relpath>                   a file shipped in the adapter package (example, schema)
she-servicectl node   update [--lts|--latest|--stable]       download the pinned tj/n if needed, then n install <label>; JSON: version before/after, what n installed, mismatch
she-servicectl restart-all                                  restart every running instance on the host (what a node update needs afterwards)
she-servicectl self-update                                  replace the script with the one on stdin (checked: header, VERSION, sh -n; .bak kept)
she-servicectl remove-key                                   drop the public key on stdin from the calling user's authorized_keys
she-servicectl teardown [--force]                           remove she from the host: that key, the sudoers rule, the script, the she-services user
she-servicectl migrate <adapter> <name>                     legacy <adapter>.service → <adapter>@<name> via the adapter's --install; old unit kept as .migrated
                                                            (unit / logs / env accept "-" as the instance for a legacy unit)
she-servicectl version
```

For adapters that run with a non-system Node (a wrapper in `/usr/local/bin` pointing at e.g. `/opt/node22/bin/node`), the helper uses that node and its npm.

**Node.js on a host.** The Hosts tab shows each host's node version next to the helper version. she asks nodejs.org once for all hosts (`GET /she/services/node/releases`, cached 6 h) what n's labels currently resolve to and shows all three of them — `stable` and `lts` (both the newest long-term-support release; `stable` is n's older name for it) and `latest` (the newest release of all). Each is either a button carrying the version it would install, or a green pill saying the host already runs it. The label is handed to n as it is: the button runs `she-servicectl node update --<label>`, then `n install <label>` with `N_PREFIX` at `/usr/local`.

[tj/n](https://github.com/tj/n) is a single self-contained bash script, and the helper installs it as one: it downloads the pinned version (`N_VERSION` in the helper) from the tj/n tag to `/usr/local/bin/n` with `curl` or `wget`, checking the interpreter line, the `VERSION` line and `bash -n` before it moves the file into place — the same three checks `self-update` makes for the helper itself. `npm install -g n` is deliberately *not* used: a host that has no node has no npm either, so npm cannot bootstrap the very thing that installs node, and it would put `n` into whatever prefix the current node uses — which the node `n` then installs into `/usr/local` shadows. A host that already has the pinned `n` skips the download.

A host with a newer Node.js waiting also lights the yellow dot on the *Hosts* sub-tab and the *Adapters* entry in the main nav — counting `latest` only for a host that already tracks the newest line, since for a host on an LTS line `latest` is a jump to another major rather than an update, and would leave the dot on forever.

The result box reports the version before and after. When another installation (a distro package, nvm, an `/opt/nodeXX` wrapper) still wins on PATH, it says so with both paths instead of claiming an upgrade the adapters will never see. Services keep the node binary they were started with, so a real version change offers *Restart all instances* (`she-servicectl restart-all` — only units that are actually running; stopped or disabled ones stay that way).

**Updating the helper.** she ships a new helper version now and then; the Hosts tab shows the helper version, marks older ones *outdated* and offers *Update helper* there (and *Deploy helper* for a host that has none yet, plus *Update all helpers* when more than one is behind). The installed helper replaces itself with the copy she sends (`self-update`, through the one sudo rule it already has — no root login, no second rule), on the she host and on remote hosts alike. Only a helper older than v4 cannot do that yet: run the setup command on the host once more (or `sudo she --install` on the she host). Existing installations: re-run `sudo she --install` once to get the helper and the sudoers line. Inside the she Docker image there is no local helper, so the she host reports "helper not installed" and stays that way; remote hosts work from Docker as long as `ssh`/`scp` are in the image.

## For adapter authors

Everything she needs is part of the mqtt-interfaces-core convention; an adapter has to do three things to work well here (see the core's README):

1. `parseConfig()` gives you `--config-schema` for free; mark credential options with `secret: true` so they are masked in the form.
2. Put the npm keyword `mqtt-interfaces` in `package.json`.
3. Add a `mqttInterfaces` field (`spec`, `envPrefix`, `needs`, `serviceExtra`) — used by the upcoming catalog.
4. Declare options that hold a user-maintained file with `file: {format, example, schema}` (core 0.6.0 → `x-file`), and ship the example and schema in the package, so the Files tab can edit the file with validation and create it from the example.
5. Declare a discovery hint and flag the option it fills with `discover: true` (core 0.9.0 → `x-discover`, whose value says whether the scan is a `network`, a `serial` or a `cloud` one). A cloud hint additionally lists in `needs` the options its scan signs in with, which the core publishes as `x-discover-needs`. she then offers the scan in the Add-instance form and asks the adapter itself — it owns the protocols. Return the name the *user* gave the device as `name` (as against `model`/`type`, which say what it is): that is what the instance name is derived from.
