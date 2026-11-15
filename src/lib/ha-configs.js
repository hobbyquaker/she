'use strict';

/**
 * Home Assistant MQTT discovery, one config topic at a time: expand a retained config into the
 * entities it announces, each with its full config in long key names.
 *
 * `ha-discovery.js` answers "which devices are announced and which topics belong to them" for the
 * discovery page. This module answers "what exactly is announced" for the home model: every
 * abbreviation expanded, `~` substituted, the device-based form (`<prefix>/device/…` with
 * `components`) split into its components with the root's shared options inherited.
 */

const { ABBREVIATIONS, DEVICE_ABBREVIATIONS, ORIGIN_ABBREVIATIONS } = require('./ha-abbreviations');
const { parseConfigTopic, DEFAULT_PREFIX } = require('./ha-discovery');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTopicKey = (k) => k === 'topic' || k.endsWith('_topic');

/** Expand the keys of one object (not recursive: every block has a table of its own). */
function expandKeys(obj, table) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[Object.hasOwn(table, k) ? table[k] : k] = v;
    return out;
}

/** `~` at the start or the end of a topic stands for the base topic. */
function substituteBase(value, base) {
    if (typeof value !== 'string' || typeof base !== 'string') return value;
    if (value.startsWith('~')) return base + value.slice(1);
    if (value.endsWith('~')) return value.slice(0, -1) + base;
    return value;
}

/**
 * One entity block with long key names and `~` substituted. `device`, `origin` and `availability`
 * entries have abbreviation tables of their own.
 * @param {object} raw
 * @param {string} [fallbackBase] the root's `~` in the device-based form
 */
function expandBlock(raw, fallbackBase) {
    const expanded = expandKeys(raw, ABBREVIATIONS);
    const base = typeof expanded['~'] === 'string' ? expanded['~'] : fallbackBase;
    delete expanded['~'];
    const out = {};
    for (const [key, value] of Object.entries(expanded)) {
        if (key === 'device' && isRecord(value)) out.device = expandKeys(value, DEVICE_ABBREVIATIONS);
        else if (key === 'origin' && isRecord(value)) out.origin = expandKeys(value, ORIGIN_ABBREVIATIONS);
        else if (key === 'availability') {
            const list = (Array.isArray(value) ? value : [value]).filter(isRecord).map((item) => {
                const entry = expandKeys(item, ABBREVIATIONS);
                entry.topic = substituteBase(entry.topic, base);
                return entry;
            });
            if (list.length) out.availability = list;
        } else if (isTopicKey(key)) out[key] = substituteBase(value, base);
        else out[key] = value;
    }
    return { config: out, base };
}

/**
 * The topics a (long-named) entity config references, by role.
 * @param {object} config
 * @returns {{state:string[], command:string[], availability:string[], attributes:string[]}}
 */
function classifyTopics(config) {
    const sets = { state: new Set(), command: new Set(), availability: new Set(), attributes: new Set() };
    for (const [key, value] of Object.entries(config)) {
        if (key === 'availability') {
            for (const a of Array.isArray(value) ? value : []) if (a && typeof a.topic === 'string' && a.topic) sets.availability.add(a.topic);
            continue;
        }
        if (!isTopicKey(key) || typeof value !== 'string' || !value) continue;
        if (key === 'availability_topic') sets.availability.add(value);
        else if (key === 'json_attributes_topic') sets.attributes.add(value);
        else if (key.endsWith('command_topic') || /^set_.+_topic$/.test(key)) sets.command.add(value);
        else sets.state.add(value);
    }
    return Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, [...s].sort()]));
}

/** `identifiers` as a flat list of strings (HA accepts a string or a list). */
function identifierList(ids) {
    if (ids === undefined || ids === null || ids === '') return [];
    return (Array.isArray(ids) ? ids : [ids]).map((x) => (Array.isArray(x) ? x.join(':') : String(x))).filter(Boolean);
}

/**
 * The key a device is identified by: its first identifier, else its first connection, else its name.
 * @param {object|null} device  long-named device block
 * @returns {string|null}
 */
function deviceKey(device) {
    if (!isRecord(device)) return null;
    const ids = identifierList(device.identifiers);
    if (ids.length) return ids[0];
    if (Array.isArray(device.connections) && Array.isArray(device.connections[0]) && device.connections[0].length) return device.connections[0].map(String).join(':');
    if (typeof device.name === 'string' && device.name) return device.name;
    return null;
}

/**
 * Expand one discovery config topic.
 *
 * @param {string} topic
 * @param {*} payload  the parsed JSON payload
 * @param {string} [prefix]
 * @returns {object[]} one record per announced entity — empty for anything that is not a config:
 *   `{configTopic, key, component, objectId, uniqueId, config, device, deviceKey, origin, topics}`.
 *   `config` is the entity's own config without `device` and `origin` (they are on the record);
 *   `key` identifies the entity within the discovery prefix when it has no `unique_id`.
 */
function expandConfig(topic, payload, prefix = DEFAULT_PREFIX) {
    const parsed = parseConfigTopic(topic, prefix);
    if (!parsed || !isRecord(payload)) return [];
    const path = topic.slice(prefix.length + 1, -'/config'.length);
    const { config: root, base: rootBase } = expandBlock(payload);

    const record = (config, component, objectId, key) => {
        const device = isRecord(config.device) ? config.device : null;
        const origin = isRecord(config.origin) ? config.origin : null;
        const own = { ...config };
        delete own.device;
        delete own.origin;
        delete own.components;
        return {
            configTopic: topic,
            key,
            component,
            objectId,
            uniqueId: typeof own.unique_id === 'string' && own.unique_id ? own.unique_id : null,
            config: own,
            device,
            deviceKey: deviceKey(device),
            origin,
            topics: classifyTopics(own),
        };
    };

    if (parsed.component === 'device') {
        if (!isRecord(root.components)) return [];
        // the root's device, origin, availability, state and command topic, qos and encoding apply to
        // every component that does not set them itself
        const shared = { ...root };
        delete shared.components;
        const out = [];
        for (const [cid, comp] of Object.entries(root.components)) {
            if (!isRecord(comp)) continue;
            const { config } = expandBlock(comp, rootBase);
            // a component reduced to its platform is the device form's way of removing it
            if (typeof config.platform !== 'string' || Object.keys(config).length < 2) continue;
            for (const [k, v] of Object.entries(shared)) if (!(k in config)) config[k] = v;
            out.push(record(config, config.platform, cid, path + '/' + cid));
        }
        return out;
    }

    return [record(root, parsed.component, parsed.objectId, path)];
}

module.exports = { expandConfig, classifyTopics, identifierList, deviceKey, substituteBase };
