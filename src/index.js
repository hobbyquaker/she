#!/usr/bin/env node
/* eslint-disable func-names */
/* eslint-disable func-name-matching */
/* eslint-disable camelcase */

/* eslint prefer-rest-params: "warn" */
/* eslint prefer-destructuring: "warn" */

/* eslint n/no-deprecated-api: "warn" */

// Ensure ~/.she/ exists before anything else runs
require('./lib/storage').ensureRoot();

const PinoPretty = require('pino-pretty');
const _pino = require('pino')(
    { level: 'debug' },
    PinoPretty({
        colorize: false,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        sync: true,
    }),
);
// Lazy import — log-ws exports a no-op broadcastLog when the HTTP server is not started.
const { broadcastLog, broadcast } = require('./web/log-ws');
const shedb = require('./web/shedb');
const log = {
    debug: (...args) => {
        _pino.debug(args.join(' '));
        broadcastLog({ level: 'debug', msg: args.join(' '), ts: Date.now() });
    },
    info: (...args) => {
        _pino.info(args.join(' '));
        broadcastLog({ level: 'info', msg: args.join(' '), ts: Date.now() });
    },
    warn: (...args) => {
        _pino.warn(args.join(' '));
        broadcastLog({ level: 'warn', msg: args.join(' '), ts: Date.now() });
    },
    error: (...args) => {
        _pino.error(args.join(' '));
        broadcastLog({ level: 'error', msg: args.join(' '), ts: Date.now() });
    },
    setLevel: (level) => {
        _pino.level = level;
    },
};
const config = require('./config.js');
const pkg = require('../package.json');

/* istanbul ignore next */
log.setLevel(['debug', 'info', 'warn', 'error'].indexOf(config.verbosity) === -1 ? 'info' : config.verbosity);
log.info('she ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

if (typeof config.port !== 'undefined') {
    require('./web/server')
        .startServer(config.port, {
            apiKey: config.apiKey,
            configPath: config.config,
            scriptDir: config.dir || null,
        })
        .then((actualPort) => log.info('http server listening on :' + actualPort))
        .catch((err) => {
            log.error('http server start failed:', err.message);
            process.exit(1);
        });
}

const chokidar = require('chokidar');
const modules = {
    'fs': require('fs'),
    'path': require('path'),
    'vm': require('vm'),
    /* eslint-disable no-restricted-modules */
    'domain': require('domain'),
    'mqtt': require('mqtt'),
    'node-schedule': require('node-schedule'),
    'suncalc': require('suncalc'),
};

const domain = modules.domain;
const vm = modules.vm;
const fs = modules.fs;
const path = modules.path;
const scheduler = modules['node-schedule'];
const suncalc = modules.suncalc;

const StateStore = require('./lib/state-store');
const sandboxModules = [];
const store = new StateStore();
const scripts = {};
const subscriptions = [];
const mqttEventCallbacks = [];
const varSubscriptions = []; // store-based var:: subscriptions { key, handler, _script }

// Per-script resource tracking for hot-reload
const scriptJobs = new Map(); // scriptFile → node-schedule Job[]
const scriptTimers = new Map(); // scriptFile → Set<timer id>

const _global = {};

// Sun scheduling

const SUNCALC_EVENTS = new Set([
    'sunrise',
    'sunriseEnd',
    'goldenHourEnd',
    'solarNoon',
    'goldenHour',
    'sunsetStart',
    'sunset',
    'dusk',
    'nauticalDusk',
    'night',
    'nadir',
    'nightEnd',
    'nauticalDawn',
    'dawn',
]);

const sunEvents = [];
let sunTimes = [{}, /* today */ {}, /* tomorrow */ {}];

function calculateSunTimes() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86400000); // (24 * 60 * 60 * 1000));
    const tomorrow = new Date(today.getTime() + 86400000); // (24 * 60 * 60 * 1000));
    sunTimes = [
        suncalc.getTimes(yesterday, config.latitude, config.longitude),
        suncalc.getTimes(today, config.latitude, config.longitude),
        suncalc.getTimes(tomorrow, config.latitude, config.longitude),
    ];
}

calculateSunTimes();

