/* eslint-disable func-name-matching, func-names, camelcase */

module.exports = function (she) {
    /**
     * @method now
     * @returns {number} ms since epoch
     */
    she.now = function Sandbox_now() {
        return new Date().getTime();
    };

    /**
     * @method age
     * @param {string} topic
     * @returns {number} seconds since last change
     */
    she.age = function Sandbox_age(topic) {
        return Math.round((new Date().getTime() - she.getProp(topic, 'lc')) / 1000);
    };

    /**
     * Link topic(s) to other topic(s)
     * @method link
     * @param {(string|string[])} source - topic or array of topics to subscribe
     * @param {(string|string[])} target - topic or array of topics to publish
     * @param {mixed} [value] - value to publish. If omitted the sources value is published. A function can be used to transform the value.
     */
    she.link = function Sandbox_link(source, target, /* optional */ value) {
        she.mqttsub(source, (topic, val) => {
            if (typeof value === 'function') {
                val = value(val);
            } else if (typeof value !== 'undefined') {
                val = value;
            }
            she.setValue(target, val);
        });
    };

    // Route a computed value to a topic string (setValue) or a callback (called as fn(topic, val)).
    function sink(target, topic, val) {
        if (typeof target === 'function') {
            target(topic, val);
        } else {
            she.setValue(target, val);
        }
    }

    const timeouts = {};
    /**
     * Publishes 1 on target for specific time after src changed to true
     * @method timer
     * @param {(string|string[])} src - topic or array of topics to subscribe
     * @param {string} target - topic to publish
     * @param {number} time - timeout in milliseconds
     */
    she.timer = function (src, target, time) {
        she.mqttsub(src, { retain: false }, (topic, val) => {
            if (val) {
                she.clearTimeout(timeouts[target]);
                if (!she.getValue(target)) {
                    she.setValue(target, 1);
                }
                timeouts[target] = she.setTimeout(() => {
                    if (she.getValue(target)) {
                        she.setValue(target, 0);
                    }
                }, time);
            }
        });

        timeouts[target] = she.setTimeout(() => {
            if (she.getValue(target)) {
                she.setValue(target, 0);
            }
        }, time);
    };

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
        /** Set a value on one or more topics. */
        set: (topic, val) => she.setValue(topic, val),
        /** Get a specific property from a topic's state object. */
        getProp: (...args) => she.getProp(...args),
        /** Forward value changes from source topic(s) to target topic(s). */
        link: (...args) => she.link(...args),
        /** Seconds since the topic's value last changed. */
        age: (topic) => she.age(topic),
        /** Register a callback for MQTT connection lifecycle events ('connect' or 'disconnect'). */
        on: (event, cb) => she._registerMqttEvent(event, cb),
        /**
         * Publish 1 to target when any source is truthy, 0 otherwise.
         * target may be a topic string or a callback(topic, val).
         */
        or: function Sandbox_mqtt_or(srcs, target) {
            function combine(topic) {
                const result = srcs.some((src) => she.getValue(src)) ? 1 : 0;
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
                const result = srcs.every((src) => she.getValue(src)) ? 1 : 0;
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
    };

    /**
     * Fetch a URL and return a Promise that resolves to the response body.
     * Resolves to parsed JSON when the Content-Type is application/json, plain text otherwise.
     * Rejects on non-2xx responses.
     * @method fetch
     * @param {string} url
     * @param {RequestInit} [options]
     * @returns {Promise<string|object>}
     */
    she.fetch = function Sandbox_fetch(url, options) {
        const TIMEOUT_MS = 30_000;
        let signal = options?.signal;
        let timer;
        if (!signal) {
            const ac = new AbortController();
            signal = ac.signal;
            timer = setTimeout(() => ac.abort(new Error(`she.fetch timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
        }
        return fetch(url, { ...options, signal })
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
                const ct = r.headers.get('content-type') || '';
                return ct.includes('json') ? r.json() : r.text();
            })
            .finally(() => clearTimeout(timer));
    };
};
