'use strict';
/**
 * Timing helpers for scripts (roadmap S10): debounce, throttle, a restartable timeout, retry with
 * backoff, and the debounce/throttle of a subscription.
 *
 * The helpers do not touch Node's timers. They take the script's tracked timer primitives, so every
 * pending run is cleared when the script is unloaded or hot-reloaded and shows up in the timer list
 * with its kind and name. Errors thrown by the wrapped function propagate to the caller — the
 * sandbox runs the timer callbacks inside the script's domain, which logs them with the script name.
 *
 * Units: the function helpers take milliseconds like setTimeout; the subscription options take
 * seconds like `shift` and `random`.
 */

const { isValidDelay, describeDelay } = require('./script-timers');

function assertFn(fn, api, what = 'fn') {
    if (typeof fn !== 'function') throw new TypeError(`${api}: ${what} must be a function (got ${describeDelay(fn)})`);
}

function assertDelay(ms, api, what) {
    if (!isValidDelay(ms)) throw new TypeError(`${api}: ${what} must be a number of milliseconds (got ${describeDelay(ms)})`);
}

/**
 * @param {object} prim the script's primitives
 * @param {Function} prim.setTimeout (fn, ms, meta) → id; meta is { kind, name } for the timer list
 * @param {Function} prim.clearTimeout (id)
 * @param {Function} [prim.now] → ms, default Date.now
 * @param {Function} [prim.onUnload] (fn) → off(); fn runs when the script is unloaded
 * @returns {{ debounce: Function, throttle: Function, timeout: Function, retry: Function }}
 */
