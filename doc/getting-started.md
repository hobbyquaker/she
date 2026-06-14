# Getting Started

## Prerequisites

- Node.js >= 20
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) — optional; she also works without MQTT if you only use Matter or sheDB

## Installation

### Run manually

```bash
npm install -g smart-home-engine
she
```

Open **http://localhost:8080**, go to the **Config** tab, and set your MQTT broker URL and any other settings. Everything is configurable from the web UI — no config file editing needed.

### Install as a systemd service (Linux)

```bash
sudo npm install -g smart-home-engine
sudo she --install
sudo systemctl start smart-home-engine
```

`she --install` creates a dedicated `she` system user and installs + enables the systemd unit. All state (scripts, database, config) is kept in `/home/she/.she/`. Once the service is running, open **http://localhost:8080** to configure it via the web UI.

## Web UI

The web UI is served on port **8080** by default. It provides:

| Tab | Description |
|-----|-------------|
| **Scripts** | Monaco-based editor: create, edit, save, rename, and delete `.js` scripts |
| **MQTT** | Browse all known topics with current values and timestamps; publish messages |
| **Matter** | Commission and manage paired Matter devices |
| **DB** | Inspect and edit sheDB documents and views |
| **Logs** | Live structured log stream |
| **Config** | All daemon settings — MQTT broker URL, authentication, port, and more |

## Your first script

Create a new script in the **Scripts** tab and paste:

```js
she.info('hello from she!');

she.mqtt.sub('home/#', (topic, val) => {
    she.info(topic, '->', val);
});
```

Scripts are hot-reloaded automatically — saving a file in the editor restarts only that script, without restarting the entire daemon.

## Next steps

- [sandbox-api.md](sandbox-api.md) — complete script API reference
- [http-api.md](http-api.md) — HTTP server, REST endpoints, and WebSocket
- [examples.md](examples.md) — real-world script examples
- [cli.md](cli.md) — all command-line flags (advanced)
