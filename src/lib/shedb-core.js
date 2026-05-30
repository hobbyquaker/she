'use strict';

/**
 * SheDB Core — vendored and simplified from hobbyquaker/mqttDB.
 *
 * Key differences vs. original:
 *   - View execution delegated to a single worker_threads Worker
 *   - No obj-ease dependency: prop utilities inlined below
 *   - No external persistence library: atomic JSON via tmp+rename
 *   - Logging via pino-style `log` object instead of yalm
 *
 * Events emitted:
 *   'ready'           — after initial file load + view compilation
 *   'update' (id, doc|'') — document changed or deleted
 *   'view'   (id, viewObj|'') — view result changed or view deleted
 *   'query'  (id)     — query (view definition) added/changed
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const mqttWildcard = require('./mqtt-wildcards');

// ---------------------------------------------------------------------------
// Inline obj-ease equivalents (dot-notation property helpers)
// ---------------------------------------------------------------------------

function getProp(obj, propPath) {
    if (obj == null || !propPath) return undefined;
    return propPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

function setProp(obj, propPath, val) {
    if (!obj || !propPath) return false;
    const parts = propPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (deepEqual(cur[last], val)) return false;
    cur[last] = val;
    return true;
}

function delProp(obj, propPath) {
    if (!obj || !propPath) return false;
    const parts = propPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') return false;
        cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (typeof cur[last] === 'undefined') return false;
    delete cur[last];
    return true;
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => kb[i] === k && deepEqual(a[k], b[k]));
}

function deepExtend(target, source) {
    let changed = false;
    for (const k of Object.keys(source)) {
        const sv = source[k];
        const tv = target[k];
        if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) && tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
            if (deepExtend(tv, sv)) changed = true;
        } else if (!deepEqual(tv, sv)) {
            target[k] = sv;
            changed = true;
        }
    }
    return changed;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

class SheDBCore extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string}  opts.dbPath        - absolute path to the JSON data file
     * @param {object}  opts.log           - pino-compatible logger
     * @param {number}  [opts.scriptTimeout=5000] - vm script timeout in ms
     */
    constructor({ dbPath, log, scriptTimeout = 5000 }) {
        super();
        this.dbPath = dbPath;
        this.log = log;
        this.scriptTimeout = scriptTimeout;

        /** @type {Object<string,object>} document store */
        this.docs = {};
        /** @type {Object<string,{filter?,map,reduce?}>} persistent view definitions */
        this.queries = {};
        /** @type {Object<string,{_id,_rev,result?,length?,error?}>} computed view results */
        this.views = {};
        /** Global revision counter — increments on every document change */
        this.rev = 0;

        this._viewEnvs = {}; // id → { compileError? } — only syntax-check metadata
        this._saveTimer = null;
        this._sendDbScheduled = false;
        this._worker = null;

        this._spawnWorker();
        this._load();
    }

    // -------------------------------------------------------------------------
    // Persistence — atomic JSON via tmp+rename
    // -------------------------------------------------------------------------

    _load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
            this.rev = data.rev || 0;
            this.docs = data.docs || {};
            this.queries = data.queries || {};
            this.views = data.views || {};
            this.log.info('shedb loaded ' + Object.keys(this.docs).length + ' docs, ' + Object.keys(this.queries).length + ' views from ' + this.dbPath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.warn('shedb: could not load ' + this.dbPath + ': ' + err.message);
            }
        }

        // Syntax-check persisted views and send state to worker
        for (const id of Object.keys(this.queries)) {
            this._syntaxCheck(id, this.queries[id]);
        }
        this._sendInitialState();

        setImmediate(() => this.emit('ready'));
    }

    _save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            const tmp = this.dbPath + '.tmp';
            try {
                fs.writeFileSync(tmp, JSON.stringify({ rev: this.rev, docs: this.docs, queries: this.queries, views: this.views }), 'utf8');
                fs.renameSync(tmp, this.dbPath); // atomic on Linux (same FS)
            } catch (err) {
                this.log.error('shedb: save failed: ' + err.message);
            }
        }, 250);
    }

    // -------------------------------------------------------------------------
    // Rev tracking — mirrors mqttDB pattern exactly
    // -------------------------------------------------------------------------

    _getRev(id) {
        if (this.docs[id] && typeof this.docs[id]._rev !== 'undefined') {
            const rev = this.docs[id]._rev;
            delete this.docs[id]._rev;
            return rev;
        }
        return -1;
    }

    _setRev(id, rev) {
        if (this.docs[id]) this.docs[id]._rev = rev;
    }

    _incRev(id, rev) {
        if (this.docs[id]) this.docs[id]._rev = rev + 1;
    }

    // -------------------------------------------------------------------------
    // Public document API
    // -------------------------------------------------------------------------

    get(id) {
        return this.docs[id];
    }

    /**
     * Set (create or overwrite) a document.
     * @param {string} id
     * @param {object|''} payload - empty string means delete
     * @returns {boolean} true if the document actually changed
     */
    set(id, payload) {
        if (payload === '') return this.del(id) || true;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

        const incoming = Object.assign({}, payload);
        delete incoming._rev;
        delete incoming._id;

        const rev = this._getRev(id);
        const cur = this.docs[id] ? Object.assign({}, this.docs[id]) : undefined;
        if (cur) {
            delete cur._rev;
            delete cur._id;
        }

        if (!deepEqual(cur, incoming)) {
            this.docs[id] = Object.assign({}, incoming, { _id: id });
            this._incRev(id, rev);
            this.rev++;
            this._save();
            this.emit('update', id, this.docs[id]);
            this._sendDb();
            return true;
        }
        this._setRev(id, rev);
        return false;
    }

    /**
     * Deep-merge a partial object into an existing document.
     */
    extend(id, payload) {
        if (!payload || typeof payload !== 'object') return false;
        const clean = Object.assign({}, payload);
        delete clean._id;
        delete clean._rev;

        const rev = this._getRev(id);
        if (!this.docs[id]) this.docs[id] = { _id: id };
        const savedId = this.docs[id]._id;
        delete this.docs[id]._id;

        const changed = deepExtend(this.docs[id], clean);
        this.docs[id]._id = savedId || id;

        if (changed) {
            this._incRev(id, rev);
            this.rev++;
            this._save();
            this.emit('update', id, this.docs[id]);
            this._sendDb();
            return true;
        }
        this._setRev(id, rev);
        return false;
    }

    del(id) {
        delete this.docs[id];
        this.rev++;
        this._save();
        this.emit('update', id, '');
        this._sendDb();
    }

    /**
     * Set/create/del a nested property on a document.
     * @param {string} id
     * @param {{method:'set'|'create'|'del', prop:string, val?:*}} opts
     */
    prop(id, { method, prop, val } = {}) {
        if (!this.docs[id] || !prop) return false;

        const rev = this._getRev(id);
        let changed = false;

        if (method === 'set') {
            changed = setProp(this.docs[id], prop, val);
        } else if (method === 'create') {
            if (typeof getProp(this.docs[id], prop) === 'undefined') {
                setProp(this.docs[id], prop, val);
                changed = true;
            }
        } else if (method === 'del') {
            changed = delProp(this.docs[id], prop);
        }

        if (changed) {
            this.docs[id]._id = id;
            this._incRev(id, rev);
            this.rev++;
            this._save();
            this.emit('update', id, this.docs[id]);
            this._sendDb();
            return true;
        }
        this._setRev(id, rev);
        return false;
    }

    // -------------------------------------------------------------------------
    // Named views (persistent map/reduce queries)
    // -------------------------------------------------------------------------

    /**
     * Create/update or delete a named view.
     * @param {string} id - view name
     * @param {''|{filter?:string, map:string, reduce?:string}} payload - '' to delete
     */
    query(id, payload) {
        if (payload === '') {
            delete this.queries[id];
            delete this._viewEnvs[id];
            delete this.views[id];
            this._save();
            if (this._worker) this._worker.postMessage({ type: 'delQuery', id });
            this.emit('view', id, '');
            return;
        }
        this.queries[id] = payload;
        // Fast in-process syntax check — report compile errors immediately
        if (!this._syntaxCheck(id, payload)) return;
        if (this._worker) this._worker.postMessage({ type: 'query', id, payload });
        this._save();
        this.emit('query', id);
    }

    // -------------------------------------------------------------------------
    // Ad-hoc (non-persistent) query — synchronous, no vm
    // Map fn signature: (doc, emit) where emit(item) pushes to result
    // -------------------------------------------------------------------------

    adhocQuery(filter, mapFn, reduceFn) {
        const result = [];
        const emit = (item) => result.push(item);
        for (const id of Object.keys(this.docs)) {
            if (filter && !mqttWildcard(id, filter)) continue;
            try {
                mapFn(this.docs[id], emit);
            } catch {
                /* ignore per-doc map errors */
            }
        }
        return typeof reduceFn === 'function' ? reduceFn(result) : result;
    }

    // -------------------------------------------------------------------------
    // Worker thread management
    // -------------------------------------------------------------------------

    _spawnWorker() {
        this._worker = new Worker(path.join(__dirname, 'shedb-worker.js'), {
            workerData: { scriptTimeout: this.scriptTimeout },
        });

        this._worker.on('message', (msg) => {
            if (msg.type !== 'view') return;
            const { id } = msg;

            if (msg.deleted) return; // deletion already handled in query()

            const prev = this.views[id] || { _id: id, _rev: -1 };

            if (msg.error) {
                this.views[id] = { _id: id, _rev: prev._rev ?? -1, error: msg.error };
                delete this.views[id].result;
                this.log.error('shedb view ' + id + ': ' + msg.error);
                this.emit('view', id, this.views[id]);
                this._save();
                return;
            }

            if (!deepEqual(msg.result, prev.result)) {
                this.views[id] = { _id: id, _rev: (prev._rev ?? -1) + 1, result: msg.result, length: msg.result.length };
                delete this.views[id].error;
                this.emit('view', id, this.views[id]);
                this._save();
            }
        });

        this._worker.on('error', (err) => {
            this.log.error('shedb worker error: ' + err.message);
        });

        this._worker.on('exit', (code) => {
            this._worker = null;
            if (code !== 0) {
                this.log.error('shedb worker exited with code ' + code + ', restarting in 1s');
                setTimeout(() => {
                    this._spawnWorker();
                    this._sendInitialState();
                }, 1000);
            }
        });
    }

    /** Send full docs snapshot to the worker (debounced via setImmediate). */
    _sendDb() {
        if (this._sendDbScheduled) return;
        this._sendDbScheduled = true;
        setImmediate(() => {
            this._sendDbScheduled = false;
            if (this._worker) {
                this._worker.postMessage({ type: 'db', docs: structuredClone(this.docs) });
            }
        });
    }

    /** Send full state (docs + all queries) to the worker — used on init and respawn. */
    _sendInitialState() {
        if (!this._worker) return;
        this._worker.postMessage({ type: 'db', docs: structuredClone(this.docs) });
        for (const id of Object.keys(this.queries)) {
            this._worker.postMessage({ type: 'query', id, payload: this.queries[id] });
        }
    }

    // -------------------------------------------------------------------------
    // Syntax check — fast in-process compile, no execution
    // -------------------------------------------------------------------------

    _syntaxCheck(id, { filter, map, reduce }) {
        if (!this._viewEnvs[id]) this._viewEnvs[id] = {};
        const env = this._viewEnvs[id];

        let src = `api.map = function() {\n${map}\n};\napi._result = [];\n`;
        if (filter) {
            src += `api.forEachDocument(docId => { if (api.mqttWildcard(docId, ${JSON.stringify(filter)})) api.map.apply(api.getDocument(docId)); });\n`;
        } else {
            src += `api.forEachDocument(docId => { api.map.apply(api.getDocument(docId)); });\n`;
        }
        if (reduce) {
            src += `api.reduce = function(result) {\n${reduce}\n};\napi._result = api.reduce(api._result);\n`;
        }

        try {
            new vm.Script(src, { filename: 'shedb-view-' + id });
            delete env.compileError;
            return true;
        } catch (err) {
            env.compileError = 'compile: ' + err.message;
            this.log.error('shedb view ' + id + ': ' + env.compileError);
            const rev = (this.views[id]?._rev ?? -1) + 1;
            this.views[id] = { _id: id, _rev: rev, error: env.compileError };
            this.emit('view', id, this.views[id]);
            return false;
        }
    }
}

module.exports = SheDBCore;
