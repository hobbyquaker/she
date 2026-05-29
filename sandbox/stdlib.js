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
                clearTimeout(timeouts[target]);
                if (!she.getValue(target)) {
                    she.setValue(target, 1);
                }
                timeouts[target] = setTimeout(() => {
                    if (she.getValue(target)) {
                        she.setValue(target, 0);
                    }
                }, time);
            }
        });

        timeouts[target] = Sandbox.setTimeout(() => {
            if (Sandbox.getValue(target)) {
                Sandbox.setValue(target, 0);
            }
        }, time);
    };
};
