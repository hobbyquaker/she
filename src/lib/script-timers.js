'use strict';
/**
 * One-shot timers a script started, tracked in the script's set so that unloading the script can
 * clear the ones still pending (roadmap B9).
 *
 * The id leaves the set when the timer fires. Before, only an explicit clearTimeout removed it, so
 * every timeout that ran normally stayed in the set for the life of the daemon — with its callback
 * and everything the callback captured. A script that starts a "switch off after N minutes" timer
 * per event leaked hundreds of them an hour, and the heap ran full after about twelve days.
 */

/**
 * A delay a script passed to a timer API: a finite number of milliseconds, not negative.
 * Node coerces anything else to NaN, warns once per process without naming the caller and fires
 * after 1 ms — a swapped argument order or an undefined config field became a silent 1 ms timer.
 * @param {*} delay
 * @returns {boolean}
 */
function isValidDelay(delay) {
    return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0;
}

/**
 * How an invalid delay is described in the warning: `undefined`, `NaN`, `"5m"`, `an object`.
 * @param {*} delay
 * @returns {string}
 */
function describeDelay(delay) {
    if (typeof delay === 'string') return JSON.stringify(delay);
    if (typeof delay === 'function') return 'a function';
    if (delay !== null && typeof delay === 'object') return Array.isArray(delay) ? 'an array' : 'an object';
    return String(delay);
}

/**
 * @param {Set} timers the script's timer set
 * @param {Function} fn called when the timer fires
 * @param {number} delay ms; an invalid delay is reported through `opts.warn` and runs as 0
 * @param {object|Function} [opts] options, or (legacy) the setTimeout function to use
 * @param {Function} [opts.setTimeoutFn] for tests
 * @param {Function} [opts.warn] called with a message when the delay is not a number (the caller
 *   adds the script's label); without it an invalid delay is silently 0
 * @param {string} [opts.api] the API name for the warning, default `setTimeout`
 * @param {string} [opts.kind] shown in the timer list: `debounce`, `throttle`, `timeout`, `retry`
 * @param {string} [opts.name] shown in the timer list next to the kind
 * @returns the timer id (what clearTimeout takes); carries `due`, and `kind`/`name` when given
 */
function trackTimeout(timers, fn, delay, opts = {}) {
    if (typeof opts === 'function') opts = { setTimeoutFn: opts };
    const setTimeoutFn = opts.setTimeoutFn || setTimeout;
    if (!isValidDelay(delay)) {
        if (typeof opts.warn === 'function') opts.warn(`${opts.api || 'setTimeout'}: delay is not a number of milliseconds (got ${describeDelay(delay)}), using 0`);
        delay = 0;
    }
    const id = setTimeoutFn(() => {
        timers.delete(id);
        fn();
    }, delay);
    if (id && typeof id === 'object') {
        id.start = Date.now(); // when it was armed — the progress bar of the timer list runs from here
        id.due = id.start + delay; // when it fires (roadmap I28: list_timers)
        if (opts.kind) id.kind = opts.kind;
        if (opts.name) id.name = opts.name;
    }
    timers.add(id);
    return id;
}

module.exports = { trackTimeout, isValidDelay, describeDelay };
