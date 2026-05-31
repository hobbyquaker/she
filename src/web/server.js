'use strict';

const express = require('express');
const path = require('path');
const { router: configRouter } = require('./config-api');
const { router: scriptsRouter } = require('./scripts-api');
const { router: shedbRouter } = require('./shedb-api');
const { router: matterRouter } = require('./matter-api');
const { router: mqttRouter } = require('./mqtt-api');
const { router: depsRouter } = require('./deps-api');
const { router: gitRouter } = require('./git-api');
const { attachWss, closeWss } = require('./log-ws');

const app = express();
app.use(express.json());

// Lazy auth check — _apiKey is populated by startServer(); null = auth disabled.
// Covers both /she/* (internal system routes) and /api/* (user-script routes).
let _apiKey = null;
app.use(['/she', '/api'], (req, res, next) => {
    if (!_apiKey) return next();
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${_apiKey}`) return next();
    res.status(401).json({ error: 'Unauthorized' });
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

// Graceful daemon restart — exit(0) and let the process manager restart
app.post('/she/restart', (req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
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

/**
 * Register an HTTP route. Throws if the same method+path pair is already registered.
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
    app[method](fullPath, handler);
}

let httpServer = null;

/**
 * Start listening. Resolves with the actual port (useful when port 0 is given).
 * @param {number} port
 * @param {{ apiKey?: string, configPath?: string, scriptDir?: string }} [options]
 * @returns {Promise<number>}
 */
function startServer(port, options = {}) {
    _apiKey = options.apiKey || null;
    if (options.configPath) {
        app.locals.configPath = options.configPath;
    }
    if (options.scriptDir) {
        app.locals.scriptDir = options.scriptDir;
    }
    return new Promise((resolve, reject) => {
        httpServer = app.listen(port, () => {
            attachWss(httpServer);
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

module.exports = { app, registerRoute, startServer, stopServer };
