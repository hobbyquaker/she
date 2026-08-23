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

// Resolve --data-dir early so that storage.js and config.js both see the correct
// data root when they are first require()'d below.
(function () {
    const idx = process.argv.indexOf('--data-dir');
    if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')) {
        process.env.SHE_DATA_DIR = process.argv[idx + 1];
    }
})();

// Ensure the data directory exists before anything else runs
require('./lib/storage').ensureRoot();

// Secrets CLI (roadmap A5): she --secret-set <group>/<field> (value on stdin) | --secret-delete <group>[/<field>] | --secret-list
{
    const idx = process.argv.findIndex((a) => a === '--secret-set' || a === '--secret-delete' || a === '--secret-list');
    if (idx !== -1) process.exit(require('./lib/secrets').cli(process.argv.slice(idx)));
}

// ---------------------------------------------------------------------------
// Persistent JSON-Lines log file — written alongside the pino-pretty stream.
// On each daemon start: rotate she.jsonl → she.jsonl.1, then open fresh.
// ---------------------------------------------------------------------------
const _fs = require('fs');
const _path = require('path');
const { LOGS_DIR } = require('./lib/storage');
const secrets = require('./lib/secrets');
const _logFileCurrent = _path.join(LOGS_DIR, 'she.jsonl');
const _logFilePrev = _path.join(LOGS_DIR, 'she.jsonl.1');
try {
    _fs.renameSync(_logFileCurrent, _logFilePrev);
} catch {
    /* no previous file — ignore */
}
const _logFileStream = _fs.createWriteStream(_logFileCurrent, { flags: 'w' });
function _writeLogLine(level, msg) {
    _logFileStream.write(JSON.stringify({ level, msg, ts: Date.now() }) + '\n');
}
// ---------------------------------------------------------------------------

const config = require('./config');

// Apply configured timezone before any Date/scheduler usage
if (config.timezone) {
    process.env.TZ = config.timezone;
}

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
const { broadcastLog, broadcast, setWelcomeProvider } = require('./web/log-ws');
const shedb = require('./web/shedb');
const log = {
    debug: (...args) => {
        const msg = secrets.redact(args.join(' '));
        _pino.debug(msg);
        broadcastLog({ level: 'debug', msg, ts: Date.now() });
        _writeLogLine('debug', msg);
    },
    info: (...args) => {
        const msg = secrets.redact(args.join(' '));
        _pino.info(msg);
        broadcastLog({ level: 'info', msg, ts: Date.now() });
        _writeLogLine('info', msg);
    },
    warn: (...args) => {
        const msg = secrets.redact(args.join(' '));
        _pino.warn(msg);
        broadcastLog({ level: 'warn', msg, ts: Date.now() });
        _writeLogLine('warn', msg);
    },
    error: (...args) => {
        const msg = secrets.redact(args.join(' '));
        _pino.error(msg);
        broadcastLog({ level: 'error', msg, ts: Date.now() });
        _writeLogLine('error', msg);
    },
    setLevel: (level) => {
        _pino.level = level;
    },
};

// Secrets store (roadmap A5): read once at startup; the UI/CLI keep it current afterwards.
{
    const st = secrets.load();
    if (st.status === 'locked' || st.status === 'error') log.warn('secrets: ' + st.error + ' — she.secrets.get() returns undefined until the key is available');
    else if (st.groups > 0) log.info(`secrets: ${st.groups} group(s) loaded`);
}
const pkg = require('../package.json');

/**
 * Build a short log label for a script file.
 * Uses the path relative to the configured script dir(s) when possible,
 * falling back to the bare filename for files outside the script dir.
 */
function makeLabel(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const dirs = config.dir ? (Array.isArray(config.dir) ? config.dir : [config.dir]) : [];
    for (const d of dirs) {
        const rel = path.relative(d, normalized).replace(/\\/g, '/');
        if (!rel.startsWith('..')) return rel + ':';
    }
    return path.basename(normalized) + ':';
}

log.setLevel(['debug', 'info', 'warn', 'error'].indexOf(config.verbosity) === -1 ? 'info' : config.verbosity);

