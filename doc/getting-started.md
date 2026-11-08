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

**Updating.** The version button at the top right of the web UI shows the installed version, the update channel (Config → Updates: `stable` offers the releases, `beta` the pre-releases too) and the newest version the channel offers; *Update to v…* installs exactly that version and restarts the daemon once npm has finished — when npm fails, the daemon keeps running and the popup says why. The install runs through the `she-servicectl` helper (`she-update <version>`, helper v16, shipped with 3.0.0-beta.2); an installation set up before that has an older helper — update it once on the Services → Hosts tab (*Update helper*), or run `sudo she --install` again. By hand: `sudo npm install -g smart-home-engine@<version>` (`@latest` for the newest release, `@next` for the newest pre-release), then `sudo systemctl restart smart-home-engine`. A Docker container is updated by pulling a new image.

### Docker

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on every release:

```bash
docker run -d \
  --name she \
  -p 8080:8080 \
  -v she-data:/var/lib/she \
  ghcr.io/hobbyquaker/she:latest
```

Or with compose:

```yaml
services:
    she:
        image: ghcr.io/hobbyquaker/she:latest
        container_name: she
        restart: unless-stopped
        ports:
            - '8080:8080'
        volumes:
            - she-data:/var/lib/she
volumes:
    she-data:
```

Tags follow the releases: `1.36.1`, `1.36`, `1`, and `latest` (pre-releases never move `latest`). To build the image yourself instead: `docker build -t she https://github.com/hobbyquaker/she.git`.

All state (scripts, database, config) is stored in the `she-data` volume. Open **http://localhost:8080**

The image carries a `HEALTHCHECK` against [`GET /she/health`](http-api.md#get-shehealth), so `docker ps` shows `healthy` only once she is up and — if a broker is configured — connected to it. Running she on a different port inside the container means passing a matching `--health-cmd`.

Two things to know about Docker specifically:

- **Matter** needs mDNS on the host network (`--network host`), which does not combine with `-p`.
- **Safe mode**: she [enters safe mode](script-engine.md#safe-mode) when its `.she-running` marker survives a shutdown. `docker rm -f` on a container whose volume is reused looks exactly like that, so if that is your normal workflow, set `"safeModeAutoDetect": false` in the config.

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

### Commits of script changes

What happens after a script is saved, renamed or deleted in the editor is set on the **Config** page (section *Git*)
or with these keys in `config.json`; they take effect at the next save, no daemon restart needed:

| Key | Values | Meaning |
| --- | --- | --- |
| `gitCommitMode` | `off` (default), `ask`, `auto` | `off`: nothing is committed, use the editor's commit buttons. `ask`: a commit dialog opens with a pre-filled message — the changed files and the date and time — that you commit as it is, edit, or replace with one the AI writes from the staged diff; *Cancel* leaves the change uncommitted. `auto`: a commit without asking. |
| `gitCommitAi` | `true` / `false` | In `auto` mode: let the configured [AI assistant](ai.md) write the commit message from the staged diff. Best effort — the message is the generic one (`update <file>`) when no AI is configured, the model fails or does not answer within eight seconds, so saving never waits longer than that. |
| `gitAutoPush` | `true` / `false` | Push to `origin` after every commit, manual or automatic. |
| `gitAutoCommit` | `true` | The key before `gitCommitMode` existed. `true` still means `auto` with the generic message when `gitCommitMode` is not set; the Config page writes `gitCommitMode` instead. |

The *Generate with AI* button in the commit dialogs (also in *Save & Commit* and in the uncommitted-changes popup
of the Scripts page) is disabled with a hint until an AI provider is configured. The model sees the staged diff only,
truncated to about 12 000 characters; nothing else of the installation goes into that request.

## Next steps

- [sandbox-api.md](sandbox-api.md) — complete script API reference
- [http-api.md](http-api.md) — HTTP server, REST endpoints, and WebSocket
- [examples.md](examples.md) — real-world script examples
- [cli.md](cli.md) — all command-line flags (advanced)