function createTimingHelpers(prim) {
    const { setTimeout: setTimer, clearTimeout: clearTimer } = prim;
    const now = prim.now || Date.now;
    const onUnload = typeof prim.onUnload === 'function' ? prim.onUnload : () => () => {};

    /**
     * Bundle calls: run fn with the arguments of the last call once `wait` ms passed without a new
     * call — at the latest `maxWait` ms after the first call of a bundle.
     * @param {Function} fn
     * @param {number} wait ms
     * @param {object} [opts]
     * @param {number} [opts.maxWait] ms; run at the latest this long after the first bundled call
     * @param {boolean} [opts.leading=false] run on the first call of a bundle as well
     * @param {boolean} [opts.trailing=true] run after the quiet period (with the last call's arguments)
     * @param {boolean} [opts.flushOnUnload=false] run a pending call when the script is unloaded
     * @param {string} [opts.name] shown in the timer list
     * @returns {Function} wrapped(...args) with cancel(), flush(), pending()
     */
    function debounce(fn, wait, opts = {}) {
        const api = 'she.debounce(fn, wait, [opts])';
        assertFn(fn, api);
        assertDelay(wait, api, 'wait');
        const { leading = false, trailing = true, maxWait, flushOnUnload = false, _onSettle } = opts;
        if (maxWait !== undefined) assertDelay(maxWait, api, 'opts.maxWait');
        if (!leading && !trailing) throw new TypeError(`${api}: opts.leading and opts.trailing cannot both be false`);
        const name = opts.name || fn.name || undefined;
        const meta = { kind: 'debounce', name };
        const maxMeta = { kind: 'debounce maxWait', name };

        let timer = null;
        let maxTimer = null;
        let lastArgs = null;
        let waiting = false; // a call waits to run
        let result;

        function settle() {
            lastArgs = null;
            waiting = false;
            if (timer === null && maxTimer === null && typeof _onSettle === 'function') _onSettle();
        }
        function clearTimers() {
            if (timer !== null) clearTimer(timer);
            if (maxTimer !== null) clearTimer(maxTimer);
            timer = maxTimer = null;
        }
        function invoke() {
            const args = lastArgs;
            lastArgs = null;
            waiting = false;
            result = fn(...args);
            if (timer === null && maxTimer === null && typeof _onSettle === 'function') _onSettle();
            return result;
        }
        function onWait() {
            timer = null;
            if (maxTimer !== null) {
                clearTimer(maxTimer);
                maxTimer = null;
            }
            if (trailing && waiting) invoke();
            else settle();
        }
        function onMaxWait() {
            maxTimer = null;
            if (timer !== null) {
                clearTimer(timer);
                timer = null;
            }
            if (waiting) invoke();
            else settle();
        }
        function wrapped(...args) {
            const idle = timer === null;
            lastArgs = args;
            if (idle && maxWait !== undefined && maxTimer === null) maxTimer = setTimer(onMaxWait, maxWait, maxMeta);
            if (timer !== null) clearTimer(timer);
            timer = setTimer(onWait, wait, meta);
            if (idle && leading) invoke();
            else waiting = true;
            return result;
        }
        wrapped.cancel = () => {
            clearTimers();
            settle();
        };
        wrapped.flush = () => {
            clearTimers();
            if (waiting) return invoke();
            settle();
            return result;
        };
        wrapped.pending = () => waiting;
        if (flushOnUnload) onUnload(() => wrapped.flush());
        return wrapped;
    }

    /**
     * Rate-limit calls: run fn at most once per `wait` ms — on the first call of a window
     * (leading) and, when more calls came in, once more with the last arguments when the window ends
     * (trailing).
     * @param {Function} fn
     * @param {number} wait ms
     * @param {object} [opts]
     * @param {boolean} [opts.leading=true]
     * @param {boolean} [opts.trailing=true]
     * @param {string} [opts.name] shown in the timer list
     * @returns {Function} wrapped(...args) with cancel(), flush(), pending()
     */
    function throttle(fn, wait, opts = {}) {
        const api = 'she.throttle(fn, wait, [opts])';
        assertFn(fn, api);
        assertDelay(wait, api, 'wait');
        const { leading = true, trailing = true, _onSettle } = opts;
        if (!leading && !trailing) throw new TypeError(`${api}: opts.leading and opts.trailing cannot both be false`);
        const meta = { kind: 'throttle', name: opts.name || fn.name || undefined };

        let timer = null;
        let lastArgs = null;
        let waiting = false;
        let result;

        function settle() {
            lastArgs = null;
            waiting = false;
            if (timer === null && typeof _onSettle === 'function') _onSettle();
        }
        function invoke() {
            const args = lastArgs;
            lastArgs = null;
            waiting = false;
            result = fn(...args);
            if (timer === null && typeof _onSettle === 'function') _onSettle();
            return result;
        }
        function onWindowEnd() {
            timer = null;
            if (trailing && waiting) {
                // the trailing run opens a new window, so runs stay `wait` apart
                timer = setTimer(onWindowEnd, wait, meta);
                invoke();
            } else settle();
        }
        function wrapped(...args) {
            lastArgs = args;
            if (timer === null) {
                timer = setTimer(onWindowEnd, wait, meta);
                if (leading) invoke();
                else waiting = true;
            } else waiting = true;
            return result;
        }
        wrapped.cancel = () => {
            if (timer !== null) clearTimer(timer);
            timer = null;
            settle();
        };
        wrapped.flush = () => {
            if (timer !== null) clearTimer(timer);
            timer = null;
            if (waiting) return invoke();
            settle();
            return result;
        };
        wrapped.pending = () => waiting;
        return wrapped;
    }

    /**
     * A debounce or throttle with a separate state per key. The key is the first argument of the
     * call unless opts.key(...args) says otherwise. Idle keys are forgotten, so a wildcard
     * subscription does not accumulate state.
     */
    function keyed(factory, api) {
        return function keyedHelper(fn, wait, opts = {}) {
            assertFn(fn, api);
            const { key: keyFn, flushOnUnload = false, name, ...rest } = opts;
            if (keyFn !== undefined) assertFn(keyFn, api, 'opts.key');
            const states = new Map();
            const forKey = (key) => {
                let state = states.get(key);
                if (!state) {
                    state = factory(fn, wait, { ...rest, name: name ? `${name} ${key}` : String(key), _onSettle: () => states.delete(key) });
                    states.set(key, state);
                }
                return state;
            };
            function wrapped(...args) {
                const key = keyFn ? keyFn(...args) : args[0];
                return forKey(key)(...args);
            }
            // without a key: every key
            wrapped.cancel = (key) => {
                if (key !== undefined) states.get(key)?.cancel();
                else for (const state of [...states.values()]) state.cancel();
            };
            wrapped.flush = (key) => {
                if (key !== undefined) return states.get(key)?.flush();
                for (const state of [...states.values()]) state.flush();
                return undefined;
            };
            wrapped.pending = (key) => {
                if (key !== undefined) return states.get(key)?.pending() ?? false;
                for (const state of states.values()) if (state.pending()) return true;
                return false;
            };
            wrapped.keys = () => [...states.keys()];
            // validate eagerly, so a wrong wait fails at load time and not on the first call
            factory(fn, wait, { ...rest, _onSettle: undefined }).cancel();
            if (flushOnUnload) onUnload(() => wrapped.flush());
            return wrapped;
        };
    }
    debounce.keyed = keyed(debounce, 'she.debounce.keyed(fn, wait, [opts])');
    throttle.keyed = keyed(throttle, 'she.throttle.keyed(fn, wait, [opts])');

    /**
     * A restartable one-shot timer. It is created idle: restart() arms it, another restart() starts
     * the delay over, cancel() disarms it.
     * @param {number} ms
     * @param {Function} cb
     * @param {object} [opts]
     * @param {string} [opts.name] shown in the timer list
     * @returns {{ restart: Function, start: Function, cancel: Function, pending: Function, remaining: Function }}
     */
    function timeout(ms, cb, opts = {}) {
        const api = 'she.timeout(ms, cb, [opts])';
        assertDelay(ms, api, 'ms');
        assertFn(cb, api, 'cb');
        const meta = { kind: 'timeout', name: opts.name || cb.name || undefined };
        let id = null;
        let due = 0;
        const handle = {
            /** (Re)arm the timer; a new delay replaces the one given at creation. */
            restart(newMs) {
                if (newMs !== undefined) {
                    assertDelay(newMs, 'timeout.restart([ms])', 'ms');
                    ms = newMs;
                }
                if (id !== null) clearTimer(id);
                due = now() + ms;
                id = setTimer(
                    () => {
                        id = null;
                        cb();
                    },
                    ms,
                    meta,
                );
                return handle;
            },
            cancel() {
                if (id !== null) clearTimer(id);
                id = null;
                return handle;
            },
            pending: () => id !== null,
            remaining: () => (id === null ? 0 : Math.max(0, due - now())),
        };
        handle.start = handle.restart;
        return handle;
    }

    /**
     * Call fn until it succeeds, waiting between the attempts. fn(attempt) may return a promise.
     * The promise resolves with fn's result; when every attempt failed it calls onFail(err, tries)
     * and resolves with its return value, or — without onFail — rejects with the last error. A
     * script unload stops the attempts; the promise then never settles.
     * @param {Function} fn
     * @param {object} [opts]
     * @param {number} [opts.tries=3] attempts in total
     * @param {number} [opts.delay=1000] ms before the second attempt
     * @param {number} [opts.backoff=1] the delay is multiplied by this after each failure (2 doubles it)
     * @param {Function} [opts.onFail] (err, tries) after the last failure
     * @param {string} [opts.name] shown in the timer list
     * @returns {Promise}
     */
    function retry(fn, opts = {}) {
        const api = 'she.retry(fn, [opts])';
        assertFn(fn, api);
        const { tries = 3, delay = 1000, backoff = 1, onFail } = opts;
        if (!Number.isInteger(tries) || tries < 1) throw new TypeError(`${api}: opts.tries must be a whole number of attempts, at least 1 (got ${describeDelay(tries)})`);
        assertDelay(delay, api, 'opts.delay');
        if (typeof backoff !== 'number' || !Number.isFinite(backoff) || backoff < 0) throw new TypeError(`${api}: opts.backoff must be a factor (got ${describeDelay(backoff)})`);
        if (onFail !== undefined) assertFn(onFail, api, 'opts.onFail');
        const name = opts.name || fn.name || undefined;

        let aborted = false;
        const off = onUnload(() => {
            aborted = true;
        });
        return new Promise((resolve, reject) => {
            const attempt = (n) => {
                if (aborted) return;
                let p;
                try {
                    p = Promise.resolve(fn(n));
                } catch (err) {
                    p = Promise.reject(err);
                }
                p.then(
                    (value) => {
                        off();
                        resolve(value);
                    },
                    (err) => {
                        if (aborted) return;
                        if (n >= tries) {
                            off();
                            if (onFail) {
                                try {
                                    resolve(onFail(err, n));
                                } catch (e) {
                                    reject(e);
                                }
                            } else reject(err);
                            return;
                        }
                        const wait = delay * Math.pow(backoff, n - 1);
                        setTimer(() => attempt(n + 1), wait, { kind: 'retry', name: `${name ? name + ' ' : ''}attempt ${n + 1}/${tries}` });
                    },
                );
            };
            attempt(1);
        });
    }

    return { debounce, throttle, timeout, retry };
}

