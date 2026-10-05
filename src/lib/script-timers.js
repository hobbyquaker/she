'use strict';
/**
 * One-shot timers a script started, tracked in the script's set so that unloading the script can
 * clear the ones still pending (roadmap B9).
 *
 * The id leaves the set when the timer fires. Before, only an explicit clearTimeout removed it, so
 * every timeout that ran normally stayed in the set for the life of the daemon — with its callback
 * and everything the callback captured. A script that starts a "switch off after N minutes" timer
 * per event leaked hundreds of them an hour, and the heap ran full after about twelve days.
 *
 * @param {Set} timers the script's timer set
 * @param {Function} fn called when the timer fires
 * @param {number} delay ms
 * @param {Function} [setTimeoutFn] for tests
 * @returns the timer id (what clearTimeout takes)
 */
function trackTimeout(timers, fn, delay, setTimeoutFn = setTimeout) {
    const id = setTimeoutFn(() => {
        timers.delete(id);
        fn();
    }, delay);
    timers.add(id);
    return id;
}

module.exports = { trackTimeout };
