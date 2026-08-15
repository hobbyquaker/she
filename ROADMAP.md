# she Roadmap

Work in progress — priorities and scope are not final.

Every item has a stable ID: a category letter plus a number (`S4`, `U2`, …). Numbers are never reused. Completed and rejected items are moved to the archive — [doc/roadmap-archive/](doc/roadmap-archive/README.md), one file per item, named after its ID — so this document only holds open work.

Categories: **B** Bugs · **S** Script Engine · **U** Web UI & Editor · **M** MQTT, Matter & Broker · **I** Integrations · **A** Architecture, Operations & Security · **T** Testing · **D** Documentation *(currently archive-only)*.

Status markers: 🔨 partially done / in progress · ⚠️ needs discussion or decision · 💡 idea · 🚧 blocked / deferred.

---

## Table of Contents

**Script Engine**
- [S1 — Async callback safety: proper per-dispatch Promise wrapping](#s1--async-callback-safety-proper-per-dispatch-promise-wrapping)
- [S2 — Per-script resource limits / blocking callback detection](#s2--per-script-resource-limits--blocking-callback-detection) 🔨 *(heartbeat shipped)*
- [S3 — Graceful WebSocket shutdown](#s3--graceful-websocket-shutdown)
- [S4 — Safe mode: start without executing scripts](#s4--safe-mode-start-without-executing-scripts)
- [S5 — `she.emit` / `events::` cross-script event bus](#s5--sheemit--events-cross-script-event-bus)
- [S6 — System scripts: two-tier script loading](#s6--system-scripts-two-tier-script-loading) ⚠️ *(needs decision)*
- [S7 — Initial evaluation from retained state for stdlib combiners](#s7--initial-evaluation-from-retained-state-for-stdlib-combiners)

**Web UI & Editor**
- [U1 — Script starter templates](#u1--script-starter-templates)
- [U2 — Diff view before git commit](#u2--diff-view-before-git-commit)
- [U3 — Log export](#u3--log-export)
- [U4 — Find & Replace entry point](#u4--find--replace-entry-point)
- [U5 — File tree virtualization](#u5--file-tree-virtualization)
- [U6 — Script-specific configuration UI](#u6--script-specific-configuration-ui) ⚠️ *(questionable idea)*
- [U7 — Hide the log panel when no file is open in the Scripts tab](#u7--hide-the-log-panel-when-no-file-is-open-in-the-scripts-tab)
- [U8 — Logs tab: clickable script prefix opens the script in the editor](#u8--logs-tab-clickable-script-prefix-opens-the-script-in-the-editor)

**MQTT, Matter & Broker**
- [M1 — Per-topic value history](#m1--per-topic-value-history)
- [M2 — Multiple MQTT broker connections](#m2--multiple-mqtt-broker-connections)
- [M3 — Raw `mosquitto.conf` editor](#m3--raw-mosquittoconf-editor)
- [M4 — Password file & ACL file management](#m4--password-file--acl-file-management)
- [M5 — Client certificate management](#m5--client-certificate-management) 🚧 *(deferred pending external CA strategy)*
- [M6 — step-ca integration (homelab PKI)](#m6--step-ca-integration-homelab-pki)
- [M7 — Let's Encrypt server cert](#m7--lets-encrypt-server-cert)

**Integrations**
- [I3 — feezal dashboard pairing](#i3--feezal-dashboard-pairing)

**Architecture, Operations & Security**
- [A1 — Health check endpoint](#a1--health-check-endpoint)
- [A2 — Script API endpoint authentication](#a2--script-api-endpoint-authentication)
- [A3 — Path traversal via symlinks](#a3--path-traversal-via-symlinks)
- [A4 — Session persistence](#a4--session-persistence)
- [A5 — Secrets management](#a5--secrets-management)
- [A6 — AI-generated auto-commit messages](#a6--ai-generated-auto-commit-messages)

**Testing**
- [T1 — Auth module unit tests](#t1--auth-module-unit-tests)
- [T2 — Auth integration tests](#t2--auth-integration-tests)
- [T3 — `.shelib` / `.shedisable` marker hot-reload integration tests](#t3--shelib--shedisable-marker-hot-reload-integration-tests)
- [T4 — Rapid hot-reload integration tests](#t4--rapid-hot-reload-integration-tests)

---

## Script Engine

### S1 — Async callback safety: proper per-dispatch Promise wrapping

The global `unhandledRejection` handler added in v1.13.0 prevents daemon crashes but cannot attribute the rejection to a specific script. The correct fix is to wrap every user callback dispatch site so that async errors are caught close to their source and logged with the script name. In `stateChange`, `mqttEventCallbacks`, and the sun/schedule dispatch, replace `callback(...)` with `Promise.resolve(callback(...)).catch(err => log.error(scriptLabel, 'async callback error:', err.message))`. Requires touching ~6 dispatch sites but no API changes and no behaviour change for synchronous callbacks. Should also be applied in `stdlib.js` (the timer/or/and/max/min helpers). Estimated effort: ~30 lines.

### S2 — Per-script resource limits / blocking callback detection

🔨 *Partially done — the event-loop heartbeat (part 2) is shipped.*

A script callback that runs a synchronous infinite loop (or any long-running blocking code) stalls the entire daemon: MQTT processing stops, all other scripts freeze, and there is no way to interrupt the blocking code from within the same thread. Complementary improvements, in increasing complexity order:

1. **`vm.Script` initial-run timeout** — pass a `timeout` option to `script.runInContext()` (e.g. 5 s). This terminates the script if the *top-level body* runs synchronously for too long. Easy, ~5 lines. Does **not** protect against blocking callbacks. Also part of [S4](#s4--safe-mode-start-without-executing-scripts), which specifies its config key.

2. ✅ **Event-loop heartbeat** — DONE. Schedule a `setImmediate` every 100 ms. If it fires more than ~500 ms late, the event loop was blocked. Track the "currently executing script" in a module-level variable (set when a sandbox callback fires, cleared in a follow-up `setImmediate`); log a warning naming the script. This detects blocking callbacks and provides useful diagnostics, but cannot interrupt them — it only reports after the fact.

3. **Worker threads per script** — the only way to achieve true isolation: each script runs in its own `worker_thread`, so blocking one worker does not affect the daemon or other scripts. The worker can be killed and restarted on reload. Major architectural rewrite: `she.mqtt.get()` is currently synchronous — in a worker context it would need `SharedArrayBuffer`-based state sharing or become async (a breaking API change). All subscription callbacks would need to be dispatched across the thread boundary via `postMessage`. Estimated effort: weeks. Only worth pursuing if the homelab grows large enough that a single misbehaving script is a real operational risk.

Practical path: implement 1 as a low-effort improvement now (2 is done); defer 3 unless there is a concrete need.

### S3 — Graceful WebSocket shutdown

When `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

### S4 — Safe mode: start without executing scripts

When a user script blocks the event loop permanently (infinite synchronous loop), the daemon becomes unresponsive: MQTT stops, the web UI is unreachable, and even `systemctl stop` hangs until systemd's `TimeoutStopSec` SIGKILL fires. Safe mode initialises everything (MQTT, HTTP/WS server, file watcher, Config, Logs) but skips all `loadScript()` calls. The user can then open the web UI, identify and fix/delete the offending script, and restart normally.

**Activation — two independent mechanisms, both configurable:**

1. **CLI flag `--safe-mode`** — always enters safe mode regardless of any other state. Useful for a manual override (`ExecStart=/usr/local/bin/she --safe-mode --data-dir /var/lib/she` as a one-off override via `systemctl edit --force`).

2. **Auto-detect via sentinel file (configurable, default on)** — on every normal startup, write a sentinel file `<dataDir>/.she-running`. Delete it as the *first* synchronous action in the `SIGTERM` handler (before any async cleanup) and also in `process.on('exit', ...)`. On startup, if the file already exists, she was SIGKILL'd without a clean exit → enter safe mode automatically. Controlled by config key `safeMode.autoDetect` (bool, default `true`). Expose as a toggle in the Config UI "Script engine" section alongside the heartbeat settings.

**Getting out of safe mode:** just use the existing "Restart daemon" button in the stats popup — no new UI flow needed. A clean restart without `--safe-mode` and without a sentinel file present will start normally.

**Web UI:** when `stats.safeMode === true`, show a full-width red banner spanning the top of the app (above the nav bar): *"⚠ SAFE MODE — scripts are not running. Edit or delete the problematic script, then restart the daemon."* The Scripts tab remains fully functional for editing and deleting. No other UI changes are needed.

**Backend:** `GET /she/status` gains a `safeMode: boolean` field. Config keys: `safeMode.autoDetect` (bool, default `true`). The `--safe-mode` CLI flag (yargs boolean, default `false`) always wins.

**`vm.Script` initial-run timeout (complementary, cf. [S2](#s2--per-script-resource-limits--blocking-callback-detection) part 1):** while implementing safe mode, also pass `{ timeout: 5000 }` to `script.runInContext()`. This kills scripts whose *top-level body* blocks synchronously for >5s at load time, catching infinite loops at the point of loading rather than only after callbacks fire. On timeout, log an error with the script name and continue loading other scripts — same behaviour as a syntax error. Default 5s; make it configurable via `safeMode.scriptTimeout` (ms, `0` = disabled). Note: this only applies to synchronous top-level code; callbacks are not affected.

**Known downsides and edge cases to handle carefully:**

- **Interaction with `TimeoutStopSec=3`** (critical): the service file uses `TimeoutStopSec=3`. If she is doing legitimate slow graceful cleanup (MQTT disconnect, DB flush) and takes >3s, systemd SIGKILLs it. Sentinel remains → false-positive safe mode on next start. **Fix:** delete the sentinel synchronously at the very start of the SIGTERM handler, before any async cleanup begins. If SIGKILL fires 3s later the sentinel is already gone. Test this carefully.

- **OOM killer / external `kill -9`**: any out-of-band SIGKILL (OOM, Docker, manual) leaves the sentinel and triggers safe mode on next start. This is arguably correct behaviour (something went wrong → investigate) but may surprise users who manage the process externally.

- **Docker volumes**: the sentinel file lives in `--data-dir`. If the container is force-removed and recreated with the same volume, the sentinel persists and triggers safe mode on the first start of the new container. Document this; advise deleting the volume or setting `safeMode.autoDetect: false` in Dockerised setups.

- **Development environments**: developers who frequently `kill -9` a local she instance will be constantly dropped into safe mode. The `safeMode.autoDetect: false` config option is the escape hatch; mention it prominently in the docs.

- **`vm.Script` timeout false positives**: scripts that intentionally do heavy synchronous work at startup (parsing large JSON files, precomputing lookup tables) could be killed. The 5s default is generous for home-automation scripts; document the `safeMode.scriptTimeout: 0` opt-out.

- **Sentinel and restart-from-UI**: `POST /she/restart` calls `process.exit(0)`, which fires `process.on('exit', ...)` → sentinel is deleted before the new process starts. No false positive.

- **Multiple simultaneous starts**: two she instances racing at startup could both see no sentinel, both write it, and both start normally. Edge case not worth special handling; process locking is overkill for this use case.

### S5 — `she.emit` / `events::` cross-script event bus

Currently scripts can share state via `she.global` (plain object, no callbacks) or via MQTT (requires broker, pollutes topic namespace, adds latency). A lightweight in-process event bus fills the gap.

Implemented as **engine core** (in `index.js`, always available, no system script needed) by extending the existing `she.on` pattern (`mqtt::`, `var::`, `matter::`) with a new `events::` namespace and a new `she.emit` method:

```js
// script-a.js — subscribe
she.on('events::alarm', ({ zone, severity }) => {
    she.info('alarm in', zone, 'severity', severity);
});

// script-b.js — emit
she.emit('events::alarm', { zone: 'front-door', severity: 'high' });
```

`events::` subscriptions are cleaned up on script unload just like `var::` subscriptions — no leaks on hot-reload. `she.emit` is the only new sandbox method. Implementation: an in-memory `Map<string, Set<{listener, _script}>>` in `index.js`. On unload, remove all `events::` listeners registered by that script. ~30 lines.

Stands on its own merits — clearly useful, zero maintenance burden — regardless of whether [S6](#s6--system-scripts-two-tier-script-loading) ever ships.

### S6 — System scripts: two-tier script loading

⚠️ *Needs a decision — see the open question at the end before implementing anything.*

**Concept:** introduce a distinction between *system scripts* (ship with the daemon, in `src/scripts/`) and *user scripts* (the existing `~/.she/scripts/`). Load order: system scripts first, then user scripts. This guarantees that any API a system script attaches to `she.global` is already available when the first user script runs.

System scripts are **disabled by default**. The user explicitly enables each one. Enabled state is tracked in `~/.she/system-scripts.json` (a simple array of enabled script names, e.g. `["notify", "mqtt-to-influx"]`). This file lives in the data dir — not `config.json` (config pollution) and not sheDB (avoids a dependency on `--db-path` being set).

**Web UI:** A small tab switcher appears above the file tree in the Scripts tab — **Scripts** (existing behaviour) | **System**. The System tab shows the contents of `src/scripts/` as a read-only file tree. Clicking a script opens it in Monaco with `readOnly: true` and a "READ ONLY — system script" indicator in the toolbar. Each entry has an enable/disable toggle; toggling writes to `system-scripts.json` and immediately loads or unloads the script without a daemon restart.

**Self-bootstrapping sheDB config**

Each system script that needs configuration creates its own sheDB document with default values on startup, and recreates it with defaults if the document has been deleted. This means the user never has to manually create a config document to get started — the script is self-documenting and safe to run unconfigured. The user edits the document in the DB tab to supply real values (API keys, topic patterns, etc.).

```js
// pattern used by every system script that needs sheDB config
const DOC_ID = 'system/notify';
const DEFAULTS = { service: 'pushover', appToken: '', userKey: '', defaultTitle: 'she' };
if (!she.db.get(DOC_ID)) she.db.set(DOC_ID, DEFAULTS);
const cfg = she.db.get(DOC_ID);
```

**`notify.js` — Pushover notifications**

Reads/bootstraps config from `she.db.get('system/notify')`:

```json
{
  "appToken": "",
  "userKey": "",
  "defaultTitle": "she"
}
```

Exposes `she.global.notify.send(title, message, [opts])`. If `appToken` or `userKey` are empty, logs a one-time warning and returns without sending. User scripts use `she.global.notify?.send(...)` — `?.` makes it a silent no-op if the system script is disabled.

**`mqtt-to-influx.js` — forward MQTT topics to InfluxDB**

Reads/bootstraps config from `she.db.get('system/mqtt-to-influx')`:

```json
{
  "subscriptions": ["home/#"],
  "measurement": "mqtt"
}
```

InfluxDB connection params come from the existing daemon-level `--influx` config (already available via `she.influx.*`). Subscribes to the configured topic patterns and writes each value change as an InfluxDB point using `she.influx.write()`. Useful for users who want time-series history of MQTT state without writing any script code — just enable the system script and configure which topics to forward.

**⚠️ Open question: is the whole system scripts concept a good idea?**

Arguments against, worth considering before implementing:

- **she's core value proposition is zero-boilerplate scripting** — the `mqtt-to-influx` use case is already three lines of user script code. Shipping a system script for it adds a whole infrastructure layer (two-tier loading, `system-scripts.json`, read-only UI tab, self-bootstrapping sheDB docs) to solve something that is already trivially solvable in user space. Does the added complexity pay for itself?

- **sheDB dependency for `notify.js`** — if `--db-path` is not configured, sheDB is unavailable and the self-bootstrapping config pattern fails silently. Pushover credentials then have no home. The daemon-level `config.json` is the more reliable place for API keys, but that conflicts with the "system scripts configure themselves" design.

- **`she.global.notify` couples user scripts to a system script** — user scripts that call `she.global.notify?.send(...)` now have an implicit dependency on a specific system script being enabled. If the system script is renamed, split, or the user switches notification service, every user script referencing `she.global.notify` breaks. This is exactly the kind of coupling she's philosophy discourages.

- **`mqtt-to-influx` conflicts with existing `she.influx.*` sandbox API** — users who already use `she.influx.write()` in their own scripts and also enable the system script end up with double-writes or competing subscription logic. The system script has no way to know what user scripts are already doing with InfluxDB.

- **Maintenance surface** — every system script is code that ships with every installation and must be maintained, tested, and documented. A poorly written `notify.js` (e.g. no timeout on the HTTP request) can hang the event loop for every she user who enables it. The same bug in a user script only affects that one user.

- **Alternative that avoids all of the above** — instead of system scripts, ship a well-stocked `doc/examples.md` and a template library (see [U1](#u1--script-starter-templates)). Users copy a template, own the code, and there is no hidden layer. The `she.emit` / `events::` engine core ([S5](#s5--sheemit--events-cross-script-event-bus)) stands on its own merits regardless of whether system scripts exist.

Consider whether S5 alone is the right deliverable, and the system scripts concept is deferred or dropped entirely. Note: the feezal bridge scripts ([I3](#i3--feezal-dashboard-pairing)) are prime candidates for system scripts — but they work fine as plain user scripts, so they do not justify the concept on their own.

### S7 — Initial evaluation from retained state for stdlib combiners

`she.mqtt.max` / `min` / `and` / `or` currently only publish their target topic when one of the source topics *changes* after the subscription is registered. On a fresh script start the target value therefore stays unset (or stale from a previous retained publish) until the first source change arrives — even though the current values of all source topics are already known from retained messages in the state store.

Add a flag (e.g. `{ initial: true }` in the options object) that evaluates the combiner immediately on registration from the retained values (`she.mqtt.get()` per source topic) and publishes the result — so a fresh script start immediately sets its target value.

Notes:

- Script load happens after the retained-state sentinel cycle completes, so the state store is fully populated at registration time — the initial evaluation is reliable.
- Source topics with no retained value yet: skip them the same way the change-driven path handles missing values (e.g. `and`/`or` over the known subset; `max`/`min` over available values; publish nothing if no source is known).
- Default off for backward compatibility — an unconditional publish-on-load could re-trigger downstream automations on every script reload.
- Consider the same flag for `she.mqtt.timer` (restart-survival is a different semantic, though — probably out of scope) and `link()` (an initial one-shot sync mirrors the same need).

## Web UI & Editor

### U1 — Script starter templates

When clicking `+ File`, offer an optional template picker (dropdown or modal) with a handful of pre-filled starters: *blank*, *motion-triggered light*, *daily schedule*, *MQTT bridge / link*, *HTTP fetch*, *sheDB subscriber*. Templates can be drawn directly from `doc/examples.md`. Frontend-only change: a small UI addition to the new-file flow, no backend needed.

### U2 — Diff view before git commit

The git workflow currently goes: edit → commit dialog → write message → commit. Missing: a way to review what you are about to commit. Add a "Show diff" toggle in the commit dialog that renders `git diff HEAD` (or `git diff --cached` after staging) in a Monaco diff editor. Monaco has a built-in `createDiffEditor` API; the backend already has `GET /she/git/diff` or can trivially add one. Makes the commit step much more intentional.

### U3 — Log export

The Logs tab holds a live ring buffer but provides no way to download it. A small export button (download as `.jsonl` or plain text) would make bug reporting and offline log analysis straightforward. Backend: a `GET /she/logs/export` endpoint that returns the buffer. Frontend: a button in the Logs toolbar.

### U4 — Find & Replace entry point

Add a small **Edit** menu button in the editor toolbar, positioned between the `filename` span and the git-status badges (current layout left-to-right: `filename | [Edit▾] | git-status | Save | Delete | AI`). Clicking it opens a compact dropdown with at minimum: *Find* (`Ctrl+F`) and *Find & Replace* (`Ctrl+H`). Could also include *Go to line* (`Ctrl+G`). Each item calls `editor.getAction('<id>')?.run()` on the Monaco instance. No Monaco context-menu changes; no new route. Frontend-only, ~20 lines + dropdown styling.

### U5 — File tree virtualization

The tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

### U6 — Script-specific configuration UI

⚠️ *Questionable idea — needs more thought before implementing.*

Scripts would call `she.config.define(schema)` to declare typed config fields (string, number, boolean, select, topic, password) with labels and defaults. Config values would be stored as `.<scriptname>.config.json` next to the script (dot-prefixed, hidden in file tree). The web UI would auto-generate a form from the schema — similar in spirit to Node-RED's node configuration panels. `she.config.get()` returns current values merged with defaults. A config change via the UI triggers a script hot-reload.

Open questions that need resolving before this is worth implementing:

- **Chicken-and-egg**: schema is defined inside the script, but the script needs config values to run. On first run defaults are used — but if the script crashes before `she.config.define()` is called, the UI has no schema to show. Static extraction (AST parse) avoids this but adds significant complexity.
- **Where does the config UI live?** — ⚙ button in file tree per script? Panel in the editor when a schema is detected? Separate tab?
- **Schema migration on hot-reload** — what happens when `she.config.define()` changes (fields added/removed)? UI needs to re-render and stored config needs to be migrated (drop removed keys, fill defaults for new ones).
- **Config files in file tree** — hidden entirely, or visible but styled differently (greyed out, non-editable as text)?
- **Multi-instance** — the real power of Node-RED's model is running the same node type N times with different configs. With file-based scripts the natural mapping is one file = one config, which means you still need N script files for N instances. Whether a smarter multi-instance model is worth the complexity is unclear.
- **Interaction with sheDB** — sheDB already provides per-document storage that scripts can read. Is this feature adding enough over `she.db.get('config/myscript')` to justify the complexity?

### U7 — Hide the log panel when no file is open in the Scripts tab

The per-script log panel at the bottom of the Scripts tab is shown even when no editor tab is open, where it can only ever be empty (it displays the active tab's `logEntries`). Hide the panel (and its resize handle / toggle) entirely while no file is open, and show it again when the first tab opens, respecting the persisted open/closed and height state (`she-log-open`, `she-scripts-log-height`). Frontend-only, `Scripts.svelte`.

### U8 — Logs tab: clickable script prefix opens the script in the editor

Log lines from scripts are prefixed with the script's label (e.g. `licht/hobbyraum.js: …`). Make that prefix a link: clicking it switches to the Scripts tab and opens (or focuses) that script in an editor tab.

Implementation sketch:

- `Logs.svelte` parses the prefix with the same pattern the Scripts tab already uses for log routing (`/^([^:\n]+\.js):\s/`, see `Scripts.svelte`) and renders it as a distinct clickable span, leaving the rest of the message as-is.
- Navigation: switch tabs via the existing hash navigation, and tell the Scripts page which file to open — e.g. a `window` CustomEvent (`she:open-script` with the path) that `Scripts.svelte` listens for (all pages stay mounted, so the listener is always live), reusing its existing open-file logic including log-history seeding.
- **Synergy with [I3](#i3--feezal-dashboard-pairing):** I3 wants a stable, documented deep-link URL for a named script (feezal "open adapter in she" links). Implementing this as a real hash route (e.g. `#/scripts/<path>`) instead of an internal event would deliver both at once — preferable if the routing change is not much bigger.

## MQTT, Matter & Broker

### M1 — Per-topic value history

The MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

### M2 — Multiple MQTT broker connections

Allow connecting to more than one broker simultaneously. Config: replace the top-level `url` string with a `brokers` map where each key is a broker name and the value is the existing per-broker options object (`url`, `username`, `password`, `ca`, `cert`, `key`, `mqttVersion`). The existing `url` key stays supported as shorthand for a single default broker (backward compat). Script API: `she.broker(name)` returns a broker-scoped object exposing the full `mqtt` sub-API (`sub`, `pub`, `get`, `link`, `or`, `and`, `max`, `min`, `timer`, `age`, `getProp`). `she.mqtt` remains a shorthand alias for `she.broker('default')` (or the sole configured broker). State store keys become `mqtt::brokerName::topic`. WS `mqtt` events carry an additional `broker` field. Each broker runs its own sentinel cycle on connect. `link()` and the stdlib helpers (`or`, `and`, `max`, `min`, `timer`) work within a single broker scope only in this first step — cross-broker bridging is a follow-up. Breaking change — requires a migration note when shipped.

**Config page UX** — the broker configuration section uses a file-tab-style switcher (same visual language as the editor's script tabs) sitting above the broker form panel. One tab per configured broker; clicking a tab activates that broker's form. Each tab shows the broker name and a small status dot (green/yellow/red, same `nav-dot` classes). A `+` button at the right end of the tab bar adds a new broker with a generated name and empty fields. Each tab has a `×` delete button (with confirmation). The form fields are: *name* (editable — renaming updates the tab label and the `brokers` map key), *url*, *username*, *password* (masked, with show/hide toggle), *ca*, *cert*, *key*, *mqttVersion*, *sentinelTimeout*. When only one broker is configured the tab bar is still shown (consistent UX, and makes it obvious how to add a second one). The existing single-broker fields (`url`, `mqttUsername`, …) in the form are migrated to the `brokers` map on first save.

**MQTT page UX** — when multiple brokers are configured, a broker filter tab bar appears above the topic list (styled like the Config broker tabs, "All" selected by default). Selecting a broker tab filters the list to that broker's topics only; the "All" tab shows every topic from every broker. In the "All" view each row shows a small broker badge (the broker name in a muted chip, similar to `pane-count`) so the origin is visible at a glance; badges are hidden when only one broker is configured or a single broker tab is active. The publish form gains a broker selector dropdown (defaults to the first/only broker; hidden when only one broker exists). The nav dot on the MQTT tab reflects the worst-case state across all brokers: red if any broker is configured but disconnected, yellow/blinking if any broker is still waiting for the sentinel, green only when all brokers are fully ready. The dot's tooltip lists per-broker status.

*Optional follow-up — cross-broker references:* allow `'brokerName##topic'` as a topic string in `link()` and stdlib helpers to reference a topic on a different broker. `##` is chosen as separator because a double hash can never appear in a valid MQTT topic (the `#` wildcard is only legal as a standalone final segment and publishing to a topic containing `#` is forbidden by spec), making it unambiguous to parse.

### M3 — Raw `mosquitto.conf` editor

The `PUT /she/broker/config/raw` endpoint and the `putBrokerConfRaw()` API helper already exist; only the frontend tab is missing. Add an **Advanced** sub-tab to the Broker page that renders the full `mosquitto.conf` text in a Monaco editor (`language: 'ini'`). On save, call `putBrokerConfRaw(content, checksum)` — external-modify detection via checksum works the same way as the structured editor. The tab should also surface the backup list with a one-click restore (calls `POST /she/broker/config/restore`). This gives power users a full escape hatch beyond what the structured Listeners / Global Config tabs expose.

### M4 — Password file & ACL file management

Users who prefer static `passwd` / `acl` files over the dynamic-security plugin have no UI support today. Needs to work in both local and SSH/remote mode (analogous to how `mosquitto.conf` read/write already works via `ssh-deploy`).

Scope:
- **Password file**: read the file, list usernames, add a user (`mosquitto_passwd -b <file> <user> <pass>`), change password, delete a user (`mosquitto_passwd -D <file> <user>`). In remote mode, run the command on the broker host via `sshDeploy.runCommand()`; in local mode use `execFile()`.
- **ACL file**: read/write the raw text (mosquitto acl format). Expose a Monaco editor for the raw file (like the Advanced config editor), plus optionally a structured UI for the common patterns (user-level `topic`, `readwrite`, `read`, `write` lines and `pattern` lines).
- **Config integration**: the global `password_file` and `acl_file` keys in `mosquitto.conf` already flow through the managed-key system; listener-level `password_file` / `acl_file` are already parsed and serialised per-listener. The new UI should make it easy to point these at the managed files.
- **Remote path convention**: document a recommended layout (e.g. `/etc/mosquitto/passwd`, `/etc/mosquitto/acl`) so the SSH deploy path and the `mosquitto.conf` path stay consistent.

### M5 — Client certificate management

🚧 *Deferred pending external CA strategy.*

The local CA and client cert issuance UI (Local CA section, Client Certs section, issue/revoke/download P12 flows) has been intentionally removed from the Security page UI. The backend API surface is preserved for automation. The right solution for client cert management in a homelab context is an external CA, not a she-managed one. Before re-introducing a client cert UI, the following questions need to be resolved:

- Which external CAs should be supported natively (step-ca, XCA, Let's Encrypt, ACME generic)?
- Should she support CSR-based enrolment for IoT devices ("poor man's CMP over MQTT" pattern — a former roadmap item, since removed)?
- What is the right auto-renewal story for 24h-TTL CAs like step-ca?
- Should she offer a `broker.certRenewHook` config field (a shell command executed after any cert change) as a generic post-renewal trigger for `systemctl reload mosquitto`?

The `POST /she/broker/ca/certs`, `DELETE /she/broker/ca/certs/:serial`, `GET /she/broker/ca/certs/:serial/download` and related CA endpoints remain available for scripted/API use.

### M6 — step-ca integration (homelab PKI)

For users running Smallstep step-ca, the integration path is: (1) add the step-ca root/intermediate cert via the Trusted CAs section so mosquitto trusts step-ca-issued client certs; (2) issue mosquitto's server cert via `step ca certificate` or use she's Generate CSR flow then upload the signed cert; (3) configure mosquitto `certfile`/`keyfile` to point at the cert. The missing piece is **auto-renewal**: step-ca issues 24h certs by default and provides `step ca renew --daemon` for background renewal. She needs to trigger `sudo systemctl reload mosquitto` after renewal. A config field `broker.certRenewHook` (a shell command executed after any cert change) would cover this generically. Document the manual flow in `doc/broker-management.md` with copy-paste commands.

### M7 — Let's Encrypt server cert

Use she's Generate CSR flow to produce the key and CSR, then use certbot or another ACME client to get it signed. Or use certbot standalone and import the resulting cert+key via the Import cert option. Auto-renewal hook: `broker.certRenewHook` (see [M6](#m6--step-ca-integration-homelab-pki)). DNS challenge is the only approach that avoids port 80 conflicts with other services.

## Integrations

### I3 — feezal dashboard pairing

**Resolved: she does not build a dashboard; feezal is the dashboard pairing.** The strategic question ("should she grow a dashboard tab?") is answered: **no**. [feezal](https://github.com/feezal/feezal) — same author — has been revived: feezal 2.0 (July 2026) dropped the Node-RED backend entirely, is MQTT-native, actively developed, and its [INTEGRATION-ROADMAP.md](https://github.com/feezal/feezal/blob/main/docs/INTEGRATION-ROADMAP.md) names **she as the priority integration target** (everything else there — HA, Node-RED, ioBroker — is research only). Division of labour: *she automates, feezal displays*. The earlier idea of a minimal declarative tile grid in she (sheDB-backed JSON tile documents + HA-discovery auto-populate) is **dropped** — it would duplicate the pairing.

**Guiding rule (feezal's "principle 5", applies to she equally):** neither side may become required. she must stay fully usable with no feezal, and vice versa. Integration UI appears only when the other side is actually detected; no feature may exist only through the pairing.

**What feezal already builds on (she-side contract — keep stable):**

- `PUT /she/scripts/<name>` — feezal's server deploys element-shipped "adapter scripts" (e.g. a weather fetcher publishing HA discovery) directly into she via this endpoint. Needs to keep working with auth enabled (Bearer token — see [A2](#a2--script-api-endpoint-authentication)).
- she's `config.json` — the feezal installer reads it (same host, file-level) to pre-seed its MQTT broker connection. Keep the config format documented; treat breaking changes to broker config keys as integration-breaking.
- `logic/connected` retained status topic — feezal uses it to detect she's presence and only then show deploy affordances.
- sheDB views with `publish: true, retain: true` — retained JSON arrays feed feezal's `layout-repeater` element directly. This end-to-end path works today with zero new code on either side.
- she config lat/lon — adapter scripts read location from she (already there for suncalc) instead of prompting in feezal.

**she-side work items the integration implies:**

1. **Bridge-script bundle** (small she scripts, shipped in feezal's repo, installed via `PUT /she/scripts/…` or copy-paste):
   - *Schedule consumer* — subscribes to feezal's retained schedule topic (feezal E52), re-registers `she.schedule()` entries on change. Note: feezal defines the serialized schedule contract, she consumes it; solar events must be representable (e.g. `{"pattern": "sunset", "shift": -1620}`).
   - *History publisher* — `she.influx.getRange` → retained JSON series per topic (feezal's history-in-payload convention).
   - *Astro publisher* — retained sunrise/sunset/phase topics daily.
   - Later: *per-viewer credential provisioner* using she's Mosquitto dynsec API (`she.broker.*`) for feezal's per-client broker credentials.
2. **Stable script-editor deep-link URL scheme** — feezal wants to render "open this element's adapter script in she" links. Open question on their side: is she's editor URL for a named script stable and linkable? Decide and document a stable scheme (e.g. `/#/scripts/<path>`), then treat it as public API.
3. **List sheDB views over HTTP** — feezal's repeater-mapping UI works from retained payloads alone (no she API needed), but listing available views so the user picks one instead of typing a topic is a cheap she-side convenience. Check whether the existing DB endpoints already cover this.
4. **Reverse deep links** — she linking to a feezal dashboard/view (feezal views are addressable via `#/<view>`). Cheap; needs feezal's base URL known to she (config key), and per principle 5 the link only renders when feezal is present.
5. **Adapter-script health convention** — feezal wants to show *deployed / running / stale* per adapter. Adapters publish availability topics; consider what she can contribute (script-status over MQTT?) without inventing a she-only mechanism.

**Explicitly rejected (on both sides):** UI embedding — neither side has UI extension points and building them would be a large permanent coupling for a convenience. Deep links are the agreed alternative. Also rejected on feezal's side: a she script spawning the feezal server (hot-reload orphans children; she is not a process supervisor) — feezal gets its own `--install` à la she instead, plus a documented docker-compose pairing.

**Relation to other roadmap items:** the bridge scripts are prime candidates for the doubted "system scripts" concept ([S6](#s6--system-scripts-two-tier-script-loading)) — but they work fine as plain user scripts, so system scripts remain unjustified by this alone. [A2](#a2--script-api-endpoint-authentication) gains urgency: `PUT /she/scripts/…` from feezal must work cleanly under auth (Bearer token support).

## Architecture, Operations & Security

### A1 — Health check endpoint

`GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.

### A2 — Script API endpoint authentication

When she auth is enabled (`auth: 'password'` or `auth: 'proxy'`), all `/she/*` routes are protected by `authMiddleware`. However, routes registered by scripts via `she.api.*` and `she.http.sub()` are explicitly excluded from this middleware (comment in `server.js`: *"user scripts control their own auth"*). In practice, scripts rarely implement auth, there is no helper to do so, and the result is a false sense of security: a user who enables password auth believing their she instance is now protected is wrong — every script-registered route remains open to anyone who can reach the HTTP port.

**Root cause:** `she.api.*` and `she.http.sub()` are conceptually different but share the same `/api/` prefix and the same absent auth policy:
- `she.api.*` — exposing script data or control endpoints, logically an extension of the she API → should inherit she-level auth
- `she.http.sub()` — receiving webhooks from external services (IFTTT, IoT devices, cloud hooks) that cannot present a session cookie → needs to remain reachable without she auth, optionally protected by a shared secret in the URL or body

**Recommended fix:** when auth mode is not `none`, apply `authMiddleware` to `/api/*` by the same rule as `/she/*`. Give `she.http.sub()` an explicit `{ public: true }` option to bypass this for genuine external webhooks:

```js
// protected by she auth (inherits current mode):
she.api.get('/status', () => she.mqtt.get('home/alarm'));

// explicitly public — external caller can't log in:
she.http.sub('/hook', body => she.info('received', body), { public: true });
```

This is **not a breaking change** for deployments using the default `auth: 'none'` — behaviour is identical. It only activates when the user has explicitly enabled auth, which is precisely when they expect protection.

`she.api.*` routes without `{ public: true }` inherit she auth and require a valid session cookie (password mode) or proxy header (proxy mode). The `Authorization: Bearer <token>` header should also be accepted as an alternative to the session cookie so scripts can be called programmatically. Bearer-token support also matters for the feezal pairing ([I3](#i3--feezal-dashboard-pairing)): feezal deploys adapter scripts via `PUT /she/scripts/…` and must be able to authenticate non-interactively.

**Additionally:** expose `she.checkAuth(req)` as a convenience for scripts that intentionally handle auth themselves (e.g. check a per-script shared secret). Returns `true` if the request passes she-level auth, regardless of mode.

### A3 — Path traversal via symlinks

`safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

### A4 — Session persistence

Login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

### A5 — Secrets management

Store secrets (named groups of arbitrary string fields, e.g. `{ "smtp": { "password": "…", "host": "…" } }`) in a dedicated encrypted file (`~/.she/secrets.enc`) separate from `config.json`, using AES-256-GCM via Node.js built-in `crypto`. Encryption key sourced from env var `SHE_SECRETS_KEY` (takes precedence) or key file `~/.she/secrets.key` (chmod 600). Access from scripts via `she.secrets.get('<name>/<field>')`. Integrate as own section in config ui (show/hide values). Open questions to resolve before implementation: HTTP API exposure (security concern — avoid reading secret values over the network, or localhost-only), behavior when key is missing, hot-reload vs. startup-only, CLI subcommands for management, configurable secrets file path.

### A6 — AI-generated auto-commit messages

When auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

## Testing

### T1 — Auth module unit tests

`POST /she/auth/setup` changes mode and password hash. Session TTL: a session created `SESSION_TTL_MS` ms ago is rejected.

### T2 — Auth integration tests

All integration tests run with `auth: 'none'`. Add a suite that starts the server with `auth: 'password'` and a hashed password: verify `/she/scripts` returns 401 without a cookie, `POST /she/auth/login` with correct credentials returns 200 and sets a cookie, the cookie grants access to `/she/scripts`, wrong password returns 401, `GET /she/auth/mode` returns 200 in all modes (public endpoint). Add to `test/unit/server.test.js` (it already spins up a real server) or a new `test/integration/auth.test.js`.

### T3 — `.shelib` / `.shedisable` marker hot-reload integration tests

The live unload/reload on marker changes has no test coverage.

### T4 — Rapid hot-reload integration tests

Edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
