# she — Services roadmap (xyz2mqtt management)

*Design document, refined 2026-08-25. Replaces the "fleet manager" that the mqtt-interfaces master roadmap planned as a standalone management UI: that UI is not built; the functionality moves into she as an optional feature (default off, enabled from the Config page). The phases are adopted as ROADMAP.md items [I4](ROADMAP.md#i4--services-xyz2mqtt-inventory-and-local-host-management)–[I8](ROADMAP.md#i8--services-docker-host-driver) (Integrations), which link here for the full design; this file is archived together with I4.*

Decisions are numbered **SV-n**, open questions **SQ-n**, so they do not collide with the letter+number item IDs of ROADMAP.md or the D-/B-/OQ- numbering of the mqtt-interfaces roadmaps.

---

## 1. Goal

One place in she to see and operate every `xyz2mqtt` service ("adapter instance") of the home — the ones built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) first, older adapters as far as their topics allow:

- **see**: which instances exist, which adapter/version they run, on which host, connected state, uptime, log level, update available;
- **operate**: restart, change log level, start/stop/enable/disable, read logs;
- **configure**: edit an instance's options with a form generated from the adapter's `--config-schema`, install a new instance, uninstall one;
- **update**: install a newer adapter version on a host and restart its instances;
- **find**: browse adapters published on npm that mark themselves as fleet members and install them on a host.

Non-goal: she does not become a process supervisor. systemd on the host stays the supervisor; she talks to it (locally or over SSH). Docker-hosted adapters are covered by the MQTT tier only until a docker driver exists (SV-5).

## 2. What the core already gives us (the contract we build on)

Everything below is shipped in mqtt-interfaces-core 0.3.0 and used by lgtv2mqtt 3.0 / cul2mqtt 1.x / alexa-remote-mqtt 2.0:

