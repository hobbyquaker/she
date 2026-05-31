<div align="center">
  <img src="doc/she.jpg" alt="she – smart home engine" width="220" />
</div>

# she — smart home engine

[![License][mit-badge]][mit-url]

Your home, your rules — written in plain JavaScript.

**she** is a Node.js daemon that loads your `.js` scripts into a sandboxed VM and wires them up to MQTT, Matter, and everything else your smart home throws at them. No cloud, no lock-in, no YAML sprawl. Just scripts that do exactly what you tell them.

- **MQTT** — subscribe, publish, react to state changes with wildcards, conditions, and delays
- **Matter** — pair and control Thread/Wi-Fi devices directly from your scripts
- **sheDB** — a lightweight document store with map/reduce views, right in the daemon
- **Scheduler** — cron expressions *and* solar events (`sunrise`, `sunset`, …) in one call
- **Web UI** — Monaco-based script editor, MQTT topic browser, device manager, live logs

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
