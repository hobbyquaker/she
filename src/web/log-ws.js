'use strict';

const { WebSocketServer } = require('ws');

let _wss = null;
const _clients = new Set();
const _welcomeProviders = [];

/**
 * Register a function that returns a welcome message (or array of messages)
 * to send to each new WebSocket client immediately after it connects.
 * May be called multiple times; all registered providers are invoked in order.
 * @param {() => object | object[]} fn
 */
function setWelcomeProvider(fn) {
    _welcomeProviders.push(fn);
}

// Ring buffer of recent log entries for the AI tool get_script_logs
const _logBuffer = [];
const LOG_BUFFER_MAX = 500;

/**
 * Attach a WebSocketServer to an existing http.Server.
 * Clients connect to /she/ws. Once connected they receive:
 *   - { type: 'log', line: string }  — every pino log line
 *   - { type: 'ping' }               — keepalive every 30 s
 *
 * @param {import('http').Server} httpServer
 * @param {(req: import('http').IncomingMessage) => boolean} [authCheck]
 *   Optional function that receives the upgrade request and returns true if
 *   the connection should be allowed. Defaults to always-allow.
 */
function attachWss(httpServer, authCheck = () => true) {
    _wss = new WebSocketServer({ server: httpServer, path: '/she/ws' });

    _wss.on('connection', (ws, req) => {
        if (!authCheck(req)) {
            ws.close(1008, 'Unauthorized');
            return;
        }
        _clients.add(ws);
        ws.on('close', () => _clients.delete(ws));
        ws.on('error', () => _clients.delete(ws));
        // Send current state to this new client immediately
        for (const provider of _welcomeProviders) {
            const msgs = provider();
            if (!msgs) continue;
            for (const msg of (Array.isArray(msgs) ? msgs : [msgs])) {
                ws.send(JSON.stringify(msg));
            }
        }
    });

    // Keepalive ping every 30 s
    const pingInterval = setInterval(() => {
        const msg = JSON.stringify({ type: 'ping' });
        for (const ws of _clients) {
            if (ws.readyState === ws.OPEN) ws.send(msg);
        }
    }, 30_000);

    _wss.on('close', () => clearInterval(pingInterval));
}

/**
 * Broadcast an arbitrary JSON message to all connected WebSocket clients.
 * @param {object} msg - must be JSON-serialisable
 */
function broadcast(msg) {
    if (_clients.size === 0) return;
    const str = JSON.stringify(msg);
    for (const ws of _clients) {
        if (ws.readyState === ws.OPEN) ws.send(str);
    }
}

/**
 * Broadcast a structured log entry to all connected WebSocket clients.
 * Also stores the entry in the in-memory ring buffer.
 * @param {{ level: string, msg: string, ts: number }} entry
 */
function broadcastLog(entry) {
    _logBuffer.push(entry);
    if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
    broadcast({ type: 'log', ...entry });
}

/**
 * Return a snapshot of recent log entries (newest last).
 * @returns {{ level: string, msg: string, ts: number }[]}
 */
function getLogBuffer() {
    return _logBuffer.slice();
}

/**
 * Close the WebSocket server.
 * @returns {Promise<void>}
 */
function closeWss() {
    return new Promise((resolve) => {
        if (_wss) {
            _wss.close(resolve);
            _wss = null;
        } else {
            resolve();
        }
    });
}

module.exports = { attachWss, broadcast, broadcastLog, closeWss, getLogBuffer, setWelcomeProvider };