// Safety net: unhandled Promise rejections from async script callbacks are not caught
// by the per-script domain (Node.js domains don't intercept Promise rejections).
// Log the error instead of letting Node.js crash the process.
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    log.error('unhandled promise rejection — add try/catch to async script callbacks:\n' + msg);
});

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
            proxyLogoutUrl: config.proxyLogoutUrl || null,
            bindAddress: config.bindAddress,
            configPath: config.config,
            scriptDir: config.dir || null,
        })
        .then((actualPort) => log.info('http server listening on :' + actualPort))
        .catch((err) => {
            log.error('http server start failed:', err.message);
            process.exit(1);
        });
    require('./web/broker-api').setLogger(log);
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
if (typeof config.port !== 'undefined') require('./web/broker-api').setStore(store);
const scripts = {};
const scriptOrigins = new Map(); // file â†’ 'builtin' | 'user'
const subscriptions = [];
const mqttEventCallbacks = [];
const varSubscriptions = []; // store-based var:: subscriptions { key, handler, _script }

// Per-script resource tracking for hot-reload
const scriptJobs = new Map(); // scriptFile â†’ node-schedule Job[]
const scriptTimers = new Map(); // scriptFile â†’ Set<timer id>

const _global = {};

// ── Event-loop heartbeat ─────────────────────────────────────────────────────
let _blockingScript = null;
let _blockingScriptTs = 0; // timestamp when the last _dispatch() call finished

/**
 * Wrap a user callback dispatch so the heartbeat can identify the active
 * script — and so async callback errors are caught close to their source with
 * script attribution (S1): when the callback returns a Promise, a rejection is
 * logged with the script's label. The global unhandledRejection handler stays
 * as a last resort but cannot name the script; label-prefixed errors also show
 * up in the script's log panel in the Scripts tab.
 */
function _dispatch(label, fn) {
    _blockingScript = label;
    let result;
    try {
        result = fn();
    } finally {
        // Record end-time synchronously — no setImmediate, which would race with the
        // heartbeat timer when blocking occurs inside a poll-phase (I/O) callback.
        _blockingScriptTs = Date.now();
    }
    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
        result.catch((err) => {
            const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
            log.error(makeLabel(label) + ' async callback error: ' + msg);
        });
    }
}

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
                _dispatch(obj._script, obj.domain.bind(obj.callback));
            } else {
                // Schedule the event and track the job so it can be cancelled on script unload
                obj._job = scheduler.scheduleJob(event, () => _dispatch(obj._script, obj.domain.bind(obj.callback)));
            }
        }
    }
}

// MQTT â€” only connect when a broker URL is configured
let mqtt = null;
let connected = false;

// Deferred start — wait for retained MQTT state before running scripts
let _started = false;
let _startupTimeout = null; // fires if broker never connects
let _sentinelTimeout = null; // fires if sentinel never arrives after connecting
let _sentinelValue = null; // unique value for this boot's sentinel
const _STARTUP_TIMEOUT_MS = 10000; // ms to wait for broker before starting anyway
const _SENTINEL_TIMEOUT_MS = config.sentinelTimeout; // ms to wait for sentinel after connecting

// Script start waits on two gates: MQTT retained state (sentinel) and — when
// the Matter controller is enabled — controller startup, so scripts using
// she.matter.* at top level don't fail with "Matter controller not started".
let _mqttGate = false;
let _matterGate = !config.matterStorage; // pre-open when matter is disabled

function _maybeStart() {
    if (_started || !_mqttGate || !_matterGate) {
        if (!_started && _mqttGate && !_matterGate) {
            log.info('waiting for matter controller before starting scripts');
        }
        return;
    }
    _started = true;
    start();
}

function matterGateOpen() {
    if (_matterGate) return;
    _matterGate = true;
    _maybeStart();
}

function startOnce(reason) {
    if (_started || _mqttGate) return;
    _mqttGate = true;
    if (_startupTimeout) {
        clearTimeout(_startupTimeout);
        _startupTimeout = null;
    }
    if (_sentinelTimeout) {
        clearTimeout(_sentinelTimeout);
        _sentinelTimeout = null;
    }
    if (reason) log.info(reason);
    broadcast({ type: 'mqtt:status', ready: true, connected });
    _maybeStart();
}

// Wire up the MQTT API: pass the state store and a getter for the live MQTT client.
// The getter always returns the current value of `mqtt` (null until connected).
require('./web/mqtt-api').init(store, () => mqtt);
require('./web/services-api').init(store, () => mqtt, {
    getMqttConfig: () => ({ url: config.url, username: config.mqttUsername, password: config.mqttPassword }),
});
require('./web/ai-api').init(store);

