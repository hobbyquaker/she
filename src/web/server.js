'use strict';

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const semverCompare = require('semantic-compare');
const pkg = require('../../package.json');
const { router: configRouter } = require('./config-api');
const { router: scriptsRouter } = require('./scripts-api');
const { router: shedbRouter } = require('./shedb-api');
const { router: matterRouter } = require('./matter-api');
const { router: mqttRouter } = require('./mqtt-api');
const { router: depsRouter } = require('./deps-api');
const { router: gitRouter } = require('./git-api');
const { router: aiRouter } = require('./ai-api');
const { router: brokerRouter } = require('./broker-api');
const { router: servicesRouter } = require('./services-api');
const { router: secretsRouter } = require('./secrets-api');
const { attachWss, closeWss } = require('./log-ws');
const { init: initAuth, authMiddleware, checkAuth, router: authRouter } = require('./auth');

const app = express();
app.use(express.json());

const SERVER_START_TIME = Date.now();

// Public auth routes — always accessible regardless of auth mode.
// Must be mounted BEFORE the auth middleware.
app.use('/she/auth', authRouter);

// Auth middleware for all /she/* routes except the public auth endpoints above.
// /api/* is intentionally excluded — user scripts control their own auth.
// The remote-host bootstrap script and its callback are fetched by curl on the target host: no
// session, but useless without the one-time token they carry (services-api validates it).
// /she/health is public on purpose: Docker HEALTHCHECK, nginx upstream probes and monitoring
// agents cannot present a session. It answers with a status only — the version is added for
// authenticated callers, the rest of the payload is counters that give nothing away.
const OPEN_SHE_PATHS = new Set(['/she/auth/mode', '/she/auth/login', '/she/auth/logout', '/she/services/setup.sh', '/she/services/setup/done', '/she/health']);
app.use('/she', (req, res, next) => {
    if (OPEN_SHE_PATHS.has(req.originalUrl.split('?')[0])) return next();
    authMiddleware(req, res, next);
});

// Config REST endpoints: GET /she/config and PUT /she/config
app.use('/she/config', configRouter);

// Scripts file CRUD: GET/PUT/DELETE /she/scripts/*
app.use('/she/scripts', scriptsRouter);

// sheDB document store REST API: /she/db/*
app.use('/she/db', shedbRouter);

// Matter controller REST API: /she/matter/*
app.use('/she/matter', matterRouter);

// MQTT state snapshot and publish: /she/mqtt/*
app.use('/she/mqtt', mqttRouter);

// npm package management: /she/deps/*
app.use('/she/deps', depsRouter);

// Git integration: /she/git/*
app.use('/she/git', gitRouter);

// AI assistant proxy: /she/ai/*
app.use('/she/ai', aiRouter);

// Broker management: /she/broker/*
app.use('/she/broker', brokerRouter);

// xyz2mqtt service management: /she/services/*
app.use('/she/services', servicesRouter);

// Secrets (roadmap A5): write-only, values never leave the daemon
app.use('/she/secrets', secretsRouter);

// Graceful daemon restart
// When running under systemd, delegate to `sudo systemctl restart` so the
// service actually comes back up. Otherwise fall back to exit(0) and let
// whatever process manager is in use handle it.
function _systemdRestart() {
    if (process.env.INVOCATION_ID) {
        spawn('sudo', ['systemctl', 'restart', 'smart-home-engine'], { detached: true, stdio: 'ignore' }).unref();
    } else {
        process.exit(0);
    }
}

app.post('/she/restart', (req, res) => {
    res.json({ ok: true });
    setTimeout(_systemdRestart, 200);
});

// npm version check — poll once on startup and every 24 hours
let _latestNpmVersion = null;
async function _checkNpmVersion() {
    try {
        const res = await fetch('https://registry.npmjs.org/smart-home-engine/latest');
        const data = await res.json();
        _latestNpmVersion = data.version && semverCompare(pkg.version, data.version) < 0 ? data.version : null;
    } catch {
        /* best-effort */
    }
}
_checkNpmVersion();
setInterval(_checkNpmVersion, 24 * 60 * 60 * 1000);

