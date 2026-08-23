# Command-Line Reference

```
Usage: she [options]
```

## Options

| Short | Long | Default | Description |
|---|---|---|---|
| `-c` | `--config` | auto | Path to JSON config file. Auto-loaded from `~/.she/config.json` if present. |
| `-d` | `--dir` | `~/.she` | Root directory for scripts. Scanned recursively for `.js` files. |
| `-p` | `--port` | `8080` | HTTP server port. `0` = OS-assigned random port. |
| | `--url` | — | MQTT broker URL (e.g. `mqtt://localhost`). MQTT is disabled when omitted. |
| | `--name` | `logic` | Instance name — used as MQTT client ID and `connected` topic prefix. |
| | `--verbosity` | `info` | Log level: `error`, `warn`, `info`, `debug`. |
| | `--variable-prefix` | `var` | Topic prefix for the variable system. |
| | `--disable-variables` | `false` | Disable variable feedback loop. Useful when running multiple instances. |
| | `--disable-watch` | `false` | Disable file watching (scripts are not reloaded on change). |
| | `--latitude` | `48.7408` | Latitude for solar-event scheduling (`she.schedule('sunrise', ...)`). |
| | `--longitude` | `9.1778` | Longitude for solar-event scheduling. |
| | `--auth` | `none` | Authentication mode: `none` (open), `password` (single-user login), `proxy` (trust HTTP header set by nginx/authentik). |
| | `--proxy-header` | `X-Remote-User` | HTTP header carrying the authenticated user in `proxy` mode. |
| | `--bind-address` | `0.0.0.0` | Interface the HTTP server binds to. Use `127.0.0.1` when behind nginx. |
| | `--db-path` | — | Path to sheDB storage file. sheDB is disabled when omitted. |
| | `--db-retain` | `false` | Publish sheDB document changes as retained MQTT messages. |
| | `--matter-storage` | — | Enable the Matter controller. Pass a directory path or `true` (uses `~/.she/matter`). |
| | `--safe-mode` | `false` | Start without loading any user script — recovery from a script that blocks the event loop. See [safe mode](script-engine.md#safe-mode). |
| | `--safe-mode-auto-detect` | `true` | Enter safe mode automatically when the previous run was killed instead of stopped (leftover `<data-dir>/.she-running`). Disable with `--no-safe-mode-auto-detect`. |
| | `--script-timeout` | `5000` | Milliseconds a script's synchronous top-level code may run before it is terminated; the other scripts load anyway. `0` = no limit. |
| | `--sentinel-timeout` | `5000` | Milliseconds to wait for the retained-state sentinel after connecting to MQTT before starting scripts anyway. |
| `-h` | `--help` | — | Show help. |
| | `--version` | — | Print version. |
| | `--secret-set <group>/<field> [--plain]` | — | Store a secret; the value is read from stdin (`printf '%s' 'pw' \| she --secret-set smtp/password`). `--plain` creates a field whose value the UI shows in clear (a user name, a host). See [Secrets](sandbox-api.md#shesecrets). |
| | `--secret-delete <group>[/<field>]` | — | Delete one secret or a whole group. |
| | `--secret-list` | — | List secret names and change times (never values). |

## Optional integrations

The following integrations are activated only when configured:

| Config key | Description |
|---|---|
| `redis.url` | Redis URL — enables write-through cache for the state store |
| `influx` | InfluxDB connection config — enables time-series write-through. 2.x: `url`, `token`, `org`, `bucket`. 1.x: `url`, `database`, optional `username`, `password`, `retentionPolicy`, `timeout` (ms, default 10000; version inferred from the keys, or forced with `version: 1`) |
| `elastic` | Elasticsearch connection config — enables search index write-through |
| `services.enabled` | Shows the Services page — management of xyz2mqtt adapter instances (MQTT inventory, systemd via the `she-servicectl` helper); `services.hosts[]` lists managed hosts, default the she host. See [services.md](services.md) |

## Environment variables

Every option can be provided as an environment variable with the `SHE_` prefix in SCREAMING_SNAKE_CASE — the option name uppercased with `-` replaced by `_`:

```bash
SHE_URL=mqtt://192.168.1.10 SHE_PORT=8081 SHE_VERBOSITY=debug she
```

| Option | Environment variable |
|---|---|
| `--url` | `SHE_URL` |
| `--dir` | `SHE_DIR` |
| `--data-dir` | `SHE_DATA_DIR` |
| `--name` | `SHE_NAME` |
| `--verbosity` | `SHE_VERBOSITY` |
| `--variable-prefix` | `SHE_VARIABLE_PREFIX` |
| `--port` | `SHE_PORT` |
| `--auth` | `SHE_AUTH` |
| `--proxy-header` | `SHE_PROXY_HEADER` |
| `--bind-address` | `SHE_BIND_ADDRESS` |
| `--db-path` | `SHE_DB_PATH` |
| `--db-retain` | `SHE_DB_RETAIN` |
| `--matter-storage` | `SHE_MATTER_STORAGE` |
| `--disable-variables` | `SHE_DISABLE_VARIABLES` |
| `--disable-watch` | `SHE_DISABLE_WATCH` |
| `--latitude` | `SHE_LATITUDE` |
| `--longitude` | `SHE_LONGITUDE` |
| `--safe-mode` | `SHE_SAFE_MODE` |
| `--safe-mode-auto-detect` | `SHE_SAFE_MODE_AUTO_DETECT` |
| `--script-timeout` | `SHE_SCRIPT_TIMEOUT` |
| `--sentinel-timeout` | `SHE_SENTINEL_TIMEOUT` |
| `--config` | `SHE_CONFIG` |

Boolean options take `true` / `false` (`SHE_DISABLE_WATCH=false` really is false — an empty value is not a way to unset an option, use the config file default instead). Nested config keys (`heartbeat.enabled`, `redis.url`) have no environment equivalent; use the config file for those.

One environment variable is **not** an option and never becomes part of the config:

| | |
|---|---|
| `SHE_SECRETS_KEY` | Encryption key for the secrets store — 32 bytes as hex or base64. When set, `~/.she/config/secrets.key` is neither used nor created. See [Secrets](sandbox-api.md#shesecrets). |

## Config file format

The config file is plain JSON. Keys match long option names in camelCase:

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "name": "logic",
  "verbosity": "info",
  "latitude": 52.52,
  "longitude": 13.405,
  "port": 8080,
  "bindAddress": "0.0.0.0",
  "auth": "none",
  "dbPath": "/opt/she/db.json",
  "matterStorage": "/opt/she/matter"
}
```

**Default config path:** `~/.she/config.json`

The file is loaded automatically at startup if it exists. It can be read and written at runtime via the **Config** tab in the web UI or via `PUT /she/config` — see [http-api.md](http-api.md).

## Precedence

CLI flags > environment variables > config file > built-in defaults.

## Multiple instances

When running more than one instance against the same broker, give each a unique `--name` and disable the variable feedback loop on all but one instance with `--disable-variables`.