// MQTT message rate counter â€” reset on each stats poll
let _mqttMsgCount = 0;
let _mqttMsgTs = Date.now();
let _prevCpuUsage = process.cpuUsage();

// perf_hooks — event loop utilization + delay histogram (always-on, minimal overhead)
const { PerformanceObserver, monitorEventLoopDelay, performance } = require('perf_hooks');
let _prevElu = performance.eventLoopUtilization();
const _elHisto = monitorEventLoopDelay({ resolution: 20 });
_elHisto.enable();

// GC observer — log only significant GC pauses (>=50ms); never spams on normal minor GCs
const _gcKinds = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weaken' };
new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (entry.duration >= 50) {
            const kind = _gcKinds[entry.detail?.kind] ?? 'gc';
            log.warn(`GC ${kind} pause ${Math.round(entry.duration)}ms`);
        }
    }
}).observe({ type: 'gc', buffered: false });

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
    const eluDelta = performance.eventLoopUtilization(_prevElu);
    _prevElu = performance.eventLoopUtilization();
    const elMeanMs = Math.round(_elHisto.mean / 1e6);
    const elMaxMs = Math.round(_elHisto.max / 1e6);
    _elHisto.reset();
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
        runningScripts: Object.keys(scripts).map((f) => makeLabel(f).slice(0, -1)),
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
        eluPercent: Math.round(eluDelta.utilization * 100),
        elMeanMs,
        elMaxMs,
    };
});

// Push current script:running state so the UI green dots survive a browser reload.
setWelcomeProvider(() => Object.keys(scripts).map((f) => ({ type: 'script:running', path: makeLabel(f).slice(0, -1), running: true })));

if (!config.url) {
    log.warn('no MQTT broker URL configured â€” set "url" in ' + path.join(require('os').homedir(), '.she', 'config.json'));
}

