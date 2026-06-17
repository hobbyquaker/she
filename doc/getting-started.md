# Getting Started

## Prerequisites

- Node.js >= 20 **or** Docker
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/)) — optional; she also works without MQTT if you only use Matter or sheDB

## Installation

### Install as a systemd service (recommended)

```bash
sudo npm install -g smart-home-engine
sudo she --install
sudo systemctl start smart-home-engine
```

`she --install` creates a dedicated `she` system user and installs + enables the systemd unit. All state (scripts, database, config) is kept in `/var/lib/she/`. Once the service is running, open **http://localhost:8080**

### Docker 

```bash
docker build -t she https://github.com/hobbyquaker/she.git
docker run -d \
  --name she \
  -p 8080:8080 \
  -v she-data:/var/lib/she \
  she
```

All state (scripts, database, config) is stored in the `she-data` volume. Open **http://localhost:8080**

## Web UI

The web UI is served on port **8080** by default. It provides:

| Tab | Description |
|-----|-------------|
| **Scripts** | Monaco-based editor: create, edit, save, rename, and delete `.js` scripts |
| **MQTT** | Browse all known topics with current values and timestamps; publish messages |
| **Matter** | Commission and manage paired Matter devices |
| **DB** | Inspect and edit sheDB documents and views |
| **Logs** | Live structured log stream |
| **Config** | All daemon settings — MQTT broker settings, authentication, ... |

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