/**
 * The limiter of a subscription (sub options `debounce`, `maxWait`, `throttle`, `perTopic`, `name`;
 * seconds). Returns deliver'(topic, val, obj, objPrev, msg): events are bundled, and the callback
 * gets the last event's topic, val, obj and msg with the objPrev from before the first bundled
 * event — so a comparison of obj and objPrev still tells whether the value really changed.
 * @param {object} options the subscription options
 * @param {Function} deliver (topic, val, obj, objPrev, msg) runs the script's callback
 * @param {object} helpers from createTimingHelpers
 * @param {string} label the default name for the timer list (the topic)
 * @returns {Function|null} the limited deliver, or null when the options ask for none
 */
function subscriptionLimiter(options, deliver, helpers, label) {
    const api = 'she.mqtt.sub(topic, opts, cb)';
    const seconds = (what) => {
        const v = options[what];
        if (v === undefined) return undefined;
        if (!isValidDelay(v)) throw new TypeError(`${api}: opts.${what} must be a number of seconds (got ${describeDelay(v)})`);
        return v * 1000;
    };
    const debounce = seconds('debounce');
    const throttle = seconds('throttle');
    const maxWait = seconds('maxWait');
    if (debounce === undefined && throttle === undefined) {
        if (maxWait !== undefined) throw new TypeError(`${api}: opts.maxWait needs opts.debounce`);
        return null;
    }
    if (debounce !== undefined && throttle !== undefined) throw new TypeError(`${api}: opts.debounce and opts.throttle exclude each other`);
    if (throttle !== undefined && maxWait !== undefined) throw new TypeError(`${api}: opts.maxWait needs opts.debounce, not opts.throttle`);
    const perTopic = !!options.perTopic;
    const name = options.name !== undefined ? String(options.name) : label;

    const firstPrev = new Map(); // key → objPrev of the first bundled event
    const keyOf = (topic) => (perTopic ? topic : '');
    const run = (topic, val, obj, objPrev, msg) => {
        const key = keyOf(topic);
        const prev = firstPrev.has(key) ? firstPrev.get(key) : objPrev;
        firstPrev.delete(key);
        deliver(topic, val, obj, prev, msg);
    };
    let limited;
    if (debounce !== undefined) {
        const opts = { maxWait, name, flushOnUnload: !!options.flushOnUnload, leading: !!options.leading, trailing: options.trailing !== false };
        limited = perTopic ? helpers.debounce.keyed(run, debounce, opts) : helpers.debounce(run, debounce, opts);
    } else {
        const opts = { name, leading: options.leading !== false, trailing: options.trailing !== false };
        limited = perTopic ? helpers.throttle.keyed(run, throttle, opts) : helpers.throttle(run, throttle, opts);
    }
    return (topic, val, obj, objPrev, msg) => {
        const key = keyOf(topic);
        if (!firstPrev.has(key)) firstPrev.set(key, objPrev);
        limited(topic, val, obj, objPrev, msg);
    };
}

module.exports = { createTimingHelpers, subscriptionLimiter };
