'use strict';

/**
 * SheDB view worker — runs in a worker_threads Worker.
 * Executes map/reduce view scripts for all named queries against
 * a snapshot of the document store received from the main thread.
 *
 * Message protocol:
 *   Main → Worker:
 *     { type: 'db',       docs: {...} }              full docs snapshot
 *     { type: 'query',    id, payload: {filter?,map,reduce?} }
 *     { type: 'delQuery', id }
 *
 *   Worker → Main:
 *     { type: 'view', id, result: [...] }            successful result
 *     { type: 'view', id, error: string }            runtime/compile error
 *     { type: 'view', id, deleted: true }            query was removed
 */

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const mqttWildcard = require('./mqtt-wildcards');

const TIMEOUT = (workerData && workerData.scriptTimeout) || 5000;

let docs = {};
const queries = {};
let queue = [];
let running = false;

// ---------------------------------------------------------------------------
// Helpers (inlined — worker has no access to main-thread closures)
// ---------------------------------------------------------------------------

function getProp(obj, propPath) {
    if (obj == null || !propPath) return undefined;
    return propPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

// ---------------------------------------------------------------------------
// View queue
// ---------------------------------------------------------------------------

function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    if (!running) scheduleNext();
}

function scheduleNext() {
    if (queue.length === 0) {
        running = false;
        return;
    }
    running = true;
    const id = queue.shift();
    setImmediate(() => buildAndRun(id));
}

function buildAndRun(id) {
    const q = queries[id];
    if (!q) {
        scheduleNext();
        return;
    }

    const { filter, map, reduce } = q;

    // Build script source — same structure as the original in-process approach
    let src = `api.map = function() {\n${map}\n};\napi._result = [];\n`;
    if (filter) {
        src += `api.forEachDocument(docId => { if (api.mqttWildcard(docId, ${JSON.stringify(filter)})) api.map.apply(api.getDocument(docId)); });\n`;
    } else {
        src += `api.forEachDocument(docId => { api.map.apply(api.getDocument(docId)); });\n`;
    }
    if (reduce) {
        src += `api.reduce = function(result) {\n${reduce}\n};\napi._result = api.reduce(api._result);\n`;
    }

    // Sandbox — uses the local docs snapshot
    const sandbox = {
        api: {
            forEachDocument: (cb) => Object.keys(docs).forEach(cb),
            getDocument: (docId) => docs[docId],
            getProp,
            mqttWildcard,
            _result: [],
        },
    };
    sandbox.emit = (item) => sandbox.api._result.push(item);

    try {
        const script = new vm.Script(src, { filename: 'shedb-view-' + id });
        const ctx = vm.createContext(sandbox);
        script.runInContext(ctx, { timeout: TIMEOUT });
        parentPort.postMessage({ type: 'view', id, result: Array.from(ctx.api._result) });
    } catch (err) {
        parentPort.postMessage({ type: 'view', id, error: 'runtime: ' + err.message });
    }

    scheduleNext();
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

parentPort.on('message', (msg) => {
    switch (msg.type) {
        case 'db':
            docs = msg.docs;
            // Re-run all registered views with the new docs snapshot
            for (const id of Object.keys(queries)) enqueue(id);
            break;

        case 'query':
            queries[msg.id] = msg.payload;
            enqueue(msg.id);
            break;

        case 'delQuery':
            delete queries[msg.id];
            queue = queue.filter((id) => id !== msg.id);
            parentPort.postMessage({ type: 'view', id: msg.id, deleted: true });
            break;
    }
});
