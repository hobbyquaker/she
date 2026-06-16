# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration

- **propagate M markers to parent directories** — done (v0.28.0)

- **clickable uncommitted-changes indicator** — done (v0.28.0)

- **git history: rename tracking** — done (v0.28.0)

## AI 

- **AI-generated auto-commit messages** — when auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

- **context window usage indicator** — done (v0.28.0, Ollama only)

## Script Engine

- **configurable timezone** — done (v0.28.0)

- **per-script resource limits** — detect callbacks that take too long, log a warning

- **per-script log history** — when a script crashes at 3am and the user opens the UI, the circular log buffer may have rotated away the relevant entries. Concrete symptom: the file tree shows a red error dot on the script, but clicking it opens an empty log panel — the error that caused the dot is gone. Store the last N log lines per script persistently in the data dir (e.g. `~/.she/logs/<scriptname>.jsonl`, ring-buffered) so the log panel always shows recent history even after daemon restart or log rotation.

- **script VM timeout** — the `vm.Script` `timeout` option is never set; a script with an infinite synchronous loop hangs the daemon. Add a configurable per-script CPU timeout (e.g. `she.schedule` should not hang the event loop).

- **config hot-reload** — settings like log level, latitude/longitude, influx/elastic endpoints could be reloaded from `config.json` without a full daemon restart (via `SIGHUP` or a `POST /she/config/reload` endpoint).

- **graceful WebSocket shutdown** — when `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

## Scripts Editor

- **Find & Replace entry point** — add a small **Edit** menu button in the editor toolbar, positioned between the `filename` span and the git-status badges (current layout left-to-right: `filename | [Edit▾] | git-status | Save | Delete | AI`). Clicking it opens a compact dropdown with at minimum: *Find* (`Ctrl+F`) and *Find & Replace* (`Ctrl+H`). Could also include *Go to line* (`Ctrl+G`). Each item calls `editor.getAction('<id>')?.run()` on the Monaco instance. No Monaco context-menu changes; no new route. Frontend-only, ~20 lines + dropdown styling.

- **Format with Prettier** — `POST /she/scripts/format` backend route that runs Prettier server-side (already a root devDependency, not bundled to browser); frontend adds a toolbar button that calls the endpoint and replaces the editor content with the formatted result. Full spec in VS Code prompt `she-editor-improvements`.

- **file tree virtualization** — the tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

## MQTT

- **configurable MQTT protocol version** — done (v0.28.0)

- **per-topic value history** — the MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

## sheDB



## Sandbox API

- **`she.http` webhook input** — `she.http.sub('/webhook/mydevice', callback)` that auto-registers a POST endpoint and calls the callback on each request, closing a common "receive a webhook and trigger logic" pattern.

## Secrets

- **secrets management** — store secrets (named groups of arbitrary string fields, e.g. `{ "smtp": { "password": "…", "host": "…" } }`) in a dedicated encrypted file (`~/.she/secrets.enc`) separate from `config.json`, using AES-256-GCM via Node.js built-in `crypto`. Encryption key sourced from env var `SHE_SECRETS_KEY` (takes precedence) or key file `~/.she/secrets.key` (chmod 600). Access from scripts via `she.secrets.get('<name>/<field>')`. Integrate as own section in config ui (show/hide values). Open questions to resolve before implementation: HTTP API exposure (security concern — avoid reading secret values over the network, or localhost-only), behavior when key is missing, hot-reload vs. startup-only, CLI subcommands for management, configurable secrets file path.

## Operations

- **health check endpoint** — `GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.

- **`npm install` async update** — the `POST /she/update` handler uses `spawnSync`, blocking the entire process while npm runs. Switch to async `spawn` and stream output to the client via WebSocket.

## Security / Robustness

- **path traversal via symlinks** — `safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

- **session persistence** — login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

## Testing

- **integration tests for `.shelib` / `.shedisable` marker hot-reload** — the live unload/reload on marker changes has no test coverage.

- **integration tests for rapid hot-reload** — edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
