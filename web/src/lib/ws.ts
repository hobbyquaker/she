export interface LogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    ts: number;
}

type LogHandler = (entry: LogEntry) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsHandler = (msg: Record<string, any>) => void;

const LOG_BUFFER_MAX = 2000;
const _logBuffer: LogEntry[] = [];

/** All log entries received since the page was opened (capped at LOG_BUFFER_MAX). */
export function getLogBuffer(): LogEntry[] {
    return _logBuffer.slice();
}

let _ws: WebSocket | null = null;
const _handlers = new Set<LogHandler>();
const _wsHandlers = new Map<string, Set<WsHandler>>();
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function totalSubscribers() {
    let n = _handlers.size;
    for (const s of _wsHandlers.values()) n += s.size;
    return n;
}

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/she/ws`;
}

function connect() {
    if (_ws) return;
    const url = wsUrl();
    const ws = new WebSocket(url);
    _ws = ws;

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'log') {
                const entry: LogEntry = { level: msg.level, msg: msg.msg, ts: msg.ts };
                if (_logBuffer.length >= LOG_BUFFER_MAX) _logBuffer.shift();
                _logBuffer.push(entry);
                _handlers.forEach((h) => h(entry));
            }
            const bucket = _wsHandlers.get(msg.type);
            if (bucket) bucket.forEach((h) => h(msg));
        } catch {
            // ignore malformed frames
        }
    };

    ws.onclose = () => {
        // Only clear _ws if it still points to this socket.
        // A newer socket may have been created already (e.g. a re-subscribe
        // happened before this stale close event fired).
        if (_ws === ws) _ws = null;
        if (totalSubscribers() > 0) {
            _reconnectTimer = setTimeout(connect, 3000);
        }
    };

    ws.onerror = () => {
        ws.close();
    };
}

function disconnect() {
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _ws?.close();
    _ws = null;
}

export function subscribeLog(handler: LogHandler) {
    _handlers.add(handler);
    if (totalSubscribers() === 1) connect();
    return () => {
        _handlers.delete(handler);
        if (totalSubscribers() === 0) disconnect();
    };
}

/**
 * Subscribe to arbitrary WebSocket message types (e.g. 'db:ids', 'db:change').
 * Returns an unsubscribe function.
 */
export function subscribeWs(type: string, handler: WsHandler) {
    if (!_wsHandlers.has(type)) _wsHandlers.set(type, new Set());
    _wsHandlers.get(type)!.add(handler);
    if (totalSubscribers() === 1) connect();
    return () => {
        _wsHandlers.get(type)?.delete(handler);
        if (totalSubscribers() === 0) disconnect();
    };
}
