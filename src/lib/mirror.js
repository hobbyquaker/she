'use strict';
/**
 * Mirror rules between the primary broker and an additional ("secondary") broker (roadmap M2).
 *
 * A rule copies messages one way: `in` from the secondary to the primary, `out` from the primary to
 * the secondary. `from` is an MQTT filter on the source broker, `to` the topic on the target broker,
 * written with the same wildcards so the matched segments are carried over (`tele/#` → `shed/tele/#`,
 * `+/status/#` → `remote/+/status/#`); without `to` the topic stays the same. QoS and retain are kept as
 * delivered: the retained burst at (re)connect is mirrored retained, a live publish arrives without the
 * flag (MQTT 3.1.1 clears it for established subscriptions) and goes out as a live message.
 *
 * Loop protection: the daemon subscribes to `#` on every broker, so each mirrored publish comes back
 * as a message on the target broker. Every publish the mirror makes is remembered (target, topic,
 * payload) until its echo arrives; the echo is stored like any message but is never mirrored again.
 * That holds for one rule as for two rules that would form a cycle (`in` `#` → `x/#` plus `out`
 * `x/#` → `#`): the cycle could only continue through the echo, and the echo is consumed. Retained
 * messages that arrive again with the same payload (a reconnect's retained burst) are not sent twice.
 */

const mqttWildcard = require('./mqtt-wildcards');

const ECHO_TTL_MS = 30_000;
const DIRECTIONS = new Set(['in', 'out']);

/** Is `filter` a syntactically valid MQTT topic filter? */
function isValidFilter(filter) {
    if (typeof filter !== 'string' || filter.length === 0) return false;
    const segs = filter.split('/');
    return segs.every((s, i) => {
        if (s === '#') return i === segs.length - 1;
        if (s.includes('#')) return false;
        if (s.includes('+')) return s === '+';
        return true;
    });
}

const countPlus = (f) => f.split('/').filter((s) => s === '+').length;
const hasHash = (f) => f.split('/').includes('#');

/**
 * Normalise and validate the `mirror` list of one broker's config.
 * @param {*} raw the config value
 * @param {string} broker the broker's name, for the messages
 * @returns {{ rules: { dir: 'in'|'out', from: string, to: string }[], errors: string[] }}
 */
function normalizeRules(raw, broker) {
    const rules = [];
    const errors = [];
    if (raw === undefined || raw === null) return { rules, errors };
    if (!Array.isArray(raw)) {
        errors.push(`brokers.${broker}.mirror must be a list of rules`);
        return { rules, errors };
    }
    raw.forEach((r, i) => {
        const where = `brokers.${broker}.mirror[${i}]`;
        if (!r || typeof r !== 'object') {
            errors.push(`${where}: not a rule object`);
            return;
        }
        const dir = r.dir;
        if (!DIRECTIONS.has(dir)) {
            errors.push(`${where}: dir must be "in" or "out"`);
            return;
        }
        const from = r.from;
        if (!isValidFilter(from)) {
            errors.push(`${where}: from "${from}" is not a valid topic filter`);
            return;
        }
        const to = r.to === undefined || r.to === null || r.to === '' ? from : r.to;
        if (!isValidFilter(to)) {
            errors.push(`${where}: to "${to}" is not a valid topic filter`);
            return;
        }
        if (countPlus(to) > countPlus(from)) {
            errors.push(`${where}: to "${to}" has more + wildcards than from "${from}"`);
            return;
        }
        if (hasHash(to) && !hasHash(from)) {
            errors.push(`${where}: to "${to}" has a # wildcard but from "${from}" has none`);
            return;
        }
        rules.push({ dir, from, to });
    });
    return { rules, errors };
}

/**
 * The target topic of a message under a rule, or null when the rule does not match.
 * @param {string} topic the topic on the source broker
 * @param {string} from the rule's filter
 * @param {string} to the rule's target (the same wildcards, or a literal topic)
 * @returns {string|null}
 */
