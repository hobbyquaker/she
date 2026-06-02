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

    /**
     * Combine topics through boolean or
     * @method combineBool
     * @param {string[]} srcs - array of topics to subscribe
     * @param {string} targets - topic to publish
     */
    she.combineBool = function Sandbox_combineBool(srcs, target) {
        function combine() {
            let result = 0;
            srcs.forEach((src) => {
                if (she.getValue(src)) {
                    result = 1;
                }
            });
            she.setValue(target, result);
        }
        combine();
        she.mqttsub(srcs, { retain: true }, combine);
    };

    /**
     * Publish maximum of combined topics
     * @method combineMax
     * @param {string[]} srcs - array of topics to subscribe
     * @param {string} targets - topic to publish
     */
    she.combineMax = function (srcs, target) {
        function combine() {
            let result = 0;
            srcs.forEach((src) => {
                const srcVal = she.getValue(src);
                if (srcVal > result) {
                    result = srcVal;
                }
            });
            she.setValue(target, result);
        }
        combine();
        she.mqttsub(srcs, { retain: true }, combine);
    };

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
     * Namespaced MQTT API — the primary way to interact with MQTT from scripts.
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
        return fetch(url, options).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
            const ct = r.headers.get('content-type') || '';
            return ct.includes('json') ? r.json() : r.text();
        });
    };
};
