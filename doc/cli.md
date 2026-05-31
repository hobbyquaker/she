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
| | `--api-key` | — | Bearer token required on all HTTP/WebSocket requests. Auth disabled when omitted. |
| | `--db-path` | — | Path to sheDB storage file. sheDB is disabled when omitted. |
| | `--db-retain` | `false` | Publish sheDB document changes as retained MQTT messages. |
| | `--matter-storage` | — | Enable the Matter controller. Pass a directory path or `true` (uses `~/.she/matter`). |
| `-h` | `--help` | — | Show help. |
| | `--version` | — | Print version. |

## Optional integrations

The following integrations are activated only when configured:

| Config key | Description |
|---|---|
| `redis.url` | Redis URL — enables write-through cache for the state store |
| `influx` | InfluxDB connection config — enables time-series write-through |
| `elastic` | Elasticsearch connection config — enables search index write-through |

## Environment variables

Every option can be provided as an environment variable with the `SHE_` prefix in SCREAMING_SNAKE_CASE:

| Option | Environment variable |
|---|---|
| `--url` | `SHE_URL` |
| `--dir` | `SHE_DIR` |
| `--name` | `SHE_NAME` |
| `--verbosity` | `SHE_VERBOSITY` |
| `--port` | `SHE_PORT` |
| `--api-key` | `SHE_API_KEY` |
| `--db-path` | `SHE_DB_PATH` |
| `--db-retain` | `SHE_DB_RETAIN` |
| `--matter-storage` | `SHE_MATTER_STORAGE` |
| `--disable-variables` | `SHE_DISABLE_VARIABLES` |
| `--disable-watch` | `SHE_DISABLE_WATCH` |
| `--latitude` | `SHE_LATITUDE` |
| `--longitude` | `SHE_LONGITUDE` |
| `--config` | `SHE_CONFIG` |

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
  "apiKey": "change-me",
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
