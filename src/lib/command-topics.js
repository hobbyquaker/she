'use strict';
/**
 * Topic conventions behind `she.mqtt.command`: where a command's effect shows up, how to tell a
 * device is offline, and which topics a script should not publish to because an adapter owns them.
 *
 * Two conventions are known:
 *
 * - mqtt-smarthome: `<inst>/set/<path>` is answered on `<inst>/status/<path>` with `{ val, … }`;
 *   `<inst>/connected` is 0 (gone), 1 (mqtt only) or 2 (device reachable).
 * - zigbee2mqtt: `<base>/<device>/set` takes `{ state: "ON" }` and the device's state is published as
 *   one JSON object on `<base>/<device>`; `<base>/<device>/availability` is `online`/`offline` (or
 *   `{ state: "offline" }`); `<base>/<device>/set/<attribute>` sets one attribute.
 *
 * Everything else needs `opts.confirm` — the functions here say so by returning null.
 */

const SMARTHOME_SET = /^(.+?)\/set\/(.+)$/;
const Z2M_SET = /^(.+)\/set$/;

/**
 * The topic (and JSON field) where the effect of a command shows up, and the value to expect.
 * @param {string} topic the command topic (the `a//b` shorthand already expanded)
 * @param {*} payload what is sent
 * @param {object} [opts] `confirm` (topic), `path` (JSON field of the status payload)
 * @param {(topic: string) => boolean} [has] whether the state store knows a topic — breaks the tie
 *   between `<inst>/set/<dev>/<dp>` and zigbee2mqtt's `<base>/<dev>/set/<attr>`
 * @returns {{ topic: string, field: string|null, expect: * }|null} null when nothing can be derived
 */
function deriveConfirm(topic, payload, opts = {}, has = () => false) {
    const isObj = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
    const keys = isObj ? Object.keys(payload) : [];
    const field = typeof opts.path === 'string' && opts.path ? opts.path : null;
    const expectFor = (f) => {
        if (isObj) {
            if (f && f in payload) return payload[f];
            if ('val' in payload) return payload.val;
            if (keys.length === 1) return payload[keys[0]];
            return payload;
        }
        return payload;
    };
    if (typeof opts.confirm === 'string' && opts.confirm) {
        const f = field || (isObj && !('val' in payload) && keys.length === 1 ? keys[0] : null);
        return { topic: opts.confirm, field: f, expect: expectFor(f) };
    }
    let m = Z2M_SET.exec(topic);
    if (m) {
        // zigbee2mqtt: the device's state object; the field is the payload's single key, or `state`
        // for a bare "ON"/"OFF"
        const f = field || (isObj && keys.length === 1 ? keys[0] : isObj ? null : 'state');
        return { topic: m[1], field: f, expect: expectFor(f) };
    }
    m = SMARTHOME_SET.exec(topic);
    if (m) {
        const status = `${m[1]}/status/${m[2]}`;
        // `<base>/<dev>/set/<attr>` of zigbee2mqtt: no status topic, but the device object exists
        if (!has(status) && has(m[1])) {
            const attr = m[2];
            return { topic: m[1], field: field || attr, expect: expectFor(field || attr) };
        }
        return { topic: status, field, expect: expectFor(field) };
    }
    return null;
}

/**
 * Whether the device behind a command topic is known to be offline.
 * @param {string} topic the command topic
 * @param {(topic: string) => *} get the state store's value of a topic (undefined when unknown)
 * @returns {string|null} what says so (`hm/connected = 1`), or null
 */
function offlineReason(topic, get) {
    const z = Z2M_SET.exec(topic);
    if (z) {
        const avail = get(`${z[1]}/availability`);
        const state = avail !== null && typeof avail === 'object' ? avail.state : avail;
        if (typeof state === 'string' && state.toLowerCase() === 'offline') return `${z[1]}/availability = offline`;
        return null;
    }
    const inst = topic.split('/')[0];
    if (!inst) return null;
    const c = get(`${inst}/connected`);
    if (c === undefined || c === null) return null;
    const n = typeof c === 'object' ? Number(c.val) : Number(c);
    if (Number.isFinite(n) && n < 2) return `${inst}/connected = ${n}`;
    return null;
}

