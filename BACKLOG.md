# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration

- **per-file git history panel** — right-click a file → "Show git history" (only when `gitInfo !== null`); shows a commit list in the left aside (below the file tree, fixed height ~220 px); clicking a commit opens a read-only diff in the existing diff overlay (historic content vs. current editor content). Requires two new backend routes: `GET /she/git/log?path=&limit=` and `GET /she/git/show?hash=&path=`. Full spec in VS Code prompt `she-git-history-view`.

- **clickable uncommitted-changes indicator** — the `✎N` badge in the Scripts toolbar is currently passive. Clicking it should open a small popup that (a) lists every changed file with its git status letter (`M`, `D`, `A`, `?`, etc.), and (b) offers a "Commit all" button with an inline message input. This also fixes the UX confusion where the counter shows N > 0 but no file in the tree has an M dot — which happens legitimately when deleted files, hidden marker files (`.shedisable-*`), or staged-only changes are involved. The popup makes the actual change set visible regardless of whether those paths appear in the tree.

- **propagate M markers to parent directories** — when only a file deep in a subdirectory has uncommitted changes, its parent folder(s) in the tree show no indicator. Add a faint dot or `M` to parent dirs so the user can find the changed file without expanding every folder.

## AI 

- **AI-generated auto-commit messages** — when auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

- **context window usage indicator** — show a circle near the chat input indicating context window usage %. Ollama exposes context length per model via `POST /api/show` → `model_info` (field name is architecture-specific, e.g. `llama.context_length`); non-Ollama providers don't have an equivalent. `Chat.svelte` already tracks `requestBytes` (prompt + input size in bytes). The indicator needs the model's max context size as the denominator.

## Script Engine

- **configurable timezone** — add a `timezone` field to the Config UI (e.g. `"Europe/Berlin"`). The daemon should set `process.env.TZ` at startup so that Node.js date/time operations and `node-schedule` cron expressions all work in the configured timezone. Without this, cron schedules run in the server's system timezone which may differ from the user's local time. The Config UI should offer a searchable dropdown of IANA timezone names. Document the option and note that a daemon restart is required when changed.

- **per-script resource limits** — detect callbacks that take too long, log a warning

- **per-script log history** — when a script crashes at 3am and the user opens the UI, the circular log buffer may have rotated away the relevant entries. Concrete symptom: the file tree shows a red error dot on the script, but clicking it opens an empty log panel — the error that caused the dot is gone. Store the last N log lines per script persistently in the data dir (e.g. `~/.she/logs/<scriptname>.jsonl`, ring-buffered) so the log panel always shows recent history even after daemon restart or log rotation.

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