if (config.url) {
    // Inform newly-connected WS clients of the current MQTT broker connection state.
    setWelcomeProvider(() => ({ type: 'mqtt:status', ready: _started, connected }));

    // resubscribe: false — she manually re-subscribes in the connect handler, so MQTT.js's
    // automatic re-subscribe on reconnect must be disabled.  If both fire, Mosquitto receives
    // two SUBSCRIBE '#' packets and silently drops QoS-0 retained messages that overflow the
    // per-client queue between the two subscriptions.
    const _mqttOpts = { will: { topic: config.name + '/connected', payload: '0', retain: true }, resubscribe: false };
    if (config.mqttUsername) _mqttOpts.username = config.mqttUsername;
    if (config.mqttPassword) _mqttOpts.password = config.mqttPassword;
    if (config.mqttCa) _mqttOpts.ca = config.mqttCa;
    if (config.mqttCert) _mqttOpts.cert = config.mqttCert;
    if (config.mqttKey) _mqttOpts.key = config.mqttKey;
    if (config.mqttVersion === '5') _mqttOpts.protocolVersion = 5;
    mqtt = modules.mqtt.connect(config.url, _mqttOpts);
    mqtt.publish(config.name + '/connected', '2', { retain: true });

    mqtt.on('connect', () => {
        connected = true;
        log.info('mqtt connected ' + config.url);
        log.debug('mqtt subscribe #');
        mqtt.subscribe('#');
        mqtt.subscribe('$SYS/#');
        mqttEventCallbacks.filter((c) => c.event === 'connect').forEach((c) => _dispatch(c._script, () => c.callback()));

        if (!_started) {
            // Cancel the “broker not connecting” startup timeout — we’re connected.
            if (_startupTimeout) {
                clearTimeout(_startupTimeout);
                _startupTimeout = null;
            }

            // Publish a non-retained sentinel immediately after subscribing to #.
            // MQTT.js sends packets in order on a single TCP connection, so the
            // broker receives SUBSCRIBE before this PUBLISH. Retained messages are
            // queued for us when SUBSCRIBE is processed; the sentinel is queued
            // afterwards. Receiving the sentinel means all retained messages have
            // been delivered — deterministic, no heuristic timer needed.
            _sentinelValue = String(Date.now());
            mqtt.publish(config.name + '/she-sentinel', _sentinelValue, { retain: false });
            log.debug('mqtt: waiting for retained-state sentinel');
            broadcast({ type: 'mqtt:status', ready: false, connected: true });

            // Fallback: if sentinel never arrives (e.g. abnormal broker behaviour)
            _sentinelTimeout = setTimeout(() => {
                log.warn('mqtt sentinel timeout — starting scripts without full retained state');
                startOnce();
            }, _SENTINEL_TIMEOUT_MS);
        } else {
            // Reconnect after a previous disconnect: scripts are already running.
            broadcast({ type: 'mqtt:status', ready: true, connected: true });
        }
    });

    mqtt.on('close', () => {
        if (connected) {
            connected = false;
            log.info('mqtt closed ' + config.url);
            mqttEventCallbacks.filter((c) => c.event === 'disconnect').forEach((c) => _dispatch(c._script, () => c.callback()));
        }
        broadcast({ type: 'mqtt:status', ready: _started, connected: false });
    });

    mqtt.on('error', () => {
        log.error('mqtt error ' + config.url);
    });

    mqtt.on('message', (topic, payload, msg) => {
        _mqttMsgCount++;

        // Sentinel detection: a non-retained message we publish to ourselves right
        // after subscribing to #. When it arrives, all retained messages from the
        // broker have already been delivered and stored.
        if (!_started && _sentinelValue !== null && !msg.retain && topic === config.name + '/she-sentinel' && payload.toString() === _sentinelValue) {
            let _retainedCount = 0;
            // eslint-disable-next-line no-unused-vars
            for (const _ of store.mqttEntries()) _retainedCount++;
            startOnce('mqtt: retained state ready, starting scripts (' + _retainedCount + ' retained topics loaded)');
            return; // sentinel is internal — don’t process further
        }

        if (shedb.handleMqttMessage(topic, payload)) return;

        // An empty payload deletes the topic from the state store (mqtt-smarthome
        // convention; also how a retained message is cleared per MQTT spec). The
        // retain flag cannot be used to detect this: MQTT 3.1.1 brokers clear it
        // when forwarding to established subscriptions, so a retained-clear
        // arrives here as a plain empty message. Previously an empty payload was
        // stored as { val: NaN }, so the MQTT tab kept showing cleared topics.
        // Subscription callbacks are still dispatched (empty publishes are also
        // used as plain triggers) with val '' — only the stored state is dropped.
        if (payload.length === 0) {
            const emptyOld = store.getObject('mqtt::' + topic) || {};
            if (store.delete('mqtt::' + topic)) {
                log.debug('empty payload, removed topic from state store:', topic);
            }
            const delArr = topic.split('/');
            if (delArr[0] === config.variablePrefix && delArr[1] === 'status') {
                store.delete('var::' + delArr.slice(2).join('/'));
            }
            const ts = new Date().getTime();
            stateChange(topic, { val: '', ts, lc: ts }, emptyOld, msg);
            return;
        }

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
                return;
            }
            if (!state.ts) {
                state.ts = new Date().getTime();
            }
            oldState = store.getObject('mqtt::' + topic) || {};
            // lc (last change): prefer a payload-provided value; otherwise set it
            // on value change and carry the previous lc over when the value is
            // unchanged. Previously the old lc was simply lost on repeated
            // identical values, so she.mqtt.age() returned NaN for topics whose
            // payloads don't carry their own lc (B5).
            if (state.lc === undefined) {
                state.lc = oldState.val !== state.val ? state.ts : (oldState.lc ?? state.ts);
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
    // Scripts wait for the controller (see _maybeStart) — but never forever:
    // a hanging start must not block the whole script engine.
    const _matterStartTimeout = setTimeout(() => {
        if (!_started) log.warn('matter controller not ready after 30s — starting scripts anyway');
        matterGateOpen();
    }, 30000);
    matterController
        .init(matterStoragePath, log, broadcast)
        .catch((err) => {
            log.error('matter controller init failed:', err.message, err.stack);
        })
        .finally(() => {
            clearTimeout(_matterStartTimeout);
            matterGateOpen();
        });
} else {
    log.warn('matter controller disabled â€” set matterStorage in config.json to enable');
}

// dynsec broker admin client - only init when broker.dynsec credentials are configured
if (config.broker && config.broker.dynsec && config.url) {
    require('./lib/dynsec').init(config, log);
}
// If no broker is configured, start scripts immediately.
// If a broker is configured, startOnce() fires from the quiet-period timer inside
// mqtt.on('connect') once the retained-message burst settles, or from the
// startup-timeout fallback if the broker is unreachable.
if (config.url) {
    _startupTimeout = setTimeout(() => {
        log.warn('mqtt startup timeout — starting scripts without retained state');
        startOnce();
    }, _STARTUP_TIMEOUT_MS);
} else {
    // No broker configured — open the MQTT gate directly (scripts may still
    // wait for the Matter controller, see _maybeStart).
    _mqttGate = true;
    _maybeStart();
}

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
                _dispatch(subs._script, () => subs.callback(topic, state.val, state, oldState, msg));
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
    const compileLabel = makeLabel(name);
    log.debug(compileLabel, 'compiling');
    try {
        return new vm.Script(source, { filename: name });
    } catch (err) {
        log.error(compileLabel, err.name + ':', err.message);
        return false;
    }
}

function runScript(script, name, _origin) {
    const scriptDir = path.dirname(path.resolve(name));
    const logLabel = makeLabel(name);

    // Initialise per-script resource tracking
    if (!scriptJobs.has(name)) scriptJobs.set(name, []);
    if (!scriptTimers.has(name)) scriptTimers.set(name, new Set());
    const _myJobs = scriptJobs.get(name);
    const _myTimers = scriptTimers.get(name);

    log.debug(logLabel, 'creating domain');
    const scriptDomain = domain.create();

    log.debug(logLabel, 'creating sandbox');

    function serializeArg(a) {
        return a !== null && typeof a === 'object' ? JSON.stringify(a) : a;
    }

    const she = {
        global: _global,

        /**
         * Log a debug message
         * @method debug
         * @param {...*}
         */
        debug(...args) {
            log.debug(logLabel, ...args.map(serializeArg));
        },
        /**
         * Log an info message
         * @method info
         * @param {...*}
         */
        info(...args) {
            log.info(logLabel, ...args.map(serializeArg));
        },
        /**
         * Log a warning message
         * @method warn
         * @param {...*}
         */
        warn(...args) {
            log.warn(logLabel, ...args.map(serializeArg));
        },
        /**
         * Log an error message
         * @method error
         * @param {...*}
         */
        error(...args) {
            log.error(logLabel, ...args.map(serializeArg));
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
                    _dispatch(name, () => callback(topic, store.get('mqtt::' + topic), store.getObject('mqtt::' + topic)));
                } else if (options.retain && (/\/\+\//.test(topic) || /\+$/.test(topic) || /\+/.test(topic) || topic.endsWith('#')) && typeof callback === 'function') {
                    for (const [t, obj] of store.mqttEntries()) {
                        if (mqttWildcards(t, topic)) {
                            _dispatch(name, () => callback(t, obj.val, obj));
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
                        const id = setTimeout(() => _dispatch(name, scriptDomain.bind(callback)), (parseFloat(options.random) || 0) * 1000 * Math.random());
                        _myTimers.add(id);
                    }),
                );
            } else {
                _myJobs.push(scheduler.scheduleJob(pattern, () => _dispatch(name, scriptDomain.bind(callback))));
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
                    if (changedKey === varStoreKey) _dispatch(name, () => boundCb(val, obj, prevObj));
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
    };

    // she.log is an alias for she.info
    she.log = she.info;

    const Sandbox = {
        setTimeout: (fn, delay, ...args) => {
            const wrapped = args.length ? () => fn(...args) : fn;
            const id = setTimeout(() => _dispatch(name, wrapped), delay);
            _myTimers.add(id);
            return id;
        },
        setInterval: (fn, delay, ...args) => {
            const wrapped = args.length ? () => fn(...args) : fn;
            const id = setInterval(() => _dispatch(name, wrapped), delay);
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
            // Failures throw (Cannot find module, syntax errors in the required
            // file, …) and thereby stop the requiring script — a script must not
            // silently continue with an undefined module.
            let result;
            if (md.match(/^\.\//) || md.match(/^\.\.\//)) {
                // Relative import — resolve from the script's own directory
                she.debug('require', md);
                result = require(path.resolve(scriptDir, md));
            } else {
                // Absolute import — try ~/.she/node_modules/ first (user-installed),
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
        },

        console: {
            log: (...args) => she.info(...args),
            error: (...args) => she.error(...args),
        },

        she,
    };

    const scriptName = path.basename(name, path.extname(name));
    // Expose read-only config values relevant to scripts.
    she.config = Object.freeze({
        latitude: config.latitude,
        longitude: config.longitude,
    });
    // she.secrets (roadmap A5): read-only access to the secrets store; unknown paths warn once per script
    const _secretWarned = new Set();
    she.secrets = Object.freeze({
        get(p) {
            const v = secrets.get(p);
            if (v === undefined && !_secretWarned.has(String(p))) {
                _secretWarned.add(String(p));
                log.warn(logLabel, `secret "${p}" not found` + (secrets.status().status === 'locked' ? ' (secrets store is locked)' : ''));
            }
            return v;
        },
        has: (p) => secrets.has(p),
    });
    // she.setTimeout / she.clearTimeout — tracked versions for use by stdlib and
    // sandbox modules that don't have direct access to the Sandbox context.
    she.setTimeout = (fn, delay, ...args) => {
        const wrapped = args.length ? () => fn(...args) : fn;
        const id = setTimeout(() => _dispatch(name, wrapped), delay);
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

    log.debug(logLabel, 'contextifying sandbox');
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
        try {
            script.runInContext(context);
        } catch (e) {
            // Contain top-level script errors: without this, the exception
            // unwinds through the caller (e.g. the watcher batch loading many
            // scripts in one tick) and aborts loading of subsequent scripts.
            // Route through the domain handler for the usual attributed log.
            scriptDomain.emit('error', e);
        }
    });

    // Log a summary of what was registered — symmetric with the unload summary
    const registeredCallbacks =
        subscriptions.filter((s) => s._script === name).length +
        varSubscriptions.filter((s) => s._script === name).length +
        mqttEventCallbacks.filter((c) => c._script === name).length;
    const registeredTimers = _myJobs.length + sunEvents.filter((e) => e._script === name).length + _myTimers.size;
    if (registeredCallbacks > 0 || registeredTimers > 0) {
        const parts = [];
        if (registeredCallbacks > 0) parts.push(`${registeredCallbacks} callback${registeredCallbacks !== 1 ? 's' : ''}`);
        if (registeredTimers > 0) parts.push(`${registeredTimers} timer${registeredTimers !== 1 ? 's' : ''}`);
        log.debug(logLabel, `registered ${parts.join(' and ')}`);
    }
}

function loadScript(file, origin) {
    origin = origin || 'user';
    file = file.replace(/\\/g, '/');
    const loadLabel = makeLabel(file);
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
                broadcast({ type: 'script:running', path: makeLabel(file).slice(0, -1), running: true });
            }
        }
    });
}

