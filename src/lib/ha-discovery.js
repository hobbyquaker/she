'use strict';

/**
 * Home Assistant MQTT discovery analysis (roadmap M10).
 *
 * Pure functions over the daemon's state store: parse every retained
 * `<prefix>/<component>/[<node_id>/]<object_id>/config` announcement, group
 * the entities by the device they belong to and derive, per device,
 *
 *   - the config topics that announce it,
 *   - the state / command / availability topics the announcements reference,
 *   - the retained topics that can safely be wiped along with the device
 *     ("state topics": referenced topics plus everything below the device's
 *     own topic prefix(es), never anything shared with another device),
 *   - an *orphaned* flag (none of the referenced topics exist any more) and a
 *     *duplicate* flag (another device with the same name exists).
 *
 * Both the classic per-entity format and the device-level format (HA 2024.4+,
 * `<prefix>/device/<id>/config` with a `cmps` map) are supported, including
 * the abbreviated key names and the `~` base-topic shorthand.
 */

const DEFAULT_PREFIX = 'homeassistant';

/** Abbreviation → full key (subset of HA's ABBREVIATIONS relevant here). */
const ABBR = {
    dev: 'device',
    ids: 'identifiers',
    mf: 'manufacturer',
    mdl: 'model',
    sw: 'sw_version',
    hw: 'hw_version',
    cns: 'connections',
    cmps: 'components',
    uniq_id: 'unique_id',
    p: 'platform',
    stat_t: 'state_topic',
    cmd_t: 'command_topic',
    avty: 'availability',
    avty_t: 'availability_topic',
    json_attr_t: 'json_attributes_topic',
    t: 'topic',
};

const TOPIC_KEY_RE = /(^|_)(topic|t)$/;

/**
 * Normalise abbreviated keys (recursively) so the rest of the module only
 * deals with long names.
 * @param {*} v
 * @returns {*}
 */
function expandKeys(v) {
    if (Array.isArray(v)) return v.map(expandKeys);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        out[ABBR[k] || k] = expandKeys(val);
    }
    return out;
}

/**
 * Apply the `~` base-topic shorthand to a topic value.
 * @param {string} t
 * @param {string} base
 */
function applyBase(t, base) {
    if (!base || typeof t !== 'string') return t;
    if (t.startsWith('~')) return base + t.slice(1);
    if (t.endsWith('~')) return t.slice(0, -1) + base;
    return t;
}

/**
 * Collect every topic string referenced by a (key-expanded) entity config,
 * split into *state* topics (`state_topic`, `command_topic`, `*_topic`, …)
 * and *availability* topics (`availability_topic`, `availability[].topic`).
 * Availability topics are frequently shared infrastructure (a bridge's
 * `…/bridge/state`), so they are kept apart: they neither derive a device's
 * topic prefix nor decide whether a device is still alive.
 * @param {object} cfg
 * @param {string} base
 * @returns {{state: string[], availability: string[]}}
 */
function collectTopics(cfg, base) {
    const state = new Set();
    const availability = new Set();
    for (const [k, v] of Object.entries(cfg)) {
        if (k === 'device' || k === 'components') continue;
        if (k === 'availability_topic') {
            if (typeof v === 'string' && v) availability.add(applyBase(v, base));
        } else if (k === 'availability') {
            const list = Array.isArray(v) ? v : [v];
            for (const a of list) {
                if (a && typeof a === 'object' && typeof a.topic === 'string' && a.topic) availability.add(applyBase(a.topic, base));
                else if (typeof a === 'string' && a) availability.add(applyBase(a, base));
            }
        } else if (TOPIC_KEY_RE.test(k) && typeof v === 'string' && v) {
            state.add(applyBase(v, base));
        }
    }
    return { state: [...state], availability: [...availability] };
}

/** Merge two collectTopics() results. */
function mergeTopics(a, b) {
    return {
        state: [...new Set([...a.state, ...b.state])],
        availability: [...new Set([...a.availability, ...b.availability])],
    };
}

/**
 * Turn HA's `identifiers` (string | (string|string[])[]) into a stable key.
 * @param {*} ids
 * @returns {string|null}
 */
function identifierKey(ids) {
    if (typeof ids === 'string') return ids || null;
    if (Array.isArray(ids) && ids.length) {
        const first = ids[0];
        if (Array.isArray(first)) return first.map(String).join(':');
        if (first !== null && first !== undefined && first !== '') return String(first);
    }
    return null;
}

