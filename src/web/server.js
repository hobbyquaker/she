'use strict';

const express = require('express');

const app = express();
app.use(express.json());

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
 * @returns {Promise<number>}
 */
function startServer(port) {
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
