'use strict';

/**
 * SheDB view worker — runs in a worker_threads Worker.
 * Executes map/reduce view scripts for all named queries against
 * a snapshot of the document store received from the main thread.
 *
 * Message protocol:
 *   Main → Worker:
 *     { type: 'init',  docs: {...} }              full snapshot (startup/respawn only)
 *     { type: 'patch', id, doc }                  single document created/updated
 *     { type: 'del',   id }                       single document deleted
 *     { type: 'query', id, payload: {filter?,map,reduce?} }
 *     { type: 'delQuery', id }
 *
 *   Worker → Main:
 *     { type: 'view', id, result: [...] }            successful result
 *     { type: 'view', id, error: string }            runtime/compile error
 *     { type: 'view', id, deleted: true }            query was removed
 */

const { parentPort, workerData } = require('worker_threads');
const mqttWildcard = require('./mqtt-wildcards');
const { compileView, runView } = require('./shedb-view');

const TIMEOUT = (workerData && workerData.scriptTimeout) || 5000;

let docs = {};
const queries = {};
let queue = new Set();
let running = false;

// Enqueue only the views whose filter matches the changed doc id.
// Views with no filter must always re-run (they iterate all docs).
function enqueueForDoc(docId) {
    for (const [id, q] of Object.entries(queries)) {
        if (!q.filter || mqttWildcard(docId, q.filter)) enqueue(id);
    }
}

// ---------------------------------------------------------------------------
// View queue
// ---------------------------------------------------------------------------

function enqueue(id) {
    queue.add(id);
    if (!running) scheduleNext();
}

function scheduleNext() {
    if (queue.size === 0) {
        running = false;
        return;
    }
    running = true;
    const id = queue.values().next().value;
    queue.delete(id);
    setImmediate(() => buildAndRun(id));
}

function buildAndRun(id) {
    const q = queries[id];
    if (!q) {
        scheduleNext();
        return;
    }

    // runs over the live docs object (updated by patch/del messages)
    try {
        parentPort.postMessage({ type: 'view', id, result: runView(q.script, docs, TIMEOUT) });
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
        case 'init':
            docs = msg.docs;
            // Re-run all registered views with the fresh snapshot
            for (const id of Object.keys(queries)) enqueue(id);
            break;

        case 'patch':
            docs[msg.id] = msg.doc;
            enqueueForDoc(msg.id);
            break;

        case 'del':
            delete docs[msg.id];
            enqueueForDoc(msg.id);
            break;

        case 'query': {
            let script;
            try {
                script = compileView(msg.id, msg.payload);
            } catch (err) {
                parentPort.postMessage({ type: 'view', id: msg.id, error: 'compile: ' + err.message });
                break;
            }
            queries[msg.id] = { ...msg.payload, script };
            enqueue(msg.id);
            break;
        }

        case 'delQuery':
            delete queries[msg.id];
            queue.delete(msg.id);
            parentPort.postMessage({ type: 'view', id: msg.id, deleted: true });
            break;
    }
});
