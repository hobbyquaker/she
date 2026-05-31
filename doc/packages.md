# Package Management

**she** lets your scripts `require()` any npm package. Packages are installed into `~/.she/node_modules/` and persisted in `~/.she/package.json`.

## Installing packages

Use the **Packages** tab in the web UI, or run npm commands directly in `~/.she/`:

```sh
cd ~/.she
npm install lodash axios
```

## Using packages in scripts

After installing, `require()` works normally inside any script:

```js
/* global she */
'use strict';

const _ = require('lodash');
const axios = require('axios');

she.schedule('0 6 * * *', async () => {
    const { data } = await axios.get('https://api.example.com/data');
    she.info('fetched', _.size(data), 'items');
});
```

## Hot-reload behaviour

| Action | Effect |
|---|---|
| Edit a regular `.js` script | Hot-reloaded immediately |
| Install / update / remove a package | **Daemon restart required** |
| Edit a library file (in a `.shelib` dir) | Warn only — restart required |

Scripts that have already `require()`d a package keep the old version in memory until the daemon restarts. The web UI shows a restart banner after any install, update, or remove operation.

## Library directories (`.shelib`)

Create an empty `.shelib` file inside any directory to mark it as a **library directory**. Files inside are not loaded as scripts automatically — they can still be `require()`d by other scripts, but they won't be run on startup and won't be hot-reloaded.

```
~/.she/scripts/
├── lights.js          ← loaded as script
├── heating.js         ← loaded as script
└── lib/
    ├── .shelib        ← marker: this dir is a library
    └── helpers.js     ← NOT loaded as script; require('./lib/helpers') still works
```

Toggle the **lib** checkbox on any folder in the Scripts tree view to add or remove the `.shelib` marker. Changes take effect after daemon restart.

## Resolve order for `require()`

1. Pre-loaded engine modules (`fs`, `path`, `mqtt`, `node-schedule`, `suncalc`, …)
2. `~/.she/node_modules/<package>` (user-installed via the Packages tab)
3. `<scriptDir>/node_modules/<package>` (backward compat — per-scripts-dir packages)
4. Node.js built-in modules (`https`, `os`, `crypto`, …)

## Security considerations

- Packages run with full Node.js privileges — the same trust level as your own scripts.
- Review packages before installing; supply-chain attacks and malicious code in npm packages are a real risk.
- Native add-ons (`.node` binaries) work but must match the Node.js ABI version.
- **she** targets trusted, home-network environments. Do not expose the web UI to untrusted networks without strong authentication (`apiKey` in `~/.she/config.json`).

## Daemon restart

A restart is equivalent to `process.exit(0)` — the process manager (systemd, PM2, Docker, etc.) is expected to restart the daemon automatically. If running manually, you will need to start it again.
