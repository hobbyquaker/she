'use strict';

/**
 * xyz2mqtt service inventory (roadmap I4, Tier 0).
 *
 * Pure functions over the daemon's state store. Adapters built on
 * mqtt-interfaces-core publish two retained topics per instance:
 *
 *   <name>/connected   0 (LWT / shut down) · 1 (mqtt only) · 2 (mqtt + device)
 *   <name>/info        {name: <npm package>, version, spec, node, host, pid, started, maintenance, …}
 *
 * An instance is "core" when it has an info payload with `name` and `version`;
 * a `connected` topic without info is a *legacy* instance (pre-core adapters
 * such as hm2mqtt, hue2mqtt) which only supports the connected state.
 *
 * Nothing here talks to MQTT — the API layer publishes to the maintenance
 * topics and clears retained messages; this module only derives the picture
 * and the list of topics a wipe would clear.
 */

const { analyzeDiscovery, DEFAULT_PREFIX } = require('./ha-discovery');

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * Parse a `<name>/connected` payload to 0 | 1 | 2, or null when unusable.
 * @param {*} val
 * @returns {0|1|2|null}
 */
function parseConnected(val) {
    if (val === null || val === undefined) return null;
    // adapters running with --json-payloads still publish connected as a plain number,
    // but tolerate {val} objects and JSON strings in case somebody wraps it
    let v = val;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t.startsWith('{')) {
            try {
                v = JSON.parse(t);
            } catch {
                return null;
            }
        } else {
            v = t;
        }
    }
    if (v && typeof v === 'object' && 'val' in v) v = v.val;
    const n = Number(v);
    return n === 0 || n === 1 || n === 2 ? n : null;
}

/**
 * Parse a `<name>/info` payload into an object, or null.
 * @param {*} val
 * @returns {object|null}
 */
function parseInfo(val) {
    let v = val;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        } catch {
            return null;
        }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    // adapters publish info as a plain object; a {val: {...}} wrapper is tolerated
    if (v.val && typeof v.val === 'object' && !('name' in v) && 'name' in v.val) v = v.val;
    return v;
}

/**
 * Derive the service inventory from the retained MQTT state.
 *
 * @param {Iterable<[string, {val:*, ts:number, lc?:number}]>} entries  `store.mqttEntries()`
 * @param {{now?: number}} [opts]
 * @returns {{instances: Array<object>, coreCount: number, legacyCount: number}}
 */
function analyzeServices(entries, opts = {}) {
    const now = opts.now ?? Date.now();
    const infos = new Map(); // instance → {info, ts}
    const conns = new Map(); // instance → {connected, ts, lc}
    const topics = new Set();

    for (const [topic, obj] of entries) {
        topics.add(topic);
        const slash = topic.indexOf('/');
        if (slash <= 0 || topic.indexOf('/', slash + 1) !== -1) continue; // exactly two levels
        const instance = topic.slice(0, slash);
        const leaf = topic.slice(slash + 1);
        if (instance.startsWith('$')) continue;
        if (leaf === 'info') {
            const info = parseInfo(obj && obj.val);
            if (info && typeof info.name === 'string' && info.name) infos.set(instance, { info, ts: obj.ts });
        } else if (leaf === 'connected') {
            const connected = parseConnected(obj && obj.val);
            if (connected !== null) conns.set(instance, { connected, ts: obj.ts, lc: obj.lc });
        }
    }

    const names = new Set([...infos.keys(), ...conns.keys()]);
    const instances = [];
    for (const instance of names) {
        const i = infos.get(instance);
        const c = conns.get(instance);
        const info = i ? i.info : null;
        const connected = c ? c.connected : null;
        let started = null;
        if (info && typeof info.started === 'string') {
            const t = Date.parse(info.started);
            if (!Number.isNaN(t)) started = t;
        }
        const statusTopics = [...topics].filter((t) => t.startsWith(instance + '/status/')).length;
        instances.push({
            instance,
            legacy: !info,
            adapter: info ? info.name : null,
            version: info && typeof info.version === 'string' ? info.version : null,
            spec: info && typeof info.spec === 'string' ? info.spec : null,
            host: info && typeof info.host === 'string' ? info.host : null,
            node: info && typeof info.node === 'string' ? info.node : null,
            pid: info && Number.isInteger(info.pid) ? info.pid : null,
            started,
            // uptime only means something while the process is up; a `started` of a
            // retained info from a dead instance would just grow forever
            uptime: started !== null && connected !== null && connected > 0 ? Math.max(0, now - started) : null,
            maintenance: info ? info.maintenance === true : false,
            connected,
            connectedTs: c ? c.ts : null,
            connectedLc: c ? (c.lc ?? c.ts) : null,
            infoTs: i ? i.ts : null,
            statusTopics,
            info,
        });
    }
    instances.sort((a, b) => a.instance.localeCompare(b.instance));
    return {
        instances,
        coreCount: instances.filter((x) => !x.legacy).length,
        legacyCount: instances.filter((x) => x.legacy).length,
    };
}

/**
 * Retained topics that belong to an instance and can be cleared when it is gone:
 * `<name>/info`, `<name>/connected`, everything below `<name>/status/` and
 * `<name>/maintenance/`, plus the Home Assistant discovery announcements whose
 * availability or state topics point at the instance (never announcements that
 * also belong to another device — `analyzeDiscovery` already excludes shared ones).
 *
 * @param {Iterable<[string, {val:*, ts:number}]>} entries `store.mqttEntries()`
 * @param {string} instance topic prefix
 * @param {{haPrefix?: string}} [opts]
 * @returns {{own: string[], discovery: string[]}}
 */
function wipeTopics(entries, instance, opts = {}) {
    const list = Array.isArray(entries) ? entries : [...entries];
    const own = [];
    for (const [topic] of list) {
        if (topic === instance + '/info' || topic === instance + '/connected' || topic.startsWith(instance + '/status/') || topic.startsWith(instance + '/maintenance/')) {
            own.push(topic);
        }
    }
    own.sort();

    const haPrefix = opts.haPrefix || DEFAULT_PREFIX;
    const discovery = new Set();
    const { devices } = analyzeDiscovery(list, { prefix: haPrefix });
    const isOurs = (t) => t === instance + '/connected' || t.startsWith(instance + '/');
    for (const d of devices) {
        // a device is the instance's when every topic it references lives under the instance
        // prefix — the core builds availability from <name>/connected and state from <name>/status/…
        if (d.refTopics.length > 0 && d.refTopics.every(isOurs)) {
            for (const t of d.configTopics) discovery.add(t);
        }
    }
    return { own, discovery: [...discovery].sort() };
}

module.exports = { analyzeServices, wipeTopics, parseConnected, parseInfo, LOG_LEVELS };
