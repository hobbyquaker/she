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
 * @param {{ level: string, msg: string, ts: number }} entry
 */
function broadcastLog(entry) {
    broadcast({ type: 'log', ...entry });
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

module.exports = { attachWss, broadcast, broadcastLog, closeWss };
