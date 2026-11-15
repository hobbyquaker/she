'use strict';

/**
 * Home Assistant MQTT discovery, one config topic at a time: expand a retained config into the
 * entities it announces, each with its full config in long key names.
 *
 * `ha-discovery.js` answers "which devices are announced and which topics belong to them" for the
 * discovery page. This module answers "what exactly is announced" for the home model. The expansion
 * itself — every abbreviation, `~`, the device-based form (`<prefix>/device/…` with `components`)
 * split into its components with the root's shared options inherited — is mqtt-ha-entities', the
 * library behind the entity layer, so Home Assistant's tables exist once. What is she's here: the
 * record per entity (the key without a `unique_id`, the device key, the topics by role).
 *
 * The library is an ES module and loaded asynchronously (`ha-entities.js`); the daemon starts the
 * home model only after it is there. Before that, expanding throws — an empty result would make the
 * mirror take every device for gone.
 */

const haEntities = require('./ha-entities');
const { DEFAULT_PREFIX } = require('./ha-discovery');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTopicKey = (k) => k === 'topic' || k.endsWith('_topic');

function library() {
    const lib = haEntities.get();
    if (!lib) throw new Error('mqtt-ha-entities is not loaded (lib/ha-entities.js load())');
    return lib;
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
    const lib = library();
    const parsed = lib.parseDiscoveryTopic(prefix, topic);
    if (!parsed || !isRecord(payload)) return [];
    const path = topic.slice(prefix.length + 1, -'/config'.length);

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
        // the root's device, origin, availability, state and command topic, qos and encoding apply to
        // every component that does not set them itself; a component reduced to its platform is the
        // device form's way of removing it, and the library leaves it out
        const { components } = lib.expandDevicePayload(payload);
        const out = [];
        for (const [cid, config] of Object.entries(components)) {
            if (typeof config.platform !== 'string' || !config.platform) continue;
            out.push(record(config, config.platform, cid, path + '/' + cid));
        }
        return out;
    }

    return [record(lib.expandEntity(payload), parsed.component, parsed.objectId, path)];
}

module.exports = { expandConfig, classifyTopics, identifierList, deviceKey };
