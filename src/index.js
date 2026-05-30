#!/usr/bin/env node
/* eslint-disable func-names */
/* eslint-disable func-name-matching */
/* eslint-disable camelcase */

/* eslint prefer-rest-params: "warn" */
/* eslint prefer-destructuring: "warn" */

/* eslint n/no-deprecated-api: "warn" */

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

const sandboxModules = [];
const status = {};
const scripts = {};
const subscriptions = [];

// Per-script resource tracking for hot-reload
const scriptJobs = new Map(); // scriptFile → node-schedule Job[]
const scriptTimers = new Map(); // scriptFile → Set<timer id>

const _global = {};

// Sun scheduling

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

// MQTT
const mqtt = modules.mqtt.connect(config.url, { will: { topic: config.name + '/connected', payload: '0', retain: true } });
mqtt.publish(config.name + '/connected', '2', { retain: true });

// sheDB — only init when --db-path is given
if (config.dbPath) {
    shedb.init({ dbPath: config.dbPath, dbRetain: config.dbRetain || false, mqttName: config.name, mqtt, log, broadcast });
}

let firstConnect = true;
let startTimeout;
let connected;

// If MQTT is unavailable at startup, start scripts after a grace period anyway
// so the daemon is usable (web UI, scheduling) even without a broker.
const mqttConnectGrace = setTimeout(() => {
    if (firstConnect) {
        log.warn('mqtt not connected after grace period — starting scripts without retained state');
        start();
    }
}, 10000);

mqtt.on('connect', () => {
    connected = true;
    clearTimeout(mqttConnectGrace);
    log.info('mqtt connected ' + config.url);
    log.debug('mqtt subscribe #');
    mqtt.subscribe('#');
    if (firstConnect) {
        // Wait until retained topics are received before we load the scripts (timeout is prolonged on incoming retained messages)
        startTimeout = setTimeout(start, 500);
    }
});

mqtt.on('close', () => {
    if (connected) {
        firstConnect = false;
        connected = false;
        log.info('mqtt closed ' + config.url);
    }
});

/* istanbul ignore next */
mqtt.on('error', () => {
    log.error('mqtt error ' + config.url);
});

