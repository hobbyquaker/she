# Backlog

Items that are intentionally deferred. Pick up when the time is right.

## Git Integration



## AI 

- **AI-generated auto-commit messages** — when auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

## Script Engine

- **`import` syntax support** — scripts currently run via `vm.Script` (classic-script context) which rejects static `import` declarations. Transform `import X from 'y'` → `const X = require('y')`, `import { a, b } from 'y'` → `const { a, b } = require('y')`, `import * as ns from 'y'` → `const ns = require('y')`, `import 'y'` → `require('y')` inside `createScript()` before handing source to `vm.Script`. Both `import` and `require` would then work side-by-side — no breaking changes. `export` statements have no meaning in script context and should either be stripped silently or cause a clear error. Do not support `import.meta` or top-level `await` (both require true ESM module scope). Implementation: ~30 lines, no new deps. A minimal regex approach covers 99% of real-world use; for robustness consider using acorn (transitive dep) to find and rewrite only top-level import nodes.

- **per-script resource limits / blocking callback detection** — a script callback that runs a synchronous infinite loop (or any long-running blocking code) stalls the entire daemon: MQTT processing stops, all other scripts freeze, and there is no way to interrupt the blocking code from within the same thread. Two complementary improvements, in increasing complexity order:

  1. **`vm.Script` initial-run timeout** — pass a `timeout` option to `script.runInContext()` (e.g. 5 s). This terminates the script if the *top-level body* runs synchronously for too long. Easy, ~5 lines. Does **not** protect against blocking callbacks.

  2. **Event-loop heartbeat** — schedule a `setImmediate` every 100 ms. If it fires more than ~500 ms late, the event loop was blocked. Track the "currently executing script" in a module-level variable (set when a sandbox callback fires, cleared in a follow-up `setImmediate`); log a warning naming the script. This detects blocking callbacks and provides useful diagnostics, but cannot interrupt them — it only reports after the fact.

  3. **Worker threads per script** — the only way to achieve true isolation: each script runs in its own `worker_thread`, so blocking one worker does not affect the daemon or other scripts. The worker can be killed and restarted on reload. Major architectural rewrite: `she.mqtt.get()` is currently synchronous — in a worker context it would need `SharedArrayBuffer`-based state sharing or become async (a breaking API change). All subscription callbacks would need to be dispatched across the thread boundary via `postMessage`. Estimated effort: weeks. Only worth pursuing if the homelab grows large enough that a single misbehaving script is a real operational risk.

  Practical path: implement 1 + 2 as a low-effort improvement now; defer 3 unless there is a concrete need.

- **per-script log history** — when a script crashes at 3am and the user opens the UI, the circular log buffer may have rotated away the relevant entries. Concrete symptom: the file tree shows a red error dot on the script, but clicking it opens an empty log panel — the error that caused the dot is gone. Store the last N log lines per script persistently in the data dir (e.g. `~/.she/logs/<scriptname>.jsonl`, ring-buffered) so the log panel always shows recent history even after daemon restart or log rotation.

- **graceful WebSocket shutdown** — when `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

- **HTTP route unregistration on script unload** — routes registered via `she.api.*` and `she.http.sub()` are added to the Express router and are currently never removed when a script is unloaded or hot-reloaded (documented limitation in `doc/script-engine.md`). This has two consequences: (1) the old handler keeps serving requests after the script is gone; (2) re-registering the same method+path after a hot-reload throws or silently stacks a duplicate handler, so only a daemon restart fixes a route change.

  Recommended fix: replace direct `router.METHOD(path, handler)` registration with a **dynamic dispatch map** (`Map<"METHOD path", handler>`). A single catch-all middleware walks this map at request time. `registerRoute(method, path, handler)` writes to the map; a new `unregisterRoutesByScript(scriptName)` removes all entries whose metadata identifies them as belonging to that script. On hot-reload the unload step clears the old entries and the new run registers fresh ones. No Express router accumulation, no daemon restart required. Estimated effort: ~40 lines in `server.js` + sandbox modules.

## System scripts & cross-script event bus

**Concept: two-tier script loading**

Introduce a distinction between *system scripts* (ship with the daemon, in `src/scripts/`) and *user scripts* (the existing `~/.she/scripts/`). Load order: system scripts first, then user scripts. This guarantees that any API a system script attaches to `she.global` is already available when the first user script runs.

System scripts are engine internals — they do not appear in the Scripts tab file tree and are not editable via the web UI. Their configuration lives in sheDB documents under the `system/<name>` namespace, editable from the DB tab.

**`she.emit` / `events::` namespace — cross-script event bus**

Currently scripts can share state via `she.global` (plain object, no callbacks) or via MQTT (requires broker, pollutes topic namespace, adds latency). A lightweight in-process event bus fills the gap.

Rather than exposing a raw `EventEmitter` on `she.global`, extend the existing `she.on` pattern (already used for `mqtt::`, `var::`, `matter::` namespaces) with a new `events::` namespace and a new `she.emit` method:

```js
// script-a.js — subscribe
she.on('events::alarm', ({ zone, severity }) => {
    she.info('alarm in', zone, 'severity', severity);
});

