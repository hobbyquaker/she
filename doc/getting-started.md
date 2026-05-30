# Getting Started

## Prerequisites

- Node.js >= 18
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/))

## Installation

```bash
npm install -g mqtt-scripts
```

Or run without a global install via `npx`:

```bash
npx mqtt-scripts --dir ~/scripts --url mqtt://localhost
```

## Quick start

1. Create a directory for your scripts:

   ```bash
   mkdir -p ~/scripts
   ```

2. Write your first script:

   ```js
   // ~/scripts/hello.js
   she.log('hello from mqtt-scripts!');

   subscribe('home/#', function (topic, val) {
       she.log(topic, '->', val);
   });
   ```

3. Start the daemon:

   ```bash
   mqtt-scripts --dir ~/scripts --url mqtt://localhost
   ```

Scripts are hot-reloaded: the process exits when any watched file changes, so use a process manager like **systemd** or **pm2** to restart it automatically.

## Using a config file

Instead of repeating flags on the command line, store them in a JSON config file:

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "name": "logic",
  "verbosity": "info"
}
```

The file is automatically loaded from `~/.config/mqtt-scripts/config.json` when it exists, or point to it explicitly:

```bash
mqtt-scripts --config /path/to/config.json
```

The config file can also be read and written at runtime via the HTTP API — see [http-api.md](http-api.md).

## Docker

```bash
docker run --rm \
  -e MQTTSCRIPTS_URL=mqtt://broker \
  -v /opt/scripts:/scripts:ro \
  dersimn/mqtt-scripts --dir /scripts
```

All CLI flags can be set as `MQTTSCRIPTS_` environment variables (e.g. `MQTTSCRIPTS_URL`, `MQTTSCRIPTS_PORT`, `MQTTSCRIPTS_API_KEY`).

## Next steps

- [cli.md](cli.md) — all command-line options and environment variables
- [sandbox-api.md](sandbox-api.md) — complete script API reference
- [http-api.md](http-api.md) — HTTP server and REST endpoints
- [examples.md](examples.md) — real-world script examples