/** on/true → "1", off/false → "0", else the trimmed lower-case string */
function norm(v) {
    if (v === true) return '1';
    if (v === false) return '0';
    const s = String(v).trim().toLowerCase();
    if (s === 'on' || s === 'true') return '1';
    if (s === 'off' || s === 'false') return '0';
    return s;
}

/**
 * Does a status value confirm the command?
 * @param {*} actual the value seen on the confirm topic (the field already picked)
 * @param {*} expect a value, or fn(actual) → boolean
 * @param {number} [tolerance=0] for numbers
 */
function confirms(actual, expect, tolerance = 0) {
    if (typeof expect === 'function') return !!expect(actual);
    if (actual === undefined) return false;
    if (expect !== null && typeof expect === 'object') {
        // an object payload (several fields): every field must match
        if (actual === null || typeof actual !== 'object') return false;
        return Object.keys(expect).every((k) => confirms(actual[k], expect[k], tolerance));
    }
    const a = typeof actual === 'string' ? actual.trim() : actual;
    const na = Number(a);
    const ne = Number(expect);
    if (a !== '' && expect !== '' && typeof a !== 'boolean' && typeof expect !== 'boolean' && Number.isFinite(na) && Number.isFinite(ne)) {
        return Math.abs(na - ne) <= tolerance;
    }
    return norm(actual) === norm(expect);
}

/**
 * Why a script should not publish to a topic: an adapter writes it as status.
 * @param {string} topic
 * @param {(topic: string) => boolean} has whether the state store knows a topic
 * @returns {string|null}
 */
function statusTopicWarning(topic, has = () => false) {
    const parts = topic.split('/');
    if (parts.length >= 3 && parts[1] === 'status') {
        return `"${topic}" is a status topic — adapters publish there; a command goes to "${parts[0]}/set/${parts.slice(2).join('/')}"`;
    }
    if (parts.length >= 2 && parts[parts.length - 1] !== 'set' && parts[parts.length - 1] !== 'get' && !topic.includes('/set/')) {
        const base = parts[0];
        if (has(`${base}/bridge/info`) || has(`${base}/bridge/state`)) {
            if (parts[1] === 'bridge') return null;
            return `"${topic}" is published by zigbee2mqtt as the device's state; a command goes to "${topic}/set"`;
        }
    }
    return null;
}

const PUBLISH_CALL = /\bshe\.(mqtt\.pub|mqttpub|setValue|mqtt\.command|mqttcommand)\(\s*(['"`])([^'"`$\\\n]+)\2/g;

/**
 * The text of a call from its opening parenthesis to the matching closing one (strings and template
 * literals skipped; at most 2000 characters, enough for an options object).
 * @param {string} text
 * @param {number} open index of the opening parenthesis
 */
function callText(text, open) {
    let depth = 0;
    let quote = null;
    const end = Math.min(text.length, open + 2000);
    for (let i = open; i < end; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return text.slice(open, i + 1);
    }
    return text.slice(open, end);
}

/** a pub call marked as a deliberate publish to a status topic: `{ status: true }` among its options */
const DELIBERATE_STATUS = /\bstatus\s*:\s*true\b/;

/**
 * The literal topics a script publishes to — for the lint at load time.
 * @param {string} source
 * @returns {{ line: number, api: string, topic: string }[]}
 */
function scanPublishTopics(source) {
    const out = [];
    const text = String(source || '');
    let m;
    PUBLISH_CALL.lastIndex = 0;
    while ((m = PUBLISH_CALL.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        if ((m[1] === 'mqtt.pub' || m[1] === 'mqttpub') && DELIBERATE_STATUS.test(callText(text, text.indexOf('(', m.index)))) continue;
        out.push({ line, api: 'she.' + m[1], topic: m[3].replace(/^([^/]+)\/\/(.+)$/, '$1/set/$2') });
    }
    return out;
}

module.exports = { deriveConfirm, offlineReason, confirms, statusTopicWarning, scanPublishTopics };
