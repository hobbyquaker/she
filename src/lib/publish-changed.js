'use strict';
/**
 * `she.mqtt.pub(topic, payload, { changed: true })`: publish only when the payload
 * differs from what this script last sent to the topic. Before the first publish of a run, the
 * comparison falls back to the topic's current value in the state store — for a command topic
 * (`<prefix>/set/<name>`) to its `status` sibling, which is where a variable's or an adapter's
 * state lives. The last payloads are kept per script, so a hot reload starts over with the store.
 */

const parsePayload = require('./parse-payload');

const CAP = 200; // topics remembered per script, like the publish record

/**
 * @param {Map<string,string>} last topic → the payload this script last published
 * @param {string} topic
 * @param {string} payload the stringified payload
 * @param {Function} lookup (topic) → the state object { val, ts, lc } or undefined
 * @returns {boolean} true when the publish would repeat the last one
 */
function isRepeat(last, topic, payload, lookup) {
    if (last.has(topic)) return last.get(topic) === payload;
    let state = lookup(topic);
    if (state === undefined) {
        const parts = topic.split('/');
        if (parts.length > 2 && parts[1] === 'set') {
            parts[1] = 'status';
            state = lookup(parts.join('/'));
        }
    }
    if (state === undefined || state === null) return false;
    return JSON.stringify(parsePayload(payload).val) === JSON.stringify(state.val);
}

/**
 * Remember what was published; at most CAP topics per script.
 * @param {Map<string,string>} last
 * @param {string} topic
 * @param {string} payload
 */
function remember(last, topic, payload) {
    if (last.size < CAP || last.has(topic)) last.set(topic, payload);
}

module.exports = { isRepeat, remember, CAP };
