'use strict';

/**
 * The worker side of the AI chat's run_analysis tool (roadmap I42, decision D-9). It runs the model's code as the
 * body of an async function in a vm context that holds only `data`, `console` and the JavaScript built-ins —
 * no require, no process, no network. Every `data.*` call is a message to the main thread, which answers from the
 * daemon's loaders; the main thread kills the worker when the time is up.
 */

const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');

const MAX_LOG_LINES = 50;
const logs = [];
let nextId = 1;
const pending = new Map();

function call(name, args) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        parentPort.postMessage({ type: 'call', id, name, args });
    });
}

parentPort.on('message', (m) => {
    if (m && m.type === 'reply') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
    }
});

const fmt = (args) =>
    args
        .map((a) => {
            if (typeof a === 'string') return a;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
const sandboxConsole = {
    log: (...a) => logs.length < MAX_LOG_LINES && logs.push(fmt(a)),
    info: (...a) => logs.length < MAX_LOG_LINES && logs.push(fmt(a)),
    warn: (...a) => logs.length < MAX_LOG_LINES && logs.push('warn: ' + fmt(a)),
    error: (...a) => logs.length < MAX_LOG_LINES && logs.push('error: ' + fmt(a)),
};

const data = Object.freeze({
    topics: (filter = '') => call('topics', [filter]),
    history: (topics, from, to) => call('history', [topics, from, to]),
    messages: (topics, from, to, limit) => call('messages', [topics, from, to, limit]),
    log: (filter = '', from, to, level, limit) => call('log', [filter, from, to, level, limit]),
    script: (path) => call('script', [path]),
    time: (str) => call('time', [str]),
    from: workerData.from,
    to: workerData.to,
});

const context = vm.createContext({ data, console: sandboxConsole });

(async () => {
    let value;
    try {
        const script = new vm.Script('(async () => {\n' + String(workerData.code) + '\n})()', { filename: 'analysis.js' });
        value = await script.runInContext(context, { timeout: workerData.timeoutMs });
    } catch (e) {
        parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e), logs });
        return;
    }
    let json;
    try {
        json = JSON.stringify(value === undefined ? null : value);
    } catch (e) {
        parentPort.postMessage({ type: 'error', message: 'the result is not JSON-serialisable: ' + e.message, logs });
        return;
    }
    parentPort.postMessage({ type: 'done', json, logs });
})();