mqtt.on('message', (topic, payload, msg) => {
    if (shedb.handleMqttMessage(topic, payload)) return;

    if (firstConnect && msg.retain) {
        // Retained message received - prolong the timeout
        clearTimeout(startTimeout);
        startTimeout = setTimeout(start, 500);
    }

    const state = require('./lib/parse-payload')(payload);

    const topicArr = topic.split('/');
    let oldState;

    if (topicArr[0] === config.variablePrefix && topicArr[1] === 'set' && !config.disableVariables) {
        topicArr[1] = 'status';
        topic = topicArr.join('/');
        oldState = status[topic] || {};
        const ts = new Date().getTime();

        state.ts = ts;

        state.lc = state.val === oldState.val ? oldState.lc : ts;
        status[topic] = state;
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
        oldState = status[topic] || {};
        if (oldState.val !== state.val) {
            state.lc = state.ts;
        }
        status[topic] = state;
        stateChange(topic, state, oldState, msg);
    }
});

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
                topic = topic.replace(/^\$/, config.variablePrefix + '/status/');
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

                if (options.retain && status[topic] && typeof callback === 'function') {
                    callback(topic.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), status[topic].val, status[topic]);
                } else if (options.retain && (/\/\+\//.test(topic) || /\+$/.test(topic) || /\+/.test(topic) || topic.endsWith('#')) && typeof callback === 'function') {
                    for (const t in status) {
                        if (mqttWildcards(t, topic)) {
                            callback(t.replace(/^([^/]+)\/status\/(.+)/, '$1//$2'), status[t].val, status[t]);
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
         * Schedule recurring and one-shot events
         * @method schedule
         * @param {(string|Date|Object|mixed[])} pattern - pattern or array of patterns. May be cron style string, Date object or node-schedule object literal. See {@link https://github.com/tejasmanohar/node-schedule/wiki}
         * @param {Object} [options]
         * @param {number} [options.random] - random delay execution in seconds. Has to be positive
         * @param {function} callback - is called with no arguments
         * @example // every full Hour.
         * she.schedule('0 * * * *', callback);
         *
         * // Monday till friday, random between 7:30am an 8:00am
         * she.schedule('30 7 * * 1-5', {random: 30 * 60}, callback);
         *
         * // once on 21. December 2018 at 5:30am
         * she.schedule(new Date(2018, 12, 21, 5, 30, 0), callback);
         *
         * // every Sunday at 2:30pm
         * she.schedule({hour: 14, minute: 30, dayOfWeek: 0}, callback);
         * @see {@link sunSchedule} for scheduling based on sun position.
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
         * Schedule a recurring event based on sun position
         * @method sunSchedule
         * @param {string|string[]} pattern - a suncalc event or an array of suncalc events. See {@link https://github.com/mourner/suncalc}
         * @param {Object} [options]
         * @param {number} [options.shift] - delay execution in seconds. Allowed Range: -86400...86400 (+/- 24h)
         * @param {number} [options.random] - random delay execution in seconds.
         * @param {function} callback - is called with no arguments
         * @example // Call callback 15 minutes before sunrise
         * she.sunSchedule('sunrise', {shift: -900}, callback);
         *
         * // Call callback random 0-15 minutes after sunset
         * she.sunSchedule('sunset', {random: 900}, callback);
         * @see {@link schedule} for time based scheduling.
         */
        sunSchedule: function Sandbox_sunSchedule(pattern, /* optional */ options, callback) {
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

            if (typeof options.shift !== 'undefined' && (options.shift < -86400 || options.shift > 86400)) {
                throw new Error('options.shift out of range');
            }

            if (typeof pattern === 'object' && pattern.length > 0) {
                pattern = Array.prototype.slice.call(pattern);
                pattern.forEach((pt) => {
                    she.sunSchedule(pt, options, callback);
                });
                return;
            }

            const event = sunTimes[0][pattern];
            if (typeof event === 'undefined') {
                throw new TypeError('unknown suncalc event ' + pattern);
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
            mqtt.publish(topic, payload, options);
        },

        /**
         * Set a value on one or more topics
         * @method setValue
         * @param {(string|string[])} topic - topic or array of topics to set value on
         * @param {mixed} val
         */
        setValue: function Sandbox_setValue(topic, val, publishUnchanged) {
            if (typeof topic === 'object' && topic.length > 0) {
                topic = Array.prototype.slice.call(topic);
                topic.forEach((tp) => {
                    she.setValue(tp, val);
                });
                return;
            }

            let changed;

            topic = topic.replace(/^\$/, config.variablePrefix + '//');

            const tmp = topic.split('/');
            if (tmp[0] === config.variablePrefix && !config.disableVariables) {
                // Variable

                tmp[1] = 'status';
                topic = tmp.join('/');
                const oldState = status[topic] || {};
                const ts = new Date().getTime();
                if (typeof val === 'object') {
                    val.ts = ts;
                } else {
                    val = { val, ts };
                }
                if (val.val !== oldState.val) {
                    val.lc = ts;
                    changed = true;
                }
                status[topic] = val;
                stateChange(topic, val, oldState, {});
                if (changed || publishUnchanged) {
                    she.mqttpub(topic, val, { retain: true });
                }
                /* istanbul ignore next */ // TODO tests!
            } else if (tmp[0] === config.variablePrefix && config.disableVariables) {
                /* istanbul ignore next */
                tmp[1] = 'status';
                topic = tmp.join('/');
                /* istanbul ignore next */
                if (!status[topic] || status[topic].val !== val) {
                    /* istanbul ignore next */
                    tmp[1] = 'set';
                    topic = tmp.join('/');
                    she.mqttpub(topic, val, { retain: false }); // TODO really retain false?!
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
            topic = topic.replace(/^\$/, config.variablePrefix + '/status/');
            topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/status/$2');
            return status[topic] && status[topic].val;
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
                let tmp = status[topic];
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
            return status[topic];
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

    // Remove shedb listeners belonging to this script
    const shedbSandbox = require('./sandbox/shedb-sandbox');
    shedbSandbox.cleanup(file);

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
    firstConnect = false; // prevent start() from being called again on retained-message timer reset
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
process.on('SIGINT', () => {
    log.info('got SIGINT. exiting.');
    process.exit(0);
});
/* istanbul ignore next */
process.on('SIGTERM', () => {
    log.info('got SIGTERM. exiting.');
    process.exit(0);
});