scheduler.scheduleJob('0 0 * * *', () => {
    // Re-calculate every day
    calculateSunTimes();
    // Schedule events for this day
    sunEvents.forEach((event) => {
        sunScheduleEvent(event);
    });
    log.info('re-scheduled', sunEvents.length, 'sun events');
});

function sunScheduleEvent(obj, shift) {
    // Shift = -1 -> yesterday
    // shift = 0 -> today
    // shift = 1 -> tomorrow
    let event = sunTimes[1 + (shift || 0)][obj.pattern];
    const now = new Date();

    if (event.toString() !== 'Invalid Date') {
        // Event will occur today

        if (obj.options.shift) {
            event = new Date(event.getTime() + (parseFloat(obj.options.shift) || 0) * 1000);
        }

        if (event.getDate() !== now.getDate() && typeof shift === 'undefined') {
            // Event shifted to previous or next day
            sunScheduleEvent(obj, event < now ? 1 : -1);
            return;
        }

        if (now.getTime() - event.getTime() < 1000) {
            // Event is less than 1s in the past or occurs later this day

            if (obj.options.random) {
                event = new Date(event.getTime() + Math.floor((parseFloat(obj.options.random) || 0) * Math.random()) * 1000);
            }

            if (event.getTime() - now.getTime() < 1000) {
                // Event is less than 1s in the future or already in the past
                // (options.random may have shifted us further to the past)
                // call the callback immediately!
                obj.domain.bind(obj.callback)();
            } else {
                // Schedule the event!
                scheduler.scheduleJob(event, obj.domain.bind(obj.callback));
            }
        }
    }
}

// MQTT — only connect when a broker URL is configured
let mqtt = null;
let connected = false;

if (config.url) {
    mqtt = modules.mqtt.connect(config.url, { will: { topic: config.name + '/connected', payload: '0', retain: true } });
    mqtt.publish(config.name + '/connected', '2', { retain: true });

    mqtt.on('connect', () => {
        connected = true;
        log.info('mqtt connected ' + config.url);
        log.debug('mqtt subscribe #');
        mqtt.subscribe('#');
        mqttEventCallbacks.filter((c) => c.event === 'connect').forEach((c) => c.callback());
    });

    mqtt.on('close', () => {
        if (connected) {
            connected = false;
            log.info('mqtt closed ' + config.url);
            mqttEventCallbacks.filter((c) => c.event === 'disconnect').forEach((c) => c.callback());
        }
    });

    /* istanbul ignore next */
    mqtt.on('error', () => {
        log.error('mqtt error ' + config.url);
    });

    mqtt.on('message', (topic, payload, msg) => {
        if (shedb.handleMqttMessage(topic, payload)) return;

        const state = require('./lib/parse-payload')(payload);

        const topicArr = topic.split('/');
        let oldState;

        if (topicArr[0] === config.variablePrefix && topicArr[1] === 'set' && !config.disableVariables) {
            topicArr[1] = 'status';
            topic = topicArr.join('/');
            const varName = topicArr.slice(2).join('/');
            oldState = store.getObject('mqtt::' + topic) || {};
            const ts = new Date().getTime();

            state.ts = ts;

            state.lc = state.val === oldState.val ? oldState.lc : ts;
            store.setObject('mqtt::' + topic, state);
            store.setObject('var::' + varName, state);
            mqtt.publish(topic, JSON.stringify(state), { retain: true });
        } else {
            /* istanbul ignore next */
            if (!state) {
                log.error('invalid state', topic, payload);
                process.exit();
            }
            if (!state.ts) {
                state.ts = new Date().getTime();
            }
            oldState = store.getObject('mqtt::' + topic) || {};
            if (oldState.val !== state.val) {
                state.lc = state.ts;
            }
            store.setObject('mqtt::' + topic, state);
            stateChange(topic, state, oldState, msg);
        }
    });
}

// sheDB — only init when --db-path is given
if (config.dbPath) {
    shedb.init({ dbPath: config.dbPath, dbRetain: config.dbRetain || false, mqttName: config.name, mqtt, log, broadcast });
}

// Redis write-through cache — only init when config.redis.url is given
if (config.redis && config.redis.url) {
    require('./lib/redis')
        .init({ url: config.redis.url, store, log })
        .catch((err) => log.error('redis init failed:', err.message));
}

// InfluxDB — only init when --influx is set
if (config.influx) {
    require('./influx').init(config.influx);
}

