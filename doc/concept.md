# Concepts

This document explains the core ideas behind **she** — the design philosophy, how MQTT and sheDB complement each other, and ideas about structuring a growing home automation system.

---

## Zero boilerplate scripting

Most home automation platforms accumulate abstraction over time: adapters, bindings, service registrations, YAML configuration files, entity declarations. Adding a new device means configuring it in one place, mapping it in another, and declaring its capabilities somewhere else — before you can write a single line of automation logic.

**she** takes a different approach. A script is a plain JavaScript file. It subscribes to MQTT topics, reacts to changes, and publishes back. That is the entire programming model. No class registration, no entity declarations, no platform-specific APIs to learn.

```js
// Turn on the hallway light when motion is detected, turn it off after 5 minutes
she.mqtt.timer('home/motion/hall', 5 * 60 * 1000, 'home/light/hall');
```

This is the complete automation. No entity, no adapter, no service setup. The `she` object provides everything a script needs, and everything else gets out of the way.

---

## MQTT for changing state

MQTT retained messages are the natural store for **fast-changing, sensor-driven state** in a smart home: temperature readings, light levels, switch positions, power consumption, door/window contacts. These values:

- change frequently (seconds to minutes)
- are produced by devices that are themselves MQTT-native, or by bridges/adapters
- need to be immediately visible to all interested scripts on daemon restart
- do not need a richer data model than a value + timestamp

she treats MQTT as the **primary state bus**. Every retained message is tracked in an in-memory state store so `she.mqtt.get(topic)` always returns the current value synchronously. Subscriptions fire callbacks whenever a value changes.

```js
// React to a temperature change on any thermostat
she.mqtt.sub('home/thermostat/+/temperature', { change: true }, (topic, val) => {
    if (val > 25) she.mqtt.pub('home/climate/cooling', 1);
});
```

Because MQTT handles the transport and retention, scripts never need to poll, persist, or cache sensor values manually.

---

## sheDB for structured, rarely-changing data

Not all data in a smart home changes frequently. Some data describes the *structure* of your home — and that structure changes slowly:

- Which room is each device in?
- What type is a device (light, switch, sensor, blind, ...)?
- What are the friendly names of devices?
- Which devices belong to a group?
- What are the configuration parameters for a device (e.g. calibration offsets, thresholds)?
- What are the members of an enum (a list of rooms, a list of zones, ...)?

Storing this as retained MQTT messages works, but it's awkward: MQTT topics have no schema, no querying, and no structure beyond a flat key-value model.

**sheDB** is the right home for this class of data. It is a lightweight embedded document store, built into the daemon, with no external dependencies.

### The home model: devices, rooms and functions

The structure of a home is mostly announced already: zigbee2mqtt, ESPHome, Tasmota, Shelly, Z-Wave JS UI and the
mqtt-smarthome adapters publish Home Assistant discovery configs that say which devices and entities exist and which
topics belong to them. she keeps a copy of those in sheDB — the [home model](home-model.md) — with one document per
device and per entity (`she/device/…`, `she/entity/…`), and lets you organise them in floors, rooms, functions and
labels on the Home page. You do not write a device registry by hand.

```js
// every window contact in the bathroom, whatever adapter it comes from
for (const e of she.home.entities({ room: 'bathroom', function: 'openings' })) {
    she.mqtt.sub(e.state_topic, { change: true }, () => she.log(e.name, she.home.entity(e.id).state().state));
}

// the rooms with their floor and how many entities they have
she.log(she.home.rooms().map((r) => r.name).join(', '));
```

A room is a document `she/room/<id>` (name, floor, aliases, order); the lists of rooms, floors and entities per room
or function are [standard views](sandbox-api.md#standard-views) that she keeps up to date (`she/rooms`,
`she/entities/by-room-function`, …). A list of rooms is never hard-coded.

### Your own documents

What she does not know is yours to store: calibration offsets, thresholds, a schedule per room, the members of a
group only you care about. Keep it **outside `she/…`** — that namespace is she's — and refer to she's documents by
their id:

```js
// a correction per temperature sensor, keyed by the entity's id
she.db.set('calibration/temperature', {
    'she/entity/shellyht-abc123-temperature': -0.5,
});

const offsets = she.db.get('calibration/temperature') ?? {};
for (const e of she.home.entities({ function: 'climate', component: 'sensor' })) {
    if (e.device_class !== 'temperature') continue;
    she.home.entity(e.id).sub((now) => {
        const value = now.state.value;
        if (typeof value === 'number') she.log(e.name, value + (offsets[e.id] ?? 0));
    });
}
```

