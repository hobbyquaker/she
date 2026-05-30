# she - smart home engine

[![License][mit-badge]][mit-url]

> Node.js script engine for MQTT- and/or Matter-based smart home ecosystems.

she loads your `.js` files into a sandboxed VM that offers easy access to MQTT and Matter. Scripts can subscribe, publish, send commands, schedule actions (cron, solar events), and expose HTTP endpoints — with zero boilerplate.

## Documentation

| File | Contents |
|---|---|
| [doc/getting-started.md](doc/getting-started.md) | Installation, first script, Docker, config file |
| [doc/cli.md](doc/cli.md) | All command-line options and environment variables |
| [doc/sandbox-api.md](doc/sandbox-api.md) | Complete sandbox API reference |
| [doc/http-api.md](doc/http-api.md) | HTTP server, authentication, system and script endpoints |
| [doc/examples.md](doc/examples.md) | Real-world script examples |

## Quick example

```js
// lights.js
she.mqtt.sub('home/motion/hall', { change: true }, (topic, val) => {
    she.mqtt.pub('home/light/hall', val ? 1 : 0);
});

she.sunSchedule('sunset', () => setValue('home/lights/outdoor', 1));
she.sunSchedule('sunrise', () => setValue('home/lights/outdoor', 0));

she.api.get('/status', () => ({ light: getValue('home/light/hall') }));
```

```bash
she --dir ~/scripts --url mqtt://localhost --port 8080
```

## License

MIT © [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
