#!/usr/bin/env node
/* eslint-disable func-names */
/* eslint-disable func-name-matching */
/* eslint-disable camelcase */

/* eslint prefer-rest-params: "warn" */
/* eslint prefer-destructuring: "warn" */

/* eslint n/no-deprecated-api: "warn" */

// Handle --install before initialising anything else (must run before ensureRoot so
// we don't create ~/.she dirs under root when invoked with sudo)
if (process.argv.includes('--install')) {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        console.error('error: she --install must be run as root (sudo she --install)');
        process.exit(1);
    }
    const { execFileSync } = require('child_process');
    const _installScript = require('path').join(__dirname, '..', 'service', 'install.sh');
    try {
        execFileSync('bash', [_installScript], { stdio: 'inherit' });
    } catch (e) {
        process.exit(e.status || 1);
    }
    process.exit(0);
}

// Ensure ~/.she/ exists before anything else runs
require('./lib/storage').ensureRoot();

const PinoPretty = require('pino-pretty');
const _pino = require('pino')(
    { level: 'debug' },
    PinoPretty({
        colorize: true,
        ignore: 'pid,hostname,time,level',
        sync: true,
    }),
);
// Lazy import â€” log-ws exports a no-op broadcastLog when the HTTP server is not started.
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

log.setLevel(['debug', 'info', 'warn', 'error'].indexOf(config.verbosity) === -1 ? 'info' : config.verbosity);
log.info('she ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

if (typeof config.port !== 'undefined') {
    // Validate: password mode requires a password hash
    if (config.auth === 'password' && !config.password) {
        log.error('auth is set to "password" but no password is configured. Set a password via the web UI Config â†’ Authentication section first.');
        process.exit(1);
    }
    require('./web/server')
        .startServer(config.port, {
            auth: config.auth,
            password: config.password || null,
            proxyHeader: config.proxyHeader,
            bindAddress: config.bindAddress,
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
    /* eslint-disable no-restricted-modules, n/no-deprecated-api */
    'domain': require('domain'),
    'mqtt': require('mqtt'),
    'node-schedule': require('node-schedule'),
    'suncalc': require('suncalc'),
};

// Require function anchored at ~/.she/ so user-installed npm packages
// in ~/.she/node_modules/ are resolved by sandbox scripts.
const Module = require('module');
const { STORAGE_ROOT } = require('./lib/storage');
const _userRequire = Module.createRequire(modules.path.join(STORAGE_ROOT, '_anchor.js'));

const { domain, vm, fs, path, suncalc } = modules;
const scheduler = modules['node-schedule'];

const StateStore = require('./lib/state-store');
const sandboxModules = [];
const store = new StateStore();
const scripts = {};
const scriptOrigins = new Map(); // file â†’ 'builtin' | 'user'
const subscriptions = [];
const mqttEventCallbacks = [];
const varSubscriptions = []; // store-based var:: subscriptions { key, handler, _script }

// Per-script resource tracking for hot-reload
const scriptJobs = new Map(); // scriptFile â†’ node-schedule Job[]
const scriptTimers = new Map(); // scriptFile â†’ Set<timer id>

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
                // Schedule the event and track the job so it can be cancelled on script unload
                obj._job = scheduler.scheduleJob(event, obj.domain.bind(obj.callback));
            }
        }
    }
}

// MQTT â€” only connect when a broker URL is configured
let mqtt = null;
let connected = false;

// Wire up the MQTT API: pass the state store and a getter for the live MQTT client.
// The getter always returns the current value of `mqtt` (null until connected).
require('./web/mqtt-api').init(store, () => mqtt);
require('./web/ai-api').init(store);

// MQTT message rate counter â€” reset on each stats poll
let _mqttMsgCount = 0;
let _mqttMsgTs = Date.now();
let _prevCpuUsage = process.cpuUsage();

