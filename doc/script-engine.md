# Script Engine

This document describes how **she** loads and runs `.js` scripts: the execution model, module system, hot-reload mechanics, startup sequencing, and file-system conventions.

---

## Execution model

Each `.js` file is compiled with Node.js's built-in [`vm.Script`](https://nodejs.org/api/vm.html) and runs inside a sandboxed context created with `vm.createContext`. The context is populated with:

- A `she` object containing the full sandbox API (MQTT, scheduling, DB, logging, …)
- Sandboxed `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` (resource-tracked per script)
- `require()` (see [Module system](#module-system) below)
- `Buffer`
- `console.log` / `console.error` (forwarded to `she.info` / `she.error`)

Scripts run **synchronously** in the Node.js event loop. There is no worker thread, no separate process, and no time-slicing. A script that blocks the event loop (e.g. an infinite synchronous loop or a long `while` busy-wait) will stall the entire daemon, including MQTT message processing and all other scripts.

Each script runs inside a Node.js [`domain`](https://nodejs.org/api/domain.html). Uncaught exceptions thrown by callbacks are caught by the domain's `error` handler, logged with a stack trace, and the script continues running (remaining callbacks are not affected). Errors during initial script execution (the top-level run) are also caught and logged.

---

## Module system

### `require()` — the only supported import mechanism

Scripts use `require()` for all imports. Node.js module resolution proceeds in this order:

1. **Engine built-ins** — a fixed set of modules the engine always exposes (`mqtt`, `node-schedule`, `suncalc`, `pino`, …). These are pre-resolved by the engine and returned directly, bypassing the file system.
2. **User-installed packages** — `~/.she/node_modules/` (or the data-dir equivalent). Install packages here with `npm install --prefix ~/.she <package>`.
3. **Script-local packages** — `<script-dir>/node_modules/<package>`. Useful for per-project dependencies.
4. **Engine's own `node_modules`** — fallback to the engine's own dependency tree (built-ins, core Node.js modules, etc.).

Relative imports (`./helper`, `../lib/utils`) are resolved relative to the directory of the calling script.

### No ESM (`import`) support

Scripts run in a **CommonJS VM context**, not as ES modules. Static `import` declarations are **not supported** and will cause a `SyntaxError` at compile time:

```js
// ❌ Will NOT work — SyntaxError
import chalk from 'chalk';
import { EventEmitter } from 'events';

// ✅ Works
const chalk = require('chalk');
const { EventEmitter } = require('events');
```

**Why this matters for npm packages:**

The npm ecosystem is split into three categories:

| Package type | `require()` | `import` (static) |
|---|---|---|
| CJS-only (classic) | ✅ works | ❌ won't compile |
| Dual (CJS + ESM) | ✅ works (loads CJS variant) | ❌ won't compile in she |
| **ESM-only** | ❌ `ERR_REQUIRE_ESM` | ❌ won't compile in she |

ESM-only packages cannot be loaded at all in the current engine. Many popular packages migrated to ESM-only at a major version:

| Package | Last CJS version | ESM-only since |
|---|---|---|
| `chalk` | 4.x | 5.0 |
| `got` | 11.x | 12.0 |
| `node-fetch` | 2.x | 3.0 |
| `execa` | 7.x | 8.0 |
| `p-map`, `p-limit`, … | various | varies |

**Workaround:** install the last CJS version explicitly:

```bash
# in ~/.she or your script directory
npm install chalk@4
npm install node-fetch@2
npm install got@11
```

**Dynamic `import()`** does work inside a VM context (it returns a Promise), but is awkward to use in the typical synchronous script style and is not officially supported or tested.

True ESM support (running scripts as actual ES modules via `vm.Module`) would require a significant rewrite of the script engine and is not planned for the near term.

---

## Hot reload

Scripts are reloaded automatically when their source file changes on disk. File watching uses [chokidar](https://github.com/paulmillr/chokidar) with `usePolling: true` (required for WSL2 / NTFS mounts).

### What happens on reload

When a script file is saved:

1. The old script is **unloaded**:
   - All MQTT subscriptions registered by this script are removed.
   - All `node-schedule` jobs registered by this script are cancelled.
   - All `setTimeout` / `setInterval` timers created by this script are cleared.
   - All sun-event registrations from this script are removed.
   - Per-script resource tracking maps are reset.
   - The `domain` from the previous run is discarded.
2. The file is re-read from disk.
3. The script is **recompiled** (`vm.Script`). A syntax error at this stage is logged; no further execution occurs until the file is saved again.
4. The compiled script is **run** in a fresh sandboxed context.

Other scripts are not affected. The daemon does not restart. MQTT state is preserved.

### What is NOT cleaned up on reload

- **`she.global`** — the shared mutable object (`she.global.myVar`) is shared across all scripts and survives reload. This is intentional.
- **HTTP routes** registered via `she.api.*` or `she.http.sub()` — these are registered on the Express router and are currently not unregistered on reload. Registering the same route twice will throw. To change an API route, restart the daemon.
- **External side effects** — anything your script did to the outside world (MQTT messages published, DB records written, etc.) is not rolled back.

### `.shelib` — shared library directories

A directory containing a `.shelib` marker file is treated as a **library directory**. Scripts inside it are loaded at startup like normal scripts, but they are **not watched** for changes and are not user-scripts. Use `.shelib` directories for shared helper modules that other scripts `require()` relatively.

```
scripts/
  lib/             ← contains .shelib
    helpers.js     ← loaded once at startup, not watched
  automation.js    ← require('./lib/helpers') works
```

### `.shedisable-<name>` — disabling scripts or directories

Place a sibling file named `.shedisable-<name>` next to a script or directory to prevent it from loading. The `<name>` matches the script filename (without extension) or the directory name.

```
scripts/
  broken.js
  .shedisable-broken    ← broken.js is skipped
  experiments/
  .shedisable-experiments   ← entire directory is skipped
```

This is useful for temporarily disabling a script without deleting it. The marker files are visible in the web UI's file tree (they appear as plain files) and can be created/deleted from the editor.

---

## Startup sequencing

Scripts do not run immediately when the daemon starts. The engine waits for the MQTT retained-state burst to complete before running any script. This ensures that `she.mqtt.get()` returns the correct values from the first line of a script, rather than undefined/stale values.

The mechanism:

1. On MQTT connect, the engine publishes a **sentinel message** (non-retained) to `<name>/she-sentinel` immediately after subscribing to `#`.
2. Because MQTT.js sends packets in order on a single TCP connection, the broker receives `SUBSCRIBE #` before the sentinel `PUBLISH`. All retained messages are queued for delivery before the sentinel.
3. When the sentinel arrives, all retained messages have been delivered and stored in the state store. Scripts start.
4. **Fallback**: if the broker never connects within 10 seconds, scripts start anyway (without retained state). If the sentinel never arrives after connecting (within the configured `sentinelTimeout`), scripts also start with a warning.

---

## Error handling

Errors during the **initial top-level execution** of a script (i.e. the script body itself, not a callback) are caught by the domain and logged. The script remains "loaded" in the sense that any callbacks already registered before the error still run. If the error occurs before any `she.mqtt.sub()` calls, no callbacks are registered and the script is effectively a no-op until it is edited and reloaded.

Errors inside **callbacks** (MQTT subscriptions, schedules, etc.) are caught by the domain's `error` handler. The error is logged with a stack trace. Other callbacks from the same script continue to work — a single failing callback does not unload the script.

The web UI shows a **red dot** on scripts with recent errors. The error message and stack trace are visible in the Logs tab (filtered by script name).

---

## Shared state: `she.global`

`she.global` is a plain JavaScript object that is shared and mutable across all scripts:

```js
// script-a.js
she.global.counter = 0;

// script-b.js
she.global.counter += 1;
she.info('counter:', she.global.counter);
```

`she.global` is not persisted — it resets to `{}` on daemon restart. For persistent shared state, use `she.db` (sheDB) or `she.mqtt.pub(..., { retain: true })`.

---

## Logging

`she.debug`, `she.info`, `she.warn`, `she.error` (and the alias `she.log`) automatically prefix every message with the script's name, making it easy to filter log output per script. `console.log` and `console.error` inside scripts are forwarded to `she.info` and `she.error` respectively, also with the script name prefix.

Log level is controlled by `--verbosity` (default: `info`). Set to `debug` to see compilation steps, require resolution, and context setup for each script.