// Elasticsearch — only init when --elastic is set
if (config.elastic) {
    require('./elastic').init(config.elastic);
}

// Matter controller — only init when --matter-storage is set
if (config.matterStorage) {
    const { ensureStorageDir } = require('./lib/storage');
    const matterController = require('./matter/controller');
    const matterStoragePath = typeof config.matterStorage === 'string' ? config.matterStorage : ensureStorageDir('matter');
    matterController.init(matterStoragePath, log, broadcast).catch((err) => {
        log.error('matter controller init failed:', err.message);
    });
}

// Start scripts immediately — MQTT retained state will populate the store asynchronously
start();

function stateChange(topic, state, oldState, msg) {
    subscriptions.forEach((subs) => {
        const options = subs.options || {};
        let delay;

        const match = mqttWildcards(topic, subs.topic);

        if (match && typeof options.condition === 'function') {
            if (!options.condition(topic.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), state.val, state, oldState, msg)) {
                return;
            }
        }

        if (match && typeof subs.callback === 'function') {
            if (msg.retain && !options.retain) {
                return;
            }
            if (options.change && state.val === oldState.val) {
                return;
            }

            delay = 0;
            if (options.shift) {
                delay += (parseFloat(options.shift) || 0) * 1000;
            }
            if (options.random) {
                delay += (parseFloat(options.random) || 0) * Math.random() * 1000;
            }

            delay = Math.floor(delay);

            setTimeout(() => {
                /**
                 * @callback subscribeCallback
                 * @param {string} topic - the topic that triggered this callback. +/status/# will be replaced by +//#
                 * @param {mixed} val - the val property of the new state
                 * @param {object} obj - new state - the whole state object (e.g. {"val": true, "ts": 12346345, "lc": 12346345} )
                 * @param {object} objPrev - previous state - the whole state object
                 * @param {object} msg - the mqtt message as received from MQTT.js
                 */
                subs.callback(topic.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), state.val, state, oldState, msg);
            }, delay);
        }
    });
}

const mqttWildcards = require('./lib/mqtt-wildcards');

/**
 * Write a variable to the var:: store namespace, sync mqtt:: for backwards
 * compat, fire mqttsub callbacks, and (mqtt backend) publish retained.
 * @param {string} name - bare variable name (e.g. 'testvar1')
 * @param {*}      val
 */
function setVariable(name, val) {
    const storeKey = 'var::' + name;
    const mqttTopic = config.variablePrefix + '/status/' + name;
    const oldState = store.getObject(storeKey) || {};
    const ts = new Date().getTime();

    let newState;
    if (typeof val === 'object' && val !== null && 'val' in val) {
        newState = { val: val.val, ts: val.ts || ts };
        newState.lc = newState.val !== oldState.val ? newState.ts : (oldState.lc || newState.ts);
    } else {
        newState = { val, ts };
        newState.lc = val !== oldState.val ? ts : (oldState.lc || ts);
    }

    const changed = newState.val !== oldState.val;
    store.setObject(storeKey, newState);              // primary: fires 'change' → she.on() callbacks
    store.setObject('mqtt::' + mqttTopic, newState);  // compat: so mqttsub('var//name') still works
    stateChange(mqttTopic, newState, oldState, {});   // fires mqttsub callbacks

    const backend = (config.variables && config.variables.backend) || 'mqtt';
    if (backend === 'mqtt' && mqtt && connected && changed) {
        mqtt.publish(mqttTopic, JSON.stringify(newState), { retain: true });
    }
}

function createScript(source, name) {
    log.debug(name, 'compiling');
    try {
        return new vm.Script(source, { filename: name });
    } catch (err) {
        log.error(name, err.name + ':', err.message);
        return false;
    }
}

