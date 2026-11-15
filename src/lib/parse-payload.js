'use strict';

/**
 * Set (not enumerable) on a state object that was the payload itself — `{"val": 21, "ts": …}`, the
 * form mqtt-smarthome adapters publish. The state `{val: 21}` alone does not tell whether the
 * payload was `21` or `{"val": 21}`; a Home Assistant template that reads `value_json.val` needs
 * to know.
 */
const ENVELOPE = Symbol.for('she.payload.envelope');

/**
 * Parse an MQTT payload (string or Buffer) into a typed state object.
 * The returned object always has a `val` property; JSON payloads that
 * already carry a `val` key are returned as-is.
 *
 * @param {string|Buffer} payload
 * @returns {{ val: *, ts?: number, lc?: number }}
 */
function parsePayload(payload) {
    const str = payload.toString();

    if (str === 'true') return { val: true };
    if (str === 'false') return { val: false };

    if (!isNaN(str)) return { val: parseFloat(str) };

    try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return { val: parsed };
        if (!parsed || typeof parsed.val === 'undefined') return { val: parsed };
        // the payload was the state object itself: say so, for whoever needs the payload again
        Object.defineProperty(parsed, ENVELOPE, { value: true });
        return parsed;
    } catch {
        return { val: str };
    }
}

module.exports = parsePayload;
module.exports.ENVELOPE = ENVELOPE;
