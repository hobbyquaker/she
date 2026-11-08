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
// Persistent JSON-Lines log file — written alongside the pino-pretty stream,
// rotated on every start and by size (roadmap B-12; src/lib/log-file.js).
// ---------------------------------------------------------------------------
const _fs = require('fs');
const _path = require('path');
const { LOGS_DIR } = require('./lib/storage');
const secrets = require('./lib/secrets');
const _logFile = require('./lib/log-file').createLogFile({ dir: LOGS_DIR });
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
const { broadcastLog, broadcast, setWelcomeProvider, onClientMessage, onClientClose, sendWs } = require('./web/log-ws');
const shedb = require('./web/shedb');
// One level for every sink (roadmap B-12): a line below it is dropped before any work on it.
const log = require('./lib/logger').createLogger({
    redact: (s) => secrets.redact(s),
    sinks: [(level, msg) => _pino[level](msg), (level, msg) => broadcastLog({ level, msg, ts: Date.now() }), (level, msg) => _logFile.write(level, msg)],
});

// Secrets store (roadmap A5): read once at startup; the UI/CLI keep it current afterwards.
{
    const st = secrets.load();
    if (st.status === 'locked' || st.status === 'error') log.warn('secrets: ' + st.error + ' — she.secrets.get() returns undefined until the key is available');
    else if (st.groups > 0) log.info(`secrets: ${st.groups} group(s) loaded`);
}
const pkg = require('../package.json');

// ---------------------------------------------------------------------------
// Safe mode (roadmap S4): start the daemon without executing any user script.
// Entered explicitly with --safe-mode, or automatically when the previous run
// did not shut down cleanly — a script blocking the event loop forever leaves
// the sentinel behind because neither the exit handler nor SIGTERM ever runs.
// ---------------------------------------------------------------------------
const _sentinelFile = _path.join(require('./lib/storage').STORAGE_ROOT, '.she-running');

/**
 * Who left the marker behind: `null` nobody (clean start), `'live'` a second instance
 * sharing this data directory (documented setup — see cli.md "Multiple instances"),
 * `'stale'` a run that was killed. Only 'stale' means safe mode; a PID reused by an
 * unrelated process after a reboot is the one case this misses, which is the harmless
 * direction to be wrong in.
 */
const _crashRecord = require('./lib/crash-record');
const _crashFile = _path.join(require('./lib/storage').STORAGE_ROOT, '.she-crashes.json');
let _deadRun = null; // the stale sentinel's { pid, startMs }
function _sentinelState() {
    let parsed;
    try {
        parsed = _crashRecord.parseSentinel(_fs.readFileSync(_sentinelFile, 'utf8'));
    } catch {
        return null; // no marker
    }
    if (!parsed.pid) {
        _deadRun = parsed;
        return 'stale';
    }
    try {
        process.kill(parsed.pid, 0);
        return 'live';
    } catch (e) {
        if (e.code === 'EPERM') return 'live'; // alive, just not ours
        _deadRun = parsed;
        return 'stale';
    }
}
const _sentinelBefore = _sentinelState();
// A stale sentinel alone is no longer a reason for safe mode (roadmap A10): only a crash that
// repeats and happens early — the signature of a script that kills the daemon at load — is.
// A single crash after days of uptime restarts normally, so the house keeps its automation.
let _crashEval = null;
if (_sentinelBefore === 'stale') {
    _crashEval = _crashRecord.evaluate(_deadRun, _crashRecord.readCrashes(_crashFile), {
        earlyCrashSec: config.safeModeEarlyCrash,
        crashCount: config.safeModeCrashCount,
        windowSec: config.safeModeCrashWindow,
    });
    _crashRecord.writeCrashes(_crashFile, _crashEval.crashes);
}
const SAFE_MODE = config.safeMode === true || (config.safeModeAutoDetect !== false && _sentinelBefore === 'stale' && !!_crashEval?.safeMode);
const SAFE_MODE_REASON = !SAFE_MODE ? null : config.safeMode === true ? '--safe-mode' : _crashEval.reason;
let _sentinelWritten = false;
function _clearSentinel() {
    if (!_sentinelWritten) return;
    _sentinelWritten = false;
    try {
        _fs.unlinkSync(_sentinelFile);
    } catch {
        /* already gone */
    }
}
if (_sentinelBefore !== 'live') {
    try {
        _fs.writeFileSync(_sentinelFile, _crashRecord.formatSentinel(process.pid, Date.now()));
        _sentinelWritten = true;
    } catch (e) {
        // not fatal — auto-detect simply never triggers when the file cannot be written
        console.error('could not write ' + _sentinelFile + ': ' + e.message);
    }
}
// Runs on exit(0) from the restart endpoint and on a normal end of the event loop.
process.on('exit', _clearSentinel);
// Wall-clock budget for a script's synchronous top-level code (0 = no limit).
const SCRIPT_TIMEOUT_MS = typeof config.scriptTimeout === 'number' && config.scriptTimeout >= 0 ? config.scriptTimeout : 5000;

/** remember which topics a script publishes to (roadmap I19), at most 200 per script */
function recordPublish(scriptFile, topic) {
    let set = scriptPublishes.get(scriptFile);
    if (!set) {
        set = new Set();
        scriptPublishes.set(scriptFile, set);
    }
    if (set.size < 200 || set.has(topic)) set.add(topic);
}

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
_pino.level = log.level;

// Safety net: unhandled Promise rejections from async script callbacks are not caught
// by the per-script domain (Node.js domains don't intercept Promise rejections).
// Log the error instead of letting Node.js crash the process.
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    log.error('unhandled promise rejection — add try/catch to async script callbacks:\n' + msg);
});

