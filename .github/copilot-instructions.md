# GitHub Copilot Instructions

## Project Overview

**mqtt-scripts** is a Node.js CLI daemon that loads user scripts into a sandboxed VM and connects them to an MQTT broker. Scripts can subscribe to topics, publish values, and schedule actions (cron, solar events). It targets smart-home environments.

- Entry point: `index.js` (CommonJS, runs as a daemon)
- Sandbox API surface: `subscribe()`, `publish()`, `link()`, `schedule()`, `sunSchedule()`, `getValue()`, `setValue()`, `getProp()`, `now()`, `age()`
- Config: `config.js` (yargs v17, `.parseSync()`)

## Stack

| Concern | Library |
|---------|---------|
| MQTT client | mqtt v5 |
| File watching | chokidar v4 (`usePolling: true` required for WSL2/NTFS paths) |
| Scheduling | node-schedule v2 |
| Solar events | suncalc |
| Logging | pino v9 + pino-pretty v13, **no ANSI colors** (`colorize: false`), `sync: true` (same-thread stream, not worker-thread transport) |
| CLI args | yargs v17 |

## Testing

- Framework: **Jest 29** (`testTimeout: 180000`, `forceExit: true`)
- In-process MQTT broker: **aedes 0.50** on a random port (`:0`)
- Fake time: **@sinonjs/fake-timers v11** — fakes only `Date`, `shouldAdvanceTime: true`, starts at `2020-01-01 23:59:20`
- All tests live in `test.js`; test scripts in `testscripts/`
- Run: `npm test`

### Key test setup facts

- `brokerSockets` Set tracks all TCP connections for forceful close in the disconnect test
- `mqtt.end(true, {}, callback)` — second arg must be `{}` (mqtt v5 signature)
- The daemon is spawned as a child process via `child_process.spawn`; its stdout is consumed line-by-line with `readline`

## Code Conventions

- **ESLint**: flat config in `eslint.config.mjs` (v9)
- **Prettier**: v3, config in `package.json`
- Format before committing: `npm run format`
- Lint: `npm run lint`

## Important Constraints

- **No ANSI colors** in log output — `colorize: false` in pino-pretty
- **Preserve full stack traces** in domain error handler
- **chokidar v4** (not v5) — v5 is ESM-only; this project uses CJS `require()`
- **`usePolling: true`** in all `chokidar.watch()` calls — required for WSL2 NTFS paths (`/mnt/c/...`)
- pino must use **same-thread sync stream** (`PinoPretty({ sync: true })`), not the worker-thread transport, so the last log line before `process.exit(0)` is not lost
- CoffeeScript support has been removed; only `.js` scripts are loaded
- No git push — stay local only

## Branch

Active work is on `feat/modernize`.