/**
 * Parse a discovery config topic.
 * @param {string} topic
 * @param {string} prefix
 * @returns {{component:string,nodeId:string|null,objectId:string}|null}
 */
function parseConfigTopic(topic, prefix) {
    if (!topic.startsWith(prefix + '/')) return null;
    const parts = topic.slice(prefix.length + 1).split('/');
    if (parts[parts.length - 1] !== 'config') return null;
    if (parts.length === 3) return { component: parts[0], nodeId: null, objectId: parts[1] };
    if (parts.length === 4) return { component: parts[0], nodeId: parts[1], objectId: parts[2] };
    return null;
}

/**
 * Longest path prefix of a topic (all segments but the last).
 * @param {string} t
 */
function dirname(t) {
    const i = t.lastIndexOf('/');
    return i > 0 ? t.slice(0, i) : '';
}

function segCount(t) {
    return t ? t.split('/').length : 0;
}

/**
 * Analyse the retained state for HA discovery announcements.
 *
 * @param {Iterable<[string, {val:*, ts?:number}]>} entries  [topic, stateObj] pairs (store.mqttEntries())
 * @param {{prefix?: string}} [opts]
 * @returns {{prefix:string, devices:object[], entityCount:number}}
 */
function analyzeDiscovery(entries, opts = {}) {
    const prefix = (opts.prefix || DEFAULT_PREFIX).replace(/\/+$/, '');
    const all = new Map(); // topic → {val, ts}
    for (const [topic, obj] of entries) all.set(topic, obj);

    /** @type {Map<string, object>} deviceKey → device */
    const devices = new Map();
    let entityCount = 0;

    const getDevice = (key, info, fallbackName) => {
        let d = devices.get(key);
        if (!d) {
            d = {
                id: key,
                name: null,
                manufacturer: null,
                model: null,
                identifiers: [],
                entities: [],
                configTopics: [],
                refTopics: new Set(),
                _stateRefs: new Set(),
                _candidatePrefixes: new Set(),
            };
            devices.set(key, d);
        }
        if (info) {
            if (!d.name && typeof info.name === 'string') d.name = info.name;
            if (!d.manufacturer && typeof info.manufacturer === 'string') d.manufacturer = info.manufacturer;
            if (!d.model && typeof info.model === 'string') d.model = info.model;
            if (!d.identifiers.length && info.identifiers !== undefined) {
                d.identifiers = (Array.isArray(info.identifiers) ? info.identifiers : [info.identifiers]).map((x) => (Array.isArray(x) ? x.join(':') : String(x)));
            }
        }
        if (!d.name && fallbackName) d.name = fallbackName;
        return d;
    };

    const addEntity = (d, entity, refs) => {
        entity.topics = [...new Set([...refs.state, ...refs.availability])].sort();
        d.entities.push(entity);
        entityCount++;
        for (const t of entity.topics) {
            if (t.startsWith(prefix + '/')) continue; // never treat discovery topics as state
            d.refTopics.add(t);
        }
        for (const t of refs.state) {
            if (t.startsWith(prefix + '/')) continue;
            d._stateRefs.add(t);
            const dir = dirname(t);
            if (segCount(dir) >= 2) d._candidatePrefixes.add(dir);
        }
    };

    for (const [topic, obj] of all) {
        const parsed = parseConfigTopic(topic, prefix);
        if (!parsed) continue;
        const raw = obj && obj.val;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const cfg = expandKeys(raw);
        const base = typeof cfg['~'] === 'string' ? cfg['~'] : '';
        const devInfo = cfg.device && typeof cfg.device === 'object' ? cfg.device : null;
        const ts = obj.ts || 0;

        if (parsed.component === 'device' && cfg.components && typeof cfg.components === 'object') {
            // Device-level discovery: one payload announces all components
            const key = identifierKey(devInfo && devInfo.identifiers) || (devInfo && devInfo.name) || 'device:' + parsed.objectId;
            const d = getDevice(key, devInfo, parsed.objectId);
            d.configTopics.push(topic);
            const shared = collectTopics(cfg, base);
            for (const [cid, comp] of Object.entries(cfg.components)) {
                if (!comp || typeof comp !== 'object') continue;
                addEntity(
                    d,
                    {
                        component: typeof comp.platform === 'string' ? comp.platform : 'unknown',
                        objectId: cid,
                        name: typeof comp.name === 'string' ? comp.name : cid,
                        uniqueId: typeof comp.unique_id === 'string' ? comp.unique_id : null,
                        configTopic: topic,
                        ts,
                    },
                    mergeTopics(shared, collectTopics(comp, base)),
                );
            }
            continue;
        }

        const key =
            identifierKey(devInfo && devInfo.identifiers) ||
            (devInfo && typeof devInfo.name === 'string' && devInfo.name) ||
            (parsed.nodeId ? 'node:' + parsed.nodeId : 'entity:' + parsed.component + '/' + parsed.objectId);
        const d = getDevice(key, devInfo, parsed.nodeId || parsed.objectId);
        d.configTopics.push(topic);
        addEntity(
            d,
            {
                component: parsed.component,
                objectId: parsed.objectId,
                name: typeof cfg.name === 'string' ? cfg.name : parsed.objectId,
                uniqueId: typeof cfg.unique_id === 'string' ? cfg.unique_id : null,
                configTopic: topic,
                ts,
            },
            collectTopics(cfg, base),
        );
    }

    // Topics / prefixes referenced by more than one device are shared
    // infrastructure (e.g. `zigbee2mqtt/bridge/state`) and must never be wiped.
    const refOwners = new Map();
    const prefixOwners = new Map();
    for (const d of devices.values()) {
        for (const t of d._stateRefs) refOwners.set(t, (refOwners.get(t) || 0) + 1);
        for (const p of d._candidatePrefixes) prefixOwners.set(p, (prefixOwners.get(p) || 0) + 1);
    }
    const isSharedPrefix = (p) => {
        // shared if the prefix itself, or any ancestor of it, is claimed by another device
        for (const [q, n] of prefixOwners) {
            if (n > 1 && (q === p || p.startsWith(q + '/'))) return true;
        }
        return false;
    };

    const nameCount = new Map();
    for (const d of devices.values()) {
        if (d.name) {
            const k = d.name.trim().toLowerCase();
            nameCount.set(k, (nameCount.get(k) || 0) + 1);
        }
    }

    const allTopics = [...all.keys()];
    const result = [];
    for (const d of devices.values()) {
        // Only state/command topics that no other device references count as
        // "owned"; they drive both the liveness check and the wipe list.
        const ownRefs = [...d._stateRefs].filter((t) => refOwners.get(t) === 1);
        const prefixes = [...d._candidatePrefixes].filter((p) => !isSharedPrefix(p));
        // Drop prefixes nested inside another kept prefix of the same device
        const statePrefixes = prefixes.filter((p) => !prefixes.some((q) => q !== p && p.startsWith(q + '/'))).sort();

        const stateSet = new Set();
        for (const t of ownRefs) if (all.has(t)) stateSet.add(t);
        for (const p of statePrefixes) {
            for (const t of allTopics) {
                if ((t === p || t.startsWith(p + '/')) && !t.startsWith(prefix + '/')) stateSet.add(t);
            }
        }
        for (const t of d.configTopics) stateSet.delete(t);
        const stateTopics = [...stateSet].sort();

        let lastSeen = null;
        let alive = 0;
        for (const t of ownRefs) {
            const o = all.get(t);
            if (o) {
                alive++;
                if (o.ts && (lastSeen === null || o.ts > lastSeen)) lastSeen = o.ts;
            }
        }
        const configTs = Math.max(0, ...d.entities.map((e) => e.ts || 0));

        result.push({
            id: d.id,
            name: d.name,
            manufacturer: d.manufacturer,
            model: d.model,
            identifiers: d.identifiers,
            entities: d.entities.sort((a, b) => a.configTopic.localeCompare(b.configTopic)),
            configTopics: [...new Set(d.configTopics)].sort(),
            refTopics: [...d.refTopics].sort(),
            statePrefixes,
            stateTopics,
            orphaned: ownRefs.length > 0 && alive === 0,
            duplicate: Boolean(d.name && nameCount.get(d.name.trim().toLowerCase()) > 1),
            lastSeen,
            configTs: configTs || null,
        });
    }

    result.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    return { prefix, devices: result, entityCount };
}

module.exports = { analyzeDiscovery, DEFAULT_PREFIX, parseConfigTopic, expandKeys, collectTopics, identifierKey };
