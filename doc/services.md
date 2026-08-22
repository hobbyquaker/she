# Services — managing xyz2mqtt adapters

she can optionally show and operate the `xyz2mqtt` adapter instances of your home — the small daemons that bridge a device or cloud service to MQTT (lgtv2mqtt, cul2mqtt, alexa-remote-mqtt, …). Adapters built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) get the full feature set; anything that only publishes a `<name>/connected` topic — older adapters, but also ESPHome devices and similar firmware — is a *legacy* row, hidden by default (tick *show legacy* on the Instances tab).

Enable it under **Settings → Services**; the **Services** page then appears in the navigation. Nothing else in she depends on it.

## What you get

| Tier | Needs | Gives |
| --- | --- | --- |
| **MQTT** (always) | nothing — she already sees every retained topic on the broker | inventory of all instances (adapter, version, host, pid, uptime, connected state), restart and log level over the adapters' maintenance topics, "update available" badge (npm registry, checked once a day), wiping the retained topics of an instance that is gone |
| **Host** | the `she-servicectl` helper on the she host (installed by `sudo she --install`) | systemd control (start/stop/restart/enable/disable), journal logs (tail + live follow), editing the instance's env file with a form generated from the adapter's `--config-schema`, installing and uninstalling instances, updating adapters via npm, editing the shared `broker.env` |

Remote hosts over SSH, per-instance broker credentials and an adapter catalog are on the [roadmap](../ROADMAP.md) (I5–I7).

## How adapters look to she

Every core adapter instance publishes two retained topics:

- `<name>/connected` — `0` (down, LWT), `1` (MQTT only), `2` (MQTT and device online)
- `<name>/info` — `{ "name": "<npm package>", "version", "spec", "node", "host", "pid", "started", "maintenance", … }`

and, unless started with `--no-maintenance`, listens on `<name>/maintenance/set/loglevel` and `<name>/maintenance/set/restart`. The instance name `<name>` is the topic prefix and the systemd instance (`<adapter>@<name>`).

On a host the core's `--install` leaves:

| Path | Purpose |
| --- | --- |
| `/etc/systemd/system/<adapter>@.service` | template unit (one per adapter; she recognises it by its `EnvironmentFile=-/etc/mqtt-interfaces/broker.env` line) |
| `/etc/<adapter>/<name>.env` | the instance's options as `<ADAPTER>_*` variables — what the config form edits |
| `/etc/mqtt-interfaces/broker.env` | optional `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, … shared by all instances on the host |
| `/var/lib/<adapter>/<name>/` | per-instance state (pairing keys, cookies) — shown, never touched |

An MQTT instance and a host instance are the same row when the instance names match and `info.host` equals the host's hostname.

## The Services page

- **Instances** — one row per instance: adapter and version (with the npm update badge), host, state (connected dot plus the systemd state when the host is managed), uptime, a log-level selector, and the actions the row supports: *Config / Logs* (opens the drawer), *Restart*, *Stop*/*Start*, *Enable*, *Uninstall*, *Wipe* (only while `connected = 0`). The nav dot is the worst case over all instances.
- **Hosts** — per managed host: helper status, installed adapters with version and origin, *Update* (`npm install -g <adapter>@latest`, then restarts the adapter's instances), and the `broker.env` editor. Adapters that were deployed manually (a tarball extracted to `/usr/local/lib/node_modules`, e.g. by an adapter's `deploy.sh`) are marked *manual*; updating them asks first because the npm version replaces the manual deploy.
- **Add instance** — pick host and adapter, choose the instance name, fill in the options (required ones first, the shared MQTT options collapsed — leave them empty to use `broker.env`), *Install*. The wizard runs `<adapter> --install --name <instance>` with the options passed as environment variables, so secrets never show up in a process list.

The drawer's **Config** tab edits `/etc/<adapter>/<name>.env`. Secrets (`x-secret` in the schema, or names containing password/token/secret/cookie/key) are masked; they stay unchanged unless you type a new value. *Save & restart* applies immediately. **Logs** shows the last 200 journal lines and can follow the journal live.

## Configuration

```json
{
  "services": {
    "enabled": true,
    "hosts": [{ "name": "local" }]
  }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `services.enabled` | `false` | show the Services page |
| `services.hosts[]` | `[{ "name": "local" }]` | managed hosts; an entry without `ssh` is the she host itself. SSH entries are accepted but not driven yet (roadmap I5) |

The Settings page only holds the enable switch; everything operational is on the Services page.

## The helper: `she-servicectl`

she runs as its own system user and never gets a blanket `sudo`. All privileged host operations go through one shell script, [`service/she-servicectl`](../service/she-servicectl), installed to `/usr/local/bin/she-servicectl` by `sudo she --install` together with the sudoers line

```
she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl
```

The script validates every argument against fixed patterns (adapter name = a template unit with the broker.env fingerprint, instance name = letters, digits, `_ . -`, actions from a short list) before it executes anything; free-form data (env files, install options) is passed on stdin. Reading it tells you exactly what she can do on the host:

```
she-servicectl list                                        JSON: hostname, node, adapters, instances, unit states
she-servicectl unit   <adapter> <instance> start|stop|restart|enable|disable|status
she-servicectl logs   <adapter> <instance> [-n N] [--follow]
she-servicectl env    <adapter> <instance> read|write       write: new file on stdin (0640 root:<adapter>, .bak kept)
she-servicectl broker-env read|write
she-servicectl schema <adapter>                             <adapter> --config-schema
she-servicectl install|uninstall <adapter> <instance>       install: options as KEY=VALUE lines on stdin
she-servicectl npm    <adapter> version|origin|install|update
she-servicectl version
```

For adapters that run with a non-system Node (a wrapper in `/usr/local/bin` pointing at e.g. `/opt/node22/bin/node`), the helper uses that node and its npm.

Existing installations: re-run `sudo she --install` once to get the helper and the sudoers line. Inside the she Docker image there is no helper — the MQTT tier still works, the host tier reports "helper not installed".

## For adapter authors

Everything she needs is part of the mqtt-interfaces-core convention; an adapter has to do three things to work well here (see the core's README):

1. `parseConfig()` gives you `--config-schema` for free; mark credential options with `secret: true` so they are masked in the form.
2. Put the npm keyword `mqtt-interfaces` in `package.json`.
3. Add a `mqttInterfaces` field (`spec`, `envPrefix`, `needs`, `serviceExtra`) — used by the upcoming catalog.