log.info('she ' + pkg.version + ' starting');
if (_sentinelBefore === 'live') log.info(`another she instance already uses ${require('./lib/storage').STORAGE_ROOT} — leaving its ${_path.basename(_sentinelFile)} marker alone`);
if (SAFE_MODE) {
    if (config.safeMode === true) log.warn('SAFE MODE (--safe-mode): user scripts are not loaded. Restart without the flag to run them.');
    else
        log.warn(
            `SAFE MODE: ${_crashEval.reason} — ${_sentinelFile} was left behind each time, so the daemon was killed rather than stopped shortly after start; a script may be blocking the event loop or crashing the daemon at load. User scripts are not loaded; fix the script and restart. Set "safeModeAutoDetect": false to disable this detection, or raise safeModeCrashCount.`,
        );
} else if (_sentinelBefore === 'stale' && _crashEval) {
    log.warn(`${_crashEval.message} (${_sentinelFile} was left behind${config.safeModeAutoDetect === false ? '; safe-mode detection is off' : ''})`);
}
// a run that stays up past the early-crash threshold is healthy: the crash record starts over
if (_sentinelBefore !== 'live' && !SAFE_MODE) {
    setTimeout(
        () => {
            _crashRecord.writeCrashes(_crashFile, []);
        },
        (config.safeModeEarlyCrash || 300) * 1000,
    ).unref();
}
log.debug('loaded config: ' + JSON.stringify(require('./lib/redact-config').redactConfig(config)));

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
            updateChannel: config.updateChannel,
        })
        .then((actualPort) => log.info('http server listening on :' + actualPort))
        .catch((err) => {
            log.error('http server start failed:', err.message);
            process.exit(1);
        });
    require('./web/broker-api').setLogger(log);
    require('./web/server').setLogger(log);
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
const { trackTimeout, isValidDelay, describeDelay } = require('./lib/script-timers');
const timing = require('./lib/timing');
const timeLib = require('./lib/time');
const publishChanged = require('./lib/publish-changed');
const { Runtime } = require('./lib/runtime');
const { callerLine } = require('./lib/call-site');
const { createCommander } = require('./lib/command');
const { statusTopicWarning, scanPublishTopics } = require('./lib/command-topics');
// What every script has registered, with statistics — the Runtime page and the editor's panel
const runtime = new Runtime();
/** the script line a registration came from, or null */
const lineOf = (file) => callerLine(file)?.line ?? null;
const sandboxModules = [];
const store = new StateStore();
if (typeof config.port !== 'undefined') require('./web/broker-api').setStore(store);
// Additional brokers: name → SecondaryBroker; filled below once the primary is set up.
// Their topics live under `mqtt@<name>::`, so everything that reads `mqtt::` keeps seeing the primary only.
const brokers = new Map();
const { SecondaryBroker, parseBrokers } = require('./lib/secondary-broker');
const { createMirror } = require('./lib/mirror');
// The mirror rules' engine: `in` rules publish on the primary, `out` rules on a secondary (the
// clients are looked up at publish time — both exist only once the connections below are set up).
const mirror = createMirror({
    publishPrimary: (topic, payload, opts) => {
        if (!mqtt || !connected) return false;
        mqtt.publish(topic, payload, opts);
        return true;
    },
    publishSecondary: (name, topic, payload, opts) => {
        const b = brokers.get(name);
        if (!b) return false;
        return b.publish(topic, payload, opts) !== 'dropped';
    },
    log,
});
const scripts = {};
const scriptOrigins = new Map(); // file â†’ 'builtin' | 'user'
const subscriptions = [];
const mqttEventCallbacks = [];
const varSubscriptions = []; // store-based var:: subscriptions { key, handler, _script }

// Per-script resource tracking for hot-reload
const scriptJobs = new Map(); // scriptFile â†’ node-schedule Job[]
const scriptPublishes = new Map(); // scriptFile → Set<topic> a script published to (roadmap I19; capped)
const scriptTimers = new Map(); // scriptFile â†’ Set<timer id>
const scriptUnloadHooks = new Map(); // scriptFile → Set<fn> run first when the script is unloaded

const _global = {};

// One store listener serves every she.on('var::…') of every script. Before, each call
// added a listener of its own, so Node warned about MaxListeners from the eleventh on; now a
// registration is an entry in varSubscriptions, which unloadScript removes.
store.on('change', (changedKey, val, obj, prevObj) => {
    if (!changedKey.startsWith('var::')) return;
    for (const sub of varSubscriptions.slice()) {
        if (sub.key === changedKey) _dispatch(sub._script, () => sub.callback(val, obj, prevObj), sub._rt);
    }
});

