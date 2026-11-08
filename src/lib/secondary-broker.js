'use strict';
/**
 * An additional ("secondary") MQTT broker: the connection, its state, and a short
 * offline queue for publishes. The primary broker stays what it is in index.js; a secondary never
 * blocks the start or the health of the daemon — it connects in the background, reconnects by
 * itself, and tells the daemon about every message and every change of its connection state.
 *
 * Config: `brokers: { <name>: { url, username, password, ca, cert, key, mqttVersion, mirror } }`.
 * A name is `[A-Za-z0-9_-]+`; it names the broker in `she.mqtt('<name>')`, in the state store
 * (`mqtt@<name>::<topic>`) and in the UI.
 */

const { EventEmitter } = require('events');
const { normalizeRules } = require('./mirror');

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const OFFLINE_QUEUE_MAX = 1000;
const OFFLINE_QUEUE_TTL_MS = 60_000;
const ERROR_LOG_INTERVAL_MS = 60_000;
const RECONNECT_PERIOD_MS = 5000;
const CONNECT_TIMEOUT_MS = 10_000;

/** a broker URL without its credentials, for the status and the log */
function redactUrl(url) {
    try {
        const u = new URL(String(url));
        u.username = '';
        u.password = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return String(url).replace(/\/\/[^@/]*@/, '//');
    }
}

/**
 * Read and validate `config.brokers`.
 * @param {*} raw
 * @returns {{ brokers: object[], errors: string[] }} the definitions in config order
 */
function parseBrokers(raw) {
    const brokers = [];
    const errors = [];
    if (raw === undefined || raw === null) return { brokers, errors };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('brokers must be an object: { "<name>": { "url": … } }');
        return { brokers, errors };
    }
    for (const [name, def] of Object.entries(raw)) {
        if (!NAME_RE.test(name)) {
            errors.push(`brokers: "${name}" is not a valid broker name (letters, digits, - and _ only)`);
            continue;
        }
        if (!def || typeof def !== 'object' || Array.isArray(def)) {
            errors.push(`brokers.${name}: not an object`);
            continue;
        }
        if (typeof def.url !== 'string' || !def.url) {
            errors.push(`brokers.${name}: url missing`);
            continue;
        }
        const { rules, errors: ruleErrors } = normalizeRules(def.mirror, name);
        errors.push(...ruleErrors);
        brokers.push({
            name,
            url: def.url,
            username: typeof def.username === 'string' && def.username ? def.username : undefined,
            password: typeof def.password === 'string' && def.password ? def.password : undefined,
            ca: def.ca || undefined,
            cert: def.cert || undefined,
            key: def.key || undefined,
            mqttVersion: def.mqttVersion !== undefined ? String(def.mqttVersion) : '',
            rules,
        });
    }
    return { brokers, errors };
}

class SecondaryBroker extends EventEmitter {
    /**
     * @param {object} def a definition from parseBrokers
     * @param {object} deps
     * @param {Function} deps.connect mqtt.connect (or a stand-in for the tests)
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} deps.log
     * @param {() => number} [deps.now]
     */
    constructor(def, deps) {
        super();
        this.name = def.name;
        this.url = def.url;
        this.def = def;
        this.rules = def.rules || [];
        this.client = null;
        this.connected = false;
        this.since = null; // when the connection state last changed
        this.error = null; // the last error message, cleared on connect
        this.everConnected = false;
        this.queue = [];
        this.dropped = 0;
        this.messages = 0;
        this._log = deps.log;
        this._connect = deps.connect;
        this._now = deps.now || Date.now;
        this._lastErrorLog = new Map(); // message → ts of the last log line
        this._label = `mqtt@${this.name}`;
    }

    /** the mqtt.js options of this broker */
    options() {
        const def = this.def;
        const opts = { resubscribe: false, reconnectPeriod: RECONNECT_PERIOD_MS, connectTimeout: CONNECT_TIMEOUT_MS };
        if (def.username) opts.username = def.username;
        if (def.password) opts.password = def.password;
        if (def.ca) opts.ca = def.ca;
        if (def.cert) opts.cert = def.cert;
        if (def.key) opts.key = def.key;
        if (def.mqttVersion === '5') opts.protocolVersion = 5;
        else if (def.mqttVersion === '3') opts.protocolVersion = 3;
        return opts;
    }

    start() {
        if (this.client) return this;
        const shown = redactUrl(this.url);
        this._log.info(`${this._label}: connecting ${shown}`);
        const client = this._connect(this.url, this.options());
        this.client = client;
        client.on('connect', () => {
            const first = !this.everConnected;
            this.connected = true;
            this.everConnected = true;
            this.error = null;
            this.since = this._now();
            this._log.info(`${this._label} connected ${shown}`);
            client.subscribe('#');
            this._flushQueue();
            this.emit('connect', { first });
        });
        client.on('close', () => {
            if (this.connected) {
                this.connected = false;
                this.since = this._now();
                this._log.warn(`${this._label} disconnected ${shown} — reconnecting in the background`);
                this.emit('close');
            }
        });
        client.on('error', (err) => {
            const msg = err && err.message ? err.message : String(err);
            this.error = msg;
            const last = this._lastErrorLog.get(msg);
            if (last === undefined || this._now() - last >= ERROR_LOG_INTERVAL_MS) {
                this._lastErrorLog.set(msg, this._now());
                this._log.warn(`${this._label} ${this.everConnected ? 'error' : 'not connected'} (${msg}) — retrying in the background`);
            }
            this.emit('error', err);
        });
        client.on('message', (topic, payload, packet) => {
            this.messages++;
            this.emit('message', topic, payload, packet);
        });
        return this;
    }

    stop() {
        if (!this.client) return;
        const c = this.client;
        this.client = null;
        this.connected = false;
        try {
            c.end(true);
        } catch {
            /* already gone */
        }
    }

    /**
     * Publish, or queue briefly while offline.
     * @returns {'sent'|'queued'|'dropped'}
     */
    publish(topic, payload, opts = {}) {
        if (this.connected && this.client) {
            this.client.publish(topic, payload, opts);
            return 'sent';
        }
        if (this.queue.length >= OFFLINE_QUEUE_MAX) {
            this.queue.shift();
            this.dropped++;
        }
        this.queue.push({ topic, payload, opts, ts: this._now() });
        return 'queued';
    }

    _flushQueue() {
        if (this.queue.length === 0) return;
        const t = this._now();
        let sent = 0;
        let expired = 0;
        for (const m of this.queue) {
            if (t - m.ts > OFFLINE_QUEUE_TTL_MS) {
                expired++;
                continue;
            }
            this.client.publish(m.topic, m.payload, m.opts);
            sent++;
        }
        this.queue = [];
        this._log.info(`${this._label}: sent ${sent} message(s) queued while offline` + (expired || this.dropped ? ` (${expired + this.dropped} dropped)` : ''));
        this.dropped = 0;
    }

    /** the state for the status payload, the Runtime page and the WebSocket */
    status() {
        return {
            name: this.name,
            url: redactUrl(this.url),
            connected: this.connected,
            everConnected: this.everConnected,
            since: this.since,
            error: this.connected ? null : this.error,
            queued: this.queue.length,
            messages: this.messages,
            rules: this.rules.length,
        };
    }
}

module.exports = { SecondaryBroker, parseBrokers, redactUrl, NAME_RE, OFFLINE_QUEUE_MAX, OFFLINE_QUEUE_TTL_MS };