// Trigger an immediate version check (called by the UI refresh button)
app.post('/she/check-update', async (req, res) => {
    await _checkNpmVersion();
    res.json({ latestVersion: _latestNpmVersion });
});

// Update — install latest npm package, then restart
app.post('/she/update', (req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
        // Use async spawn so the HTTP server (and event loop) remain responsive
        // while npm runs. spawnSync would block all HTTP polling from the UI.
        const child = spawn('sudo', ['npm', 'install', '-g', 'smart-home-engine'], { stdio: 'inherit' });
        child.on('close', () => _systemdRestart());
    }, 200);
});

// Runtime stats — script count + MQTT topic count
let _getStats = null;
function setStatsProvider(fn) {
    _getStats = fn;
}

// Health check (roadmap A1) — 200 while the daemon can do its job, 503 otherwise.
// Not healthy: still starting up (waiting for retained MQTT state or the Matter
// controller), or a broker is configured but not connected. Safe mode stays 200:
// it is a deliberate state the user has to reach the web UI to get out of, so a
// probe that takes the daemon out of an upstream pool would be counterproductive.
let _getHealth = null;
function setHealthProvider(fn) {
    _getHealth = fn;
}
app.get('/she/health', (req, res) => {
    const h = _getHealth ? _getHealth() : null;
    const mqtt = !h ? 'unknown' : h.mqttConfigured ? (h.mqttConnected ? 'connected' : 'disconnected') : 'disabled';
    const ok = !!h && h.started && mqtt !== 'disconnected';
    const body = {
        status: ok ? 'ok' : 'degraded',
        uptime: Math.round((Date.now() - SERVER_START_TIME) / 1000),
        started: !!h?.started,
        mqtt,
        scripts: h?.scripts ?? 0,
    };
    if (h?.safeMode) body.safeMode = true;
    if (checkAuth(req)) body.version = pkg.version;
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json(body);
});
const _isDocker = require('fs').existsSync('/.dockerenv');
app.get('/she/status', (req, res) => {
    const s = _getStats ? _getStats() : { scripts: 0, topics: 0 };
    if (_latestNpmVersion) s.latestVersion = _latestNpmVersion;
    s.dataDir = require('../lib/storage').STORAGE_ROOT;
    s.user = require('os').userInfo().username; // the OS user the daemon runs as (default SSH user for managed hosts)
    s.startedAt = SERVER_START_TIME;
    if (_isDocker) s.docker = true;
    res.json(s);
});

// Log history from the current daemon run's she.jsonl file.
// ?since=<ts> filters to entries with ts >= that timestamp (default: 0 = all).
app.get('/she/logs/history', (req, res) => {
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;
    const { LOGS_DIR } = require('../lib/storage');
    const logFile = require('path').join(LOGS_DIR, 'she.jsonl');
    try {
        const raw = require('fs').readFileSync(logFile, 'utf8');
        const entries = raw
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            })
            .filter((e) => e && typeof e.ts === 'number' && e.ts >= since);
        res.json(entries);
    } catch {
        res.json([]);
    }
});

// Serve the built Svelte SPA from dist/web/
// Hashed assets (JS/CSS) are immutable; index.html must never be cached so
// browsers always pick up a freshly deployed version.
const distWeb = path.resolve(__dirname, '../../dist/web');
app.use(express.static(distWeb, { index: false })); // don't auto-serve index.html
// SPA fallback — serve index.html for any non-API route, always no-cache
app.use((req, res, next) => {
    if (req.path.startsWith('/she') || req.path.startsWith('/api')) return next();
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(distWeb, 'index.html'));
});

// Central route registry — key: 'METHOD /api/scriptname/path'
const registry = new Map();

// Per-script Express sub-routers for she.api routes.
// Each script gets one Router mounted at /api/<scriptName>; the layer reference
// is kept so it can be spliced out of the app's middleware stack on unload.
const scriptRouters = new Map(); // scriptName → { router, layer }