function runScript(script, name) {
    const scriptDir = path.dirname(path.resolve(name));

    // Initialise per-script resource tracking
    if (!scriptJobs.has(name)) scriptJobs.set(name, []);
    if (!scriptTimers.has(name)) scriptTimers.set(name, new Set());
    const _myJobs = scriptJobs.get(name);
    const _myTimers = scriptTimers.get(name);

    log.debug(name, 'creating domain');
    const scriptDomain = domain.create();

    log.debug(name, 'creating sandbox');

    const she = {
        global: _global,

        /**
         * Log a debug message
         * @method debug
         * @param {...*}
         */
        debug() {
            const args = Array.prototype.slice.call(arguments);
            args.unshift(name + ':');
            log.debug.apply(log, args);
        },
        /**
         * Log an info message
         * @method info
         * @param {...*}
         */
        info() {
            const args = Array.prototype.slice.call(arguments);
            args.unshift(name + ':');
            log.info.apply(log, args);
        },
        /**
         * Log a warning message
         * @method warn
         * @param {...*}
         */
        warn() {
            const args = Array.prototype.slice.call(arguments);
            args.unshift(name + ':');
            log.warn.apply(log, args);
        },
        /**
         * Log an error message
         * @method error
         * @param {...*}
         */
        error() {
            const args = Array.prototype.slice.call(arguments);
            args.unshift(name + ':');
            log.error.apply(log, args);
        },

        /**
         * Subscribe to MQTT topic(s)
         * @method mqttsub
         * @param {(string|string[])} topic - topic or array of topics to subscribe
         * @param {Object|string|function} [options] - Options object or as shorthand to options.condition a function or string
         * @param {number} [options.shift] - delay execution in seconds. Has to be positive
         * @param {number} [options.random] - random delay execution in seconds. Has to be positive
         * @param {boolean} [options.change] - if set to true callback is only called if val changed
         * @param {boolean} [options.retain] - if set to true callback is also called on retained messages
         * @param {(string|function)} [options.condition] - conditional function or condition string
         * @param {subscribeCallback} callback
         */
        mqttsub: function Sandbox_mqttsub(topic, /* optional */ options, callback) {
            if (typeof topic === 'undefined') {
                throw new TypeError('argument topic missing');
            }

            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }

                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                options = arguments[1] || {};

                if (typeof options === 'string' || typeof options === 'function') {
                    options = { condition: options };
                }

                callback = arguments[2];
            } else if (arguments.length > 3) {
                throw new Error('wrong number of arguments');
            }

            if (typeof topic === 'string') {
                topic = topic.replace(/^([^/]+)\/\//, '$1/status/');

                if (typeof options.condition === 'string') {
                    if (options.condition.indexOf('\n') !== -1) {
                        throw new Error('options.condition string must be one-line javascript');
                    }
                    /* eslint-disable no-new-func */
                    options.condition = new Function('topic', 'val', 'obj', 'objPrev', 'msg', 'return ' + options.condition + ';');
                }

                if (typeof options.condition === 'function') {
                    options.condition = scriptDomain.bind(options.condition);
                }

                subscriptions.push({ topic, options, callback: typeof callback === 'function' && scriptDomain.bind(callback), _script: name });

                if (options.retain && store.has('mqtt::' + topic) && typeof callback === 'function') {
                    callback(topic.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), store.get('mqtt::' + topic), store.getObject('mqtt::' + topic));
                } else if (options.retain && (/\/\+\//.test(topic) || /\+$/.test(topic) || /\+/.test(topic) || topic.endsWith('#')) && typeof callback === 'function') {
                    for (const [t, obj] of store.mqttEntries()) {
                        if (mqttWildcards(t, topic)) {
                            callback(t.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), obj.val, obj);
                        }
                    }
                }
            } else if (typeof topic === 'object' && topic.length > 0) {
                topic = Array.prototype.slice.call(topic);
                topic.forEach((tp) => {
                    she.mqttsub(tp, options, callback);
                });
            }
        },

        /**
         * Schedule recurring and one-shot callbacks, including solar events.
         * Pass a suncalc event name (e.g. 'sunrise', 'sunset') as pattern to schedule
         * relative to a solar event; cron strings, Date objects, and node-schedule
         * literals are also accepted.
         * @method schedule
         * @param {string|Date|Object|Array} pattern - Cron string, suncalc event name, Date, node-schedule literal, or an array of any mix.
         * @param {Object} [options]
         * @param {number} [options.random] - random delay in seconds
         * @param {number} [options.shift]  - offset in seconds for solar events (-86400…86400)
         * @param {function} callback - is called with no arguments
         */
        schedule: function Sandbox_schedule(pattern, /* optional */ options, callback) {
            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                options = arguments[1] || {};
                callback = arguments[2];
            } else {
                throw new Error('wrong number of arguments');
            }

            if (typeof pattern === 'object' && pattern.length > 0) {
                pattern = Array.prototype.slice.call(pattern);
                pattern.forEach((pt) => {
                    she.schedule(pt, options, callback);
                });
                return;
            }

            // A string with no spaces is treated as a suncalc event name.
            if (typeof pattern === 'string' && !pattern.includes(' ')) {
                if (!SUNCALC_EVENTS.has(pattern)) {
                    throw new TypeError('unknown suncalc event ' + pattern);
                }
                if (typeof options.shift !== 'undefined' && (options.shift < -86400 || options.shift > 86400)) {
                    throw new Error('options.shift out of range');
                }
                const obj = {
                    pattern,
                    options,
                    callback,
                    context: she,
                    domain: scriptDomain,
                    _script: name,
                };
                sunEvents.push(obj);
                sunScheduleEvent(obj);
                return;
            }

            if (options.random) {
                _myJobs.push(
                    scheduler.scheduleJob(pattern, () => {
                        setTimeout(scriptDomain.bind(callback), (parseFloat(options.random) || 0) * 1000 * Math.random());
                    }),
                );
            } else {
                _myJobs.push(scheduler.scheduleJob(pattern, scriptDomain.bind(callback)));
            }
        },

        /**
         * Publish a MQTT message
         * @method mqttpub
         * @param {(string|string[])} topic - topic or array of topics to publish to
         * @param {(string|Object)} payload - the payload string. If an object is given it will be JSON.stringified
         * @param {Object} [options] - the options to publish with
         * @param {number} [options.qos=0] - QoS Level
         * @param {boolean} [options.retain=false] - retain flag
         */
        mqttpub: function Sandbox_mqttpub(topic, payload, options) {
            if (typeof topic === 'object' && topic.length > 0) {
                topic = Array.prototype.slice.call(topic);
                topic.forEach((tp) => {
                    she.mqttpub(tp, payload, options);
                });
                return;
            }

            topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2');

            if (typeof payload === 'object') {
                payload = JSON.stringify(payload);
            } else {
                payload = String(payload);
            }
            if (!mqtt || !connected) return; // silently drop when MQTT is not connected
            mqtt.publish(topic, payload, options);
        },

        /**
         * Set a value on one or more topics
         * @method setValue
         * @param {(string|string[])} topic - topic or array of topics to set value on
         * @param {mixed} val
         */
        setValue: function Sandbox_setValue(topic, val) {
            if (typeof topic === 'object' && topic.length > 0) {
                topic = Array.prototype.slice.call(topic);
                topic.forEach((tp) => {
                    she.setValue(tp, val);
                });
                return;
            }

            const tmp = topic.split('/');
            if (tmp[0] === config.variablePrefix && !config.disableVariables) {
                // Variable — delegate to setVariable (handles var:: store + MQTT publish)
                const varName = tmp.slice(2).join('/');
                setVariable(varName, val);
            } else if (tmp[0] === config.variablePrefix && config.disableVariables) {
                /* istanbul ignore next */
                tmp[1] = 'status';
                topic = tmp.join('/');
                /* istanbul ignore next */
                if (!store.has('mqtt::' + topic) || store.get('mqtt::' + topic) !== val) {
                    /* istanbul ignore next */
                    tmp[1] = 'set';
                    topic = tmp.join('/');
                    she.mqttpub(topic, val, { retain: false });
                }
            } else {
                topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2');
                she.mqttpub(topic, val, { retain: false });
            }
        },

        /**
         * @method getValue
         * @param {string} topic
         * @returns {mixed} the topics value
         */
        getValue: function Sandbox_getValue(topic) {
            topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/status/$2');
            return store.get('mqtt::' + topic);
        },

        /**
         * Get a specific property of a topic
         * @method getProp
         * @param {string} topic
         * @param {...string} [property] - the property to retrieve. May be repeated for nested properties. If omitted the whole topic object is returned.
         * @returns {mixed} the topics properties value
         * @example // returns the timestamp of a given topic
         * she.getProp('hm//Bewegungsmelder Keller/MOTION', 'ts');
         */
        getProp: function Sandbox_getProp(topic /* , optional property, optional nested property, ... */) {
            topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/status/$2');
            if (arguments.length > 1) {
                let tmp = store.getObject('mqtt::' + topic);
                if (typeof tmp === 'undefined') {
                    return;
                }
                for (let i = 1; i < arguments.length; i++) {
                    if (typeof tmp[arguments[i]] === 'undefined') {
                        return;
                    }
                    tmp = tmp[arguments[i]];
                }
                return tmp;
            }
            return store.getObject('mqtt::' + topic);
        },

        /**
         * Universal read by namespaced key.
         * @method get
         * @param {string} key  Namespaced key, e.g. 'mqtt::home/sensor/temp' or 'var::myVar'
         * @returns {*} current value, or undefined
         */
        get: function Sandbox_she_get(key) {
            if (key.startsWith('var::')) {
                return store.get('var::' + key.slice(5));
            }
            return store.get(key);
        },

        /**
         * Universal read (full state object) by namespaced key.
         * @method getObject
         * @param {string} key
         * @returns {{ val:*, ts:number, lc:number } | undefined}
         */
        getObject: function Sandbox_she_getObject(key) {
            if (key.startsWith('var::')) {
                return store.getObject('var::' + key.slice(5));
            }
            return store.getObject(key);
        },

        /**
         * Universal subscribe by namespaced key.
         * Callback receives (val, obj, prevObj).
         * @method on
         * @param {string} key  Namespaced key: 'mqtt::topic', 'var::name', 'matter::nodeId/ep/Cluster/attr'
         * @param {function} callback
         */
        on: function Sandbox_she_on(key, callback) {
            if (typeof key !== 'string') throw new TypeError('she.on: key must be a string');
            if (typeof callback !== 'function') throw new TypeError('she.on: callback must be a function');

            if (key.startsWith('mqtt::')) {
                she.mqttsub(key.slice(6), { retain: true }, (_topic, val, obj, prevObj) => {
                    callback(val, obj, prevObj);
                });
            } else if (key.startsWith('var::')) {
                const varStoreKey = 'var::' + key.slice(5);
                const boundCb = scriptDomain.bind(callback);
                const varHandler = (changedKey, val, obj, prevObj) => {
                    if (changedKey === varStoreKey) boundCb(val, obj, prevObj);
                };
                store.on('change', varHandler);
                varSubscriptions.push({ key: varStoreKey, handler: varHandler, _script: name });
                // Fire immediately if var already has a value (retain semantics)
                const currentVarObj = store.getObject(varStoreKey);
                if (currentVarObj !== undefined) boundCb(currentVarObj.val, currentVarObj, undefined);
            } else if (key.startsWith('matter::')) {
                const parts = key.slice(8).split('/');
                if (parts.length !== 4) throw new TypeError('she.on: invalid matter key (expected matter::nodeId/ep/Cluster/attr)');
                const [nodeId, endpointId, clusterName, attrName] = parts;
                if (!she.matter) throw new Error('she.on: Matter not configured');
                she.matter.sub(Number(nodeId), Number(endpointId), clusterName, attrName, callback);
            } else {
                throw new TypeError('she.on: unknown namespace in key: ' + key);
            }
        },

        /**
         * Universal write by namespaced key.
         * @method set
         * @param {string} key  Namespaced key: 'mqtt::topic', 'var::name'
         * @param {*} val
         */
        set: function Sandbox_she_set(key, val) {
            if (typeof key !== 'string') throw new TypeError('she.set: key must be a string');

            if (key.startsWith('mqtt::')) {
                she.mqttpub(key.slice(6), val);
            } else if (key.startsWith('var::')) {
                setVariable(key.slice(5), val);
            } else if (key.startsWith('matter::')) {
                throw new Error('she.set: matter:: write not yet implemented');
            } else {
                throw new TypeError('she.set: unknown namespace in key: ' + key);
            }
        },

        /** @internal Register a callback for MQTT connection lifecycle events. */
        _registerMqttEvent: function Sandbox_she_registerMqttEvent(event, callback) {
            if (event !== 'connect' && event !== 'disconnect') {
                throw new TypeError('she.mqtt.on: unknown event "' + event + '" — use "connect" or "disconnect"');
            }
            mqttEventCallbacks.push({ event, callback: scriptDomain.bind(callback), _script: name });
        },
    };

    // she.log is an alias for she.info
    she.log = she.info;

    const Sandbox = {
        setTimeout: (fn, delay, ...args) => {
            const id = setTimeout(fn, delay, ...args);
            _myTimers.add(id);
            return id;
        },
        setInterval: (fn, delay, ...args) => {
            const id = setInterval(fn, delay, ...args);
            _myTimers.add(id);
            return id;
        },
        clearTimeout: (id) => {
            _myTimers.delete(id);
            clearTimeout(id);
        },
        clearInterval: (id) => {
            _myTimers.delete(id);
            clearInterval(id);
        },

        Buffer,

        require(md) {
            if (modules[md]) {
                return modules[md];
            }
            try {
                let tmp;
                if (md.match(/^\.\//) || md.match(/^\.\.\//)) {
                    tmp = './' + path.relative(__dirname, path.join(scriptDir, md));
                } else {
                    tmp = md;
                    if (fs.existsSync(path.join(scriptDir, 'node_modules', md, 'package.json'))) {
                        tmp = path.join(scriptDir, 'node_modules', md);
                    }
                }
                she.debug('require', tmp);
                modules[md] = require(tmp);
                return modules[md];
            } catch (err) {
                const lines = err.stack.split('\n');
                const stack = [];
                lines.forEach((line) => {
                    if (!line.match(/module\.js:/)) {
                        stack.push(line);
                    }
                });
                log.error(name + ': ' + stack);
            }
        },

        console: {
            log: (...args) => she.info(...args),
            error: (...args) => she.error(...args),
        },

        she,
    };

    const scriptName = path.basename(name, path.extname(name));
    sandboxModules.forEach((md) => {
        md(she, { scriptDomain, scriptName });
    });

    log.debug(name, 'contextifying sandbox');
    const context = vm.createContext(Sandbox);

    scriptDomain.on('error', (e) => {
        /* istanbul ignore if */
        if (!e.stack) {
            log.error(name + ' unknown exception');
            return;
        }
        const lines = e.stack.split('\n');
        const stack = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/at ContextifyScript\.Script\.runInContext|at Script\.runInContext/)) {
                break;
            }
            stack.push(lines[i]);
        }

        log.error(name + ' ' + e.name + ': ' + e.message + '\n' + stack.join('\n'));
    });

    scriptDomain.run(() => {
        log.debug(name, 'running');
        script.runInContext(context);
    });
}

