'use strict';

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const pkg = require('../../package.json');
const { router: configRouter, DEFAULT_CONFIG_PATH } = require('./config-api');
const updateChannel = require('../lib/update-channel');
const selfUpdate = require('../lib/self-update');
const servicesHost = require('../lib/services-host');
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
// every request from arrival to the end of the response, for the event-loop heartbeat's attribution
app.use(require('../lib/activity').middleware());
// 10 MB: a long AI conversation with its tool events, a saved script, a sheDB document — Express's 100 KB
// default answered "request entity too large" on a long chat (1.52.0)
app.use(express.json({ limit: '10mb' }));

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

// The runtime model: handlers, timers, statistics, gauge history, the editor's timer actions
app.use('/she/runtime', require('./runtime-api').router);

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

// Update check — the GitHub releases of she, by channel: `stable` offers the newest release,
// `beta` also the pre-releases. Polled once at start and every 24 hours, and on the UI's button.
const _isDocker = require('fs').existsSync('/.dockerenv');
let _update = null; // the last check's result (update-channel.checkUpdate)
let _startupChannel = 'stable';

// The channel is read from the config file at every check, so a change on the Config page
// takes effect without a restart; the CLI/env value is the fallback when the file has none.
function currentChannel() {
    try {
        const file = JSON.parse(require('fs').readFileSync(app.locals.configPath || DEFAULT_CONFIG_PATH, 'utf8'));
        if (updateChannel.CHANNELS.includes(file.updateChannel)) return file.updateChannel;
    } catch {
        /* no file, or not ours to parse */
    }
    return _startupChannel;
}

async function _checkUpdate() {
    _update = await updateChannel.checkUpdate({ installed: pkg.version, channel: currentChannel(), docker: _isDocker });
    return _update;
}

function _updateFields() {
    const f = { updateChannel: _update ? _update.channel : currentChannel() };
    if (_update && _update.latest) {
        f.latestVersion = _update.latest;
        if (_update.latestIsPrerelease) f.latestPrerelease = true;
    }
    if (_update && _update.stable) f.latestStable = _update.stable;
    if (_update && _update.prerelease) f.latestBeta = _update.prerelease;
    if (_updateFailed) f.updateError = _updateFailed;
    else if (_update && _update.error) f.updateError = _update.error;
    if (_updating) f.updating = true;
    return f;
}

// Trigger an immediate version check (called by the UI refresh button)
app.post('/she/check-update', async (req, res) => {
    const r = await _checkUpdate();
    res.json({ latestVersion: r.latest, ..._updateFields() });
});

// Update — install the offered version exactly, then restart — but only after npm succeeded.
// The install runs through the helper (`she-servicectl she-update <version>`, v16) when the host
// has it; a host with an older helper falls back to the literal `sudo npm install -g
// smart-home-engine` of the old sudoers rule when the offered version is npm's `latest`, and is
// asked to update the helper otherwise. Without a known version there is nothing to install.
let _updating = false; // an install is running
let _updateFailed = null; // the last failed install's message, until the next attempt

function _log(level, msg) {
    if (_logger) _logger[level](msg);
    else (level === 'error' || level === 'warn' ? console.error : console.log)(msg);
}

async function _planUpdate(version) {
    const helperVersion = await selfUpdate.helperVersionOf(servicesHost.createLocalDriver());
    // npm's `latest` matters only for the fallback, so it is fetched only when the helper is too old
    const helperOk = Number.isInteger(helperVersion) && helperVersion >= selfUpdate.HELPER_SHE_UPDATE_VERSION;
    return selfUpdate.planUpdate({ version, helperVersion, npmLatest: helperOk ? null : await updateChannel.npmLatest() });
}

app.post('/she/update', async (req, res) => {
    const version = _update && _update.latest;
    if (!version || _isDocker) {
        res.status(409).json({ ok: false, error: _isDocker ? 'a Docker container is updated by pulling a new image' : 'no update known — check for updates first' });
        return;
    }
    if (_updating) {
        res.status(409).json({ ok: false, error: 'an update is already running' });
        return;
    }
    const plan = await _planUpdate(version);
    if (plan.error) {
        _updateFailed = plan.error;
        _log('warn', `update to ${version} not possible: ${plan.error}`);
        res.status(409).json({ ok: false, error: plan.error });
        return;
    }
    _updating = true;
    _updateFailed = null;
    res.json({ ok: true, version, via: plan.mode });
    // async spawn, so the HTTP server (and the UI's polling) stays responsive while npm runs
    setTimeout(async () => {
        const r = await selfUpdate.performUpdate({ plan, version, spawn, onRestart: _systemdRestart, log: _log });
        _updating = false;
        if (!r.ok) _updateFailed = r.error;
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
    if (h?.safeMode) {
        body.safeMode = true;
        if (h.safeModeReason) body.safeModeReason = h.safeModeReason;
    }
    if (checkAuth(req)) body.version = pkg.version;
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json(body);
});
app.get('/she/status', (req, res) => {
    const s = Object.assign(_getStats ? _getStats() : { scripts: 0, topics: 0 }, _updateFields());
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
    _startupChannel = updateChannel.normalizeChannel(options.updateChannel);
    _checkUpdate();
    setInterval(_checkUpdate, 24 * 60 * 60 * 1000).unref();
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

let _logger = null;
/** The daemon's logger; without one the update path writes to the console. */
function setLogger(log) {
    _logger = log;
}

module.exports = { app, registerRoute, unregisterRoutesByScript, setStatsProvider, setHealthProvider, setLogger, startServer, stopServer };
