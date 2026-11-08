'use strict';
/**
 * `she.mqtt.command(topic, payload, [opts])`: publish a command and wait for the device's status to
 * confirm it — with a timeout per attempt, retries, a fast failure when the device is known to be
 * offline, and a warning in the log when the command did not take.
 *
 * The commander is created per script with the script's primitives (publish, the state store, the
 * tracked timers, the unload hook), so a pending command is a timer of the script: it shows in the
 * timer list, is cancelled when the script is unloaded, and the editor can cancel it.
 *
 * `she.mqtt.pub` stays fire-and-forget; this is for the commands whose effect matters.
 */

const { deriveConfirm, offlineReason, confirms } = require('./command-topics');

const DEFAULT_TIMEOUT_S = 5;

class CommandError extends Error {
    /**
     * @param {'timeout'|'offline'|'superseded'|'unloaded'|'cancelled'} reason
     * @param {object} info topic, payload (as sent), tries, detail
     */
    constructor(reason, info) {
        const why = {
            timeout: `no confirmation within ${info.timeoutS} s${info.tries > 1 ? ` (${info.tries} attempts)` : ''}`,
            // the device's own offline signal, or the broker the command would go to
            offline: info.detail && info.detail.startsWith('broker ') ? info.detail : `device offline (${info.detail})`,
            superseded: 'superseded by a newer command to the same topic',
            unloaded: 'script unloaded',
            cancelled: 'cancelled from the editor',
        }[reason];
        super(`she.mqtt.command ${info.topic} ← ${info.payload}: ${why}`);
        this.name = 'CommandError';
        this.reason = reason;
        this.topic = info.topic;
        this.payload = info.payload;
        this.tries = info.tries;
        if (info.confirm) this.confirm = info.confirm;
    }
}

/**
 * @param {object} prim the script's primitives
 * @param {(topic: string, payload: string) => void} prim.publish
 * @param {(topic: string) => *} prim.get the state store's value of a topic
 * @param {(topic: string) => boolean} prim.has
 * @param {() => string|null} [prim.offline] why the broker itself is unreachable (`broker "x" not connected`), or null
 * @param {(topic: string, cb: (val: *) => void) => () => void} prim.watch called with every new value
 *   stored for the topic, until the returned function is called
 * @param {(fn: Function, ms: number, meta: object) => *} prim.setTimeout the script's tracked timer;
 *   meta is { kind: 'command', name, extra, onCancel, actions }
 * @param {(id: *) => void} prim.clearTimeout
 * @param {(fn: Function) => () => void} [prim.onUnload]
 * @param {(msg: string) => void} [prim.warn] the script's warning log
 * @param {() => void} [prim.onFail] counts a failed command (timeout, offline)
 * @param {() => number} [prim.now]
 * @param {() => number|null} [prim.line] the script line of the call
 * @returns {Function} command(topic, payload, [opts]) → Promise<{ val, ms, tries, already? }>
 */
