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

- **Find in files** — cross-file text search across all files in the scripts directory. Backend: new endpoint `GET /she/scripts/search?q=<text>&regex=false&caseSensitive=false`; reads all non-binary files via the existing storage layer, scans line-by-line, returns `[{ path, matches: [{ line, col, preview }] }]` (line 1-based, preview is the matched line trimmed); caps total matches at ~500 and sets a `truncated` flag. Frontend: a search-icon button in the sidebar toolbar (next to `+ File`, `+ Folder`) toggles a search panel that slides in above the file tree; fields: text input + `Aa` case toggle + `.*` regex toggle + debounced search-on-type (300 ms); results grouped by file showing matched lines with the match highlighted; clicking a result opens the tab and jumps via `editor.revealLineInCenter()` + `editor.setPosition()`; shows total result / file counts and a truncation notice when capped. Searches all file types the editor handles (excluding detected binary files — skip files containing a null byte in the first 8 KB). Keyboard shortcut `Ctrl+Shift+F` should open the panel regardless of whether Monaco has focus: register the shortcut both via `editor.addCommand` (inside Monaco) and as a `keydown` listener on the Svelte layout container (outside Monaco).

- **Find and replace across files** — extend the find-in-files panel with an optional replace field (toggle-disclosed, VS Code style). Confirmation step before applying: show a preview list of all changes grouped by file with diff-style before/after lines and a per-file checkbox to opt out. Applies changes via sequential `PUT /she/scripts/:path` calls. Undo is out of scope for v1 — the confirmation step is the safeguard. Depends on *Find in files* being shipped first.

- **Find in files — auto-refresh on save** — after a script is saved (tab `dirty → clean` transition or external WS `script:change` event), re-run the current search query silently and update the result list in-place, highlighting newly appeared or disappeared matches. Should debounce file-change events (files can save in quick succession). Depends on *Find in files* being shipped first.

- **tab bar scrolling** — when many files are open the tab bar overflows with no way to reach hidden tabs (the bar already has `overflow-x: auto; scrollbar-width: none` so the overflow exists but is invisible). Fix: wrap the tab strip in a `tab-bar-wrap` flex row containing a `‹` button, the tab strip (`flex:1`, `overflow-x: hidden`), and a `›` button; clicking either calls `tabBarEl.scrollBy({ left: ±200, behavior: 'smooth' })`; a `wheel` listener on the strip translates `deltaY` → `scrollLeft` (with `e.preventDefault()` to suppress page scroll). Buttons are always rendered but disabled/dimmed (opacity ~0.3, `cursor: default`) at the respective end — avoids layout shift and `ResizeObserver` complexity. Track `canScrollLeft` / `canScrollRight` from a combined `scroll` + `ResizeObserver` listener on the strip. Bonus: call `activeTabEl.scrollIntoView({ inline: 'nearest' })` on every tab switch so the active tab is always visible. Frontend-only, no backend changes.

- **file tree virtualization** — the tree re-renders entirely on any change; with hundreds of scripts this becomes slow. Use a virtual list (`svelte-virtual-list` or similar) to only render visible rows.

## MQTT

- **per-topic value history** — the MQTT tab shows current state only. A configurable ring buffer (e.g. last 20 values with timestamps) per topic would be useful for debugging value changes over time.