// she.mqtt.command waits for the device's status: one store listener serves every pending command.
// Keyed by the store key (`mqtt::<topic>`, or `mqtt@<broker>::<topic>` on an additional broker).
const commandWatchers = new Map(); // store key → Set<cb(val)>
store.on('change', (changedKey, val) => {
    if (commandWatchers.size === 0) return;
    const set = commandWatchers.get(changedKey);
    if (!set) return;
    for (const cb of [...set]) cb(val);
});
function watchKey(key, cb) {
    let set = commandWatchers.get(key);
    if (!set) {
        set = new Set();
        commandWatchers.set(key, set);
    }
    set.add(cb);
    return () => {
        set.delete(cb);
        if (set.size === 0) commandWatchers.delete(key);
    };
}

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
function _dispatch(label, fn, handler) {
    _blockingScript = label;
    const t0 = handler ? performance.now() : 0;
    let result;
    let failed = false;
    try {
        result = fn();
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        // Record end-time synchronously — no setImmediate, which would race with the
        // heartbeat timer when blocking occurs inside a poll-phase (I/O) callback.
        _blockingScriptTs = Date.now();
        // the handler's statistics: fires, time, errors — since load and over the last five minutes
        if (handler) handler.stats.record(performance.now() - t0, failed, _blockingScriptTs);
    }
    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
        result.catch((err) => {
            if (handler) handler.stats.fail();
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

// she.time: the zone, locale and holiday table every script's helpers use — validated once,
// a bad value is logged once here and replaced by the default.
const timeSettings = timeLib.settingsFromConfig(config, (msg) => log.warn(msg));
log.info(
    `she.time: zone ${timeSettings.timeZone}, locale ${timeSettings.locale}, holidays ${timeSettings.holidays || 'not configured'}` +
        (timeSettings.holidaysExtra.length ? ` + ${timeSettings.holidaysExtra.length} extra` : ''),
);

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
                _dispatch(obj._script, obj.domain.bind(obj.callback), obj._rt);
            } else {
                // Schedule the event and track the job so it can be cancelled on script unload
                obj._job = scheduler.scheduleJob(event, () => _dispatch(obj._script, obj.domain.bind(obj.callback), obj._rt));
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
let _matterStoragePath = null;

function _maybeStart() {
    if (_started || !_mqttGate || !_matterGate) {
        if (!_started && _mqttGate && !_matterGate) {
            log.info('waiting for matter controller before starting scripts');
        }
        return;
    }
    _started = true;
    start();
    // the Matter ↔ MQTT bridge needs both: the controller and the retained state (M19)
    if (config.matterStorage) {
        try {
            require('./matter/mqtt-bridge').start();
        } catch (err) {
            log.warn('matter bridge start failed:', err.message);
        }
        // Device health (M21): batteries, last seen, offline history — published under <name>/status/matter/health
        try {
            require('./matter/device-health').start({
                publish: (topic, payload, opts) => {
                    if (mqtt && connected) mqtt.publish(topic, payload, opts || {});
                },
                name: config.name,
                log,
                broadcast,
                storageDir: _matterStoragePath,
            });
        } catch (err) {
            log.warn('matter device health start failed:', err.message);
        }
        // Thread health alerts (M26): evaluated once a minute, published under <name>/status/thread/health
        try {
            require('./matter/thread-health').start({
                publish: (topic, payload, opts) => {
                    if (mqtt && connected) mqtt.publish(topic, payload, opts || {});
                },
                name: config.name,
                log,
                broadcast,
            });
        } catch (err) {
            log.warn('matter thread health start failed:', err.message);
        }
    }
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
require('./web/mqtt-api').init(
    store,
    () => mqtt,
    (name) => brokers.get(name) || null,
);
require('./web/services-api').init(store, () => mqtt, {
    getMqttConfig: () => ({ url: config.url, username: config.mqttUsername, password: config.mqttPassword }),
});

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

function countTopics(broker) {
    let topics = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of store.mqttEntries(broker)) topics++;
    return topics;
}

/** the additional brokers' state for the status payload, the Runtime page and the WebSocket */
function brokerStatuses() {
    const out = [];
    for (const b of brokers.values()) out.push({ ...b.status(), topics: countTopics(b.name), mirror: mirror.stats(b.name) });
    return out;
}
function broadcastBrokers() {
    if (brokers.size > 0) broadcast({ type: 'mqtt:brokers', brokers: brokerStatuses() });
}

/**
 * The daemon's gauges: rates since the previous sample (message rate, CPU, event-loop utilisation
 * and lag), memory, counts. One sampler owns the interval counters — every reader (the status
 * endpoint, the Runtime page, the hour's history) sees the same sample instead of resetting the
 * counters under each other. Sampled every 10 s, every second while a Runtime page is open; the
 * history keeps one sample per 10 s for an hour.
 */
let _statsLagMax = 0; // the worst event-loop lag since the last maintenance/stats sample
function sampleGauges() {
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
    // the histogram is NaN before the first measurement of an interval — that is 0 lag, not null
    const elMeanMs = Math.round(_elHisto.mean / 1e6) || 0;
    const elMaxMs = Math.round(_elHisto.max / 1e6) || 0;
    _elHisto.reset();
    if (elMaxMs > _statsLagMax) _statsLagMax = elMaxMs;
    const mem = process.memoryUsage();
    const sample = {
        ts: now,
        mqttMsgPerSec,
        cpuPercent,
        eluPercent: Math.round(eluDelta.utilization * 100),
        elMeanMs,
        elMaxMs,
        memMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        topics: countTopics(),
        handlers: runtime.handlers.size,
        pendingTimers: runtime.pending.size,
    };
    runtime.latestGauges = sample;
    runtime.gauges.push(sample);
    return sample;
}
sampleGauges();

/**
 * The daemon's own process statistics: what every mqtt-smarthome adapter publishes
 * as <name>/maintenance/stats — retained, every statsInterval seconds (0 disables) — so the
 * Services page, InfluxDB and Elasticsearch keep she's memory trend like any adapter's. The last
 * sample is also served in /she/status as `stats`.
 */
const _processStats = require('./lib/process-stats');
const countSchedules = () => {
    let n = 0;
    for (const h of runtime.handlers.values()) if (h.kind === 'schedule' || h.kind === 'sun') n++;
    return n;
};
const _procStats = _processStats.createProcessStats({
    takeLagMax: () => {
        const v = _statsLagMax;
        _statsLagMax = 0;
        return v;
    },
    counts: () => ({
        scripts: Object.keys(scripts).length,
        topics: countTopics(),
        handlers: subscriptions.length + varSubscriptions.length + mqttEventCallbacks.length,
        timers: runtime.pending.size,
        schedules: countSchedules(),
    }),
});
let _lastStats = null;
const STATS_TOPIC = config.name + '/maintenance/stats';
const _statsSeconds = Number(config.statsInterval);
if (_statsSeconds > 0) {
    const publishStats = () => {
        _lastStats = _procStats.sample();
        if (mqtt && connected) mqtt.publish(STATS_TOPIC, JSON.stringify(_lastStats), { retain: true });
    };
    setInterval(publishStats, _statsSeconds * 1000).unref();
}

// Register runtime stats provider for GET /she/status
const statsSnapshot = () => {
    const g = runtime.latestGauges || sampleGauges();
    const { mqttMsgPerSec, cpuPercent, eluPercent, elMeanMs, elMaxMs, memMb, heapMb } = g;
    const topics = countTopics();
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
        heapMb,
        cpuPercent,
        eluPercent,
        elMeanMs,
        elMaxMs,
        pendingTimers: runtime.pending.size,
        schedules: countSchedules(),
        commandsFailed: runtime.commandsFailed,
        memory: process.memoryUsage(),
        resources: _processStats.activeResources(),
        statsTopic: _statsSeconds > 0 && config.url ? STATS_TOPIC : null,
        statsInterval: _statsSeconds > 0 ? _statsSeconds : 0,
        stats: _lastStats,
        safeMode: SAFE_MODE,
        safeModeReason: SAFE_MODE_REASON,
        brokers: brokerStatuses(),
    };
};
require('./web/server').setStatsProvider(statsSnapshot);

// The Runtime page and the editor's Runtime panel: a snapshot about once a second over the
// WebSocket, only to the clients that asked for it (optionally one script's part); the gauges are
// sampled every second while someone watches, every 10 s otherwise.
const _runtimeSubs = new Map(); // ws → script file | null (everything)
const scriptLabel = (f) => makeLabel(f).slice(0, -1);
const scriptOrigin = (f) => scriptOrigins.get(f) || 'user';
const fileOfLabel = (label) => Object.keys(scripts).find((f) => scriptLabel(f) === label);
function runtimeSnapshot(file) {
    return runtime.snapshot({ script: file, label: scriptLabel, origin: scriptOrigin });
}
function pushRuntime() {
    if (_runtimeSubs.size === 0) return;
    let full = null;
    const brokerList = brokers.size > 0 ? brokerStatuses() : undefined;
    for (const [ws, file] of _runtimeSubs) {
        let snap;
        if (file === null) snap = full || (full = runtimeSnapshot());
        else snap = runtimeSnapshot(file);
        sendWs(ws, { type: 'runtime', ...snap, brokers: brokerList });
    }
}
let _sampleTimer = null;
function scheduleSample() {
    if (_sampleTimer) clearTimeout(_sampleTimer);
    _sampleTimer = setTimeout(
        () => {
            sampleGauges();
            pushRuntime();
            scheduleSample();
        },
        _runtimeSubs.size > 0 ? 1000 : 10_000,
    );
    _sampleTimer.unref();
}
scheduleSample();
onClientMessage('runtime:subscribe', (ws, msg) => {
    let file = null;
    if (typeof msg.script === 'string' && msg.script) {
        file = fileOfLabel(msg.script);
        // not loaded (a library, a disabled or broken script): subscribe anyway and show it empty — the
        // panel re-subscribes when the script's running state changes
        if (!file) file = '\0unknown:' + msg.script;
    }
    const first = _runtimeSubs.size === 0;
    _runtimeSubs.set(ws, file);
    sendWs(ws, { type: 'runtime', ...runtimeSnapshot(file) });
    if (first) scheduleSample(); // from the 10 s to the 1 s cadence at once
});
onClientMessage('runtime:unsubscribe', (ws) => _runtimeSubs.delete(ws));
onClientClose((ws) => _runtimeSubs.delete(ws));
require('./web/runtime-api').init({
    runtime,
    snapshot: (label) => {
        if (!label) return runtimeSnapshot();
        const file = fileOfLabel(label);
        return runtimeSnapshot(file || '\0unknown:' + label);
    },
    history: () => ({ intervalMs: runtime.gauges.intervalMs, samples: runtime.gauges.list() }),
    log: (file, msg) => log.info(makeLabel(file), msg),
});

// Health probe for GET /she/health (roadmap A1) — cheap, no counting, no allocation.
const healthSnapshot = () => ({
    started: _started,
    mqttConfigured: !!config.url,
    mqttConnected: connected,
    scripts: Object.keys(scripts).length,
    safeMode: SAFE_MODE,
    safeModeReason: SAFE_MODE_REASON,
});
require('./web/server').setHealthProvider(healthSnapshot);

// What the AI chat may look at (roadmap I19, I27, I28): read-only views of the daemon's state.
const nextOf = (job) => {
    try {
        const d = job && typeof job.nextInvocation === 'function' ? job.nextInvocation() : null;
        const date = d && typeof d.toDate === 'function' ? d.toDate() : d;
        return date instanceof Date ? date.getTime() : null;
    } catch {
        return null;
    }
};
const introspect = {
    // the AI's publish tool (roadmap I20), guarded and confirmed in ai-api; here only the broker call —
    // on the primary, or on an additional broker named by the tool's `broker` argument
    publish: (topic, payload, opts, broker) =>
        new Promise((resolve, reject) => {
            const str = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
            if (broker) {
                const b = brokers.get(broker);
                if (!b) return reject(new Error(`no additional broker "${broker}" is configured`));
                if (!b.connected) return reject(new Error(`broker "${broker}" is not connected`));
                b.client.publish(String(topic), str, opts || {}, (err) => (err ? reject(err) : resolve()));
                return;
            }
            if (!mqtt || !connected) return reject(new Error('MQTT is not connected'));
            mqtt.publish(String(topic), str, opts || {}, (err) => (err ? reject(err) : resolve()));
        }),
    brokers: () => brokerStatuses(),
    config: () => ({
        name: config.name,
        variablePrefix: config.variablePrefix || 'var',
        version: pkg.version,
        timezone: timeSettings.timeZone,
        locale: timeSettings.locale,
        holidays: timeSettings.holidays,
    }),
    scripts: () =>
        Object.keys(scripts).map((file) => ({
            file,
            label: makeLabel(file).slice(0, -1),
            origin: scriptOrigins.get(file) || 'user',
            subscriptions: subscriptions.filter((x) => x._script === file).flatMap((x) => (Array.isArray(x.topic) ? x.topic : [x.topic])),
            varSubscriptions: varSubscriptions.filter((x) => x._script === file).map((x) => x.key),
            publishes: [...(scriptPublishes.get(file) || [])],
            jobs: (scriptJobs.get(file) || []).filter(Boolean).map((job) => ({ next: nextOf(job) })),
            sunEvents: sunEvents.filter((e) => e._script === file).map((e) => ({ pattern: e.pattern, next: nextOf(e._job) })),
            timers: [...(scriptTimers.get(file) || [])].map((t) => ({
                due: t.due || null,
                start: t.start || null,
                every: t.every || null,
                kind: t.kind || null,
                name: t.name || null,
            })),
        })),
    stats: statsSnapshot,
    health: healthSnapshot,
    instances: () => require('./lib/services-inventory').analyzeServices(store.mqttEntries()).instances,
    devices: () => require('./lib/ha-discovery').analyzeDiscovery(store.mqttEntries()).devices,
};
require('./web/ai-api').init(store, log, introspect);

// Push current script:running state so the UI green dots survive a browser reload.
setWelcomeProvider(() => Object.keys(scripts).map((f) => ({ type: 'script:running', path: makeLabel(f).slice(0, -1), running: true })));

if (!config.url) {
    // config.config is the file actually in use — hardcoding ~/.she misleads anyone
    // running with --data-dir / SHE_DATA_DIR or --config.
    log.warn('no MQTT broker URL configured â€” set "url" in ' + config.config + ' (or pass --url / SHE_URL)');
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
        log.info('mqtt connected ' + require('./lib/redact-config').redactUrl(String(config.url)));
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

        // Mirror rules: what an `in` rule just published here comes back as this message —
        // stored like any other, never mirrored on. Everything else may leave through the `out` rules.
        if (!mirror.consumeEcho(null, topic, payload)) mirror.fromPrimary(topic, payload, msg);

        if (shedb.handleMqttMessage(topic, payload)) return;

        // matter/set/… and matter/get/… go to the Matter bridge (M19); the message is still stored below
        if (config.matterStorage && _started) {
            try {
                require('./matter/mqtt-bridge').onMessage(topic, payload);
            } catch (err) {
                log.warn('matter bridge:', err.message);
            }
        }

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
            // dispatch now, as setVariable() does: the broker's echo of the status publish below finds the store
            // already updated, so a { change: true } subscription would never see the change (B-22)
            stateChange(topic, state, oldState, msg);
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
            // our own echo: she publishes <prefix>/status/<name> retained after a var/set or she.var.set(), and the
            // broker delivers it back (we subscribe to #). The subscriptions were dispatched at set time; the
            // echo carries the stored state verbatim (same ts and lc), so it is stored again but not dispatched.
            if (
                topicArr[0] === config.variablePrefix &&
                topicArr[1] === 'status' &&
                oldState.ts === state.ts &&
                oldState.lc === state.lc &&
                JSON.stringify(oldState.val) === JSON.stringify(state.val)
            ) {
                return;
            }
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

// ---------------------------------------------------------------------------
// Additional brokers: connected in the background, never waited for. Their messages
// go to the state store under `mqtt@<name>::<topic>` and to the subscriptions made through
// `she.mqtt('<name>')`; the mirror rules copy what the config says into the primary and back.
// ---------------------------------------------------------------------------
{
    const parsed = parseBrokers(config.brokers);
    for (const e of parsed.errors) log.warn('config: ' + e);
    if (parsed.brokers.length > 0 && !config.url) log.warn('brokers: additional brokers are configured but no primary broker (url) — the mirror rules have nowhere to publish');
    for (const def of parsed.brokers) {
        const b = new SecondaryBroker(def, { connect: modules.mqtt.connect, log });
        brokers.set(def.name, b);
        mirror.setRules(def.name, def.rules);
        b.on('connect', () => broadcastBrokers());
        b.on('close', () => broadcastBrokers());
        b.on('error', () => {
            /* logged by the broker itself; the status carries the message */
        });
        b.on('message', (topic, payload, msg) => handleSecondaryMessage(def.name, topic, payload, msg));
    }
    if (brokers.size > 0) {
        log.info(`brokers: ${brokers.size} additional broker(s): ${[...brokers.keys()].join(', ')}`);
        setWelcomeProvider(() => ({ type: 'mqtt:brokers', brokers: brokerStatuses() }));
        for (const b of brokers.values()) b.start();
    }
}

/** a message from an additional broker: stored under its namespace, dispatched to its subscriptions, mirrored in */
function handleSecondaryMessage(name, topic, payload, msg) {
    _mqttMsgCount++;
    const ns = StateStore.mqttNamespace(name);
    const echo = mirror.consumeEcho(name, topic, payload);
    if (payload.length === 0) {
        const emptyOld = store.getObject(ns + topic) || {};
        store.delete(ns + topic);
        const ts = Date.now();
        stateChange(topic, { val: '', ts, lc: ts }, emptyOld, msg, name);
    } else {
        const state = require('./lib/parse-payload')(payload);
        if (!state.ts) state.ts = Date.now();
        const oldState = store.getObject(ns + topic) || {};
        if (state.lc === undefined) state.lc = oldState.val !== state.val ? state.ts : (oldState.lc ?? state.ts);
        store.setObject(ns + topic, state);
        stateChange(topic, state, oldState, msg, name);
    }
    if (!echo) mirror.fromSecondary(name, topic, payload, msg);
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
    _matterStoragePath = matterStoragePath;
    require('./matter/mqtt-bridge').init({
        publish: (topic, payload, opts) => {
            if (!mqtt) throw new Error('MQTT is not connected');
            mqtt.publish(topic, payload, opts || {});
        },
        isConnected: () => !!mqtt && connected,
        store,
        log,
        storageDir: matterStoragePath,
        broadcast,
    });
    // Scripts wait for the controller (see _maybeStart) — but never forever:
    // a hanging start must not block the whole script engine.
    const _matterStartTimeout = setTimeout(() => {
        if (!_started) log.warn('matter controller not ready after 30s — starting scripts anyway');
        matterGateOpen();
    }, 30000);
    matterController
        .init(matterStoragePath, log, broadcast, { dclOffline: config.matterDclOffline === true })
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

/**
 * Dispatch a stored state change to the matching subscriptions of its broker.
 * @param {string|null} [broker] null: the primary; a name: the additional broker the message came from
 */
function stateChange(topic, state, oldState, msg, broker = null) {
    subscriptions.forEach((subs) => {
        if ((subs.broker || null) !== broker) return;
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

            /**
             * @callback subscribeCallback
             * @param {string} topic - the topic that triggered this callback
             * @param {mixed} val - the val property of the new state
             * @param {object} obj - new state - the whole state object (e.g. {"val": true, "ts": 12346345, "lc": 12346345} )
             * @param {object} objPrev - previous state - the whole state object
             * @param {object} msg - the mqtt message as received from MQTT.js
             */
            const run = () => subs.deliver(topic, state.val, state, oldState, msg);
            const timers = scriptTimers.get(subs._script) || new Set();
            // The delay timer is tracked like a script's own setTimeout, so a reload of
            // the script between the message and the shifted callback cancels the callback instead
            // of running the unloaded script's code.
            if (delay === 0) {
                trackTimeout(timers, run, 0);
            } else {
                // a shifted delivery is a pending timer of the script: listed under the
                // subscription's `shift` group, cancellable from the editor
                const group = runtime.timerGroup(subs._script, { kind: 'shift', name: subs.topic, line: subs._rt?.line ?? null });
                let pending = null;
                const id = trackTimeout(
                    timers,
                    () => {
                        runtime.removePending(pending);
                        run();
                    },
                    delay,
                    { kind: 'shift', name: subs.topic },
                );
                const clear = () => {
                    timers.delete(id);
                    clearTimeout(id);
                    runtime.removePending(pending);
                };
                pending = runtime.addPending(group, {
                    due: id.due,
                    start: id.start,
                    fire: () => {
                        clear();
                        run();
                    },
                    cancel: clear,
                });
            }
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

function runScript(script, name, _origin, source) {
    const scriptDir = path.dirname(path.resolve(name));
    const logLabel = makeLabel(name);

    // Initialise per-script resource tracking
    if (!scriptJobs.has(name)) scriptJobs.set(name, []);
    if (!scriptTimers.has(name)) scriptTimers.set(name, new Set());
    const _myJobs = scriptJobs.get(name);
    const _myTimers = scriptTimers.get(name);
    const _myHooks = new Set();
    scriptUnloadHooks.set(name, _myHooks);
    let _unloaded = false;
    let _subCount = 0;
    _myHooks.add(() => {
        _unloaded = true;
    });

    log.debug(logLabel, 'creating domain');
    const scriptDomain = domain.create();

    log.debug(logLabel, 'creating sandbox');

    function serializeArg(a) {
        return a !== null && typeof a === 'object' ? JSON.stringify(a) : a;
    }

    /**
     * The script's one-shot timer: the delay is validated and a bad one is logged with the script's
     * name, the callback runs in the script's domain, the id is tracked for the unload
     * and carries kind and name for the timer list. Every timer API of the sandbox goes through here.
     */
    function _timeout(fn, delay, meta = {}, api = 'setTimeout') {
        if (_unloaded) {
            log.debug(logLabel, `${api} after unload ignored`);
            return null;
        }
        // The runtime model groups timers by kind, name and the line that created them: a plain
        // setTimeout by its call site, a timing helper by the line the helper was created on (the
        // helper passes it in its meta — the stack at re-arm time points into a callback).
        const kind = meta.kind || 'timer';
        const line = meta.line !== undefined ? meta.line : kind === 'timer' ? lineOf(name) : null;
        const group = runtime.timerGroup(name, { kind, name: meta.name, line });
        const run = scriptDomain.bind(() => _dispatch(name, fn, group));
        let pending = null;
        const id = trackTimeout(
            _myTimers,
            () => {
                runtime.removePending(pending);
                run();
            },
            delay,
            {
                warn: (msg) => log.warn(logLabel, msg),
                api,
                kind: meta.kind,
                name: meta.name,
            },
        );
        pending = runtime.addPending(group, {
            due: id.due,
            start: id.start,
            fire:
                meta.actions && meta.actions.run === false
                    ? null
                    : () => {
                          _clearTimeout(id);
                          run();
                      },
            cancel: () => {
                _clearTimeout(id);
                if (typeof meta.onCancel === 'function') meta.onCancel();
            },
            extra: meta.extra,
        });
        id.rt = pending;
        return id;
    }
    function _clearTimeout(id) {
        _myTimers.delete(id);
        clearTimeout(id);
        if (id && id.rt) runtime.removePending(id.rt);
    }
    const _timing = timing.createTimingHelpers({
        setTimeout: (fn, ms, meta) => _timeout(fn, ms, meta),
        clearTimeout: _clearTimeout,
        onUnload: (fn) => {
            _myHooks.add(fn);
            return () => _myHooks.delete(fn);
        },
        line: () => lineOf(name),
    });
    const _lintWarned = new Set(); // topics already warned about (load-time scan and runtime)
    function lintPublish(topic, api, line, broker = null) {
        const key = (broker || '') + '\0' + topic;
        if (_lintWarned.has(key)) return;
        const ns = StateStore.mqttNamespace(broker);
        const why = statusTopicWarning(topic, (t) => store.has(ns + t));
        if (!why) return;
        _lintWarned.add(key);
        log.warn(logLabel, `${api}${line ? ` (line ${line})` : ''}: ${why}`);
    }
    // one commander per broker the script talks to: the primary's, and one for each she.mqtt('<name>')
    const _commanders = new Map();
    function commanderFor(broker) {
        const k = broker || '';
        if (_commanders.has(k)) return _commanders.get(k);
        const ns = StateStore.mqttNamespace(broker);
        const cmd = createCommander({
            publish: (topic, payload) => {
                if (broker) {
                    brokers.get(broker).publish(topic, payload, {});
                    return;
                }
                recordPublish(name, topic);
                if (mqtt && connected) mqtt.publish(topic, payload, {});
            },
            get: (topic) => store.get(ns + topic),
            has: (topic) => store.has(ns + topic),
            offline: broker ? () => (brokers.get(broker).connected ? null : `broker "${broker}" not connected`) : null,
            watch: (topic, cb) => watchKey(ns + topic, cb),
            setTimeout: (fn, ms, meta) => _timeout(fn, ms, meta, 'she.mqtt.command'),
            clearTimeout: _clearTimeout,
            onUnload: (fn) => {
                _myHooks.add(fn);
                return () => _myHooks.delete(fn);
            },
            warn: (msg) => log.warn(logLabel, msg),
            onFail: () => {
                runtime.commandsFailed++;
            },
            line: () => lineOf(name),
        });
        _commanders.set(k, cmd);
        return cmd;
    }
    /** the last payload per topic for pub({ changed: true }), per broker */
    const _lastPayloads = new Map();
    function lastPayloadsOf(broker) {
        const k = broker || '';
        if (!_lastPayloads.has(k)) _lastPayloads.set(k, new Map());
        return _lastPayloads.get(k);
    }
    /** the additional broker behind a she.mqtt('<name>') call, or a TypeError at the call site */
    function brokerOf(broker) {
        const b = brokers.get(broker);
        if (!b) {
            const known = [...brokers.keys()];
            throw new TypeError(`she.mqtt("${broker}"): no such broker — ${known.length ? 'configured: ' + known.join(', ') : 'no additional brokers are configured'}`);
        }
        return b;
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
            return _mqttsub(null, topic, ...rest);
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
            return _schedule(pattern, ...rest);
        },

        /**
         * Publish a MQTT message
         * @method mqttpub
         * @param {(string|string[])} topic - topic or array of topics to publish to
         * @param {(string|Object)} payload - the payload string. If an object is given it will be JSON.stringified
         * @param {Object} [options] - the options to publish with
         * @param {number} [options.qos=0] - QoS Level
         * @param {boolean} [options.retain=false] - retain flag
         * @param {boolean} [options.changed=false] - publish only when the payload differs from the last one this
         *   script published to the topic (before the first one: from the topic's current value in the state store)
         */
        mqttpub: function Sandbox_mqttpub(topic, payload, options) {
            return _mqttpub(null, topic, payload, options);
        },

        /**
         * Publish a command and wait for the device's status to confirm it. she.mqtt.command.
         * @method mqttcommand
         * @param {string} topic
         * @param {*} payload
         * @param {Object} [options] confirm, path, expect, tolerance, timeout (s), retries, quiet
         * @returns {Promise<{val, ms, tries, already?}>}
         */
        mqttcommand: function Sandbox_mqttcommand(topic, payload, options) {
            return _mqttcommand(null, topic, payload, options);
        },

        /**
         * Set a value on one or more topics
         * @method setValue
         * @param {(string|string[])} topic - topic or array of topics to set value on
         * @param {mixed} val
         */
        setValue: function Sandbox_setValue(topic, val) {
            return _setValue(null, topic, val);
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
            return _getProp(null, topic, ...props);
        },

        /**
         * Universal subscribe by namespaced key.
         * Callback receives (val, obj, prevObj).
         * @method on
         * @param {string} key  Namespaced key: 'mqtt::topic', 'mqtt@broker::topic', 'var::name', 'matter::nodeId/ep/Cluster/attr'
         * @param {function} callback
         */
        on: function Sandbox_she_on(key, callback) {
            if (typeof key !== 'string') throw new TypeError('she.on: key must be a string');
            if (typeof callback !== 'function') throw new TypeError('she.on: callback must be a function');

            const mqttKey = StateStore.parseMqttKey(key);
            if (mqttKey) {
                if (mqttKey.broker) brokerOf(mqttKey.broker);
                _mqttsub(mqttKey.broker, mqttKey.topic, { retain: true }, (_topic, val, obj, prevObj) => {
                    callback(val, obj, prevObj);
                });
            } else if (key.startsWith('var::')) {
                const varStoreKey = 'var::' + key.slice(5);
                const boundCb = scriptDomain.bind(callback);
                const handler = runtime.handler(name, { kind: 'var', name: key, line: lineOf(name) });
                // served by the one store listener at module level
                varSubscriptions.push({ key: varStoreKey, callback: boundCb, _script: name, _rt: handler });
                // Fire immediately if var already has a value (retain semantics)
                const currentVarObj = store.getObject(varStoreKey);
                if (currentVarObj !== undefined) _dispatch(name, () => boundCb(currentVarObj.val, currentVarObj, undefined), handler);
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

    // ── The MQTT primitives, scoped to a broker ─────────────────────────────────────
    // `broker` is null for the primary (she.mqtt.*, she.mqttsub, …) or the name of an additional
    // broker (she.mqtt('<name>').*). Same code, another state-store namespace and another client.

    /**
     * Subscribe to MQTT topic(s)
     * @param {string|null} broker
     * @param {(string|string[])} topic - topic or array of topics to subscribe
     * @param {Object|string|function} [options] - Options object or as shorthand to options.condition a function or string
     * @param {number} [options.shift] - delay execution in seconds. Has to be positive
     * @param {number} [options.random] - random delay execution in seconds. Has to be positive
     * @param {boolean} [options.change] - if set to true callback is only called if val changed
     * @param {boolean} [options.retain] - if set to true callback is also called on retained messages
     * @param {(string|function)} [options.condition] - conditional function or condition string
     * @param {subscribeCallback} callback
     */
    function _mqttsub(broker, topic, ...rest) {
        {
            const ns = StateStore.mqttNamespace(broker);
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
            options = options || {};

            let topics;
            if (typeof topic === 'string') topics = [topic];
            else if (typeof topic === 'object' && topic.length > 0) topics = Array.prototype.slice.call(topic);
            else return;

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

            const boundCallback = typeof callback === 'function' && scriptDomain.bind(callback);
            const label = topics.length > 1 ? `${topics[0]} +${topics.length - 1}` : topics[0];
            // one handler in the runtime model per call — the topics of an array share it, like
            // they share the limiter below
            const optNames = ['change', 'retain', 'shift', 'random', 'condition', 'debounce', 'throttle', 'maxWait', 'perTopic'].filter(
                (k) => options[k] !== undefined && options[k] !== false,
            );
            const detail =
                [broker ? `broker ${broker}` : null, topics.length > 1 ? topics.join(', ') : null, optNames.length ? optNames.join(', ') : null].filter(Boolean).join(' · ') ||
                null;
            const handler = runtime.handler(name, { kind: 'sub', name: label, detail, line: lineOf(name) });
            // what runs the callback for one event; with opts.debounce or opts.throttle the events of
            // this call are bundled — across the topics of an array, per topic with opts.perTopic
            let deliver = (t, val, obj, objPrev, msg) => _dispatch(name, () => boundCallback(t, val, obj, objPrev, msg), handler);
            const limited = timing.subscriptionLimiter(options, deliver, _timing, label);
            if (limited) deliver = limited;

            for (const tp of topics) {
                subscriptions.push({ topic: tp, options, callback: boundCallback, deliver, broker, _script: name, _rt: handler });
                _subCount++;
                if (_subCount === 1000) {
                    log.warn(
                        logLabel,
                        'has registered 1000 subscriptions — she.mqtt.sub is meant to be called when the script loads, not inside a callback: every call adds a subscription that stays until the script is unloaded',
                    );
                }

                if (options.retain && boundCallback) {
                    if (store.has(ns + tp)) {
                        deliver(tp, store.get(ns + tp), store.getObject(ns + tp));
                    } else if (tp.includes('+') || tp.endsWith('#')) {
                        for (const [t, obj] of store.mqttEntries(broker)) {
                            if (mqttWildcards(t, tp)) deliver(t, obj.val, obj);
                        }
                    }
                }
            }
        }
    }

    /** she.schedule — see the sandbox method above */
    function _schedule(pattern, ...rest) {
        {
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
                const sunDetail = [options.shift ? `shift ${options.shift}s` : null, options.random ? `random ${options.random}s` : null].filter(Boolean).join(', ') || null;
                const obj = {
                    pattern,
                    options,
                    callback,
                    context: she,
                    domain: scriptDomain,
                    _script: name,
                    _rt: null,
                };
                obj._rt = runtime.handler(name, {
                    kind: 'sun',
                    name: pattern,
                    detail: sunDetail,
                    line: lineOf(name),
                    next: () => nextOf(obj._job),
                    run: () => _dispatch(name, scriptDomain.bind(callback), obj._rt),
                });
                sunEvents.push(obj);
                sunScheduleEvent(obj);
                return;
            }

            // a Date from the sandbox is of the context's realm, so no instanceof
            const shown = pattern && typeof pattern.toISOString === 'function' ? pattern.toISOString() : typeof pattern === 'string' ? pattern : JSON.stringify(pattern);
            let handler = null;
            const runNow = () => _dispatch(name, scriptDomain.bind(callback), handler);
            const run = options.random
                ? () => {
                      // Track the random-delay timer so it is cancelled on unload
                      // if the job fires in the same tick as the script is reloaded.
                      _timeout(
                          () => runNow(),
                          (parseFloat(options.random) || 0) * 1000 * Math.random(),
                          { kind: 'schedule random', name: shown, line: handler?.line ?? null },
                          'she.schedule',
                      );
                  }
                : runNow;
            let job = null;
            job = scheduler.scheduleJob(pattern, () => {
                // A one-shot job (a Date) is done after this run: forget it, so that a script
                // scheduling a Date per event does not keep every fired job.
                if (job && job.nextInvocation() === null) {
                    const i = _myJobs.indexOf(job);
                    if (i !== -1) _myJobs.splice(i, 1);
                    runtime.removeHandler(handler);
                }
                run();
            });
            if (!job) {
                log.warn(logLabel, `she.schedule: nothing scheduled for ${shown} — not a valid pattern, or a date in the past`);
                return;
            }
            _myJobs.push(job);
            handler = runtime.handler(name, {
                kind: 'schedule',
                name: shown,
                detail: options.random ? `random ${options.random}s` : null,
                line: lineOf(name),
                next: () => nextOf(job),
                run: runNow,
            });
        }
    }

    /**
     * Publish a MQTT message — she.mqtt.pub on the primary, she.mqtt('<name>').pub on an additional broker
     * (there the message is queued briefly while the broker is offline; the primary drops it).
     * @param {string|null} broker
     */
    function _mqttpub(broker, topic, payload, options) {
        if (typeof topic === 'object' && topic.length > 0) {
            topic = Array.prototype.slice.call(topic);
            topic.forEach((tp) => {
                _mqttpub(broker, tp, payload, options);
            });
            return;
        }

        const ns = StateStore.mqttNamespace(broker);
        topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2');
        if (!broker) recordPublish(name, topic);
        lintPublish(topic, 'she.mqtt.pub', undefined, broker);

        if (typeof payload === 'object') {
            payload = JSON.stringify(payload);
        } else {
            payload = String(payload);
        }
        let changed = false;
        if (options && typeof options === 'object' && 'changed' in options) {
            ({ changed, ...options } = options);
        }
        const lastPayload = lastPayloadsOf(broker);
        if (changed && publishChanged.isRepeat(lastPayload, topic, payload, (t) => store.getObject(ns + t))) return;
        if (broker) {
            publishChanged.remember(lastPayload, topic, payload);
            brokers.get(broker).publish(topic, payload, options || {});
            return;
        }
        if (!mqtt || !connected) return; // silently drop when MQTT is not connected
        publishChanged.remember(lastPayload, topic, payload);
        mqtt.publish(topic, payload, options);
    }

    /** she.mqtt.command, scoped to a broker */
    function _mqttcommand(broker, topic, payload, options) {
        if (typeof topic === 'string') lintPublish(topic.replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2'), 'she.mqtt.command', undefined, broker);
        return commanderFor(broker)(topic, payload, options);
    }

    /** she.setValue: on the primary with the variable system, on an additional broker a plain publish */
    function _setValue(broker, topic, val) {
        if (typeof topic === 'object' && topic.length > 0) {
            topic = Array.prototype.slice.call(topic);
            topic.forEach((tp) => {
                _setValue(broker, tp, val);
            });
            return;
        }
        if (broker) {
            _mqttpub(broker, topic, val, { retain: false });
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
                _mqttpub(null, topic, val, { retain: false });
            }
        } else {
            _mqttpub(null, topic, val, { retain: false });
        }
    }

    function _getValue(broker, topic) {
        return store.get(StateStore.mqttNamespace(broker) + topic);
    }

    function _getProp(broker, topic, ...props) {
        const ns = StateStore.mqttNamespace(broker);
        if (props.length > 0) {
            let tmp = store.getObject(ns + topic);
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
        return store.getObject(ns + topic);
    }

    /**
     * The primitives behind she.mqtt('<name>'): the stdlib builds the same namespace as
     * she.mqtt from them. Throws at the call site when no such broker is configured.
     */
    function mqttScope(broker) {
        if (typeof broker !== 'string' || !broker) throw new TypeError(`she.mqtt(name): name must be a broker name (got ${typeof broker})`);
        brokerOf(broker);
        return {
            broker,
            sub: (...args) => _mqttsub(broker, ...args),
            pub: (topic, payload, options) => _mqttpub(broker, topic, payload, options),
            command: (topic, payload, options) => _mqttcommand(broker, topic, payload, options),
            get: (topic) => _getValue(broker, topic),
            getProp: (...args) => _getProp(broker, ...args),
            set: (topic, val) => _setValue(broker, topic, val),
        };
    }

    // she.log is an alias for she.info
    she.log = she.info;

    const Sandbox = {
        // setTimeout(fn) without a delay is Node's "next tick"; a delay that is given but is not a
        // number is a mistake and logged with the script's name
        setTimeout: (fn, ...rest) => {
            const [delay, ...args] = rest;
            const wrapped = args.length ? () => fn(...args) : fn;
            return _timeout(wrapped, rest.length ? delay : 0);
        },
        setInterval: (fn, ...rest) => {
            let [delay, ...args] = rest;
            if (!isValidDelay(delay)) {
                log.warn(logLabel, `setInterval: delay is not a number of milliseconds (got ${describeDelay(delay)}), using 0`);
                delay = 0;
            }
            const wrapped = args.length ? () => fn(...args) : fn;
            let handler = null;
            let pending = null;
            const tick = scriptDomain.bind(() => _dispatch(name, wrapped, handler));
            const id = setInterval(() => {
                // the pending entry is the next run: the progress bar starts over with every tick
                if (pending) {
                    pending.start = Date.now();
                    pending.due = pending.start + delay;
                }
                tick();
            }, delay);
            id.every = delay;
            id.start = Date.now();
            id.due = id.start + delay;
            _myTimers.add(id);
            const clear = () => {
                _myTimers.delete(id);
                clearInterval(id);
                runtime.removeHandler(handler);
            };
            handler = runtime.handler(name, { kind: 'interval', name: `every ${delay} ms`, line: lineOf(name), run: tick, cancel: clear });
            pending = runtime.addPending(handler, { due: id.due, start: id.start, every: delay });
            id.rt = handler;
            return id;
        },
        clearTimeout: _clearTimeout,
        clearInterval: (id) => {
            _myTimers.delete(id);
            clearInterval(id);
            if (id && id.rt) runtime.removeHandler(id.rt);
        },

        Buffer,

        require(md) {
            // A relative path is cached by Node under its resolved file; caching it here under the bare
            // specifier made two scripts requiring './util' from different directories share the first
            // one's module. The cache here is for the daemon's own modules and packages.
            const relative = /^\.\.?\//.test(md);
            if (!relative && modules[md]) {
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
            if (!relative) modules[md] = result;
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
        timezone: timeSettings.timeZone,
        locale: timeSettings.locale,
        holidays: timeSettings.holidays,
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
    // she.setTimeout / she.clearTimeout — the sandbox's tracked timers under the she object: the
    // documented aliases of the globals, and what stdlib and the sandbox modules use.
    she.setTimeout = Sandbox.setTimeout;
    she.clearTimeout = Sandbox.clearTimeout;
    // Timing helpers: their timers are the script's, so a reload clears them and
    // the timer list shows them with kind and name.
    she.debounce = _timing.debounce;
    she.throttle = _timing.throttle;
    she.timeout = _timing.timeout;
    she.retry = _timing.retry;
    // she.time: windows, wall-clock instants, holidays and formatting in the configured zone;
    // sun events come from suncalc with the coordinates she.schedule uses.
    she.time = timeLib.createTime({
        ...timeSettings,
        sunTimes: (noonMs) => suncalc.getTimes(new Date(noonMs), config.latitude, config.longitude),
        warn: (msg) => log.warn(logLabel, msg),
    });
    sandboxModules.forEach((md) => {
        md(she, { scriptDomain, scriptName, scriptFile: name, mqttScope });
    });

    // Lint before the script runs: a literal topic that an adapter writes as status is a command
    // that will never arrive (<inst>/status/… instead of <inst>/set/…)
    if (source !== undefined) {
        for (const hit of scanPublishTopics(source)) lintPublish(hit.topic, hit.api, hit.line);
    }

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
            // The timeout only covers synchronous top-level code — a callback registered
            // here can still block the loop later (that is what the heartbeat reports).
            script.runInContext(context, SCRIPT_TIMEOUT_MS > 0 ? { timeout: SCRIPT_TIMEOUT_MS } : undefined);
        } catch (e) {
            if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
                // Killing the script mid-run leaves whatever it registered before the
                // timeout in place; loading continues with the remaining scripts.
                log.error(logLabel, `top-level code did not finish within ${SCRIPT_TIMEOUT_MS} ms and was terminated ("scriptTimeout", 0 disables this)`);
                return;
            }
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
                runScript(scripts[file], file, origin, src.toString());
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

    // The script's unload hooks run first: the sandbox marks itself unloaded, a debounce
    // with flushOnUnload runs its pending call, a retry stops. Then the timers below are cleared.
    const hooks = scriptUnloadHooks.get(file);
    if (hooks) {
        scriptUnloadHooks.delete(file);
        for (const hook of hooks) {
            try {
                _dispatch(file, hook);
            } catch (err) {
                log.error(unloadLabel, 'error while unloading: ' + (err && err.stack ? err.stack : err));
            }
        }
    }

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
    scriptPublishes.delete(file);
    runtime.removeScript(file);

    // Remove store-based var:: subscriptions belonging to this script
    for (let i = varSubscriptions.length - 1; i >= 0; i--) {
        if (varSubscriptions[i]._script === file) {
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
            // the Scripts page reloads an open tab of this file (U12): every file, also libraries, disabled
            // scripts and non-.js files, since any of them may be open in a tab
            if (event === 'change') broadcast({ type: 'script:changed', path: fileLabel.slice(0, -1) });
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
    if (SAFE_MODE) {
        log.warn('safe mode: no script is loaded and the script directory is not watched. Edit or delete the offending script in the web UI, then restart the daemon.');
        return;
    }
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
    // First thing, synchronously: the async cleanup below may outlive systemd's
    // TimeoutStopSec, and a SIGKILL after that must not look like a crash.
    _clearSentinel();
    log.info(`got ${signal}. exiting.`);
    if (config.matterStorage) {
        try {
            require('./matter/mqtt-bridge').stop();
            require('./matter/thread-health').stop();
            require('./matter/device-health').stop();
        } catch {
            // ignore
        }
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
