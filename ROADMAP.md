# she Roadmap

Work in progress — priorities and scope are not final.

Every item has a stable ID: a category letter plus a number (`S4`, `U2`, …). Numbers are never reused. Completed and rejected items are moved to the archive — [doc/roadmap-archive/](doc/roadmap-archive/README.md), one file per item, named after its ID — so this document only holds open work.

Categories: **B** Bugs · **S** Script Engine · **U** Web UI & Editor · **M** MQTT, Matter & Broker · **I** Integrations · **A** Architecture, Operations & Security · **T** Testing · **D** Documentation *(currently archive-only)*.

Status markers: 🔨 partially done / in progress · ⚠️ needs discussion or decision · 💡 idea · 🚧 blocked / deferred.

---

## Table of Contents

**Script Engine**
- [S2 — Per-script resource limits / blocking callback detection](#s2--per-script-resource-limits--blocking-callback-detection) 🔨 *(only worker-thread isolation left)*
- [S3 — Graceful WebSocket shutdown](#s3--graceful-websocket-shutdown)
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

**MQTT, Matter & Broker**
- [M1 — Per-topic value history](#m1--per-topic-value-history)
- [M2 — Multiple MQTT broker connections](#m2--multiple-mqtt-broker-connections)
- [M4 — Password file & ACL file management](#m4--password-file--acl-file-management)
- [M5 — Client certificate management](#m5--client-certificate-management) 🚧 *(deferred pending external CA strategy)*
- [M6 — step-ca integration (homelab PKI)](#m6--step-ca-integration-homelab-pki)
- [M7 — Let's Encrypt server cert](#m7--lets-encrypt-server-cert)

**Integrations**
- [I3 — feezal dashboard pairing](#i3--feezal-dashboard-pairing)
- [I8 — Services: docker host driver](#i8--services-docker-host-driver) 💡
- [I13 — Device discovery when adding an instance](#i13--device-discovery-when-adding-an-instance) 🚧 *(blocked on `x-discover` landing in core)*

**Architecture, Operations & Security**
- [A2 — Script API endpoint authentication](#a2--script-api-endpoint-authentication)
- [A3 — Path traversal via symlinks](#a3--path-traversal-via-symlinks)
- [A4 — Session persistence](#a4--session-persistence)
- [A6 — AI-generated auto-commit messages](#a6--ai-generated-auto-commit-messages)
- [A7 — Relicense to AGPL-3.0-or-later](#a7--relicense-to-agpl-30-or-later)
- [A9 — Secrets: revealing values in the UI](#a9--secrets-revealing-values-in-the-ui) 🔨

**Testing**
- [T1 — Auth module unit tests](#t1--auth-module-unit-tests)
- [T2 — Auth integration tests](#t2--auth-integration-tests)
- [T3 — `.shelib` / `.shedisable` marker hot-reload integration tests](#t3--shelib--shedisable-marker-hot-reload-integration-tests)
- [T4 — Rapid hot-reload integration tests](#t4--rapid-hot-reload-integration-tests)

---

## Script Engine

### S2 — Per-script resource limits / blocking callback detection

🔨 *Partially done — the event-loop heartbeat (part 2) and the initial-run timeout (part 1) are shipped; only worker-thread isolation (part 3) is open.*

A script callback that runs a synchronous infinite loop (or any long-running blocking code) stalls the entire daemon: MQTT processing stops, all other scripts freeze, and there is no way to interrupt the blocking code from within the same thread. Complementary improvements, in increasing complexity order:

1. ✅ **`vm.Script` initial-run timeout** — DONE, shipped with [S4](doc/roadmap-archive/S4.md) as `scriptTimeout` (default 5000 ms, `0` disables): `script.runInContext()` gets a `timeout`, a script whose *top-level body* overruns it is terminated and named in the log, the remaining scripts load anyway. Does **not** protect against blocking callbacks.

2. ✅ **Event-loop heartbeat** — DONE. Schedule a `setImmediate` every 100 ms. If it fires more than ~500 ms late, the event loop was blocked. Track the "currently executing script" in a module-level variable (set when a sandbox callback fires, cleared in a follow-up `setImmediate`); log a warning naming the script. This detects blocking callbacks and provides useful diagnostics, but cannot interrupt them — it only reports after the fact.

3. **Worker threads per script** — the only way to achieve true isolation: each script runs in its own `worker_thread`, so blocking one worker does not affect the daemon or other scripts. The worker can be killed and restarted on reload. Major architectural rewrite: `she.mqtt.get()` is currently synchronous — in a worker context it would need `SharedArrayBuffer`-based state sharing or become async (a breaking API change). All subscription callbacks would need to be dispatched across the thread boundary via `postMessage`. Estimated effort: weeks. Only worth pursuing if the homelab grows large enough that a single misbehaving script is a real operational risk.

Practical path: 1 and 2 are done; defer 3 unless there is a concrete need.

### S3 — Graceful WebSocket shutdown

When `process.exit(0)` is called (e.g. on restart request), connected WebSocket clients drop abruptly. Send a WS close frame first so the frontend can show a meaningful disconnect message.

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

## MQTT, Matter & Broker

### M1 — Per-topic value history

The MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

### M2 — Multiple MQTT broker connections

Allow connecting to more than one broker simultaneously. Config: replace the top-level `url` string with a `brokers` map where each key is a broker name and the value is the existing per-broker options object (`url`, `username`, `password`, `ca`, `cert`, `key`, `mqttVersion`). The existing `url` key stays supported as shorthand for a single default broker (backward compat). Script API: `she.broker(name)` returns a broker-scoped object exposing the full `mqtt` sub-API (`sub`, `pub`, `get`, `link`, `or`, `and`, `max`, `min`, `timer`, `age`, `getProp`). `she.mqtt` remains a shorthand alias for `she.broker('default')` (or the sole configured broker). State store keys become `mqtt::brokerName::topic`. WS `mqtt` events carry an additional `broker` field. Each broker runs its own sentinel cycle on connect. `link()` and the stdlib helpers (`or`, `and`, `max`, `min`, `timer`) work within a single broker scope only in this first step — cross-broker bridging is a follow-up. Breaking change — requires a migration note when shipped.

*Note:* the Services inventory ([I4](doc/roadmap-archive/I4.md)) keys adapter instances by topic prefix; with multiple brokers it gains a broker dimension (`mqtt::brokerName::topic`), so the Services page needs the same broker filter as the MQTT page below.

**Config page UX** — the broker configuration section uses a file-tab-style switcher (same visual language as the editor's script tabs) sitting above the broker form panel. One tab per configured broker; clicking a tab activates that broker's form. Each tab shows the broker name and a small status dot (green/yellow/red, same `nav-dot` classes). A `+` button at the right end of the tab bar adds a new broker with a generated name and empty fields. Each tab has a `×` delete button (with confirmation). The form fields are: *name* (editable — renaming updates the tab label and the `brokers` map key), *url*, *username*, *password* (masked, with show/hide toggle), *ca*, *cert*, *key*, *mqttVersion*, *sentinelTimeout*. When only one broker is configured the tab bar is still shown (consistent UX, and makes it obvious how to add a second one). The existing single-broker fields (`url`, `mqttUsername`, …) in the form are migrated to the `brokers` map on first save.

**MQTT page UX** — when multiple brokers are configured, a broker filter tab bar appears above the topic list (styled like the Config broker tabs, "All" selected by default). Selecting a broker tab filters the list to that broker's topics only; the "All" tab shows every topic from every broker. In the "All" view each row shows a small broker badge (the broker name in a muted chip, similar to `pane-count`) so the origin is visible at a glance; badges are hidden when only one broker is configured or a single broker tab is active. The publish form gains a broker selector dropdown (defaults to the first/only broker; hidden when only one broker exists). The nav dot on the MQTT tab reflects the worst-case state across all brokers: red if any broker is configured but disconnected, yellow/blinking if any broker is still waiting for the sentinel, green only when all brokers are fully ready. The dot's tooltip lists per-broker status.

*Optional follow-up — cross-broker references:* allow `'brokerName##topic'` as a topic string in `link()` and stdlib helpers to reference a topic on a different broker. `##` is chosen as separator because a double hash can never appear in a valid MQTT topic (the `#` wildcard is only legal as a standalone final segment and publishing to a topic containing `#` is forbidden by spec), making it unambiguous to parse.

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

### I8 — Services: docker host driver

💡 *Idea — designed-for in I4, not built.* Third host driver over the `docker` CLI (compose restart, logs, env) for containerised adapters (ghcr images exist for alexa-remote-mqtt & co.). Until then Docker-hosted instances are covered by Tier 0 only. Depends on [I5](doc/roadmap-archive/I5.md) ✅ and actual demand.

### I13 — Device discovery when adding an instance

🚧 *Blocked until the `x-discover` schema marker (decided, see below) lands in mqtt-interfaces-core and the pilot adapters.*

mqtt-interfaces-core 0.9 gave adapters device discovery (core roadmap B-2): a declarative `DISCOVERY` hint (SSDP, mDNS/DNS-SD, vendor UDP broadcast probes, port probes, subnet sweeps, ARP/OUI — and, in progress, USB serial ports via `/dev/serial/by-id`), surfaced on every discovery-capable adapter as `--discover` / `--discover-json` / `--discover-timeout` / `--discover-address`. Pilots: hm2mqtt 3.3.0 (eQ-3 UDP probe + interface ports, shipped), lgsb2mqtt (`_googlecast._tcp` + temescal port, in progress — including mDNS-reflector answers and `--discover-address` CIDR ranges for a device on another VLAN) and cul2mqtt (busware USB sticks by their stable by-id serial name, in progress). she should use it where it pays off most: the **Add instance** flow, so the user never types an IP address or hunts through `/dev` for a device path the host can just tell us.

**UX (extends [AddInstance.svelte](web/src/pages/services/AddInstance.svelte)):** after host + adapter are chosen and the schema has loaded, a discovery-capable adapter gets a scan step above the config form:

- **Decided: explicit trigger, no auto-scan.** A *Scan network* button next to the address field starts the scan (default `--discover-timeout` 5 s), spinner *"scanning the network from \<host\>…"*; the form stays usable during the scan — discovery assists, it never blocks manual entry. No network traffic the user did not ask for.
- **One device found:** preselected result row, the user confirms; the marked property is prefilled. **Several:** pick one from the list. **None:** manual entry as today, plus — for network discovery only — an expander *"device on another network?"* with an address/CIDR input (`--discover-address`) and a timeout field, and a re-scan button.
- A result row shows what `describe()` prints: the identifier, friendly name/model/type, serial, the answering services as badges (`ReGa BidCos-RF HmIP-RF`), and the source (`udp`, `mdns+oui`, `serial`). All of it is untrusted network/bus data — render as text, length-capped.
- **The identifier is not always an IP address.** A USB adapter's discovery (cul2mqtt) returns serial ports keyed by their stable `/dev/serial/by-id/…` name — the one that survives a replug and a reboot while `/dev/ttyACM0` can swap sticks — with the resolved device node alongside. That stable path is what gets prefilled into `serialport`; the row shows both (`usb-busware.de_CUL868-if00` → `/dev/ttyACM0`). No services badges, no cross-network expander, and the scan is instant (a directory listing, no timeout to speak of).
- Picking a result prefills the marked property (see contract below) and, when the device carries a name of its own, the instance name — see below.
- Devices already claimed by an existing instance of the same adapter on that host (same address in its env file) are marked *"already configured as \<instance\>"* and deprioritised, not hidden — a second instance against the same CCU is legitimate. **Decided: in v1** (one `env read` per sibling instance of that adapter on that host).

**Instance name from the device name.** Several adapters return what the user called the device: wiim2mqtt lifts the UPnP `friendlyName` out of `description.xml`, lgsb2mqtt the Chromecast `fn` label — both as `entry.name`, which is the core's conventional field for a human-given name (`describe()` already prefers it over `model`/`type`). Where it exists it is a much better instance name than `wiim`/`wiim2`/`wiim3`: **the instance name is the MQTT topic prefix** (`<name>/info`, `<name>/status/#`), and someone with four WiiMs wants `wohnzimmer`, `kueche`, `bad`, `buero` — this is the strongest argument for the whole feature, more than saving an IP address.

It is also why the name can only ever be *suggested*, never taken verbatim: besides the topic prefix it is the systemd instance (`wiim2mqtt@<name>.service`), the env file path (`/etc/wiim2mqtt/<name>.env`) and the dynsec client (`svc-<name>`), and `[A-Za-z0-9_.-]+` is enforced independently by she ([`validInstance`](src/web/services-api.js)), by the core (`instanceName()`) and by systemd. A friendly name is free-form UTF-8 off the network.

- **Slug** (decided 2026-08-28): transliterate first (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, then NFKD-drop the rest so `é→e`), lowercase (fleet convention — `hm`, `lgtv`, `wiim`; MQTT topics are case-sensitive), everything outside `[a-z0-9_.-]` → `-`, collapse and trim, cap at 32. *"Küche Oben"* → `kueche-oben`.
- **Fallback**: a slug that comes out empty or all digits — a device that returns a UUID or a bare number as its name — is discarded and the schema default (`name.default`) is used exactly as today.
- **Uniqueness against every known instance, not just this adapter's on this host.** A topic prefix collides fleet-wide: `wohnzimmer` already taken by a wiim2mqtt instance on another host, or by any other adapter in the MQTT inventory, is a real conflict. she has both lists (`host.instances` and the retained inventory) — suffix `-2`, `-3`, … the way the current flow appends `2` to the schema default.
- **Prefill until edited** (decided 2026-08-28), not on empty: after the schema loads the field already holds `wiim`, so "empty" never happens. Track whether the user edited the name themselves; if not, picking a device replaces it, with the provenance shown under the field — *from the device name "Küche Oben"*. One manual keystroke and discovery never touches it again.
- The raw name is untrusted network data: slugged for the field, rendered as capped text in the result row, and the server keeps validating `validInstance` on install as it does now.

*Core side:* `entry.name` carries this today by convention only — the hint table documents `probe` as returning "fields". Worth pinning in the core README while B-2 is warm: **`name` is the name the user gave the device** (absent when it has none — a CCU), as against `model`/`type` which say what it is. she derives an instance name from `name` alone.

**Why the scan runs on the target host, not in the she daemon:** broadcast, multicast and ARP only see the network the scanning process sits on, and the adapter's host is by definition on (or routed to) the device's network — the she host may not be. Running the adapter's own `--discover` also reuses the hint, the parsers and the rate limiting exactly as shipped; she re-implements none of it. This falls out of the existing driver architecture for free (local sudo / SSH), and the adapter package is already installed at this point in the flow — same precondition as the `schema` verb.

**Helper (v10 → v11):** new verb `discover <adapter> [--timeout <s>] [--address <addr-or-cidr>]` → `exec <adapter-cmd> --discover --discover-json [--discover-timeout …] [--discover-address …]`. On an older helper the scan UI is hidden behind the existing `helperOutdated` machinery — everything else in the flow works as before.

**she API:** `POST /she/services/hosts/:host/adapters/:adapter/discover` `{ timeout?, address? }` → `{ devices: [...] }`, exec timeout = discovery timeout + margin (a `--discover-address` sweep of a /24 can take a while — allow ~60 s wall clock). Validate the JSON shape server-side (addresses, string caps) before it reaches the UI.

**Core contract (decided 2026-08-28, to be implemented in mqtt-interfaces-core):** `--config-schema` currently says nothing about discovery — the `--discover*` options are META_OPTIONS, deliberately excluded. Decision: an `x-discover` marker on the schema property that receives the discovered identifier — the same property that accepts `auto` (`ccu-address` in hm2mqtt, `address` in lgsb2mqtt, `tv` in lgtv2mqtt, **`serialport` in cul2mqtt**), set by the core next to the existing `x-env` / `x-secret` / `x-file` extensions. Presence of any `x-discover` property ⇒ the adapter is discovery-capable — no separate top-level flag.

Since cul2mqtt joined the pilots the marker's value should carry the **kind**, not just `true`: `"x-discover": "network" | "serial"` — the core derives it from the hint it already owns (ssdp/mdns/udp/ports/oui ⇒ `network`, `hint.serial` ⇒ `serial`; an adapter with both — a CUN is a CUL with ethernet — gets an array). she keys UI affordances off it: the cross-network expander and the timeout field exist only for `network`; a `serial` scan is a plain button with instant results. **This item is blocked until that lands in core** and the pilot adapters pick it up.

**Deliberately not in v1:**

- **Storing `auto` as the value.** The core supports `--address auto` / `--serialport auto` (discover at startup), but a pinned concrete value is the right thing for an installed instance: `auto` fails hard when a second device appears and adds a scan to every restart. The UI pins what was picked — for serial the stable by-id path, never the raw `/dev/tty*` node; `auto` stays a CLI affordance.
- **Re-discovery for an existing instance** (device got a new IP, instance is down): a *"find it again"* action in the instance detail's config panel reusing the same scan endpoint. Natural follow-up once the Add flow is in.
- **Discovery-driven catalog suggestions** (*"scan found a CCU — install hm2mqtt?"*): inverted flow, much larger scope, needs per-adapter hints she would have to know before installing anything. Out.

## Architecture, Operations & Security

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

### A6 — AI-generated auto-commit messages

When auto-commit is enabled and a script is saved (or renamed/deleted), instead of the generic `"update <path>"` message, ask the configured AI to generate a meaningful commit message based on the diff (`git diff --cached`). Should be best-effort: fall back to the generic message if the AI call fails or times out. Needs a budget-conscious prompt (diff only, no extra context) and a short timeout so saves don't feel sluggish.

### A7 — Relicense to AGPL-3.0-or-later

**Goal:** no cloud hosting / SaaS of *modified* she without copyleft. she is currently `GPL-3.0-or-later`, which has exactly the SaaS loophole this is about: running a modified version as a hosted service is not "conveying" under GPLv3, so a provider could modify she and share nothing. AGPLv3 §13 closes that: anyone letting users interact with a modified version over a network (she's web UI qualifies unambiguously) must offer those users the complete corresponding source.

**Understood limitations (accepted):** AGPL does not forbid SaaS as such — hosting *unmodified* she commercially stays permitted (source obligation satisfied by the public repo), and separate proprietary software talking to she over its APIs (MQTT, HTTP, user scripts) is generally not captured. Preventing all unblessed commercial hosting would require a non-open-source license (SSPL/BSL-style) — explicitly not the goal.

**Facts making the switch clean:**

- Sole copyright holder (LICENSE names Sebastian Raff; AI co-author trailers carry no copyright claim) — relicensing needs no third-party consent. The existing "commercial license available" note remains valid; dual licensing works identically under AGPL.
- Dependencies (Apache-2.0 matter.js, MIT mqtt, …) are one-way compatible into AGPLv3; AGPLv3 ↔ GPLv3 (feezal) interoperate by design via the mutual §13 clauses.
- Published versions ≤ the last GPL release keep their license irrevocably; the change applies from the next release.

**Steps when executing:**

1. Replace LICENSE body with the AGPL-3.0 text, keeping the copyright line and the commercial-license paragraph.
2. `"license": "AGPL-3.0-or-later"` in `package.json` (and `web/package.json` for consistency).
3. Update the README license section; add a short relicensing note (which version the switch happens at).
4. Bump at least a minor version so the license boundary is obvious.
5. Consider adopting a CLA (feezal has `CLA.md`) before accepting outside contributions, to preserve the ability to dual-license.

### A9 — Secrets: revealing values in the UI

🔨 partially done. **✅ Option 3 shipped (she 1.32.0):** fields are *plain* (listed in clear, editable, not redacted in logs) or *secret* (write-only, as A5); the kind is chosen with the lock icon when a field is created, and the lock on a plain field marks it secret — one-way, never shown again (`POST /she/secrets/:group/:field/secret`; `she --secret-set … --plain` on the CLI). Entries from before the change count as secret. **Still open:** option 2 below (revealing a *secret* field through a deliberate, re-authenticated, logged path) as an opt-in setting — not built until the user wants it.

Filed 2026-08-26 while [A5](doc/roadmap-archive/A5.md) was fresh; the user would like an eye icon that shows a stored value, which A5 rules out on purpose. What is at stake, and the options:

**Why A5 is write-only.** Whoever can talk to `/she/*` can already do everything a script can — and a script can `she.info(she.secrets.get('smtp/password'))` or publish it to MQTT. So a read route does not create a *new* capability for an attacker who has a session; what it removes is the *accidental* channel: a value that is never in an HTTP response cannot end up in browser history, a HAR file, a proxy log, a screenshot, a screen share, or the AI chat's context. That is the whole benefit, and it is real but modest. "Only the web interface may read it" is not enforceable: the browser is an HTTP client like any other, and anything the page can fetch, `curl` with the same cookie can fetch.

**Options, weakest to strongest guarantee:**

1. **Eye icon, plain read route** (`GET /she/secrets/:group/:field/value`): simplest, matches the user's wish; the only protections left are the session and the log redaction. Values in transit are as safe as the rest of the session (use HTTPS).
2. **Reveal with friction**: the read route exists but requires re-entering the she password (password mode) or a short-lived per-reveal token minted on the page, is rate-limited, and is logged (`secret smtp/password revealed by <session>`). Same guarantee as 1 technically, but reveals become deliberate, visible acts rather than a click — this is what most secret managers do (Vault, 1Password) and the recommended middle ground.
3. **Two field kinds** — the user's own suggestion: *secret* fields (write-only, exactly A5) and *plain* fields (a username, a host, a client id) whose values are listed and shown in clear. Usernames and hosts are not secrets and it is annoying to type them blind; this keeps the strong rule for the things that matter and still lets one group carry everything a script needs. Fits A5's model with one boolean per field (`secret: true|false`, default true) and `GET /she/secrets` returning the value for plain fields only. Note that a plain field's value would also be exempt from log redaction.
4. **3 + 2**: plain fields always visible, secret fields revealable only through the deliberate path.

**Recommendation:** implement 3 now (small, no new attack surface, solves the "I want to see the username" half), and offer 2 as an opt-in setting (`secrets.allowReveal`, default off) for people who want the eye on secret fields too — with the re-auth/log/rate-limit friction, and the docs stating plainly that with it enabled a session can read every secret. Never 1.

**Open for the user to decide:** whether the plain/secret flag is chosen at creation only (simpler, honest — turning a secret into "plain" later is a reveal by another name) or can be flipped; whether reveal in option 2 should require the password even in proxy/none auth modes (proposal: in `none` mode option 2 is not available at all).
## Testing

### T1 — Auth module unit tests

`POST /she/auth/setup` changes mode and password hash. Session TTL: a session created `SESSION_TTL_MS` ms ago is rejected.

### T2 — Auth integration tests

All integration tests run with `auth: 'none'`. Add a suite that starts the server with `auth: 'password'` and a hashed password: verify `/she/scripts` returns 401 without a cookie, `POST /she/auth/login` with correct credentials returns 200 and sets a cookie, the cookie grants access to `/she/scripts`, wrong password returns 401, `GET /she/auth/mode` returns 200 in all modes (public endpoint). Add to `test/unit/server.test.js` (it already spins up a real server) or a new `test/integration/auth.test.js`.

### T3 — `.shelib` / `.shedisable` marker hot-reload integration tests

The live unload/reload on marker changes has no test coverage.

### T4 — Rapid hot-reload integration tests

Edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
