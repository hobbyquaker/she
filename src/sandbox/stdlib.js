/* eslint-disable func-name-matching, func-names, camelcase */

module.exports = function (she, ctx = {}) {
    /**
     * @method now
     * @returns {number} ms since epoch
     */
    she.now = function Sandbox_now() {
        return new Date().getTime();
    };

    // Route a computed value to a topic string (setValue) or a callback (called as fn(topic, val)).
    function sink(target, topic, val) {
        if (typeof target === 'function') {
            target(topic, val);
        } else {
            she.setValue(target, val);
        }
    }

    // Timeout handles indexed by target (string key or function reference).
    const timerHandles = new Map();

    // Treat common MQTT string payloads as falsy: "off" (any case) matches
    // devices (Zigbee, Tasmota, etc.) that publish "off"/"OFF" instead of 0.
    function isTruthy(v) {
        if (typeof v === 'string') return v.toLowerCase() !== 'off';
        return !!v;
    }

    /**
     * Namespaced MQTT API - the primary way to interact with MQTT from scripts.
     * @namespace she.mqtt
     */
    she.mqtt = {
        /** Subscribe to one or more MQTT topics. Same signature as she.mqttsub(). */
        sub: (...args) => she.mqttsub(...args),
        /** Publish an MQTT message. Same signature as she.mqttpub(). */
        pub: (...args) => she.mqttpub(...args),
        /** Get the last-known value for a topic. */
        get: (topic) => she.getValue(topic),
        /** Get a specific property from a topic's state object. */
        getProp: (...args) => she.getProp(...args),
        /** Forward value changes from source topic(s) to target topic(s). */
        link: function Sandbox_mqtt_link(source, target, /* optional */ value) {
            she.mqttsub(source, (topic, val) => {
                if (typeof value === 'function') {
                    val = value(val);
                } else if (typeof value !== 'undefined') {
                    val = value;
                }
                she.setValue(target, val);
            });
        },
        /** Seconds since the topic's value last changed. */
        age: function Sandbox_mqtt_age(topic) {
            return Math.round((new Date().getTime() - she.getProp(topic, 'lc')) / 1000);
        },
        /**
         * Publish 1 to target when any source is truthy, 0 otherwise.
         * target may be a topic string or a callback(topic, val).
         */
        or: function Sandbox_mqtt_or(srcs, target) {
            function combine(topic) {
                const result = srcs.some((src) => isTruthy(she.getValue(src))) ? 1 : 0;
                sink(target, topic ?? null, result);
            }
            combine(null);
            she.mqttsub(srcs, { retain: true }, (topic) => combine(topic));
        },
        /**
         * Publish 1 to target when all sources are truthy, 0 otherwise.
         * target may be a topic string or a callback(topic, val).
         */
        and: function Sandbox_mqtt_and(srcs, target) {
            function combine(topic) {
                const result = srcs.every((src) => isTruthy(she.getValue(src))) ? 1 : 0;
                sink(target, topic ?? null, result);
            }
            combine(null);
            she.mqttsub(srcs, { retain: true }, (topic) => combine(topic));
        },
        /**
         * Publish the maximum of all source values to target.
         * target may be a topic string or a callback(topic, val).
         */
        max: function Sandbox_mqtt_max(srcs, target) {
            function combine(topic) {
                let result = 0;
                srcs.forEach((src) => {
                    const v = she.getValue(src);
                    if (v > result) result = v;
                });
                sink(target, topic ?? null, result);
            }
            combine(null);
            she.mqttsub(srcs, { retain: true }, (topic) => combine(topic));
        },
        /**
         * Publish the minimum of all source values to target.
         * target may be a topic string or a callback(topic, val).
         */
        min: function Sandbox_mqtt_min(srcs, target) {
            function combine(topic) {
                const values = srcs.map((src) => she.getValue(src)).filter((v) => v !== undefined && v !== null);
                const result = values.length ? Math.min(...values) : 0;
                sink(target, topic ?? null, result);
            }
            combine(null);
            she.mqttsub(srcs, { retain: true }, (topic) => combine(topic));
        },
        /**
         * Pulse target to 1 for ms after src goes truthy, then reset to 0.
         * Signature: timer(src, ms, target)
         * target may be a topic string or a callback(topic, val).
         * When target is a topic string, any lingering 1 from a previous run is
         * cleared by an initial timeout on startup.
         */
        timer: function Sandbox_mqtt_timer(src, ms, target) {
            const key = target;
            she.mqttsub(src, { retain: false }, (topic, val) => {
                if (isTruthy(val)) {
                    she.clearTimeout(timerHandles.get(key));
                    sink(target, topic, 1);
                    timerHandles.set(
                        key,
                        she.setTimeout(() => {
                            sink(target, null, 0);
                        }, ms),
                    );
                }
            });
            if (typeof target !== 'function') {
                timerHandles.set(
                    key,
                    she.setTimeout(() => {
                        if (she.getValue(target)) she.setValue(target, 0);
                    }, ms),
                );
            }
        },
    };

    /**
     * HTTP helpers — fetch and webhook receiver.
     * @namespace she.http
     */
    she.http = {
        /**
         * Fetch a URL and return a Promise that resolves to the response body.
         * Resolves to parsed JSON when the Content-Type is application/json and
         * the body parses; falls back to the raw text body when parsing fails.
         * Rejects on non-2xx responses.
         * @param {string} url
         * @param {RequestInit} [options]
         * @returns {Promise<string|object>}
         */
        fetch: function Sandbox_http_fetch(url, options, callback) {
            // Support she.http.fetch(url, callback) shorthand (no options)
            if (typeof options === 'function') {
                callback = options;
                options = undefined;
            }
            const TIMEOUT_MS = 30_000;
            let signal = options?.signal;
            let timer;
            if (!signal) {
                const ac = new AbortController();
                signal = ac.signal;
                timer = setTimeout(() => ac.abort(new Error(`she.http.fetch timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
            }
            const promise = fetch(url, { ...options, signal })
                .then(async (r) => {
                    const ct = r.headers.get('content-type') || '';
                    const text = await r.text();
                    let body = text;
                    if (ct.includes('json')) {
                        try {
                            body = JSON.parse(text);
                        } catch {
                            // Content-Type lied — deliver the raw body instead of throwing
                        }
                    }
                    const headers = {};
                    r.headers.forEach((v, k) => {
                        headers[k] = v;
                    });
                    const res = { body, code: r.status, headers };
                    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${r.statusText}`), res);
                    return res;
                })
                .finally(() => clearTimeout(timer));
            if (typeof callback === 'function') {
                promise.then((res) => callback(null, res)).catch((err) => callback(err, null));
                return undefined;
            }
            return promise;
        },
        /**
         * Register a POST webhook endpoint at /api/<scriptName><path>.
         * The endpoint auto-responds { ok: true } (200) when the callback resolves,
         * or { error } (500) when it throws. The callback receives:
         *   callback(body, { params, query, headers })
         * @param {string} path    - Route path, e.g. '/webhook/mydevice'
         * @param {function} callback
         */
        sub: function Sandbox_http_sub(path, callback) {
            const { registerRoute } = require('../web/server');
            const { scriptName } = ctx;
            if (typeof path !== 'string') throw new TypeError('path must be a string');
            if (typeof callback !== 'function') throw new TypeError('callback must be a function');
            const fullPath = '/api/' + (scriptName || 'unknown') + path;
            registerRoute('post', fullPath, (req, res) => {
                let result;
                try {
                    result = callback(req.body, { params: req.params, query: req.query, headers: req.headers });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                Promise.resolve(result)
                    .then(() => res.json({ ok: true }))
                    .catch((err) => res.status(500).json({ error: err.message }));
            });
        },
    };
};