function loadScript(file) {
    file = file.replace(/\\/g, '/');
    /* istanbul ignore if */
    if (scripts[file]) {
        log.error(file, 'already loaded?!');
        return;
    }

    log.info(file, 'loading');
    fs.readFile(file, (err, src) => {
        /* istanbul ignore if */
        if (err && err.code === 'ENOENT') {
            log.error(file, 'not found');
        } else if (err) {
            /* istanbul ignore next */
            log.error(file, err);
        } else {
            if (file.match(/\.js$/)) {
                // Javascript
                scripts[file] = createScript(src, file);
            }
            if (scripts[file]) {
                runScript(scripts[file], file);
            }
        }
    });
}

function unloadScript(file) {
    file = file.replace(/\\/g, '/');
    log.info(file, 'unloading');

    // Remove MQTT subscriptions belonging to this script
    for (let i = subscriptions.length - 1; i >= 0; i--) {
        if (subscriptions[i]._script === file) subscriptions.splice(i, 1);
    }

    // Remove MQTT event callbacks (connect/disconnect) belonging to this script
    for (let i = mqttEventCallbacks.length - 1; i >= 0; i--) {
        if (mqttEventCallbacks[i]._script === file) mqttEventCallbacks.splice(i, 1);
    }

    // Cancel all node-schedule jobs for this script
    const jobs = scriptJobs.get(file);
    if (jobs) {
        jobs.forEach((job) => job && job.cancel());
        scriptJobs.delete(file);
    }

    // Remove sun events belonging to this script
    for (let i = sunEvents.length - 1; i >= 0; i--) {
        if (sunEvents[i]._script === file) sunEvents.splice(i, 1);
    }

    // Clear all tracked timers for this script
    const timers = scriptTimers.get(file);
    if (timers) {
        timers.forEach((id) => clearTimeout(id));
        scriptTimers.delete(file);
    }

    // Remove store-based var:: subscriptions belonging to this script
    for (let i = varSubscriptions.length - 1; i >= 0; i--) {
        if (varSubscriptions[i]._script === file) {
            store.removeListener('change', varSubscriptions[i].handler);
            varSubscriptions.splice(i, 1);
        }
    }

    // Remove shedb listeners belonging to this script
    const shedbSandbox = require('./sandbox/shedb-sandbox');
    shedbSandbox.cleanup(file);

    // Remove matter subscriptions belonging to this script
    if (config.matterStorage) {
        const matterSandbox = require('./sandbox/matter-sandbox');
        matterSandbox.cleanup(file);
    }

    // Remove from scripts map so it can be re-loaded
    delete scripts[file];
}

