import { getToken } from './api.js';

export interface LogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    ts: number;
}

type LogHandler = (entry: LogEntry) => void;

let _ws: WebSocket | null = null;
const _handlers = new Set<LogHandler>();
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/she/ws`;
}

function connect() {
    if (_ws) return;
    const url = wsUrl();
    // Append token as query param (WS handshake doesn't support custom headers in browsers)
    const tok = getToken();
    _ws = new WebSocket(tok ? `${url}?token=${encodeURIComponent(tok)}` : url);

    _ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'log') {
                const entry: LogEntry = { level: msg.level, msg: msg.msg, ts: msg.ts };
                _handlers.forEach((h) => h(entry));
            }
        } catch {
            // ignore malformed frames
        }
    };

    _ws.onclose = () => {
        _ws = null;
        if (_handlers.size > 0) {
            _reconnectTimer = setTimeout(connect, 3000);
        }
    };

    _ws.onerror = () => {
        _ws?.close();
    };
}

function disconnect() {
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _ws?.close();
    _ws = null;
}

export function subscribeLog(handler: LogHandler) {
    _handlers.add(handler);
    if (_handlers.size === 1) connect();
    return () => {
        _handlers.delete(handler);
        if (_handlers.size === 0) disconnect();
    };
}
