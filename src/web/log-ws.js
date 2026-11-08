'use strict';

const { WebSocketServer } = require('ws');

let _wss = null;
const _clients = new Set();
// A client that stops reading (a tablet asleep with the IDE open) would collect every log line in
// the daemon's memory (roadmap B-12): above this backlog the connection is closed; the browser
// reconnects and gets the ring buffer as welcome.
const MAX_BACKLOG = 1024 * 1024;

function sendOrDrop(ws, str) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BACKLOG) {
        _clients.delete(ws);
        ws.terminate();
        return;
    }
    ws.send(str);
}
const _welcomeProviders = [];
const _clientHandlers = new Map(); // message type → (ws, msg)
const _closeHandlers = new Set(); // (ws) when a client goes away

/**
 * Handle a message a client sends: `{ type, ... }`. One handler per type.
 * @param {string} type
 * @param {(ws: import('ws').WebSocket, msg: object) => void} fn
 */
function onClientMessage(type, fn) {
    _clientHandlers.set(type, fn);
}

/**
 * Called with the socket when a client disconnects — to drop what it subscribed to.
 * @param {(ws: import('ws').WebSocket) => void} fn
 */
function onClientClose(fn) {
    _closeHandlers.add(fn);
}

/**
 * Send a JSON message to one client (dropped when it is gone or not reading).
 * @param {import('ws').WebSocket} ws
 * @param {object} msg
 */
function sendWs(ws, msg) {
    sendOrDrop(ws, JSON.stringify(msg));
}

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
 *   - { type: 'log', level, msg, ts } — every daemon/script log entry
 *   - { type: 'ping' }                — keepalive every 30 s
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
        const gone = () => {
            if (!_clients.delete(ws)) return;
            for (const fn of _closeHandlers) fn(ws);
        };
        ws.on('close', gone);
        ws.on('error', gone);
        // A client may ask for something — a page subscribing to the runtime snapshot: { type, ... }
        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (!msg || typeof msg.type !== 'string') return;
            const handler = _clientHandlers.get(msg.type);
            if (handler) handler(ws, msg);
        });
        // Send current state to this new client immediately
        for (const provider of _welcomeProviders) {
            const msgs = provider();
            if (!msgs) continue;
            for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
                ws.send(JSON.stringify(msg));
            }
        }
    });

    // Keepalive ping every 30 s
    const pingInterval = setInterval(() => {
        const msg = JSON.stringify({ type: 'ping' });
        for (const ws of _clients) sendOrDrop(ws, msg);
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
    for (const ws of _clients) sendOrDrop(ws, str);
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
 * Broadcast a structured broker (mosquitto) log entry to all connected
 * WebSocket clients as { type: 'brokerLog', level, msg, ts }.
 * Also stores the entry in a server-side ring buffer exposed via getBrokerLogBuffer().
 * @param {string} level  Single-letter mosquitto level: D|I|N|W|E
 * @param {string} msg
 * @param {number} ts     Unix ms timestamp
 */
const _brokerLogBuffer = [];
const BROKER_LOG_BUFFER_MAX = 500;

function broadcastBrokerLog(level, msg, ts) {
    _brokerLogBuffer.push({ level, msg, ts });
    if (_brokerLogBuffer.length > BROKER_LOG_BUFFER_MAX) _brokerLogBuffer.shift();
    broadcast({ type: 'brokerLog', level, msg, ts });
}

/**
 * Return a snapshot of recent broker log entries (oldest first).
 * @returns {{ level: string, msg: string, ts: number }[]}
 */
function getBrokerLogBuffer() {
    return _brokerLogBuffer.slice();
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

module.exports = {
    attachWss,
    broadcast,
    broadcastBrokerLog,
    broadcastLog,
    closeWss,
    getBrokerLogBuffer,
    getLogBuffer,
    setWelcomeProvider,
    onClientMessage,
    onClientClose,
    sendWs,
    _internal: { clients: _clients, MAX_BACKLOG },
};