function unloadScript(file) {
    file = file.replace(/\\/g, '/');
    const _origin = scriptOrigins.get(file) || 'user';
    const unloadLabel = makeLabel(file);
    log.info(unloadLabel, 'unloading');
    scriptOrigins.delete(file);

    let removedCallbacks = 0;
    let removedTimers = 0;

    // Remove MQTT subscriptions belonging to this script
    for (let i = subscriptions.length - 1; i >= 0; i--) {
        if (subscriptions[i]._script === file) {
            subscriptions.splice(i, 1);
            removedCallbacks++;
        }
    }

    // Remove MQTT event callbacks (connect/disconnect) belonging to this script
    for (let i = mqttEventCallbacks.length - 1; i >= 0; i--) {
        if (mqttEventCallbacks[i]._script === file) {
            mqttEventCallbacks.splice(i, 1);
            removedCallbacks++;
        }
    }

    // Remove HTTP routes registered by this script via she.api
    const scriptName = path.basename(file, path.extname(file));
    require('./web/server').unregisterRoutesByScript(scriptName);

    // Cancel all node-schedule jobs for this script
    const jobs = scriptJobs.get(file);
    if (jobs) {
        jobs.forEach((job) => job && job.cancel());
        removedTimers += jobs.length;
        scriptJobs.delete(file);
    }

    // Remove sun events belonging to this script and cancel any pending scheduled job
    for (let i = sunEvents.length - 1; i >= 0; i--) {
        if (sunEvents[i]._script === file) {
            if (sunEvents[i]._job) sunEvents[i]._job.cancel();
            sunEvents.splice(i, 1);
            removedTimers++;
        }
    }

    // Clear all tracked timers for this script
    const timers = scriptTimers.get(file);
    if (timers) {
        timers.forEach((id) => clearTimeout(id));
        removedTimers += timers.size;
        scriptTimers.delete(file);
    }

    // Remove store-based var:: subscriptions belonging to this script
    for (let i = varSubscriptions.length - 1; i >= 0; i--) {
        if (varSubscriptions[i]._script === file) {
            store.removeListener('change', varSubscriptions[i].handler);
            varSubscriptions.splice(i, 1);
            removedCallbacks++;
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

    if (removedCallbacks > 0 || removedTimers > 0) {
        const parts = [];
        if (removedCallbacks > 0) parts.push(`${removedCallbacks} callback${removedCallbacks !== 1 ? 's' : ''}`);
        if (removedTimers > 0) parts.push(`${removedTimers} timer${removedTimers !== 1 ? 's' : ''}`);
        log.debug(unloadLabel, `unregistered ${parts.join(' and ')}`);
    }

    // Remove from scripts map so it can be re-loaded
    delete scripts[file];
    broadcast({ type: 'script:running', path: makeLabel(file).slice(0, -1), running: false });
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

            // .shelib marker changes - unload or reload scripts in the affected directory
            if (basename === '.shelib') {
                const affectedDir = path.dirname(filePath);
                if (event === 'add') {
                    log.info(makeLabel(filePath), 'library marker added - unloading scripts in this directory');
                    Object.keys(scripts).forEach((scriptFile) => {
                        const absScript = path.resolve(scriptFile);
                        const absDir = path.resolve(affectedDir);
                        if (absScript.startsWith(absDir + path.sep) || path.dirname(absScript) === absDir) {
                            unloadScript(scriptFile);
                        }
                    });
                } else if (event === 'unlink') {
                    log.info(makeLabel(filePath), 'library marker removed - loading scripts in this directory');
                    loadDirRecursive(affectedDir, path.resolve(dir));
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

            const fileLabel = makeLabel(filePath);
            if (event === 'change' && filePath.endsWith('.js')) {
                if (isLibFile(filePath, dir)) {
                    log.warn(fileLabel, 'is a library file - scripts that require() it will see the old version until they or the daemon are restarted');
                    return;
                }
                if (isDisabledPath(filePath) || isInDisabledDir(filePath, dir)) {
                    log.debug(fileLabel, 'is disabled - ignoring change');
                    return;
                }
                log.info(fileLabel, 'change detected. hot-reloading.');
                unloadScript(filePath);
                loadScript(filePath);
            } else if (event === 'add' && filePath.endsWith('.js')) {
                if (isLibFile(filePath, dir)) {
                    log.debug(fileLabel, 'is a library file - not loading as script');
                    return;
                }
                if (isDisabledPath(filePath) || isInDisabledDir(filePath, dir)) {
                    log.debug(fileLabel, 'is disabled - not loading as script');
                    return;
                }
                log.info(fileLabel, 'added. loading.');
                loadScript(filePath);
            } else if (event === 'unlink' && filePath.endsWith('.js')) {
                if (scripts[filePath]) {
                    log.info(fileLabel, 'removed. unloading.');
                    unloadScript(filePath);
                }
            }
        });
    }
}
function start() {
    if (config.heartbeat?.enabled) {
        const _hbInterval = typeof config.heartbeat.interval === 'number' ? config.heartbeat.interval : 50;
        const _hbThreshold = typeof config.heartbeat.threshold === 'number' ? config.heartbeat.threshold : 300;
        let _lastBeat = Date.now();
        const _hbTimer = setInterval(() => {
            const now = Date.now();
            const lag = now - _lastBeat - _hbInterval;
            const prevBeat = _lastBeat;
            _lastBeat = now;
            if (lag > _hbThreshold) {
                // Attribute to a script only if it dispatched a callback since the previous beat.
                const label = _blockingScriptTs >= prevBeat ? (_blockingScript ?? 'unknown') : 'unknown';
                if (lag > 2000) {
                    log.warn(`event loop blocked ${lag}ms — script: ${label}`);
                } else {
                    log.warn(`event loop lag ${lag}ms — last active script: ${label}`);
                }
            }
        }, _hbInterval);
        _hbTimer.unref();
    }

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