| Piece | Where | What she reads / calls |
| --- | --- | --- |
| `<name>/connected` retained `0`/`1`/`2` (LWT) | MQTT | liveness: 0 down, 1 mqtt only, 2 device online |
| `<name>/info` retained JSON `{name (npm pkg), version, spec, node, host (os.hostname), pid, started, maintenance, …extras}` | MQTT | identity, version, host correlation, uptime |
| `<name>/maintenance/set/loglevel` `error\|warn\|info\|debug` | MQTT | runtime log level (only if `info.maintenance === true`) |
| `<name>/maintenance/set/restart` | MQTT | graceful exit 0, systemd `Restart=always` brings it back |
| `<adapter> --config-schema` | CLI on host | JSON Schema draft 2020-12 of all options, `x-env` per property, `x-adapter: {name, version, envPrefix}`, `required[]` |
| systemd template unit `<adapter>@<name>.service`, `SyslogIdentifier=<adapter>@%i` | host | list/start/stop/restart/enable/disable, `journalctl -u` |
| `/etc/<adapter>/<name>.env` (`<ENVPREFIX>_*`, mode 640 root:`<adapter>`) | host | the instance config; edit + restart |
| `/etc/mqtt-interfaces/broker.env` (`MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, …) | host | shared broker settings, `EnvironmentFile=-` in every unit |
| `/var/lib/<adapter>/<name>/` | host | per-instance state (pairing keys, cookies) — never touched, only shown |
| `sudo <adapter> --install --name <n> [options]` / `--uninstall --name <n>` | host | create/remove an instance (writes env file + template unit, enables + starts) |
| `/etc/systemd/system/<adapter>@.service` containing `EnvironmentFile=-/etc/mqtt-interfaces/broker.env` | host | reliable fingerprint "this unit was installed by the core" |

she already subscribes to `#` and keeps every retained topic in its state store ([src/index.js:479](src/index.js#L479)), so `+/info` and `+/connected` are available with no new subscription. Host access reuses [src/lib/ssh-deploy.js](src/lib/ssh-deploy.js) (system `ssh`/`scp`, `BatchMode`, `accept-new`) — its functions already take an `sshConfig` object, only the broker-specific default identity path needs to become a parameter.

### 2.1 Changes needed in the core / the adapters (small, all useful beyond she)

| Change | Where | Why |
| --- | --- | --- |
| `secret: true` on an option definition → `"x-secret": true` in the schema property | core `lib/config.js` `configSchema()` (one line) + mark `mqtt-password` and adapter secrets (`--cookie-file` contents no, `--amazon-password` yes, …) | she masks secrets in forms and API responses (SV-10); heuristic fallback for adapters that predate it |
| keyword `mqtt-interfaces` in `package.json` | every adapter | npm discovery of the catalog (SV-11) |
| `"mqttInterfaces": {"spec": "2.0", "envPrefix": "…", "serviceExtra": [...], "needs": ["serial"]}` field in `package.json` | every adapter; documented in the core README | catalog metadata without a central file (SV-11); `envPrefix` lets she build env files before the package is installed |

## 3. Principles

1. **Optional, off by default.** `services.enabled` shows the **Services** page in the nav (same mechanism as `broker.enabled` → Broker page). Nothing else in she depends on it; feezal's "principle 5" applies (no feature may exist only through the pairing — here: she stays complete without any service management, and the adapters stay complete without she).
2. **Tiers that degrade gracefully.** Everything the MQTT contract allows works with zero host access (Tier 0). Host access (Tier 1) is added per host; an instance whose host is not configured still shows and is still restartable over MQTT.
3. **No she-only mechanism in the adapters.** she consumes the existing convention (`info`, `connected`, `maintenance`, `--config-schema`, template units). The additions of §2.1 are convention-level (any consumer can use them), not she hooks.
4. **Least privilege, one helper.** Neither she nor the SSH user gets a blanket `sudo`. All privileged host operations go through one shipped helper with an argument allow-list (§7).
5. **Same UI language as the rest of she.** Nav dot (worst-case state), tables and detail panels like the Matter page and the HA-discovery view, sub-tabs like the Broker page, schema-driven forms styled like the Config page.

## 4. Architecture — three tiers

### Tier 0 — MQTT inventory and maintenance (no host access)

Backend `src/lib/services-inventory.js` (pure functions over the state store, like `ha-discovery.js`):

- Scan `mqtt::<x>/info` for every single-level `<x>`; parse JSON; an entry is an instance if the payload has `name` and `version`. Pair with `mqtt::<x>/connected`.
- Entries with `connected` but no `info` are **legacy instances** (pre-core adapters: hm2mqtt, hue2mqtt, …): shown, marked *legacy*, with instance name and connected state only; the only action is "wipe retained topics" (SV-12).
- Derived per instance: `instance` (topic prefix), `adapter` (`info.name`), `version`, `host` (`info.host`), `uptime` (now − `info.started`; only meaningful while `connected > 0`), `maintenance` (bool), `latestVersion` (npm registry lookup per adapter name, cached 24 h like she's own check in [src/web/server.js](src/web/server.js)).
- Actions over MQTT: `restart` (`<x>/maintenance/set/restart`), `loglevel` (`<x>/maintenance/set/loglevel`), disabled when `maintenance === false`.
- Live updates: the existing `mqtt` WebSocket events already carry `<x>/info` and `<x>/connected` changes; the page re-derives on those topics (no new WS message type needed).
- "Wipe retained": clear `<x>/info`, `<x>/connected`, `<x>/status/#` and the instance's HA discovery announcements — reuse the M10 cleanup code path ([src/lib/ha-discovery.js](src/lib/ha-discovery.js)) for the discovery part. Offered for instances with `connected = 0` (typically after an uninstall or a rename).

### Tier 1 — hosts over systemd (local or SSH)

Backend `src/lib/services-host.js` + `src/web/services-api.js`, one **host driver** interface (`exec(helperArgs, {stdin})`, `hostname()`, `ping()`) with two implementations: *local* (`execFile` on the she host) and *ssh* (`ssh-deploy.runCommand`). Both run every privileged command through the helper of §7, so the drivers differ only in transport. The interface is kept transport-agnostic so a third driver (docker, SV-5) can be added without touching the API layer — but it is not built now.

Per host:

- **Discover installed adapters**: `she-servicectl list` → adapters (template units with the broker.env fingerprint), instances (`/etc/<adapter>/*.env`), unit state (`systemctl show -p ActiveState,SubState,UnitFileState,ExecMainStartTimestamp`), installed version (`<adapter> --version`), node version, hostname — one JSON document per call.
- **Unit control**: start / stop / restart / enable / disable.
- **Logs**: `journalctl -u <adapter>@<name> -n 200 -o json` for the detail panel; live follow streamed over the existing log WebSocket as `{type: 'serviceLog', host, unit, level, msg, ts}` (same shape as `brokerLog`), broadcast to all clients, clients filter by `{host, unit}`; one `journalctl -f` per open panel, stopped when the panel closes or the last client disconnects (SV-13).
- **Config**: read `/etc/<adapter>/<name>.env` → key/value; `<adapter> --config-schema` → JSON Schema (cached per `adapter@version`); the form is generated from the schema (`x-env` maps property ↔ env var), values from the env file override schema defaults; save writes the env file (atomic: temp file + rename, keep `.bak` like `--install` does) and offers restart. Unknown env keys (not in the schema) are kept and shown read-only. Secrets: properties with `x-secret`, or — fallback — names matching `password|token|secret|cookie|apikey`, are returned masked (`***`) and only overwritten when the user types a new value (SV-10).
- **Install**: `sudo <adapter> --install --name <n> …` built from the same form (schema `required` enforced client-side; option values passed as `<ENVPREFIX>_*` environment on the helper's stdin, not as argv, so secrets never show in `ps`).
- **Uninstall**: `sudo <adapter> --uninstall --name <n>`, followed by an offer to wipe retained topics (Tier 0).
- **Update**: `npm view <adapter> version` vs. installed; `sudo npm install -g <adapter>@latest` then restart every instance of that adapter on the host; output streamed like the she self-update.
- **broker.env**: view/edit `/etc/mqtt-interfaces/broker.env`; a "use she's broker settings" button pre-fills `MQTT_URL` from she's config. With Mosquitto management enabled, "create broker credentials for this instance" creates a dynsec user with an ACL limited to `<name>/#` (+ `homeassistant/#` publish) via the existing `she.broker` layer — the one real synergy with the Broker page.

**Correlation** of the two tiers: an MQTT instance matches a host instance when `info.host` equals the host's captured `hostname` and the topic prefix equals the instance name. `info.host` is `os.hostname()`, which may differ from the SSH alias — the host entry stores the hostname after the first successful connection; it is editable in Config (SV-14).

### Tier 2 — catalog via npm (SV-11)

No catalog file. Adapters mark themselves:

- **Discovery**: `GET https://registry.npmjs.org/-/v1/search?text=keywords:mqtt-interfaces&size=250`, filtered on the exact keyword in each result's `keywords` array, skipping deprecated packages; cached 24 h with the last good result kept on failure; *Refresh* button.
- **Metadata**: the `mqttInterfaces` field from the packument (`GET https://registry.npmjs.org/<name>`, `dist-tags.latest` version) — spec version, `envPrefix`, `serviceExtra`, `needs` (e.g. `serial` → hint about `SupplementaryGroups=dialout`), description and repository from the usual fields.
- **Trust**: `services.trustedPublishers` (default `["hobbyquaker"]`). Packages whose `publisher`/`maintainers` include a trusted name get the *Install* button; the rest are listed with an *unverified publisher* badge and no install action (the user can add the publisher to the list). This is the trust anchor a curated catalog would otherwise provide, without central maintenance.
- **Install from catalog** = `she-servicectl npm <adapter> install` on the chosen host, then the Add-instance wizard continues with `--config-schema` from the freshly installed package.

Known downsides, accepted: search-index lag (minutes–hours after a publish), the search endpoint's occasional unavailability (mitigated by the cache), fuzzy matching (mitigated by the exact-keyword filter), and legacy adapters never appearing in the catalog (they still show as legacy rows via MQTT).

## 5. Configuration

`config.json`:

```json
{
  "services": {
    "enabled": true,
    "trustedPublishers": ["hobbyquaker"],
    "hosts": [
      { "name": "local" },
      { "name": "mqtt-ifaces", "hostname": "mqtt-ifaces", "ssh": { "host": "mqtt-ifaces.lan", "port": 22, "user": "she", "identityFile": "~/.she/ssh/services_id_ed25519" } }
    ]
  }
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `services.enabled` | `false` | shows the Services page; Tier 0 needs nothing else |
| `services.hosts[]` | `[]` | host entries; an entry without `ssh` is the she host itself (local driver). `name` is the label in the UI |
| `services.hosts[].ssh` | — | same shape as `broker.ssh` (kept separate from it, SV-7); identity default `<data-dir>/ssh/services_id_ed25519` (one key for all hosts, generated from the UI like the broker key) |
| `services.hosts[].hostname` | — | captured automatically after the first connection (for `info.host` correlation); editable |
| `services.trustedPublishers` | `["hobbyquaker"]` | npm publishers whose adapters get an *Install* button (SV-11) |

**Config page** gets a *Services* section next to *Mosquitto management*: an Enable checkbox with the same tooltip style, and when enabled a host list (name, SSH host/port/user, identity file, hostname, *Test connection*, *Deploy helper*, remove), a *Generate SSH key* button and the trusted-publishers list. Only that lives there; everything operational is on the Services page. `services` becomes a known key in Config.svelte so the block round-trips through save (as `broker` does).

## 6. Web UI — the Services page (SV-2)

Nav entry **Services** (own top-level tab; icon: stacked boxes / gears), visible when `services.enabled`; nav dot = worst case over all instances: green all `connected = 2`, yellow any `1` or systemd `activating`, red any `0`/`failed` (tooltip lists the offenders), same `nav-dot` classes as MQTT/Matter.

Sub-tabs (Broker-page style):

- **Instances** — the main table: instance · adapter@version (update badge when npm has a newer one) · host · state (connected dot 0/1/2 + systemd state when known) · uptime · actions (restart, log level dropdown, logs, config, stop/start, uninstall, wipe). Union of Tier 0 and Tier 1 entries; rows with only one side are marked ("not seen on MQTT" / "host not configured"); legacy rows carry a *legacy* chip. Filter by host and adapter; free-text search.
- **Instance detail** (drawer, like the Matter device detail): raw `info` JSON, config form (schema-driven, secrets masked), live log (journal follow), HA-discovery link ("show device in MQTT → HA discovery" — the M10 view already groups it), state directory path (read-only).
- **Hosts** — per host: reachability, hostname, node version, helper status (installed / outdated / missing, with *Deploy*), installed adapters with versions + update buttons, broker.env editor.
- **Catalog** — the npm list (§4 Tier 2): name, description, version, publisher (trusted badge), *Install on host…*.
- **Add instance** — wizard: host → adapter (installed on that host, or from the catalog) → form from `--config-schema` (required first, shared MQTT options collapsed with "use broker.env" default, adapter-specific options expanded) → *Install* → shows the journal until `connected` flips to 1/2.

## 7. Privileges and security (SV-4)

she runs as user `she` (systemd unit, [service/smart-home-engine.service](service/smart-home-engine.service)); today's sudoers only allow `systemctl restart smart-home-engine` and the self-update. Remote hosts are reached as a normal SSH user. Neither gets root.

**One privileged helper, `she-servicectl`** — a POSIX shell script (no Node dependency on the host; readable in one screen), shipped in `service/`, versioned:

- **she host**: `sudo she --install` copies it to `/usr/local/bin/she-servicectl` and adds `she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl` to `/etc/sudoers.d/she` (existing installs re-run `sudo she --install`; the Docker image of she skips it — local driver unavailable there).
- **remote hosts**: *Deploy helper* uploads it via scp to `/usr/local/bin/` (through the SSH user's home + a printed `sudo install` line the first time) and shows the one-line `/etc/sudoers.d/she-services` for the admin to add. she never writes sudoers on remote hosts.

The helper validates every argument against fixed patterns (`adapter` ∈ installed template units with the fingerprint, `instance` matches `^[A-Za-z0-9_.-]+$` — the core's `instanceName()` rule —, action ∈ allow-list) and only then execs the real command:

```
she-servicectl list                                        (JSON: hostname, node, adapters, instances, unit states)
she-servicectl unit   <adapter> <instance> start|stop|restart|enable|disable|status
she-servicectl logs   <adapter> <instance> [-n N|--follow]
she-servicectl env    <adapter> <instance> read|write       (write: new file on stdin → 0640 root:<adapter>, .bak kept)
she-servicectl broker-env read|write
she-servicectl schema <adapter>                             (runs <adapter> --config-schema)
she-servicectl install|uninstall <adapter> <instance>       (options as <ENVPREFIX>_* lines on stdin, never argv)
she-servicectl npm    <adapter> version|origin|install|update  (npm install -g <adapter>[@latest]; adapter name validated against ^[a-z0-9][a-z0-9._-]*$, scoped names allowed; origin = registry | manual, SV-16)
she-servicectl version
```

Node resolution (SV-17): for every adapter command the helper reads the interpreter from the adapter's wrapper (`/usr/local/bin/<adapter>` — a `#!/bin/sh` `exec /opt/node22/bin/node …` wrapper or a symlink to the package's bin) and uses that node and its sibling npm, so hosts with a non-system Node work without configuration.

The Hosts tab warns when a host runs an older helper than she ships. Everything she can do on a host is enumerable by reading one script — documented in [doc/security.md](doc/security.md).

Also: all `/she/services/*` routes sit behind the existing auth middleware; MQTT maintenance actions are only offered when `info.maintenance` is true (adapters run with `--no-maintenance` on untrusted brokers by design); `npm install` from the catalog only for trusted publishers (SV-11); secrets masked per SV-10; SSH host keys use `accept-new` as the broker deploy does.

## 8. Phases → ROADMAP.md items

| Item | Phase | Scope | Depends on |
| --- | --- | --- | --- |
| **I4** | Tier 0 + local host | `services.enabled` + Config section; Services tab; MQTT inventory table (incl. legacy rows), restart/loglevel over MQTT, update badge, wipe-retained, nav dot; **local host driver** with `she-servicectl` (shipped by `she --install`), unit control, journal tail + follow, env read/write with schema form, install/uninstall wizard, adapter update; Hosts tab (local only); docs (`doc/services.md`, security section) | core 0.3.0 contract; `x-secret` in the core is nice-to-have (heuristic works without it) |
| **I5** | remote hosts | ssh driver on the generalised `ssh-deploy.js`, host list + SSH key generation in Config, helper deploy + sudoers hint, hostname capture/override, helper version check | I4 |
| **I6** | broker.env + dynsec synergy | broker.env editor, "use she's broker", per-instance dynsec credentials with restricted ACL | I4 (local) / I5 (remote) + Mosquitto management |
| **I7** | catalog | npm keyword search, `mqttInterfaces` metadata, trusted publishers, install-from-catalog in the wizard; adapters get keyword + field (core README) | I4; adapters republished with the keyword |
| **I8** 💡 | docker driver | third host driver over the `docker` CLI (compose restart, logs, env) for containerised adapters; designed-for, not built, in I4 | I5; demand |

I4 is deliberately the big one: with adapters running on the she host it is the complete experience for a single-box setup. I5 turns it into the multi-host picture (mqtt-ifaces, zigbee, …).

## 9. Decisions

| ID | Decision |
| --- | --- |
| SV-1 | The fleet manager is **not** a standalone app; it is she's optional *Services* feature. The mqtt-interfaces master roadmap's "fleet manager" backlog item is closed with a pointer here. |
| SV-2 | Off by default; `services.enabled` toggled on the Config page; own top-level nav tab **Services** with sub-tabs; Tier 0 requires no further configuration. |
| SV-3 | Three tiers (MQTT / host via systemd / catalog); every tier is useful without the next; an instance is never hidden because a tier is missing. |
| SV-4 | Privileged host operations only through `she-servicectl` (POSIX shell, argument allow-list). `she --install` installs it and its sudoers line on the she host; on remote hosts she deploys the script and prints the sudoers line, never edits sudoers. |
| SV-5 | Host access is systemd-only for now. Docker adapters get Tier 0; a docker driver is a documented follow-up (I8), and the driver interface is kept transport-agnostic so it fits later. |
| SV-6 | Config forms are generated from `--config-schema` at request time (schema fetched from the host, cached per adapter@version) — she ships no per-adapter knowledge. The schema is **not** published over MQTT. |
| SV-7 | Hosts are a `services.hosts[]` list separate from `broker.ssh` (same `ssh` shape). Unifying into one host registry is deferred (SQ-2). |
| SV-8 | No `she.services.*` sandbox API. Scripts that want to restart an adapter publish to its maintenance topic; the host tier is an operator feature. |
| SV-9 | Phases become ROADMAP.md items **I4–I8** (Integrations); this file is archived on adoption. |
| SV-10 | Secrets: the core gains `secret: true` → `x-secret` in the schema; she masks `x-secret` properties, with a name heuristic (`password|token|secret|cookie|apikey`) as fallback for adapters without it. |
| SV-11 | Catalog by npm self-marking: keyword `mqtt-interfaces` for discovery, `mqttInterfaces` package.json field for metadata, `services.trustedPublishers` (default `hobbyquaker`) gates *Install*; unverified publishers are listed with a badge. No catalog file anywhere. |
| SV-12 | Legacy adapters (connected topic, no info) are shown, marked *legacy*, with wipe-retained as the only action. |
| SV-13 | Journal follow goes over the existing log WebSocket as broadcast `serviceLog` messages tagged `{host, unit}`; clients filter. |
| SV-14 | Instance ↔ host correlation via `info.host` = captured hostname (auto-captured on first connection, editable). |
| SV-15 | First increment (I4) is Tier 0 **plus** the local host driver, not Tier 0 alone. |
| SV-16 | Adapters deployed by tarball (the adapters' `deploy.sh`: `/usr/local/lib/node_modules/<adapter>` + wrapper) are detected by the helper (install origin from `npm ls -g --json` / missing `_resolved`); the UI marks the host *manually deployed* and asks for confirmation before `npm install -g` replaces such an install. |
| SV-17 | The helper follows the adapter's wrapper for Node: it parses the node path from `/usr/local/bin/<adapter>` and uses that node and its sibling npm for `--config-schema`, `--version` and `npm install`; `$PATH` only as fallback. Part of I4. |
| SV-18 | Wipe-retained is offered only at `connected = 0`. Stale `status/*` of a running adapter is the adapter's `clearStatus()` job. |
| SV-19 | Multi-broker (M2): the inventory keys instances by topic prefix today; with M2 it gains a broker dimension. Noted in M2, not blocking. |

## 10. Open questions

- **SQ-2 — One host registry for Broker and Services?** The Mosquitto host is usually also an adapter host. Deferred until I5 shows the pain; if unified later, `broker.ssh` becomes a reference to a `hosts[]` entry (config migration).

Everything else is decided (§9). Questions that come up during implementation get new SQ numbers here until I4 ships.

## 11. Explicitly out of scope

- Building or replacing supervisors (no she-spawned adapter processes — hot reload orphans children; same reasoning as rejected for feezal in [I3](ROADMAP.md#i3--feezal-dashboard-pairing)).
- Editing the adapter's *state* directory (pairing keys, cookies) — shown as a path only.
- Managing non-mqtt-smarthome services (zigbee2mqtt, Home Assistant, …) — outside the convention; they may appear as legacy rows if they publish a `connected`-like topic, nothing more.
- Device discovery (`--discover`, core B-2) from the UI — later, once the core has it; would slot into the Add-instance wizard as an "address" picker.
- A curated catalog file (rejected in favour of SV-11).

## 12. Implementation plan (file level)

Order of work for I4; later items only list what they add. Conventions: backend CommonJS like the rest of `src/`, pure logic in `src/lib/*` with unit tests in `test/unit/`, HTTP in `src/web/*-api.js` mounted in `server.js`, frontend Svelte 5 runes, API functions in `web/src/lib/api.ts`.

### I4 — step by step

1. **Inventory (Tier 0, pure)** — `src/lib/services-inventory.js`: `analyzeServices(store, {now})` → `{instances: [{instance, adapter, version, spec, host, pid, started, uptime, connected, maintenance, legacy}]}` from `mqtt::<x>/info` + `mqtt::<x>/connected`; `wipeTopics(store, instance)` → list of retained topics to clear (`<x>/info`, `<x>/connected`, `<x>/status/#`, plus the instance's HA announcements via `ha-discovery.analyzeDiscovery`). Tests: `test/unit/services-inventory.test.js` (core instance, legacy row, connected without info, malformed info, wipe list).
2. **Config + gating** — `services` block: read live from config.json in the API (like `broker-api.getBrokerConfig`); `services.enabled` → `App.svelte` nav tab (copy the `brokerEnabled` handling), redirect away when disabled; `/she/status` gains `servicesEnabled`; Config.svelte: *Services* section with the enable toggle (copy the Mosquitto block), `services` added to the known keys / `extra` round-trip.
3. **API (Tier 0)** — `src/web/services-api.js` mounted at `/she/services`: `GET /instances` (inventory + `latestVersion` from a per-adapter npm cache modelled on `_checkNpmVersion`), `POST /instances/:name/restart`, `POST /instances/:name/loglevel {level}` (publish via the mqtt client the way `mqtt-api.js` does), `DELETE /instances/:name/retained` (wipe; refuse when `connected > 0`, SV-18). Doc in `doc/http-api.md`.
4. **Services page (Tier 0)** — `web/src/pages/Services.svelte` with sub-tabs (copy the `Security.svelte` tab shell): *Instances* table, actions, nav dot derived in `App.svelte` from the instances list (re-derive on `mqtt` WS events for `+/info`, `+/connected`); `web/src/pages/services/Instances.svelte`. API functions + types in `api.ts`.
5. **Helper** — `service/she-servicectl` (POSIX sh, executable, shipped in the npm `files` list via `service/`): commands of §7, JSON output for `list`, strict argument validation, node resolution from the adapter wrapper (SV-17), install-origin detection (SV-16). `service/install.sh` copies it to `/usr/local/bin/she-servicectl` and appends its sudoers line; `she --install` already runs that script. Tests: a bash-level test that runs the helper with a fake `systemctl`/`journalctl`/`npm` on `PATH` (`test/unit/she-servicectl.test.js` spawning it; skipped on non-Linux).
6. **Host driver (local)** — `src/lib/services-host.js`: `createLocalDriver()` → `{name: 'local', exec(args, {stdin}) → {stdout, stderr, code}, hostname()}`; every call goes through `sudo -n /usr/local/bin/she-servicectl …`; helper-missing → a typed error the UI turns into "Deploy helper" guidance.
7. **API (Tier 1)** — `GET /hosts` (driver list + `list` result), `POST /hosts/:host/units/:adapter/:instance/:action`, `GET …/logs?n=200`, `POST …/logs/follow` + `DELETE` (journal follower → `log-ws` broadcast `serviceLog`, one follower per `{host, unit}` ref-counted), `GET …/env` (masked), `PUT …/env`, `GET /hosts/:host/adapters/:adapter/schema` (cached per adapter@version), `POST /hosts/:host/adapters/:adapter/install {name, options}`, `DELETE …/instances/:name`, `POST /hosts/:host/adapters/:adapter/update` (origin check → 409 with `{origin: 'manual'}` unless `{force: true}`), `GET /hosts/:host/broker-env` / `PUT` (I6 fills the UI, the endpoint is trivial now).
8. **Frontend (Tier 1)** — `services/InstanceDetail.svelte` (info, config form, log panel), `services/SchemaForm.svelte` (JSON Schema → fields: string/number/boolean/enum/array, `x-secret` masked, required first, shared MQTT options collapsed), `services/Hosts.svelte`, `services/AddInstance.svelte` (wizard); `serviceLog` handling in `web/src/lib/ws.ts`.
9. **Docs** — `doc/services.md` (concept, tiers, config, helper, sudoers), README feature bullet + doc link, `doc/security.md` section on `she-servicectl`, `doc/cli.md` note on `she --install` installing the helper, `doc/http-api.md` section. Archive I4 + this file per CLAUDE.md.

### I5 adds
`createSshDriver(hostCfg)` in `services-host.js` on `ssh-deploy.js` (identity-file default becomes a parameter); Config.svelte host list editor + key generation (`POST /she/services/ssh/keygen`, copy of the broker one) + `POST /hosts/:host/test`; `POST /hosts/:host/helper/deploy` (scp to `~`, print the `install`/sudoers lines) and helper version check in `list`; hostname capture into `services.hosts[].hostname`.

### I6 adds
broker.env editor in `Hosts.svelte`; `POST /hosts/:host/instances/:name/broker-credentials` → `dynsec.createClient` + role with `<name>/#` and `homeassistant/#` ACLs (reuse `src/lib/dynsec.js`) → write `<ENVPREFIX>_MQTT_USERNAME/PASSWORD` into the env file → offer restart.

### I7 adds
`src/lib/services-catalog.js`: `searchCatalog()` (registry search, exact-keyword filter, deprecated skip, 24 h cache with last-good), `packument(name)` → `mqttInterfaces` + `dist-tags.latest`, `isTrusted(pkg, trustedPublishers)`; `GET /she/services/catalog`, `POST /hosts/:host/adapters/:adapter/install-package`; `services/Catalog.svelte`; `services.trustedPublishers` in Config. Prereq outside she: adapters republished with keyword + field (core 0.4.0 README documents it; core ROADMAP tracks the per-adapter one-liners).

## 13. Notes from the source review (2026-08-25)

- The public `mqtt-interfaces` repository is **empty** (no commits); the master roadmap with D-1…D-13, B-1…B-8, OQ-* that the core, cul2mqtt and alexa-remote-mqtt roadmaps link to is not published (it exists only on another machine). This document therefore reconstructs the fleet-manager intent from the core's README/ROADMAP (`--config-schema` "consumed by the fleet manager", installer layout, `info`/`maintenance` topics). When the umbrella repo gets pushed, its fleet-manager item should point here, and SV-1/SV-4/SV-6 should be checked against whatever it decided.
- Core adapters on npm today: lgtv2mqtt 3.0.0, cul2mqtt 1.1.1; alexa-remote-mqtt 2.0 is tagged locally but not yet released; lgsb2mqtt 2.0 is next. Legacy (pre-core) adapters by the same author still on npm: hm2mqtt, homekit2mqtt, airtunes2mqtt, mqttdb, influx4mqtt (and hue2mqtt & co. outside the search window) — these are the legacy rows of SV-12.
- she internals reused: `broker.enabled` → nav-tab gating in [web/src/App.svelte](web/src/App.svelte); Config-page feature toggle pattern ([web/src/pages/Config.svelte](web/src/pages/Config.svelte) *Mosquitto management* section); `ssh-deploy.js`; `ha-discovery.js` for wiping announcements; the npm-version check and `sudo` spawn pattern in `server.js`; `brokerLog` WS message shape in [src/web/log-ws.js](src/web/log-ws.js); `service/install.sh` for the sudoers/helper installation.