// Register runtime stats provider for GET /she/status
require('./web/server').setStatsProvider(() => {
    let topics = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of store.mqttEntries()) topics++;
    const now = Date.now();
    const elapsed = (now - _mqttMsgTs) / 1000;
    const mqttMsgPerSec = elapsed > 0 ? Math.round((_mqttMsgCount / elapsed) * 10) / 10 : 0;
    _mqttMsgCount = 0;
    _mqttMsgTs = now;
    const cpuDelta = process.cpuUsage(_prevCpuUsage);
    _prevCpuUsage = process.cpuUsage();
    const cpuPercent = elapsed > 0 ? Math.round(((cpuDelta.user + cpuDelta.system) / 1000 / (elapsed * 1000)) * 1000) / 10 : 0;
    const mem = process.memoryUsage();
    const memMb = Math.round(mem.rss / 1048576);
    const core = shedb.getCore();
    const dbDocs = core ? Object.keys(core.docs).length : null;
    const dbViews = core ? Object.keys(core.queries).length : null;
    let matterNodes = 0;
    let matterEndpoints = 0;
    if (config.matterStorage) {
        try {
            const mc = require('./matter/controller');
            const paired = mc.listPaired();
            matterNodes = paired.length;
            for (const { nodeId } of paired) {
                try {
                    matterEndpoints += mc.getEndpoints(nodeId).length;
                } catch {
                    /* offline */
                }
            }
        } catch {
            /* controller not ready */
        }
    }
    return {
        scripts: Object.keys(scripts).length,
        topics,
        mqttMsgPerSec,
        matterEnabled: !!config.matterStorage,
        matterNodes,
        matterEndpoints,
        dbEnabled: !!config.dbPath,
        dbDocs,
        dbViews,
        handlers: subscriptions.length + varSubscriptions.length + mqttEventCallbacks.length,
        memMb,
        cpuPercent,
    };
});