// script-b.js — emit
she.emit('events::alarm', { zone: 'front-door', severity: 'high' });
```

`events::` subscriptions are cleaned up on script unload just like `var::` subscriptions — no leaks on hot-reload. `she.emit` is the only new sandbox method required. This approach is more idiomatic than `she.global.events = new EventEmitter()`, reuses the existing API surface, and avoids the cleanup problem that a raw EventEmitter on `she.global` would have.

Implementation: add an in-memory `Map<string, Set<listener>>` in `index.js`. `she.on('events::x', cb)` adds to the set. `she.emit('events::x', data)` iterates all listeners. On script unload, remove all `events::` listeners registered by that script. ~30 lines.

**`notify.js` — notification system script**

A system script that reads config from `she.db.get('system/notify')` and exposes `she.global.notify.send(title, message, [opts])`. Supported backends (selected by `config.service`):

- `ntfy` — POST to `config.url`, optional Bearer token
- `pushover` — POST to `https://api.pushover.net/1/messages.json` with `config.appToken` + `config.userKey`
- `gotify` — POST to `config.url/message` with `config.token`

User scripts call `she.global.notify?.send('Motion detected', 'Front door')` — the `?.` makes it a no-op if the system script is disabled or not yet configured.

Configuration example (create via DB tab):
```json
// sheDB document id: system/notify
{
  "service": "ntfy",
  "url": "https://ntfy.sh/my-private-topic",
  "token": "optional-bearer-token"
}
```

**Open questions:**
- Should system scripts be opt-in (listed in `config.json` `systemScripts: ['notify']`) or always-on (check their own sheDB config, self-disable if missing)? Always-on with self-disabling is simpler for the user.
- Should `she.emit` / `events::` be engine core (no script needed) or implemented as a system script? Engine core is cleaner since it avoids the load-order bootstrapping problem for the event bus itself.
- What other system scripts make sense? Candidates: `presence.js` (aggregate per-room presence from multiple sensors), `sun.js` (publish current sun phase and twilight data to MQTT on schedule).



- **Script starter templates** — when clicking `+ File`, offer an optional template picker (dropdown or modal) with a handful of pre-filled starters: *blank*, *motion-triggered light*, *daily schedule*, *MQTT bridge / link*, *HTTP fetch*, *sheDB subscriber*. Templates can be drawn directly from `doc/examples.md`. Frontend-only change: a small UI addition to the new-file flow, no backend needed.

- **Diff view before git commit** — the git workflow currently goes: edit → commit dialog → write message → commit. Missing: a way to review what you are about to commit. Add a "Show diff" toggle in the commit dialog that renders `git diff HEAD` (or `git diff --cached` after staging) in a Monaco diff editor. Monaco has a built-in `createDiffEditor` API; the backend already has `GET /she/git/diff` or can trivially add one. Makes the commit step much more intentional.

- **Log export** — the Logs tab holds a live ring buffer but provides no way to download it. A small export button (download as `.jsonl` or plain text) would make bug reporting and offline log analysis straightforward. Backend: a `GET /she/logs/export` endpoint that returns the buffer. Frontend: a button in the Logs toolbar.