function createCommander(prim) {
    const now = prim.now || Date.now;
    const onUnload = typeof prim.onUnload === 'function' ? prim.onUnload : () => () => {};
    const warn = typeof prim.warn === 'function' ? prim.warn : () => {};
    const onFail = typeof prim.onFail === 'function' ? prim.onFail : () => {};
    const lineOf = typeof prim.line === 'function' ? prim.line : () => null;
    /** topic → the running command's abort(reason) */
    const active = new Map();

    /**
     * @param {string} topic the command topic (`a//b` is `a/set/b`)
     * @param {*} payload a string, number, boolean or object (JSON)
     * @param {object} [opts]
     * @param {string} [opts.confirm] the status topic that shows the effect (derived when omitted)
     * @param {string} [opts.path] the field of a JSON status payload to look at
     * @param {*} [opts.expect] the value to expect (default: the payload), or fn(val) → boolean
     * @param {number} [opts.tolerance=0] for numbers
     * @param {number} [opts.timeout=5] seconds per attempt
     * @param {number} [opts.retries=0] further attempts after a timeout
     * @param {boolean} [opts.quiet=false] no warning in the log when the command fails
     * @returns {Promise<{ val: *, ms: number, tries: number, already?: boolean }>}
     */
    function command(topic, payload, opts = {}) {
        const api = 'she.mqtt.command(topic, payload, [opts])';
        if (typeof topic !== 'string' || !topic) throw new TypeError(`${api}: topic must be a string (got ${typeof topic})`);
        if (payload === undefined) throw new TypeError(`${api}: payload missing`);
        if (opts === null || typeof opts !== 'object') throw new TypeError(`${api}: opts must be an object`);
        topic = topic.replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2');
        const payloadStr = payload !== null && typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
        const confirm = deriveConfirm(topic, payload, opts, prim.has);
        if (!confirm) throw new TypeError(`${api}: cannot derive the status topic of "${topic}" — pass opts.confirm`);
        const expect = 'expect' in opts ? opts.expect : confirm.expect;
        const tolerance = typeof opts.tolerance === 'number' && opts.tolerance >= 0 ? opts.tolerance : 0;
        const timeoutS = typeof opts.timeout === 'number' && Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT_S;
        const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 0;
        if (opts.timeout !== undefined && timeoutS !== opts.timeout) throw new TypeError(`${api}: opts.timeout must be a number of seconds > 0`);
        if (opts.retries !== undefined && retries !== opts.retries) throw new TypeError(`${api}: opts.retries must be a whole number ≥ 0`);
        const line = lineOf();
        const pick = (val) => (confirm.field ? (val !== null && typeof val === 'object' ? val[confirm.field] : undefined) : val);

        const promise = new Promise((resolve, reject) => {
            const t0 = now();
            let tries = 0;
            let timer = null;
            let offWatch = null;
            let offUnload = null;
            let settled = false;

            const cleanup = () => {
                settled = true;
                if (timer !== null) prim.clearTimeout(timer);
                timer = null;
                if (offWatch) offWatch();
                if (offUnload) offUnload();
                if (active.get(topic) === abort) active.delete(topic);
            };
            const fail = (reason, detail) => {
                if (settled) return;
                cleanup();
                const err = new CommandError(reason, { topic, payload: payloadStr, tries: Math.max(tries, 1), timeoutS, detail, confirm: confirm.topic });
                if (reason === 'timeout' || reason === 'offline') {
                    onFail();
                    if (!opts.quiet) warn(err.message + (reason === 'timeout' ? ` — nothing matching on ${confirm.topic}${confirm.field ? ' .' + confirm.field : ''}` : ''));
                }
                reject(err);
            };
            const abort = (reason) => fail(reason);

            // a newer command to the same topic replaces the running one
            const previous = active.get(topic);
            if (previous) previous('superseded');
            active.set(topic, abort);

            // an additional broker that is not connected fails before any device check
            const offline = (typeof prim.offline === 'function' && prim.offline()) || offlineReason(topic, prim.get);
            if (offline) {
                fail('offline', offline);
                return;
            }

            const current = pick(prim.get(confirm.topic));
            if (confirms(current, expect, tolerance)) {
                // the status already shows the target: send anyway (the device may be out of sync
                // with its last report) and do not wait for an echo many devices will not send
                prim.publish(topic, payloadStr);
                cleanup();
                resolve({ val: current, ms: 0, tries: 1, already: true });
                return;
            }

            offUnload = onUnload(() => fail('unloaded'));
            offWatch = prim.watch(confirm.topic, (val) => {
                if (settled) return;
                const v = pick(val);
                if (!confirms(v, expect, tolerance)) return;
                cleanup();
                resolve({ val: v, ms: now() - t0, tries });
            });

            const attempt = () => {
                tries++;
                prim.publish(topic, payloadStr);
                timer = prim.setTimeout(
                    () => {
                        timer = null;
                        if (settled) return;
                        if (tries <= retries) attempt();
                        else fail('timeout');
                    },
                    timeoutS * 1000,
                    {
                        kind: 'command',
                        name: topic,
                        line,
                        extra: { topic, payload: payloadStr, tries, confirm: confirm.topic },
                        actions: { run: false },
                        onCancel: () => fail('cancelled'),
                    },
                );
            };
            attempt();
        });
        // a failure is reported in the log (unless quiet); a script that does not catch it must not
        // produce an unhandled rejection on top
        promise.catch(() => {});
        return promise;
    }

    return command;
}

module.exports = { createCommander, CommandError, DEFAULT_TIMEOUT_S };
