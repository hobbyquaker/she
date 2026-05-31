# Getting Started

## Prerequisites

- Node.js >= 20
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) — optional; she also works without MQTT if you only use Matter or sheDB

## Installation

```bash
npm install -g she
```

## Quick start

1. Create a directory for your scripts:

   ```bash
   mkdir -p ~/scripts
   ```

2. Write your first script:

   ```js
   // ~/scripts/hello.js
   she.log('hello from she!');

   she.mqtt.sub('home/#', (topic, val) => {
       she.log(topic, '->', val);
   });
   ```

3. Start the daemon:

   ```bash
   she --dir ~/scripts --url mqtt://localhost
   ```

4. Open the web UI at **http://localhost:8080** to edit scripts, browse MQTT topics, and manage the daemon configuration.

Scripts are hot-reloaded automatically: whenever you save a `.js` file inside `--dir`, she restarts that script without restarting the entire process.

## Using a config file

Instead of repeating flags on the command line, store them in a JSON config file:

```json
{
  "url": "mqtt://192.168.1.10",
  "dir": "/opt/scripts",
  "name": "logic",
  "port": 8080,
  "apiKey": "secret",
  "verbosity": "info"
}
```

The file is automatically loaded from `~/.she/config.json` when it exists, or point to it explicitly:

```bash
she --dir ~/scripts --config /path/to/config.json
```

You can also read and write `config.json` at runtime from the **Config** tab in the web UI or via the HTTP API — see [http-api.md](http-api.md).

## Web UI

The built-in web UI is served on the configured `--port` (default 8080). It provides:

| Tab | Description |
|-----|-------------|
| **Scripts** | Monaco-based editor: open, edit, save, rename, and delete `.js` scripts |
| **MQTT** | Browse all known topics with current values and timestamps; publish messages |
| **Matter** | Commission and manage paired Matter devices |
| **DB** | Inspect and edit sheDB documents and views |
| **Logs** | Live structured log stream |
| **Config** | Read and write `config.json` |

If `apiKey` is set in the config, the UI prompts for the key on first load.

## Docker

```bash
docker run --rm \
  -e SHE_URL=mqtt://broker \
  -v /opt/scripts:/scripts:ro \
  she --dir /scripts
```

All CLI flags can also be set via environment variables using the `SHE_` prefix in SCREAMING_SNAKE_CASE (e.g. `SHE_URL`, `SHE_PORT`, `SHE_API_KEY`).

## Next steps

- [cli.md](cli.md) — all command-line options and environment variables
- [sandbox-api.md](sandbox-api.md) — complete script API reference
- [http-api.md](http-api.md) — HTTP server, REST endpoints, and WebSocket
- [examples.md](examples.md) — real-world script examples
