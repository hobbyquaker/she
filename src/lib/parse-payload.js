'use strict';

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
        return parsed;
    } catch {
        return { val: str };
    }
}

module.exports = parsePayload;
