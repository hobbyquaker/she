# Command-Line Reference

```
Usage: mqtt-scripts [options]
```

## Options

| Short | Long | Default | Description |
|---|---|---|---|
| `-c` | `--config` | auto | Path to JSON config file. Auto-loaded from `~/.config/mqtt-scripts/config.json` if present. |
| `-d` | `--dir` | — | Directory to scan for `.js` script files. Repeatable for multiple directories. |
| `-u` | `--url` | `mqtt://127.0.0.1` | MQTT broker URL. See [MQTT.js docs](https://github.com/mqttjs/MQTT.js#connect-using-a-url). |
| `-n` | `--name` | `logic` | Instance name — used as MQTT client ID and as the prefix for the `connected` topic. |
| `-v` | `--verbosity` | `info` | Log level: `error`, `warn`, `info`, `debug`. |
| `-s` | `--variable-prefix` | `var` | Topic prefix for `$` shorthand substitution (variables). |
| `-t` | `--disable-variables` | `false` | Disable variable feedback. Use when running multiple instances. |
| `-w` | `--disable-watch` | `false` | Disable file watching — process will not exit on file changes. |
| `-l` | `--latitude` | `48.7408` | Latitude for solar-event calculations (`sunSchedule`). |
| `-m` | `--longitude` | `9.1778` | Longitude for solar-event calculations (`sunSchedule`). |
| `-p` | `--port` | — | HTTP server port. `0` = OS-assigned. Omit to disable the HTTP server entirely. |
| `-k` | `--api-key` | — | Bearer token required on all HTTP requests. Omit to disable authentication. |
| `-h` | `--help` | — | Show help. |

## Environment variables

Every option can be provided as an environment variable with the `MQTTSCRIPTS_` prefix in SCREAMING_SNAKE_CASE:

| Option | Environment variable |
|---|---|
| `--url` | `MQTTSCRIPTS_URL` |
| `--dir` | `MQTTSCRIPTS_DIR` |
| `--name` | `MQTTSCRIPTS_NAME` |
| `--verbosity` | `MQTTSCRIPTS_VERBOSITY` |
| `--variable-prefix` | `MQTTSCRIPTS_VARIABLE_PREFIX` |
| `--disable-variables` | `MQTTSCRIPTS_DISABLE_VARIABLES` |
| `--disable-watch` | `MQTTSCRIPTS_DISABLE_WATCH` |
| `--latitude` | `MQTTSCRIPTS_LATITUDE` |
| `--longitude` | `MQTTSCRIPTS_LONGITUDE` |
| `--port` | `MQTTSCRIPTS_PORT` |
| `--api-key` | `MQTTSCRIPTS_API_KEY` |
| `--config` | `MQTTSCRIPTS_CONFIG` |

Environment variables are useful in Docker Compose and systemd unit files.

## Config file format

The config file is plain JSON. Keys match the long option names (camelCase or kebab-case are both accepted):

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": ["/opt/scripts", "/opt/shared-scripts"],
  "name": "logic",
  "verbosity": "info",
  "latitude": 52.52,
  "longitude": 13.405,
  "port": 8080,
  "apiKey": "change-me"
}
```

**Default config path:** `~/.config/mqtt-scripts/config.json`

The file is loaded automatically at startup if it exists. It can be written at runtime via `PUT /she/config` — see [http-api.md](http-api.md). A daemon restart is required for the new config to take effect.

## Precedence

CLI flags > environment variables > config file > built-in defaults.

## Multiple instances

When running more than one instance against the same broker, give each a unique `--name` and disable variable feedback on all but one instance with `--disable-variables`.
