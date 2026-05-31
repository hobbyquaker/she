# she — smart home engine

[![License][mit-badge]][mit-url]

Your home, your rules — written in plain JavaScript.

**she** is a Node.js daemon that loads your `.js` scripts into a sandboxed VM and wires them up to MQTT, Matter, and everything else your smart home throws at them. No cloud, no lock-in, no YAML sprawl, no opinionated bloated schemata. Just scripts that do exactly what you tell them.

- **MQTT** — subscribe, publish, react to state changes with wildcards, conditions, and delays
- **Matter** — pair and control Matter devices directly from your scripts
- **sheDB** — a lightweight document store with map/reduce views, right in the daemon
- **Scheduler** — cron expressions and solar events (`sunrise`, `sunset`, …) in one call
- **Web UI** — Script editor, MQTT topic browser, Matter device manager, sheDB-Frontend, live logs

## Motivation

She is built around a simple idea: home automation should stay understandable, even as it grows. Instead of collecting adapters, bindings, integrations, and configuration layers, you work directly with devices, events, and logic. The result is a system that scales with your home without turning into a project of its own.

Spend your time automating your home, not maintaining your automation software. Less clicking through configuration screens, fewer plugins talking to plugins, and no need for YAML archaeology when something stops working. Just a straightforward path from devices to automations, built on open standards and designed for people who prefer understanding their system over managing it.

At some point every smart home platform starts promising simplicity and ends up teaching you its own ecosystem. She takes a different approach. It's built around devices, messages, and automation logic—not around ever-growing collections of adapters, bindings, and abstractions.

The goal is simple: a smart home that remains understandable years later. No migration-guide marathons, no plugin jungles, no configuration archaeology. Just automation infrastructure that grows with your home instead of growing into a hobby of its own.

## Docs

| | |
|---|---|
| [Getting started](doc/getting-started.md) | Install, write your first script, configure |
| [CLI reference](doc/cli.md) | All flags and environment variables |
| [Sandbox API](doc/sandbox-api.md) | Everything available inside a script |
| [HTTP API](doc/http-api.md) | REST endpoints and WebSocket |
| [Examples](doc/examples.md) | Real-world script patterns |

## Quick look

```js
// lights.js

// Follow a motion sensor
she.mqtt.sub('home//hall/motion', { change: true }, (topic, val) => {
    she.mqtt.set('home//hall/light', val ? 1 : 0);
});

// Solar schedule — no hardcoded times
she.schedule('sunset',  () => she.mqtt.set('home//lights/outdoor', 1));
she.schedule('sunrise', () => she.mqtt.set('home//lights/outdoor', 0));

// Keep device metadata in sheDB
she.db.set('hall/motion', { name: 'Hall PIR', location: 'hall' });
```

```bash
npm install -g she
she --dir ~/scripts --url mqtt://localhost
```

Then open **http://localhost:8080** and start writing.

## License

MIT © [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