- **Find & Replace entry point** — add a small **Edit** menu button in the editor toolbar, positioned between the `filename` span and the git-status badges (current layout left-to-right: `filename | [Edit▾] | git-status | Save | Delete | AI`). Clicking it opens a compact dropdown with at minimum: *Find* (`Ctrl+F`) and *Find & Replace* (`Ctrl+H`). Could also include *Go to line* (`Ctrl+G`). Each item calls `editor.getAction('<id>')?.run()` on the Monaco instance. No Monaco context-menu changes; no new route. Frontend-only, ~20 lines + dropdown styling.

- **file tree virtualization** — the tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

- **Script-specific configuration UI** ⚠️ *questionable idea — needs more thought before implementing* — scripts would call `she.config.define(schema)` to declare typed config fields (string, number, boolean, select, topic, password) with labels and defaults. Config values would be stored as `.<scriptname>.config.json` next to the script (dot-prefixed, hidden in file tree). The web UI would auto-generate a form from the schema — similar in spirit to Node-RED's node configuration panels. `she.config.get()` returns current values merged with defaults. A config change via the UI triggers a script hot-reload.

  Open questions that need resolving before this is worth implementing:
  - **Chicken-and-egg**: schema is defined inside the script, but the script needs config values to run. On first run defaults are used — but if the script crashes before `she.config.define()` is called, the UI has no schema to show. Static extraction (AST parse) avoids this but adds significant complexity.
  - **Where does the config UI live?** — ⚙ button in file tree per script? Panel in the editor when a schema is detected? Separate tab?
  - **Schema migration on hot-reload** — what happens when `she.config.define()` changes (fields added/removed)? UI needs to re-render and stored config needs to be migrated (drop removed keys, fill defaults for new ones).
  - **Config files in file tree** — hidden entirely, or visible but styled differently (greyed out, non-editable as text)?
  - **Multi-instance** — the real power of Node-RED's model is running the same node type N times with different configs. With file-based scripts the natural mapping is one file = one config, which means you still need N script files for N instances. Whether a smarter multi-instance model is worth the complexity is unclear.
  - **Interaction with sheDB** — sheDB already provides per-document storage that scripts can read. Is this feature adding enough over `she.db.get('config/myscript')` to justify the complexity?

## MQTT

- **per-topic value history** — the MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