function mapTopic(topic, from, to) {
    const caps = mqttWildcard(topic, from);
    if (caps === null) return null;
    if (!/[+#]/.test(to)) return to;
    const nPlus = countPlus(from);
    const plusCaps = caps.slice(0, nPlus);
    const rest = hasHash(from) ? (caps[nPlus] ?? '') : '';
    let k = 0;
    const out = [];
    for (const seg of to.split('/')) {
        if (seg === '+') out.push(plusCaps[k++]);
        else if (seg === '#') {
            if (rest !== '') out.push(rest);
        } else out.push(seg);
    }
    return out.join('/');
}

/** The one-click presets of the Config page, as rules. */
const PRESETS = {
    /** everything of the secondary appears on the primary under `<name>/` */
    everythingIn: (name) => [{ dir: 'in', from: '#', to: `${name}/#` }],
    /** an mqtt-smarthome adapter instance on the secondary, reachable from the primary as if it were local */
    smarthomeAdapter: (inst) => [
        { dir: 'in', from: `${inst}/status/#`, to: `${inst}/status/#` },
        { dir: 'in', from: `${inst}/connected`, to: `${inst}/connected` },
        { dir: 'out', from: `${inst}/set/#`, to: `${inst}/set/#` },
    ],
};

/** a payload as a map key: latin1 maps every byte to one character, so two payloads collide only when equal */
const payloadKey = (payload) => (Buffer.isBuffer(payload) ? payload.toString('latin1') : Buffer.from(String(payload)).toString('latin1'));

/**
 * The engine: holds the rules of every secondary and forwards messages.
 * @param {object} deps
 * @param {(topic: string, payload: Buffer|string, opts: { retain: boolean, qos: number }) => boolean|void} deps.publishPrimary
 * @param {(name: string, topic: string, payload: Buffer|string, opts: object) => boolean|void} deps.publishSecondary
 *   both return false when nothing was sent (not connected, dropped) — then no echo is expected
 * @param {{ debug: Function, warn: Function }} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.echoTtlMs]
 */
function createMirror(deps) {
    const now = deps.now || Date.now;
    const ttl = deps.echoTtlMs || ECHO_TTL_MS;
    const log = deps.log || { debug() {}, warn() {} };
    /** broker name → { in: rule[], out: rule[] } */
    const rulesOf = new Map();
    /** broker name → { in: count, out: count } */
    const counts = new Map();
    /** `${target}\0${topic}\0${payload}` → expiry timestamps of the echoes still expected */
    const echoes = new Map();
    /** `${target}\0${topic}` → the payload key of the last retained message mirrored there */
    const lastRetained = new Map();

    const PRIMARY = '';
    const echoKey = (target, topic, payload) => `${target}\0${topic}\0${payloadKey(payload)}`;

    function sweep() {
        const t = now();
        for (const [k, list] of echoes) {
            const live = list.filter((exp) => exp > t);
            if (live.length === 0) echoes.delete(k);
            else if (live.length !== list.length) echoes.set(k, live);
        }
    }

    function expectEcho(target, topic, payload) {
        if (echoes.size > 5000) sweep();
        const k = echoKey(target, topic, payload);
        const list = echoes.get(k) || [];
        list.push(now() + ttl);
        echoes.set(k, list);
    }

    /**
     * Was this message our own mirrored publish coming back? Consumes one expected echo.
     * @param {string|null} broker the broker the message arrived on (null: the primary)
     */
    function consumeEcho(broker, topic, payload) {
        if (echoes.size === 0) return false;
        const k = echoKey(broker || PRIMARY, topic, payload);
        const list = echoes.get(k);
        if (!list) return false;
        const t = now();
        const live = list.filter((exp) => exp > t);
        if (live.length === 0) {
            echoes.delete(k);
            return false;
        }
        live.pop();
        if (live.length === 0) echoes.delete(k);
        else echoes.set(k, live);
        return true;
    }

    /** forward one message to `target` ('' = primary) if it is not a retained repeat */
    function forward(target, topic, payload, msg, send) {
        const retain = !!(msg && msg.retain);
        const opts = { retain, qos: typeof msg?.qos === 'number' ? msg.qos : 0 };
        const rk = `${target}\0${topic}`;
        if (retain) {
            const pk = payloadKey(payload);
            if (lastRetained.get(rk) === pk) return false;
            lastRetained.set(rk, pk);
        }
        // the publish is remembered before it is sent: the echo can arrive on the next tick
        expectEcho(target, topic, payload);
        const sent = send(opts);
        if (sent === false) {
            consumeEcho(target || null, topic, payload);
            if (retain) lastRetained.delete(rk);
            return false;
        }
        return true;
    }

    const bump = (name, dir) => {
        const c = counts.get(name) || { in: 0, out: 0 };
        c[dir]++;
        counts.set(name, c);
    };

    return {
        /** set (or replace) the rules of a secondary */
        setRules(name, rules) {
            rulesOf.set(name, { in: rules.filter((r) => r.dir === 'in'), out: rules.filter((r) => r.dir === 'out') });
            if (!counts.has(name)) counts.set(name, { in: 0, out: 0 });
        },
        removeBroker(name) {
            rulesOf.delete(name);
            counts.delete(name);
        },
        rules(name) {
            const r = rulesOf.get(name);
            return r ? [...r.in, ...r.out] : [];
        },
        consumeEcho,
        /** a message arrived on the primary: apply every secondary's `out` rules */
        fromPrimary(topic, payload, msg) {
            if (topic.startsWith('$')) return;
            for (const [name, r] of rulesOf) {
                for (const rule of r.out) {
                    const target = mapTopic(topic, rule.from, rule.to);
                    if (target === null) continue;
                    if (forward(name, target, payload, msg, (opts) => deps.publishSecondary(name, target, payload, opts))) {
                        bump(name, 'out');
                        log.debug(`mirror out ${name}: ${topic} → ${target}`);
                    }
                    break; // the first matching rule wins
                }
            }
        },
        /** a message arrived on a secondary: apply its `in` rules */
        fromSecondary(name, topic, payload, msg) {
            if (topic.startsWith('$')) return;
            const r = rulesOf.get(name);
            if (!r) return;
            for (const rule of r.in) {
                const target = mapTopic(topic, rule.from, rule.to);
                if (target === null) continue;
                if (forward(PRIMARY, target, payload, msg, (opts) => deps.publishPrimary(target, payload, opts))) {
                    bump(name, 'in');
                    log.debug(`mirror in ${name}: ${topic} → ${target}`);
                }
                break;
            }
        },
        /** how many messages were mirrored for a broker since start */
        stats(name) {
            const c = counts.get(name);
            return c ? { ...c } : { in: 0, out: 0 };
        },
        /** for the tests: how many publishes still wait for their echo */
        _pendingEchoes: () => echoes.size,
    };
}

module.exports = { createMirror, normalizeRules, mapTopic, isValidFilter, PRESETS, ECHO_TTL_MS };
