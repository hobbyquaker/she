'use strict';

const { WebSocketServer } = require('ws');

let _wss = null;
const _clients = new Set();

/**
 * Attach a WebSocketServer to an existing http.Server.
 * Clients connect to /she/ws. Once connected they receive:
 *   - { type: 'log', line: string }  — every pino log line
 *   - { type: 'ping' }               — keepalive every 30 s
 *
 * @param {import('http').Server} httpServer
 */
function attachWss(httpServer) {
    _wss = new WebSocketServer({ server: httpServer, path: '/she/ws' });

    _wss.on('connection', (ws) => {
        _clients.add(ws);
        ws.on('close', () => _clients.delete(ws));
        ws.on('error', () => _clients.delete(ws));
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
 * Broadcast a structured log entry to all connected WebSocket clients.
 * @param {{ level: string, msg: string, ts: number }} entry
 */
function broadcastLog(entry) {
    if (_clients.size === 0) return;
    const msg = JSON.stringify({ type: 'log', ...entry });
    for (const ws of _clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
    }
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

module.exports = { attachWss, broadcastLog, closeWss };
