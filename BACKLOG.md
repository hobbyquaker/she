# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration



## AI 

- **AI-generated auto-commit messages** — when auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

## Script Engine

- **`import` syntax support** — scripts currently run via `vm.Script` (classic-script context) which rejects static `import` declarations. Transform `import X from 'y'` → `const X = require('y')`, `import { a, b } from 'y'` → `const { a, b } = require('y')`, `import * as ns from 'y'` → `const ns = require('y')`, `import 'y'` → `require('y')` inside `createScript()` before handing source to `vm.Script`. Both `import` and `require` would then work side-by-side — no breaking changes. `export` statements have no meaning in script context and should either be stripped silently or cause a clear error. Do not support `import.meta` or top-level `await` (both require true ESM module scope). Implementation: ~30 lines, no new deps. A minimal regex approach covers 99% of real-world use; for robustness consider using acorn (transitive dep) to find and rewrite only top-level import nodes.

- **per-script resource limits** — detect callbacks that take too long, log a warning

- **per-script log history** — when a script crashes at 3am and the user opens the UI, the circular log buffer may have rotated away the relevant entries. Concrete symptom: the file tree shows a red error dot on the script, but clicking it opens an empty log panel — the error that caused the dot is gone. Store the last N log lines per script persistently in the data dir (e.g. `~/.she/logs/<scriptname>.jsonl`, ring-buffered) so the log panel always shows recent history even after daemon restart or log rotation.

- **script VM timeout** — the `vm.Script` `timeout` option is never set; a script with an infinite synchronous loop hangs the daemon. Add a configurable per-script CPU timeout (e.g. `she.schedule` should not hang the event loop).

- **config hot-reload** — settings like log level, latitude/longitude, influx/elastic endpoints could be reloaded from `config.json` without a full daemon restart (via `SIGHUP` or a `POST /she/config/reload` endpoint).

- **graceful WebSocket shutdown** — when `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

## Scripts Editor







- **Find & Replace entry point** — add a small **Edit** menu button in the editor toolbar, positioned between the `filename` span and the git-status badges (current layout left-to-right: `filename | [Edit▾] | git-status | Save | Delete | AI`). Clicking it opens a compact dropdown with at minimum: *Find* (`Ctrl+F`) and *Find & Replace* (`Ctrl+H`). Could also include *Go to line* (`Ctrl+G`). Each item calls `editor.getAction('<id>')?.run()` on the Monaco instance. No Monaco context-menu changes; no new route. Frontend-only, ~20 lines + dropdown styling.


- **file tree virtualization** — the tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

- **`beforeunload` guard for dirty editor tabs** — if the user reloads or closes the browser tab while one or more editor tabs have unsaved changes (`tab.dirty === true`), no warning is shown and the edits are silently lost. The dirty state is already tracked per-tab in `Scripts.svelte`. Fix: register a `beforeunload` event listener in `onMount` (and clean it up in `onDestroy`) that calls `e.preventDefault()` when `tabs.some(t => t.dirty)` — this triggers the browser's native "Leave site? Changes you made may not be saved." dialog. The handler must be a named function (not an arrow function stored in a `let`) so `removeEventListener` can reference the same instance. No new UI needed; browser handles the prompt natively. ~10 lines, frontend-only in `Scripts.svelte`.

## MQTT

  **Recommendation**: implement *Option B* first (low risk, immediate fix for the stdlib functions). Follow up with *Option A* in a minor bump with a migration note, since normalising `"on"`/`"off"` in `parsePayload` is the right long-term convention. Use `v.toLowerCase() === 'off'` in the helper to handle `"Off"`, `"oFF"` etc. without enumerating every variant. New unit tests in `stdlib.test.js` for `or`/`and`/`timer` with `"off"` and `"ON"` source values.

- **per-topic value history** — the MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

- **configurable MQTT sentinel timeout** — the time the daemon waits for the retained-state sentinel after connecting to the broker is currently hard-coded to `_SENTINEL_TIMEOUT_MS = 5000` ms in `src/index.js`. On slow or high-traffic brokers with large retained-state sets, 5 s may not be enough and scripts start without the full retained state. Expose this as a config option (`sentinelTimeout`, in ms) settable via `config.json` / the Config UI. Read it in `src/config.js` (add a `--sentinel-timeout` yargs option with a 5000 ms default) and replace the constant in `index.js` with `config.sentinelTimeout`.

## Packages

- **pinned packages** — allow the user to pin individual npm packages so they are excluded from the outdated count and do not trigger the orange dot on the Packages nav tab. UI: a small pin icon next to the installed version column; clicking it toggles the pin. When a package is pinned and a newer version is available, still show the version arrow but render it in grey instead of orange/yellow — so the update is visible but clearly deprioritised. Pinned package IDs stored in `config.json` (e.g. `pinnedPackages: ["some-package"]`). The `getOutdatedDeps` helper in `web/src/lib/api.ts` (or the backend endpoint) should filter out pinned packages when computing the count used for the dot, while still returning them in the full list so the UI can show them greyed.

## sheDB



## Secrets

- **secrets management** — store secrets (named groups of arbitrary string fields, e.g. `{ "smtp": { "password": "…", "host": "…" } }`) in a dedicated encrypted file (`~/.she/secrets.enc`) separate from `config.json`, using AES-256-GCM via Node.js built-in `crypto`. Encryption key sourced from env var `SHE_SECRETS_KEY` (takes precedence) or key file `~/.she/secrets.key` (chmod 600). Access from scripts via `she.secrets.get('<name>/<field>')`. Integrate as own section in config ui (show/hide values). Open questions to resolve before implementation: HTTP API exposure (security concern — avoid reading secret values over the network, or localhost-only), behavior when key is missing, hot-reload vs. startup-only, CLI subcommands for management, configurable secrets file path.

## Operations

- **health check endpoint** — `GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.


## Security / Robustness

- **path traversal via symlinks** — `safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

- **session persistence** — login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

## Testing

- **integration tests for `.shelib` / `.shedisable` marker hot-reload** — the live unload/reload on marker changes has no test coverage.

- **integration tests for rapid hot-reload** — edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