A room can carry fields of your own too (`she.db.extend('she/room/kitchen', { facade: 'south' })`): she keeps
fields she does not know.

### When to use MQTT vs. sheDB

| | MQTT (retained) | sheDB |
|---|---|---|
| **Change frequency** | Seconds to minutes | Hours, days, or never |
| **Produced by** | Devices, bridges, scripts | You, manually or via scripts |
| **Typical content** | Temperature, switch state, power, presence | The home model (devices, rooms, functions), config params, your own lists |
| **Querying** | By topic / wildcard | Map/reduce views, ad-hoc `db.query()` |
| **Script access** | `she.mqtt.get()`, `she.mqtt.sub()` | `she.db.get()`, `she.db.query()` |
| **Persistence** | Broker-managed (retained flag) | JSON file on disk (`--db-path`) |
| **Survives broker restart** | Yes (broker retains) | Yes (daemon persists) |

A useful rule of thumb: if a value would appear in a time-series graph, it belongs in MQTT. If it would appear in a configuration spreadsheet, it belongs in sheDB.

---

## Script versioning with Git

The web UI has built-in git integration for the scripts directory. From the **Scripts** tab you can commit changes, write commit messages, view history, and push to a remote — without leaving the browser.

She does not create a git repository automatically. You set it up once and then forget about it.

### Setting up (systemd installation)

All git commands on the data directory must be run as the `she` user — the daemon owns the files and git will fail with permission errors if you run as root or your own user:

```bash
sudo -u she git -C /var/lib/she init
sudo -u she git -C /var/lib/she remote add origin git@github.com:you/she-scripts.git
sudo -u she git -C /var/lib/she config user.email "you@example.com"
sudo -u she git -C /var/lib/she config user.name "Your Name"
```

SSH keys for push access go in `/var/lib/she/.ssh/` (directory mode `700`, key files mode `600`):

```bash
sudo -u she ssh-keygen -t ed25519 -f /var/lib/she/.ssh/id_ed25519 -N ""
# Add the public key to your GitHub/Gitea/GitLab account
cat /var/lib/she/.ssh/id_ed25519.pub
```

### Setting up (Docker)

```bash
docker exec -it she bash
git -C /var/lib/she init
git -C /var/lib/she remote add origin git@github.com:you/she-scripts.git
git -C /var/lib/she config user.email "you@example.com"
git -C /var/lib/she config user.name "Your Name"
```

Git runs as root inside the container. SSH keys go in the volume at `/var/lib/she/.ssh/`.

### What gets committed

The git repository covers the entire data directory, which includes scripts, the sheDB data file, and the `config.json`. You may want to add a `.gitignore` to exclude things you do not want versioned (e.g. secrets, large binary files):

```bash
sudo -u she tee /var/lib/she/.gitignore <<'EOF'
# exclude sensitive config values — commit a sanitized copy manually if needed
config.json
# exclude sheDB if you don't want document state versioned
she.db
EOF
```

Once the remote is configured, the commit/push/history controls in the Scripts tab work without any further setup.

---

## Broker access control with Mosquitto Dynamic Security

In a production homelab it is often useful to assign different MQTT permissions to different clients — for example, granting a specific IoT device access only to its own topics, or restricting a guest system from publishing to sensitive topics.

**she** integrates with Mosquitto's [Dynamic Security plugin](https://mosquitto.org/documentation/dynamic-security/) and exposes its full management surface through the `she.broker.*` script API and the Broker page in the web UI. From a script you can create and delete clients, roles, and groups, assign ACLs, and react to membership changes — all at runtime, without restarting Mosquitto or editing config files by hand.

```js
// Provision a new IoT device client with its own role and topic ACL
she.broker.createClient({ username: 'sensor-kitchen', password: 'secret' });
she.broker.createRole({ rolename: 'sensor-kitchen' });
she.broker.addRoleACL('sensor-kitchen', 'publishClientSend', 'home/sensor/kitchen/#', true);
she.broker.assignRole('sensor-kitchen', 'sensor-kitchen');
```

This makes it straightforward to automate device provisioning: a single script can handle the full lifecycle — creating credentials when a device is first seen and revoking them when it is decommissioned.

See [Broker management](broker-management.md) for the full API reference, setup instructions, and the web UI walkthrough.

