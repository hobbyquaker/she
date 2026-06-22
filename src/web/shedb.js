'use strict';

/**
 * sheDB integration module.
 *
 * Wraps SheDBCore and provides:
 *   - MQTT command topic handling (she/db/set/#, extend/#, delete/#, prop/#, get/#)
 *   - WebSocket broadcast of document/view change events
 *   - Listener registry for she.db.sub() sandbox subscriptions
 */

const SheDBCore = require('../lib/shedb-core');
const mqttWildcard = require('../lib/mqtt-wildcards');

let _core = null;
let _mqtt = null;
let _mqttName = '';
let _dbPublish = false;
let _dbRetain = false;
let _dbPrefix = 'she/db/';
let _broadcast = () => {};

/** Registry for she.db.sub() sandbox subscriptions */
const _listeners = []; // { pattern: string, callback: Function, _script: string }

/**
 * Initialise sheDB.
 *
 * @param {object} opts
 * @param {string}   opts.dbPath    - absolute path to the JSON data file
 * @param {boolean}  opts.dbRetain  - whether to publish docs/views as retained MQTT messages
 * @param {string}   opts.mqttName  - mqtt client name / topic prefix (config.name)
 * @param {object}   opts.mqtt      - connected mqtt.js client (may be null if offline)
 * @param {object}   opts.log       - pino-compatible logger
 * @param {Function} opts.broadcast - function(msg) to push a message to all WS clients
 * @returns {SheDBCore}
 */
function init({ dbPath, dbPublish, dbRetain, dbPrefix, mqttName, mqtt, log, broadcast }) {
    _mqtt = mqtt;
    _mqttName = mqttName;
    _dbPublish = dbPublish;
    _dbRetain = dbRetain;
    _dbPrefix = dbPrefix && dbPrefix.endsWith('/') ? dbPrefix : (dbPrefix || 'she/db/') + '/';
    _broadcast = broadcast;

    _core = new SheDBCore({ dbPath, log });

    _core.on('ready', () => {
        log.info('shedb ready, ' + Object.keys(_core.docs).length + ' docs, ' + Object.keys(_core.queries).length + ' views');
        _broadcast({ type: 'db:ids', ids: Object.keys(_core.docs).sort() });
        _broadcast({ type: 'db:viewIds', ids: Object.keys(_core.queries).sort() });
    });

    _core.on('update', (id, doc) => {
        _broadcast({ type: 'db:change', id, doc: doc || null });
        _broadcast({ type: 'db:ids', ids: Object.keys(_core.docs).sort() });

        if (_dbPublish && _mqtt) {
            _mqtt.publish(_dbPrefix + 'doc/' + id, doc ? JSON.stringify(doc) : '', { retain: _dbRetain });
        }

        // Fire sandbox she.db.sub() listeners
        for (const sub of _listeners) {
            if (mqttWildcard(id, sub.pattern) !== null) {
                try {
                    sub.callback(id, doc || null);
                } catch {
                    /* errors are caught by the script domain wrapper */
                }
            }
        }
    });

    _core.on('view', (id, view) => {
        _broadcast({ type: 'db:viewUpdate', id });
        _broadcast({ type: 'db:viewIds', ids: Object.keys(_core.queries).sort() });

        // Per-view MQTT publish (independent of global dbPublish setting)
        const query = _core.queries[id];
        if (query && query.mqttpub && _mqtt && view && !view.error) {
            _mqtt.publish(_dbPrefix + 'view/' + id, JSON.stringify(view.result ?? []), { retain: query.retain === true });
        }
    });

    // When a view definition is saved, immediately publish the existing cached
    // result if mqttpub is enabled. This covers the case where the user enables
    // mqttpub on an already-computed view: the worker re-runs and finds an
    // identical result, so the 'view' event is suppressed by the deepEqual
    // check — without this handler nothing would be published until the next
    // document change triggers a view recomputation.
    _core.on('query', (id) => {
        const query = _core.queries[id];
        if (query && query.mqttpub && _mqtt) {
            const view = _core.views[id];
            if (view && !view.error) {
                _mqtt.publish(_dbPrefix + 'view/' + id, JSON.stringify(view.result ?? []), { retain: query.retain === true });
            }
        }
    });

    return _core;
}

/**
 * Route an incoming MQTT message to sheDB if it matches the db topic prefix.
 * Called from the main mqtt.on('message') handler.
 *
 * @param {string} topic
 * @param {Buffer} payload
 * @returns {boolean} true if the message was handled by sheDB
 */
function handleMqttMessage(topic, payload) {
    if (!_core) return false;

    const prefix = _dbPrefix;
    if (!topic.startsWith(prefix)) return false;

    const rest = topic.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return false;

    const cmd = rest.slice(0, slash);
    const id = rest.slice(slash + 1);
    const str = payload.toString();

    switch (cmd) {
        case 'set':
            try {
                _core.set(id, JSON.parse(str));
            } catch {
                /* ignore malformed payload */
            }
            break;
        case 'extend':
            try {
                _core.extend(id, JSON.parse(str));
            } catch {
                /* ignore malformed payload */
            }
            break;
        case 'delete':
            _core.del(id);
            break;
        case 'prop':
            try {
                _core.prop(id, JSON.parse(str));
            } catch {
                /* ignore malformed payload */
            }
            break;
        case 'get':
            if (_mqtt) {
                const doc = _core.get(id);
                _mqtt.publish(_dbPrefix + 'result/' + id, doc ? JSON.stringify(doc) : '');
            }
            break;
        default:
            return false;
    }
    return true;
}

/** Register a she.db.sub() listener. */
function addListener(pattern, callback, scriptName) {
    _listeners.push({ pattern, callback, _script: scriptName });
}

/** Remove all listeners registered by a script (called on hot-reload / unload). */
function removeListenersByScript(scriptName) {
    for (let i = _listeners.length - 1; i >= 0; i--) {
        if (_listeners[i]._script === scriptName) _listeners.splice(i, 1);
    }
}

/** Return the live core instance (used by shedb-api.js). */
function getCore() {
    return _core;
}

module.exports = { init, handleMqttMessage, addListener, removeListenersByScript, getCore };