function loadSandbox(callback) {
    const dir = path.join(__dirname, 'sandbox');
    fs.readdir(dir, (err, data) => {
        /* istanbul ignore if */
        if (err) {
            if (err.errno === 34) {
                log.error('directory ' + path.resolve(dir) + ' not found');
            } else {
                log.error('readdir', dir, err);
            }
        } else {
            data.sort().forEach((file) => {
                if (file.match(/\.js$/)) {
                    sandboxModules.push(require(path.join(dir, file)));
                }
            });

            if (!config.disableWatch) {
                const sandboxWatcher = chokidar.watch(dir, {
                    ignored: (p, stats) => stats?.isFile() && !p.endsWith('.js'),
                    persistent: true,
                    ignoreInitial: true,
                    usePolling: true,
                });
                sandboxWatcher.on('ready', () => log.debug('watch', dir, 'initialized'));
                sandboxWatcher.on('all', (event, filePath) => {
                    sandboxWatcher.close();
                    log.info(filePath, 'sandbox change detected. exiting.');
                    process.exit(0);
                });
            }

            callback();
        }
    });
}

function loadDir(dir) {
    fs.readdir(dir, (err, data) => {
        /* istanbul ignore if */
        if (err) {
            if (err.errno === 34) {
                log.error('directory ' + path.resolve(dir) + ' not found');
            } else {
                log.error('readdir', dir, err);
            }
        } else {
            data.sort().forEach((file) => {
                if (file.match(/\.js$/)) {
                    loadScript(path.join(dir, file));
                }
            });

            if (!config.disableWatch) {
                const dirWatcher = chokidar.watch(dir, {
                    ignored: (p, stats) => stats?.isFile() && !p.endsWith('.js'),
                    persistent: true,
                    ignoreInitial: true,
                    usePolling: true,
                });
                dirWatcher.on('ready', () => log.debug('watch', dir, 'initialized'));
                dirWatcher.on('all', (event, filePath) => {
                    filePath = filePath.replace(/\\/g, '/');
                    if (event === 'change' && filePath.endsWith('.js')) {
                        log.info(filePath, 'change detected. hot-reloading.');
                        unloadScript(filePath);
                        loadScript(filePath);
                    } else if (event === 'add' && filePath.endsWith('.js')) {
                        log.info(filePath, 'added. loading.');
                        loadScript(filePath);
                    } else if (event === 'unlink') {
                        log.info(filePath, 'removed. unloading.');
                        unloadScript(filePath);
                    } else {
                        dirWatcher.close();
                        log.info(filePath, 'change detected. exiting.');
                        process.exit(0);
                    }
                });
            }
        }
    });
}

function start() {
    /* istanbul ignore if */
    if (config.file) {
        if (typeof config.file === 'string') {
            loadScript(config.file);
        } else {
            config.file.forEach((file) => {
                loadScript(file);
            });
        }
    }

    loadSandbox(() => {
        if (config.dir) {
            /* istanbul ignore else */
            if (typeof config.dir === 'string') {
                loadDir(config.dir);
            } else {
                config.dir.forEach((dir) => {
                    loadDir(dir);
                });
            }
        }
    });
}

/* istanbul ignore next */
async function gracefulShutdown(signal) {
    log.info(`got ${signal}. exiting.`);
    if (config.matterStorage) {
        try {
            await require('./matter/controller').close();
        } catch {
            // ignore
        }
    }
    process.exit(0);
}

/* istanbul ignore next */
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
/* istanbul ignore next */
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