- **ACL overlay in topic tree** — when dynsec is configured, allow the user to inspect which roles/groups/users can publish to or subscribe from any topic in the tree. Primary use case: debugging access problems ("why is user X not receiving topic Y?"). Secondary: security auditing ("which topics are unprotected?").

  **UX design:**
  - An **"ACL" toggle button** in the MQTT tab toolbar (hidden when dynsec not configured / not ready). When active, each topic row gets a subtle lock badge (🔒) if at least one explicit role ACL pattern matches that topic, distinguishing "has explicit ACL" from "falls back to default".
  - Clicking the badge (or clicking any topic row while ACL mode is on) opens an **inline inspection panel** below the row showing three sections: *Can publish (send)*, *Can subscribe*, *Can receive* — each listing the matching roles and, under each role, the groups and individual users that hold it.
  - A "Default ACL" footer row shows the broker-wide default for each operation type (from `getDefaultACLAccess`) as the fallback when no role ACL matches.
  - `%c` / `%u` pattern-substituted ACL entries (per-clientid / per-username topics) are shown with a ⚠ note: "per-client pattern — cannot evaluate statically."

  **Implementation approach (v1, client-side matching):**
  - On first toggle activation: batch-fetch `GET /she/broker/roles?verbose=true`, `GET /she/broker/users?verbose=true`, `GET /she/broker/groups?verbose=true` and cache in memory (re-fetched on manual refresh). Total: 3 API calls, one-time.
  - The existing `mqttMatch()` in MQTT.svelte already handles MQTT wildcard patterns (`#`, `+`). Reuse it to evaluate whether each role ACL's topic pattern covers the inspected topic.
  - Build an in-memory index: `Map<acltype, Map<rolename, allow/deny>>` per topic on demand (lazy, computed on panel open).
  - Walk the index to resolve roles → groups → users for display.
  - Mosquitto's full priority/precedence logic (multiple roles per client, group priorities) is complex; v1 can show all *matching* roles without computing the winning one — good enough for debugging.

  **v2 option — dedicated backend endpoint:** `GET /she/broker/acl-check?topic=foo/bar` returns a pre-computed effective-permission summary computed server-side by the dynsec module. This gives authoritative results including priority resolution, at the cost of one round-trip per inspected topic. Worthwhile if the client-side approximation causes confusion.

