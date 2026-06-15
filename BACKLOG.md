# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration

- **per-file git history panel** — right-click a file → "Show git history" (only when `gitInfo !== null`); shows a commit list in the left aside (below the file tree, fixed height ~220 px); clicking a commit opens a read-only diff in the existing diff overlay (historic content vs. current editor content). Requires two new backend routes: `GET /she/git/log?path=&limit=` and `GET /she/git/show?hash=&path=`. Full spec in VS Code prompt `she-git-history-view`.

## AI Chat

- **context window usage indicator** — show a circle near the chat input indicating context window usage %. Ollama exposes context length per model via `POST /api/show` → `model_info` (field name is architecture-specific, e.g. `llama.context_length`); non-Ollama providers don't have an equivalent. `Chat.svelte` already tracks `requestBytes` (prompt + input size in bytes). The indicator needs the model's max context size as the denominator.

## Script Engine

- **per-script resource limits** — detect callbacks that take too long, log a warning

- **per-script log history** — when a script crashes at 3am and the user opens the UI, the circular log buffer may have rotated away the relevant entries. Store the last N log lines per script persistently in the data dir so the log panel always shows recent history even after daemon restart.

- **script VM timeout** — the `vm.Script` `timeout` option is never set; a script with an infinite synchronous loop hangs the daemon. Add a configurable per-script CPU timeout (e.g. `she.schedule` should not hang the event loop).

- **config hot-reload** — settings like log level, latitude/longitude, influx/elastic endpoints could be reloaded from `config.json` without a full daemon restart (via `SIGHUP` or a `POST /she/config/reload` endpoint).

- **graceful WebSocket shutdown** — when `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

## Scripts Editor

- **Find & Replace entry point** — add "Find" and "Find & Replace" to Monaco's right-click context menu via `editor.addAction()` so mouse-driven users can discover the built-in widget. No custom widget needed; Monaco handles Ctrl+F / Ctrl+H natively. Full spec in VS Code prompt `she-editor-improvements`.

- **Format with Prettier** — `POST /she/scripts/format` backend route that runs Prettier server-side (already a root devDependency, not bundled to browser); frontend adds a toolbar button that calls the endpoint and replaces the editor content with the formatted result. Full spec in VS Code prompt `she-editor-improvements`.

- **file tree virtualization** — the tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

## MQTT

- **per-topic value history** — the MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

## sheDB

- **view auto-refresh** — the DB tab's view result doesn't update when underlying documents change. A "live" toggle that re-runs the view on `db:change` WebSocket events would be useful.

## Sandbox API

- **`she.http` webhook input** — `she.http.sub('/webhook/mydevice', callback)` that auto-registers a POST endpoint and calls the callback on each request, closing a common "receive a webhook and trigger logic" pattern.

## Operations

- **health check endpoint** — `GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.

- **`npm install` async update** — the `POST /she/update` handler uses `spawnSync`, blocking the entire process while npm runs. Switch to async `spawn` and stream output to the client via WebSocket.

## Security / Robustness

- **path traversal via symlinks** — `safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

- **session persistence** — login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

## Testing

- **integration tests for `.shelib` / `.shedisable` marker hot-reload** — the live unload/reload on marker changes has no test coverage.

- **integration tests for rapid hot-reload** — edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