- **multiple MQTT broker connections** — allow connecting to more than one broker simultaneously. Config: replace the top-level `url` string with a `brokers` map where each key is a broker name and the value is the existing per-broker options object (`url`, `username`, `password`, `ca`, `cert`, `key`, `mqttVersion`). The existing `url` key stays supported as shorthand for a single default broker (backward compat). Script API: `she.broker(name)` returns a broker-scoped object exposing the full `mqtt` sub-API (`sub`, `pub`, `get`, `link`, `or`, `and`, `max`, `min`, `timer`, `age`, `getProp`). `she.mqtt` remains a shorthand alias for `she.broker('default')` (or the sole configured broker). State store keys become `mqtt::brokerName::topic`. WS `mqtt` events carry an additional `broker` field. Each broker runs its own sentinel cycle on connect. `link()` and the stdlib helpers (`or`, `and`, `max`, `min`, `timer`) work within a single broker scope only in this first step — cross-broker bridging is a follow-up. Breaking change — requires a migration note when shipped.

  **Config page UX** — the broker configuration section uses a file-tab-style switcher (same visual language as the editor's script tabs) sitting above the broker form panel. One tab per configured broker; clicking a tab activates that broker's form. Each tab shows the broker name and a small status dot (green/yellow/red, same `nav-dot` classes). A `+` button at the right end of the tab bar adds a new broker with a generated name and empty fields. Each tab has a `×` delete button (with confirmation). The form fields are: *name* (editable — renaming updates the tab label and the `brokers` map key), *url*, *username*, *password* (masked, with show/hide toggle), *ca*, *cert*, *key*, *mqttVersion*, *sentinelTimeout*. When only one broker is configured the tab bar is still shown (consistent UX, and makes it obvious how to add a second one). The existing single-broker fields (`url`, `mqttUsername`, …) in the form are migrated to the `brokers` map on first save.

  **MQTT page UX** — when multiple brokers are configured, a broker filter tab bar appears above the topic list (styled like the Config broker tabs, "All" selected by default). Selecting a broker tab filters the list to that broker's topics only; the "All" tab shows every topic from every broker. In the "All" view each row shows a small broker badge (the broker name in a muted chip, similar to `pane-count`) so the origin is visible at a glance; badges are hidden when only one broker is configured or a single broker tab is active. The publish form gains a broker selector dropdown (defaults to the first/only broker; hidden when only one broker exists). The nav dot on the MQTT tab reflects the worst-case state across all brokers: red if any broker is configured but disconnected, yellow/blinking if any broker is still waiting for the sentinel, green only when all brokers are fully ready. The dot's tooltip lists per-broker status.

  *Optional follow-up — cross-broker references:* allow `'brokerName##topic'` as a topic string in `link()` and stdlib helpers to reference a topic on a different broker. `##` is chosen as separator because a double hash can never appear in a valid MQTT topic (the `#` wildcard is only legal as a standalone final segment and publishing to a topic containing `#` is forbidden by spec), making it unambiguous to parse.

## Matter

## sheDB



## Secrets

- **secrets management** — store secrets (named groups of arbitrary string fields, e.g. `{ "smtp": { "password": "…", "host": "…" } }`) in a dedicated encrypted file (`~/.she/secrets.enc`) separate from `config.json`, using AES-256-GCM via Node.js built-in `crypto`. Encryption key sourced from env var `SHE_SECRETS_KEY` (takes precedence) or key file `~/.she/secrets.key` (chmod 600). Access from scripts via `she.secrets.get('<name>/<field>')`. Integrate as own section in config ui (show/hide values). Open questions to resolve before implementation: HTTP API exposure (security concern — avoid reading secret values over the network, or localhost-only), behavior when key is missing, hot-reload vs. startup-only, CLI subcommands for management, configurable secrets file path.

## Broker Page — Certificates & mTLS

- **Client certificate management — deferred pending external CA strategy** — The local CA and client cert issuance UI (Local CA section, Client Certs section, issue/revoke/download P12 flows) has been intentionally removed from the Security page UI. The backend API surface is preserved for automation. The right solution for client cert management in a homelab context is an external CA, not a she-managed one. Before re-introducing a client cert UI, the following questions need to be resolved:
  - Which external CAs should be supported natively (step-ca, XCA, Let's Encrypt, ACME generic)?
  - Should she support CSR-based enrolment for IoT devices ("poor man's CMP over MQTT" pattern — see former MQTT-based CSR renewal backlog item)?
  - What is the right auto-renewal story for 24h-TTL CAs like step-ca?
  - Should she offer a `broker.certRenewHook` config field (a shell command executed after any cert change) as a generic post-renewal trigger for `systemctl reload mosquitto`?
  The `POST /she/broker/ca/certs`, `DELETE /she/broker/ca/certs/:serial`, `GET /she/broker/ca/certs/:serial/download` and related CA endpoints remain available for scripted/API use.

- **step-ca integration (homelab PKI)** — for users running Smallstep step-ca, the integration path is: (1) add the step-ca root/intermediate cert via the Trusted CAs section so mosquitto trusts step-ca-issued client certs; (2) issue mosquitto's server cert via `step ca certificate` or use she's Generate CSR flow then upload the signed cert; (3) configure mosquitto `certfile`/`keyfile` to point at the cert. The missing piece is **auto-renewal**: step-ca issues 24h certs by default and provides `step ca renew --daemon` for background renewal. She needs to trigger `sudo systemctl reload mosquitto` after renewal. A config field `broker.certRenewHook` (a shell command executed after any cert change) would cover this generically. Document the manual flow in `doc/broker-management.md` with copy-paste commands.

- **Let's Encrypt server cert** — use she's Generate CSR flow to produce the key and CSR, then use certbot or another ACME client to get it signed. Or use certbot standalone and import the resulting cert+key via the Import cert option. Auto-renewal hook: `broker.certRenewHook` (see step-ca item). DNS challenge is the only approach that avoids port 80 conflicts with other services.

## Operations

- **health check endpoint** — `GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.


## Security / Robustness

- **path traversal via symlinks** — `safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

- **session persistence** — login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

## Testing

- **integration tests for `.shelib` / `.shedisable` marker hot-reload** — the live unload/reload on marker changes has no test coverage.

- **integration tests for rapid hot-reload** — edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
