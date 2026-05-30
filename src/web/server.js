'use strict';

const express = require('express');
const { router: configRouter } = require('./config-api');

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
 * @param {{ apiKey?: string, configPath?: string }} [options]
 * @returns {Promise<number>}
 */
function startServer(port, options = {}) {
    _apiKey = options.apiKey || null;
    if (options.configPath) {
        app.locals.configPath = options.configPath;
    }
    return new Promise((resolve, reject) => {
        httpServer = app.listen(port, () => resolve(httpServer.address().port));
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
            httpServer.close(resolve);
            httpServer = null;
        } else {
            resolve();
        }
    });
}

module.exports = { app, registerRoute, startServer, stopServer };
