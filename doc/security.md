# Security

## Trust model

**she is designed to run inside a trusted local network, accessed by trusted clients.**

It is generally not a good idea to expose she — or the MQTT broker it connects to, or the smart home devices behind it — directly to the internet, or to any environment where untrusted clients can reach it. This applies equally to the web UI, the HTTP API, and the WebSocket endpoint. If you need remote access, route it through a hardened intermediary rather than exposing she directly.

This does not mean she is insecure by design — it means the trust boundary is the network perimeter, and you are responsible for where you draw that line. A home automation system that talks to locks, alarms, presence sensors, and actuators deserves the same consideration as any other security-sensitive service you run at home.

## Auth modes

she has three auth modes, set via `auth` in `config.json`:

| Mode | Description |
|------|-------------|
| `none` | No authentication (default). Suitable for a local network where you trust all clients. |
| `password` | Session-based login with a bcrypt-hashed password. Sessions are stored in memory and lost on restart. |
| `proxy` | Trust an upstream reverse proxy to authenticate users via a configurable header (e.g. `X-Remote-User`). Recommended for internet-facing deployments. |

When auth is enabled, the `/she/*` API routes and the WebSocket endpoint are protected. See [Script API endpoints](#script-api-endpoints) below for an important caveat about script-registered routes.

## HTTPS

Always terminate TLS when she is accessible beyond localhost. The recommended approach is a reverse proxy (nginx, Caddy) that handles TLS and forwards to she over HTTP on localhost. This also enables you to use a public CA certificate (e.g. Let's Encrypt) without she managing certificates itself.

An example nginx config is provided in [doc/nginx.conf](nginx.conf).

## Reverse proxy and auth proxy

For internet-facing deployments, `auth: 'proxy'` in combination with an authenticating reverse proxy is the recommended approach. The proxy handles login, MFA, and session management; she trusts the proxy-injected header and does not need to know about users or passwords at all.

Any reverse proxy that can inject a user-identity header after successful authentication works. Common choices:

- **[Authentik](https://goauthentik.io/)** — full OIDC/SAML identity provider with a built-in forward-auth proxy; suits households that also want SSO across multiple self-hosted services
- **[Authelia](https://www.authelia.com/)** — lightweight forward-auth proxy with MFA; integrates directly with nginx or Traefik
- **nginx `auth_basic`** — the simplest option for single-user access; no SSO, just an htpasswd file and a browser prompt

Set `authProxyHeader` in `config.json` to whichever header your proxy injects (default: `x-remote-user`).

## Network segmentation

Regardless of auth mode:

- Run your IoT devices on a **separate VLAN** isolated from your main network. MQTT traffic stays on the IoT VLAN; she bridges it to your personal devices but untrusted IoT devices cannot reach your laptops or NAS directly.
- Consider a **VPN** as an alternative to exposing she over the internet at all.
- Setup good firewall rules

## Script API endpoints

Scripts can register their own HTTP routes under `/api/<scriptName>/` using `she.api.*` and `she.http.sub()`. These routes are **intentionally not covered by she-level auth** — the design intent is that scripts control their own access, because some script endpoints are legitimate public webhook receivers (called by external services that cannot present a session cookie or proxy header).

In practice this means that even with `auth: 'password'` or `auth: 'proxy'` enabled, script-registered routes remain accessible without authentication unless the script implements its own access control. Be aware of this when writing scripts that expose sensitive state (presence, lock status, alarm state) via `she.api.*`.

A script can inspect `req.headers` to implement its own auth — for example, verify a shared secret in the `Authorization` header for webhook endpoints.

> This behaviour is tracked as a known limitation and a more ergonomic solution (auth inherited by default, with an explicit `{ public: true }` opt-out for webhook receivers) is planned. See [BACKLOG.md](../BACKLOG.md).

## Third-party npm packages in scripts

Scripts run inside a Node.js VM sandbox, but they can `require()` any package that is installed in the global Node.js environment or in the she package itself. This means that **whatever npm package you load into a script runs with the same privileges as the she process** — full filesystem access, network access, and access to all connected devices.

npm is a large, open ecosystem. The vast majority of packages are written in good faith, but the historical record includes a meaningful number of packages that were malicious (credential theft, crypto miners, backdoors) or simply of such low quality that they introduced severe vulnerabilities. Supply-chain attacks — where a legitimate package is later compromised — are a documented and recurring threat.

**Recommendations:**

- **Keep third-party dependencies at an absolute minimum.** Before reaching for an npm package, ask whether the task can be done with the built-in sandbox API (`she.mqtt`, `she.db`, `she.http.fetch`, …) or with a short piece of code you write yourself.
- **Read the code you introduce.** If you do use a package, read every line that will execute in your scripts. This is realistic for small, focused utilities (a handful of functions, no transitive dependencies); it is not realistic for large packages with deep dependency trees.
- **Prefer zero-dependency packages.** Each transitive dependency is an additional attack surface you did not review.
- **Pin exact versions.** Use `npm install --save-exact` so an update cannot silently swap in different code.
- **Check package provenance.** Look at download counts, publish history, the source repository, and when the last version was published. A package that was dormant for two years and suddenly received an update deserves extra scrutiny.
- **Never install a package solely because a tutorial or an AI assistant suggested it** without first reviewing what it actually does.

You are responsible for every piece of code that runs in your smart home. A compromised script has access to your presence sensors, locks, alarms, and anything else connected to your broker. Treat npm installs in this context with the same caution you would apply to running an unknown binary as root.

## Mosquitto Dynamic Security

If you run Mosquitto as your MQTT broker, the **Dynamic Security plugin** lets you define per-client ACLs that control which topics each client may publish or subscribe to. This limits blast radius if a script or IoT device misbehaves — a device that should only publish its own sensor data cannot subscribe to lock commands.

she includes built-in support for managing Mosquitto Dynamic Security: client and role management, ACL assignment, via a web UI in the Broker tab and with a script api.

See [Broker management](broker-management.md) for setup instructions and configuration details.
