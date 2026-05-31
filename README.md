# she - smart home engine

[![License][mit-badge]][mit-url]

> Node.js script engine for MQTT- and/or Matter-based smart home ecosystems.

**she** loads your `.js` files into a sandboxed VM that gives scripts easy access to MQTT topics, Matter devices, a built-in document store (sheDB), and a scheduler (cron + solar events). A built-in web UI lets you edit scripts, browse MQTT topics, manage Matter devices, and configure the daemon — all from a browser.

## Documentation

| File | Contents |
|---|---|
| [doc/getting-started.md](doc/getting-started.md) | Installation, first script, Docker, config file |
| [doc/cli.md](doc/cli.md) | All command-line options and environment variables |
| [doc/sandbox-api.md](doc/sandbox-api.md) | Complete sandbox API reference |
| [doc/http-api.md](doc/http-api.md) | HTTP server, authentication, REST endpoints, WebSocket |
| [doc/examples.md](doc/examples.md) | Real-world script examples |

## Quick example

```js
// lights.js

// React to motion sensor and control a light
she.mqtt.sub('home//hall/motion', { change: true }, (topic, val) => {
    she.mqtt.set('home//hall/light', val ? 1 : 0);
});

// Switch outdoor lights at dawn and dusk
she.schedule('sunset',  () => she.mqtt.set('home//lights/outdoor', 1));
she.schedule('sunrise', () => she.mqtt.set('home//lights/outdoor', 0));

// Store device config in sheDB
she.db.set('hall/motion', { name: 'Hall PIR', location: 'hall' });
```

```bash
she --dir ~/scripts --url mqtt://localhost --port 8080
```

Then open **http://localhost:8080** in a browser to edit scripts, browse MQTT topics, and manage devices.

## License

MIT © [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