/**
 * Register an HTTP route. Throws if the same method+path pair is already registered.
 * Routes under /api/<scriptName>/... are grouped into a per-script sub-router so
 * they can all be removed at once when the script is unloaded.
 * @param {'get'|'post'|'put'|'delete'} method
 * @param {string} fullPath  - absolute Express path, e.g. '/api/myscript/foo'
 * @param {Function} handler - Express route handler (req, res)
 */
function registerRoute(method, fullPath, handler) {
    const key = `${method.toUpperCase()} ${fullPath}`;
    if (registry.has(key)) {
        throw new Error(`Route already registered: ${key}`);
    }
    registry.set(key, true);

    // Route belongs to a user script — use a per-script sub-router.
    const m = fullPath.match(/^\/api\/([^/]+)(\/.*)?$/);
    if (m) {
        const scriptName = m[1];
        const routePath = m[2] || '/';
        let entry = scriptRouters.get(scriptName);
        if (!entry) {
            const router = express.Router();
            app.use('/api/' + scriptName, router);
            // Capture the layer Express just pushed onto its stack.
            // Express 5 exposes the router via the public `app.router` getter.
            const stack = app.router.stack;
            const layer = stack[stack.length - 1];
            entry = { router, layer };
            scriptRouters.set(scriptName, entry);
        }
        entry.router[method](routePath, handler);
    } else {
        // Fallback for any non-/api/ paths (shouldn't occur in normal usage).
        app[method](fullPath, handler);
    }
}

/**
 * Remove all HTTP routes registered by a script and allow re-registration.
 * Called by unloadScript() in index.js on hot-reload.
 * @param {string} scriptName - basename without extension, e.g. 'myscript'
 */
function unregisterRoutesByScript(scriptName) {
    const entry = scriptRouters.get(scriptName);
    if (entry) {
        const stack = app.router?.stack;
        if (stack) {
            const idx = stack.indexOf(entry.layer);
            if (idx !== -1) stack.splice(idx, 1);
        }
        scriptRouters.delete(scriptName);
    }
    // Clear registry entries so the routes can be re-registered on reload.
    for (const key of [...registry.keys()]) {
        if (key.includes('/api/' + scriptName + '/') || key.endsWith('/api/' + scriptName)) {
            registry.delete(key);
        }
    }
}

let httpServer = null;

/**
 * Start listening. Resolves with the actual port (useful when port 0 is given).
 * @param {number} port
 * @param {{ auth?: string, password?: string, proxyHeader?: string, proxyLogoutUrl?: string, bindAddress?: string, configPath?: string, scriptDir?: string }} [options]
 * @returns {Promise<number>}
 */
function startServer(port, options = {}) {
    initAuth({
        auth: options.auth || 'none',
        password: options.password || null,
        proxyHeader: options.proxyHeader || 'X-Remote-User',
        proxyLogoutUrl: options.proxyLogoutUrl || null,
        configPath: options.configPath || null,
    });
    if (options.configPath) {
        app.locals.configPath = options.configPath;
    }
    if (options.scriptDir) {
        app.locals.scriptDir = options.scriptDir;
    }
    const host = options.bindAddress || '0.0.0.0';
    return new Promise((resolve, reject) => {
        httpServer = app.listen(port, host, () => {
            attachWss(httpServer, checkAuth);
            resolve(httpServer.address().port);
        });
        httpServer.on('error', reject);
    });
}

/**
 * Stop the HTTP server gracefully.
 * @returns {Promise<void>}
 */
function stopServer() {
    return new Promise((resolve) => {
        if (httpServer) {
            closeWss().then(() => {
                httpServer.close(resolve);
                httpServer = null;
            });
        } else {
            resolve();
        }
    });
}

module.exports = { app, registerRoute, unregisterRoutesByScript, setStatsProvider, setHealthProvider, startServer, stopServer };