- **multiple MQTT broker connections** — allow connecting to more than one broker simultaneously. Config: replace the top-level `url` string with a `brokers` map where each key is a broker name and the value is the existing per-broker options object (`url`, `username`, `password`, `ca`, `cert`, `key`, `mqttVersion`). The existing `url` key stays supported as shorthand for a single default broker (backward compat). Script API: `she.broker(name)` returns a broker-scoped object exposing the full `mqtt` sub-API (`sub`, `pub`, `get`, `link`, `or`, `and`, `max`, `min`, `timer`, `age`, `getProp`). `she.mqtt` remains a shorthand alias for `she.broker('default')` (or the sole configured broker). State store keys become `mqtt::brokerName::topic`. WS `mqtt` events carry an additional `broker` field. Each broker runs its own sentinel cycle on connect. `link()` and the stdlib helpers (`or`, `and`, `max`, `min`, `timer`) work within a single broker scope only in this first step — cross-broker bridging is a follow-up. Breaking change — requires a migration note when shipped.

  **Config page UX** — the broker configuration section uses a file-tab-style switcher (same visual language as the editor's script tabs) sitting above the broker form panel. One tab per configured broker; clicking a tab activates that broker's form. Each tab shows the broker name and a small status dot (green/yellow/red, same `nav-dot` classes). A `+` button at the right end of the tab bar adds a new broker with a generated name and empty fields. Each tab has a `×` delete button (with confirmation). The form fields are: *name* (editable — renaming updates the tab label and the `brokers` map key), *url*, *username*, *password* (masked, with show/hide toggle), *ca*, *cert*, *key*, *mqttVersion*, *sentinelTimeout*. When only one broker is configured the tab bar is still shown (consistent UX, and makes it obvious how to add a second one). The existing single-broker fields (`url`, `mqttUsername`, …) in the form are migrated to the `brokers` map on first save.

  **MQTT page UX** — when multiple brokers are configured, a broker filter tab bar appears above the topic list (styled like the Config broker tabs, "All" selected by default). Selecting a broker tab filters the list to that broker's topics only; the "All" tab shows every topic from every broker. In the "All" view each row shows a small broker badge (the broker name in a muted chip, similar to `pane-count`) so the origin is visible at a glance; badges are hidden when only one broker is configured or a single broker tab is active. The publish form gains a broker selector dropdown (defaults to the first/only broker; hidden when only one broker exists). The nav dot on the MQTT tab reflects the worst-case state across all brokers: red if any broker is configured but disconnected, yellow/blinking if any broker is still waiting for the sentinel, green only when all brokers are fully ready. The dot's tooltip lists per-broker status.

  *Optional follow-up — cross-broker references:* allow `'brokerName##topic'` as a topic string in `link()` and stdlib helpers to reference a topic on a different broker. `##` is chosen as separator because a double hash can never appear in a valid MQTT topic (the `#` wildcard is only legal as a standalone final segment and publishing to a topic containing `#` is forbidden by spec), making it unambiguous to parse.

## Matter

- **QR code scanning for pairing** — the commission flow currently requires the user to manually enter a pairing code or passcode + discriminator. Add support for scanning a Matter QR code (`MT:…`) via (a) the device camera (`getUserMedia` + canvas frame sampling + a JS QR decoder such as `jsQR` or `zxing-js`) or (b) an image file upload (same decoder, fed a decoded canvas). Either path extracts the pairing code and pre-fills the commissioning form. Camera path should show a live preview with a targeting reticle; file-upload path is the fallback for environments without camera access. Frontend-only change; no backend modifications needed.

## sheDB



## Secrets

- **secrets management** — store secrets (named groups of arbitrary string fields, e.g. `{ "smtp": { "password": "…", "host": "…" } }`) in a dedicated encrypted file (`~/.she/secrets.enc`) separate from `config.json`, using AES-256-GCM via Node.js built-in `crypto`. Encryption key sourced from env var `SHE_SECRETS_KEY` (takes precedence) or key file `~/.she/secrets.key` (chmod 600). Access from scripts via `she.secrets.get('<name>/<field>')`. Integrate as own section in config ui (show/hide values). Open questions to resolve before implementation: HTTP API exposure (security concern — avoid reading secret values over the network, or localhost-only), behavior when key is missing, hot-reload vs. startup-only, CLI subcommands for management, configurable secrets file path.

## Security Page — CA & mTLS

- **Document the XCA / intermediate CA workflow** — the existing `addTrustedCert` endpoint (`POST /she/broker/ca/trusted`) already handles the primary use case: a user has a CA cert signed by their own XCA (or any external CA) and wants mosquitto to trust client certs issued by it. The flow is: upload the intermediate CA cert PEM → it is added to the `capath` directory and rehashed → point the mosquitto listener's `capath` to that directory. What is **not** yet covered: (a) using an externally-signed CA as she's *own signing CA* (to sign server certs and client certs from within the Security UI) — there is no "import CA keypair" path, only "generate self-signed". Add an *Import existing CA* option that accepts a PEM cert + key and writes them to `ca.crt` / `ca.key` under the CA directory. (b) Intermediate CA chain files: if the CA was signed by an intermediate (not a root), mosquitto needs `cafile` to contain the full chain (intermediate cert + root cert concatenated). The import flow should detect this and offer to paste the chain. Document both paths in `doc/broker-management.md`.

- **mTLS ↔ dynsec user linkage** — `use_identity_as_username true` (mosquitto.conf listener option) maps the client cert's CN to the MQTT username, enabling password-free mTLS auth backed by dynsec ACLs. Currently this option is not surfaced anywhere in the UI. Required changes: (a) add a `use_identity_as_username` toggle to the Listeners section in the Security page (visible only for TLS listeners); (b) when issuing a client cert, add a "link to dynsec user" dropdown — pre-fill the CN field with the selected username and, optionally, create the dynsec user simultaneously if it doesn't exist; (c) add a callout in the cert issuance form: "The CN must match the dynsec username exactly for mTLS auth to work." Backend: no changes needed — mosquitto handles the mapping at connect time.

- **step-ca integration (homelab PKI)** — for users running Smallstep step-ca, the integration path is: (1) add the step-ca root/intermediate cert via `addTrustedCert` so mosquitto trusts step-ca-issued client certs; (2) issue mosquitto's server cert via `step ca certificate`; (3) configure mosquitto `certfile`/`keyfile` to point at the step-ca cert. The missing piece is **auto-renewal**: step-ca issues 24h certs by default and provides `step ca renew --daemon` for background renewal. She needs to trigger `sudo systemctl reload mosquitto` after renewal. Implementation option A: a config field `broker.certRenewHook` that she executes after any cert change (generic, also useful for LE). Option B: detect that the server cert path is managed by step-ca and offer to install a systemd timer or cron. Document the manual flow in `doc/broker-management.md` with copy-paste commands.

- **Let's Encrypt server cert** — for mosquitto with a public hostname, certbot can issue and auto-renew the server cert. She could detect a certbot-managed cert at well-known paths (`/etc/letsencrypt/live/<domain>/`) and offer to configure the listener's `certfile`/`keyfile` to point there. The critical integration piece is the renewal hook: she should offer to install a `--deploy-hook "sudo systemctl reload mosquitto"` into certbot's hook directory. DNS challenge (`--dns-*` plugins) is the only approach that avoids port 80 conflicts with other services and works for private hostnames. Scope: a wizard step "Use Let's Encrypt certificate" that (a) asks for the domain name, (b) shows the certbot command to run, (c) detects the resulting cert file and wires it into the listener config automatically.

- **MQTT-based CSR renewal ("poor man's CMP over MQTT")** — a composable mechanism for IoT devices (e.g. ESPHome with mTLS client certs) to renew their certificates without manual intervention, using existing mosquitto infrastructure. Design:

  *Device side:* when the current cert approaches expiry, the device generates a new keypair + CSR and publishes the CSR PEM (retained, QoS 1) to `$she/csr/<its-own-username>`. The device is still authenticated via its current (not-yet-expired) client cert; mosquitto verifies identity via mTLS + dynsec ACL `publishClientSend $she/csr/%u allow`. The ACL's `%u` substitution ensures a device can only submit a CSR for its own username — identity is proven by the still-valid cert.

  *She side:* a user-written script (or a built-in handler) subscribes to `$she/csr/#`, validates that the CSR's CN matches the topic segment (and matches a known cert in the database), calls `she.broker.signCSR(csrPem)`, and publishes the resulting cert PEM to `$she/cert/<username>` (retained, QoS 1).

  *Device side (renewal):* device receives the new cert, writes to flash/FS, restarts its TLS stack with the new cert. Old cert is now superseded; she can revoke it.

  *Required changes:*
  - Expose `she.broker.signCSR(csrPem, { days? })` in the script sandbox API → calls `ca.issueClientCertFromCSR(config, csrPem, { days })` (new ca.js function that accepts a CSR rather than generating a key internally).
  - Add `POST /she/broker/ca/sign-csr` HTTP endpoint (for the UI and for script use).
  - The script that drives the flow is entirely user-land; include an example in `doc/examples.md`.
  - ACL setup guide: document the `$she/csr/%u` / `$she/cert/%u` role ACL pattern that enables the flow.
  - ESPHome: the custom MQTT component + `on_message` + `globals` approach for publishing CSR and receiving cert is documented as an example.

  *Security properties:* the device can only request renewal while its current cert is valid (replay window = cert lifetime). No shared secrets required. The CA key never leaves the she host. Revocation of the old cert after successful renewal prevents replay. Limitations: if the cert has already expired, the device can no longer authenticate and the CSR flow is unavailable — this requires out-of-band recovery (flash a new cert manually). Consider adding a `she.broker.issueRenewalToken(username, ttl)` that issues a short-lived MQTT username/password token for the recovery path.

## Operations

- **health check endpoint** — `GET /she/health` returning 200 if the daemon is alive, configured mqtt broker is connected, ..., 503 otherwise. Useful for Docker health checks, nginx upstreams, and monitoring systems.


## Security / Robustness

- **path traversal via symlinks** — `safePath()` in `scripts-api.js` checks `startsWith(root + sep)` but does not resolve symlinks. A symlinked entry inside the script root could point outside it. Use `fs.realpath()` to resolve before checking.

- **session persistence** — login sessions are held in-memory and lost on every daemon restart, forcing all users to re-login. Persist session tokens (hashed) to a file in `--data-dir`.

## Testing

- **integration tests for `.shelib` / `.shedisable` marker hot-reload** — the live unload/reload on marker changes has no test coverage.

- **integration tests for rapid hot-reload** — edge cases in subscription cleanup during rapid script updates (change → reload cycle) are not tested.
