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

`she --install` creates a dedicated `she` system user, installs + enables the systemd unit and puts the `she-servicectl` helper for the optional [Services](services.md) feature in place. All state (scripts, database, config) is kept in `/var/lib/she/`. Once the service is running, open **http://localhost:8080**

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
| **Broker** | Manage Mosquitto config, listeners, TLS, dynsec users and roles *(must be enabled — see below)* |
| **Matter** | Commission and manage paired Matter devices *(must be enabled — see below)* |
| **DB** | Inspect and edit sheDB documents and views |
| **Logs** | Live structured log stream |
| **Config** | All daemon settings — MQTT broker settings, authentication, ... |

> **Note:** The **Broker** and **Matter** tabs are hidden by default. Enable them in **Config → Mosquitto** and **Config → Matter controller** respectively. The **DB** tab is visible by default and can be hidden the same way.

## Your first script

Create a new script in the **Scripts** tab and paste:

```js
she.info('hello from she!');

she.mqtt.sub('home/#', (topic, val) => {
    she.info(topic, '->', val);
});
```

Scripts are hot-reloaded automatically — saving a file in the editor restarts only that script, without restarting the entire daemon.

## Git integration

The **Scripts** editor has built-in git support (commit, push, history). To use it you need to set up a git repository in the scripts data directory yourself — she does not do this automatically.

### systemd installation

```bash
sudo -u she git -C /var/lib/she init
sudo -u she git -C /var/lib/she remote add origin git@github.com:you/she-scripts.git
sudo -u she git -C /var/lib/she config user.email "you@example.com"
sudo -u she git -C /var/lib/she config user.name "Your Name"
```

> **Note:** All git commands on `/var/lib/she` must be run as `sudo -u she` — the daemon runs as the `she` user and git operations will fail with permission errors otherwise. SSH keys for push access should be placed in `/var/lib/she/.ssh/`.

### Docker

```bash
# open a shell into the running container
docker exec -it she bash

# inside the container
git -C /var/lib/she init
git -C /var/lib/she remote add origin git@github.com:you/she-scripts.git
git -C /var/lib/she config user.email "you@example.com"
git -C /var/lib/she config user.name "Your Name"
```

Git runs as root inside the container. Place SSH keys in the volume at `/var/lib/she/.ssh/` (mode `700` for the directory, `600` for key files).

## Next steps

- [sandbox-api.md](sandbox-api.md) — complete script API reference
- [http-api.md](http-api.md) — HTTP server, REST endpoints, and WebSocket
- [examples.md](examples.md) — real-world script examples
- [cli.md](cli.md) — all command-line flags (advanced)