if (!config.url) {
    log.warn('no MQTT broker URL configured â€” set "url" in ' + path.join(require('os').homedir(), '.she', 'config.json'));
}

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

    mqtt.on('error', () => {
        log.error('mqtt error ' + config.url);
    });

    mqtt.on('message', (topic, payload, msg) => {
        _mqttMsgCount++;
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

// sheDB â€” only init when --db-path is given
if (config.dbPath) {
    const dbPathResolved = config.dbPath.replace(/^~(?=[/\\]|$)/, require('os').homedir());
    shedb.init({
        dbPath: dbPathResolved,
        dbPublish: config.dbPublish || false,
        dbRetain: config.dbRetain || false,
        dbPrefix: config.dbPrefix || 'she/db/',
        mqttName: config.name,
        mqtt,
        log,
        broadcast,
    });
}

// Redis write-through cache â€” only init when config.redis.url is given
if (config.redis && config.redis.url) {
    require('./lib/redis')
        .init({ url: config.redis.url, store, log })
        .catch((err) => log.error('redis init failed:', err.message));
}

// InfluxDB â€” only init when --influx is set
if (config.influx) {
    require('./influx').init(config.influx);
}

// Elasticsearch â€” only init when --elastic is set
if (config.elastic) {
    require('./elastic').init(config.elastic);
}

// Matter controller â€” only init when --matter-storage is set
if (config.matterStorage) {
    const { ensureStorageDir } = require('./lib/storage');
    const matterController = require('./matter/controller');
    let matterStoragePath;
    if (typeof config.matterStorage === 'string') {
        matterStoragePath = config.matterStorage.replace(/^~(?=[/\\]|$)/, require('os').homedir());
        fs.mkdirSync(matterStoragePath, { recursive: true });
    } else {
        matterStoragePath = ensureStorageDir('matter');
    }
    log.info('matter controller starting, storage:', matterStoragePath);
    matterController.init(matterStoragePath, log, broadcast).catch((err) => {
        log.error('matter controller init failed:', err.message, err.stack);
    });
} else {
    log.warn('matter controller disabled â€” set matterStorage in config.json to enable');
}

// Start scripts immediately â€” MQTT retained state will populate the store asynchronously
start();

function stateChange(topic, state, oldState, msg) {
    subscriptions.forEach((subs) => {
        const options = subs.options || {};
        let delay;

        const match = mqttWildcards(topic, subs.topic);

        if (match && typeof options.condition === 'function') {
            if (!options.condition(topic, state.val, state, oldState, msg)) {
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
                 * @param {string} topic - the topic that triggered this callback
                 * @param {mixed} val - the val property of the new state
                 * @param {object} obj - new state - the whole state object (e.g. {"val": true, "ts": 12346345, "lc": 12346345} )
                 * @param {object} objPrev - previous state - the whole state object
                 * @param {object} msg - the mqtt message as received from MQTT.js
                 */
                subs.callback(topic, state.val, state, oldState, msg);
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
        newState.lc = newState.val !== oldState.val ? newState.ts : oldState.lc || newState.ts;
    } else {
        newState = { val, ts };
        newState.lc = val !== oldState.val ? ts : oldState.lc || ts;
    }

    const changed = newState.val !== oldState.val;
    store.setObject(storeKey, newState); // primary: fires 'change' â†’ she.on() callbacks
    store.setObject('mqtt::' + mqttTopic, newState); // compat: so mqttsub('var//name') still works
    stateChange(mqttTopic, newState, oldState, {}); // fires mqttsub callbacks

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

function runScript(script, name, origin) {
    const scriptDir = path.dirname(path.resolve(name));
    const logLabel = (origin || 'user') + '::' + path.basename(name) + ':';

    // Initialise per-script resource tracking
    if (!scriptJobs.has(name)) scriptJobs.set(name, []);
    if (!scriptTimers.has(name)) scriptTimers.set(name, new Set());
    const _myJobs = scriptJobs.get(name);
    const _myTimers = scriptTimers.get(name);

    log.debug(logLabel, 'creating domain');
    const scriptDomain = domain.create();

    log.debug(logLabel, 'creating sandbox');

    const she = {
        global: _global,

        /**
         * Log a debug message
         * @method debug
         * @param {...*}
         */
        debug(...args) {
            log.debug(logLabel, ...args);
        },
        /**
         * Log an info message
         * @method info
         * @param {...*}
         */
        info(...args) {
            log.info(logLabel, ...args);
        },
        /**
         * Log a warning message
         * @method warn
         * @param {...*}
         */
        warn(...args) {
            log.warn(logLabel, ...args);
        },
        /**
         * Log an error message
         * @method error
         * @param {...*}
         */
        error(...args) {
            log.error(logLabel, ...args);
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
        mqttsub: function Sandbox_mqttsub(topic, ...rest) {
            if (typeof topic === 'undefined') {
                throw new TypeError('argument topic missing');
            }

            let options, callback;
            if (rest.length === 1) {
                if (typeof rest[0] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                [callback] = rest;
                options = {};
            } else if (rest.length === 2) {
                if (typeof rest[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                [options, callback] = rest;
                options = options || {};

                if (typeof options === 'string' || typeof options === 'function') {
                    options = { condition: options };
                }
            } else if (rest.length > 2) {
                throw new Error('wrong number of arguments');
            }

            if (typeof topic === 'string') {
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
                    callback(topic, store.get('mqtt::' + topic), store.getObject('mqtt::' + topic));
                } else if (options.retain && (/\/\+\//.test(topic) || /\+$/.test(topic) || /\+/.test(topic) || topic.endsWith('#')) && typeof callback === 'function') {
                    for (const [t, obj] of store.mqttEntries()) {
                        if (mqttWildcards(t, topic)) {
                            callback(t, obj.val, obj);
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
         * @param {number} [options.shift]  - offset in seconds for solar events (-86400â€¦86400)
         * @param {function} callback - is called with no arguments
         */
        schedule: function Sandbox_schedule(pattern, ...rest) {
            let options, callback;
            if (rest.length === 1) {
                if (typeof rest[0] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                [callback] = rest;
                options = {};
            } else if (rest.length === 2) {
                if (typeof rest[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                [options, callback] = rest;
                options = options || {};
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
                        // Track the random-delay timer so it is cancelled on unload
                        // if the job fires in the same tick as the script is reloaded.
                        const id = setTimeout(scriptDomain.bind(callback), (parseFloat(options.random) || 0) * 1000 * Math.random());
                        _myTimers.add(id);
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
                // Variable â€” delegate to setVariable (handles var:: store + MQTT publish)
                const varName = tmp.slice(2).join('/');
                setVariable(varName, val);
            } else if (tmp[0] === config.variablePrefix && config.disableVariables) {
                tmp[1] = 'status';
                topic = tmp.join('/');
                if (!store.has('mqtt::' + topic) || store.get('mqtt::' + topic) !== val) {
                    tmp[1] = 'set';
                    topic = tmp.join('/');
                    she.mqttpub(topic, val, { retain: false });
                }
            } else {
                she.mqttpub(topic, val, { retain: false });
            }
        },

        /**
         * @method getValue
         * @param {string} topic
         * @returns {mixed} the topics value
         */
        getValue: function Sandbox_getValue(topic) {
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
        getProp: function Sandbox_getProp(topic, ...props) {
            if (props.length > 0) {
                let tmp = store.getObject('mqtt::' + topic);
                if (typeof tmp === 'undefined') {
                    return;
                }
                for (const prop of props) {
                    if (typeof tmp[prop] === 'undefined') {
                        return;
                    }
                    tmp = tmp[prop];
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
                throw new TypeError('she.mqtt.on: unknown event "' + event + '" â€” use "connect" or "disconnect"');
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
                let result;
                if (md.match(/^\.\//) || md.match(/^\.\.\//)) {
                    // Relative import â€” resolve from the script's own directory
                    const tmp = './' + path.relative(__dirname, path.join(scriptDir, md));
                    she.debug('require', tmp);
                    result = require(tmp);
                } else {
                    // Absolute import â€” try ~/.she/node_modules/ first (user-installed),
                    // then fall back to engine's own require (builtins + engine deps).
                    try {
                        result = _userRequire(md);
                        she.debug('require (user)', md);
                    } catch {
                        const localMod = path.join(scriptDir, 'node_modules', md, 'package.json');
                        if (fs.existsSync(localMod)) {
                            result = require(path.join(scriptDir, 'node_modules', md));
                            she.debug('require (local)', md);
                        } else {
                            result = require(md);
                            she.debug('require', md);
                        }
                    }
                }
                modules[md] = result;
                return result;
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
    // she.setTimeout / she.clearTimeout — tracked versions for use by stdlib and
    // sandbox modules that don't have direct access to the Sandbox context.
    she.setTimeout = (fn, delay, ...args) => {
        const id = setTimeout(fn, delay, ...args);
        _myTimers.add(id);
        return id;
    };
    she.clearTimeout = (id) => {
        _myTimers.delete(id);
        clearTimeout(id);
    };
    sandboxModules.forEach((md) => {
        md(she, { scriptDomain, scriptName, scriptFile: name });
    });

    log.debug(name, 'contextifying sandbox');
    const context = vm.createContext(Sandbox);

    scriptDomain.on('error', (e) => {
        if (!e.stack) {
            log.error(logLabel, 'unknown exception');
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

        log.error(logLabel + ' ' + e.name + ': ' + e.message + '\n' + stack.join('\n'));
    });

    scriptDomain.run(() => {
        log.debug(logLabel, 'running');
        script.runInContext(context);
    });
}

function loadScript(file, origin) {
    origin = origin || 'user';
    file = file.replace(/\\/g, '/');
    const loadLabel = (origin || 'user') + '::' + path.basename(file) + ':';
    if (scripts[file]) {
        log.error(loadLabel, 'already loaded?!');
        return;
    }

    log.info(loadLabel, 'loading');
    fs.readFile(file, (err, src) => {
        if (err && err.code === 'ENOENT') {
            log.error(loadLabel, 'not found');
        } else if (err) {
            log.error(loadLabel, err);
        } else {
            if (file.match(/\.js$/)) {
                // Javascript
                scripts[file] = createScript(src, file);
            }
            if (scripts[file]) {
                scriptOrigins.set(file, origin);
                runScript(scripts[file], file, origin);
            }
        }
    });
}

function unloadScript(file) {
    file = file.replace(/\\/g, '/');
    const origin = scriptOrigins.get(file) || 'user';
    const unloadLabel = (origin || 'user') + '::' + path.basename(file) + ':';
    log.info(unloadLabel, 'unloading');
    scriptOrigins.delete(file);

    // Remove MQTT subscriptions belonging to this script
    for (let i = subscriptions.length - 1; i >= 0; i--) {
        if (subscriptions[i]._script === file) subscriptions.splice(i, 1);
    }

    // Remove MQTT event callbacks (connect/disconnect) belonging to this script
    for (let i = mqttEventCallbacks.length - 1; i >= 0; i--) {
        if (mqttEventCallbacks[i]._script === file) mqttEventCallbacks.splice(i, 1);
    }

    // Remove HTTP routes registered by this script via she.api
    const scriptName = path.basename(file, path.extname(file));
    require('./web/server').unregisterRoutesByScript(scriptName);

    // Cancel all node-schedule jobs for this script
    const jobs = scriptJobs.get(file);
    if (jobs) {
        jobs.forEach((job) => job && job.cancel());
        scriptJobs.delete(file);
    }

    // Remove sun events belonging to this script and cancel any pending scheduled job
    for (let i = sunEvents.length - 1; i >= 0; i--) {
        if (sunEvents[i]._script === file) {
            if (sunEvents[i]._job) sunEvents[i]._job.cancel();
            sunEvents.splice(i, 1);
        }
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

function loadBuiltinsDir(callback) {
    const dir = path.join(__dirname, 'scripts');
    fs.readdir(dir, (err, data) => {
        if (err) {
            if (err.code !== 'ENOENT') {
                log.error('readdir builtin scripts', dir, err);
            }
            callback();
            return;
        }
        data.sort().forEach((file) => {
            if (file.match(/\.js$/)) {
                loadScript(path.join(dir, file), 'builtin');
            }
        });
        callback();
    });
}

function loadSandbox(callback) {
    const dir = path.join(__dirname, 'sandbox');
    fs.readdir(dir, (err, data) => {
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

/**
 * Returns true if any ancestor directory of absFile (between it and scriptRoot)
 * contains a .shelib marker file.
 */
function isLibFile(absFile, scriptRoot) {
    const root = path.resolve(scriptRoot);
    let dir = path.dirname(path.resolve(absFile));
    while (dir.length >= root.length && dir.startsWith(root)) {
        if (dir !== root && fs.existsSync(path.join(dir, '.shelib'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return false;
}

/**
 * Returns true if a .shedisable-<name> sibling marker exists for the given path.
 * Works for both files and directories.
 */
function isDisabledPath(absPath) {
    const dir = path.dirname(path.resolve(absPath));
    const name = path.basename(absPath);
    return fs.existsSync(path.join(dir, `.shedisable-${name}`));
}

/**
 * Returns true if any ancestor directory of absFile (between it and scriptRoot)
 * has a .shedisable-<dirname> sibling in its parent.
 */
function isInDisabledDir(absFile, scriptRoot) {
    const root = path.resolve(scriptRoot);
    let dir = path.dirname(path.resolve(absFile));
    while (dir.length > root.length && dir.startsWith(root)) {
        if (isDisabledPath(dir)) return true;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return false;
}

/**
 * Recursively load all user .js scripts from a directory tree.
 * Files/dirs with a .shedisable-<name> sibling, and files inside .shelib dirs, are skipped.
 */
function loadDirRecursive(dir, scriptRoot) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        log.error('readdir', dir, err);
        return;
    }
    entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((entry) => {
            if (entry.name.startsWith('.shedisable-')) return; // skip marker files
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!isDisabledPath(abs)) loadDirRecursive(abs, scriptRoot);
            } else if (entry.name.endsWith('.js') && !isLibFile(abs, scriptRoot) && !isDisabledPath(abs)) {
                loadScript(abs.replace(/\\/g, '/'));
            }
        });
}

function loadDir(dir) {
    const scriptRoot = path.resolve(dir);
    loadDirRecursive(scriptRoot, scriptRoot);

    if (!config.disableWatch) {
        const dirWatcher = chokidar.watch(dir, {
            ignored: (p, stats) => {
                const name = path.basename(p);
                if (name.startsWith('.shedisable-')) return false; // always watch disable markers
                return stats?.isFile() && !name.endsWith('.js') && name !== '.shelib';
            },
            persistent: true,
            ignoreInitial: true,
            usePolling: true,
        });
        dirWatcher.on('ready', () => log.info('watch', dir, 'initialized'));
        dirWatcher.on('all', (event, filePath) => {
            filePath = filePath.replace(/\\/g, '/');
            const basename = path.basename(filePath);

            // .shedisable-<name> marker changes - hot-unload or hot-reload the target
            if (basename.startsWith('.shedisable-')) {
                const targetName = basename.slice('.shedisable-'.length);
                const targetPath = path.join(path.dirname(filePath), targetName).replace(/\\/g, '/');
                if (event === 'add') {
                    if (targetName.endsWith('.js')) {
                        if (scripts[targetPath]) {
                            log.info(targetPath, 'disabled. unloading.');
                            unloadScript(targetPath);
                        }
                    } else {
                        const absTarget = path.resolve(targetPath);
                        Object.keys(scripts).forEach((scriptFile) => {
                            if (path.resolve(scriptFile).startsWith(absTarget + path.sep)) {
                                log.info(scriptFile, 'directory disabled. unloading.');
                                unloadScript(scriptFile);
                            }
                        });
                    }
                } else if (event === 'unlink') {
                    if (targetName.endsWith('.js')) {
                        if (fs.existsSync(targetPath) && !isLibFile(targetPath, dir) && !scripts[targetPath]) {
                            log.info(targetPath, 're-enabled. loading.');
                            loadScript(targetPath);
                        }
                    } else {
                        if (fs.existsSync(targetPath)) loadDirRecursive(targetPath, path.resolve(dir));
                    }
                }
                return;
            }

            // .shelib marker changes - warn only, manual restart required
            if (basename === '.shelib') {
                if (event === 'add') {
                    log.warn(filePath, 'library marker added - .js files in this directory will no longer load as scripts after daemon restart');
                } else if (event === 'unlink') {
                    log.warn(filePath, 'library marker removed - .js files in this directory will load as scripts after daemon restart');
                }
                return;
            }

            // Directory events - handle gracefully (no process.exit)
            if (event === 'addDir') return;

            if (event === 'unlinkDir') {
                const absDir = path.resolve(filePath);
                Object.keys(scripts).forEach((scriptFile) => {
                    const absScript = path.resolve(scriptFile);
                    if (absScript.startsWith(absDir + path.sep) || absScript === absDir) {
                        log.info(scriptFile, 'directory removed. unloading.');
                        unloadScript(scriptFile);
                    }
                });
                return;
            }

            if (event === 'change' && filePath.endsWith('.js')) {
                if (isLibFile(filePath, dir)) {
                    log.warn(filePath, 'is a library file - scripts that require() it will see the old version until they or the daemon are restarted');
                    return;
                }
                if (isDisabledPath(filePath) || isInDisabledDir(filePath, dir)) {
                    log.debug(filePath, 'is disabled - ignoring change');
                    return;
                }
                log.info(filePath, 'change detected. hot-reloading.');
                unloadScript(filePath);
                loadScript(filePath);
            } else if (event === 'add' && filePath.endsWith('.js')) {
                if (isLibFile(filePath, dir)) {
                    log.debug(filePath, 'is a library file - not loading as script');
                    return;
                }
                if (isDisabledPath(filePath) || isInDisabledDir(filePath, dir)) {
                    log.debug(filePath, 'is disabled - not loading as script');
                    return;
                }
                log.info(filePath, 'added. loading.');
                loadScript(filePath);
            } else if (event === 'unlink' && filePath.endsWith('.js')) {
                if (scripts[filePath]) {
                    log.info(filePath, 'removed. unloading.');
                    unloadScript(filePath);
                }
            }
        });
    }
}
function start() {
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
        loadBuiltinsDir(() => {
            if (config.dir) {
                if (typeof config.dir === 'string') {
                    loadDir(config.dir);
                } else {
                    config.dir.forEach((dir) => {
                        loadDir(dir);
                    });
                }
            }
        });
    });
}

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

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
