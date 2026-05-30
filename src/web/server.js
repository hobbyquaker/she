'use strict';

const express = require('express');
const path = require('path');
const { router: configRouter } = require('./config-api');
const { router: scriptsRouter } = require('./scripts-api');
const { router: shedbRouter } = require('./shedb-api');
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

// Serve the built Svelte SPA from dist/web/
const distWeb = path.resolve(__dirname, '../../dist/web');
app.use(express.static(distWeb));
// SPA fallback — serve index.html for any non-API route
app.use((req, res, next) => {
    if (req.path.startsWith('/she') || req.path.startsWith('/api')) return next();
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
