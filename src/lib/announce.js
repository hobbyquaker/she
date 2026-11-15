'use strict';

/**
 * she.mqtt.announce(): scripts announce their own entities through Home Assistant MQTT discovery,
 * in the device form of the mqtt-smarthome convention (section 8): one retained config per device on
 * `<prefix>/device/<id>/config`, a `components` map of the device's entities, origin she, and the
 * availability from she's own `<name>/connected` (online at 2).
 *
 * A device is the script itself (the default) or a named device (`device: 'Garden'`) that several
 * scripts may fill together. Each entity belongs to the script that announced it; when the script
 * stops its entities are dropped, and a device left without entities gets its config cleared. The
 * drop waits a few seconds, so a reload that announces the same entities again does not make Home
 * Assistant forget and re-create them.
 *
 * The module is pure apart from the injected publish and timer functions, so it can be tested
 * without a broker.
 */

const DEFAULT_PREFIX = 'homeassistant';
/** how long the entities of a stopped script stay announced — a reload announces them again in time */
const DEFAULT_GRACE_MS = 5000;

/** Home Assistant's MQTT platforms that can be announced in a device's `components` */
const COMPONENTS = new Set([
    'alarm_control_panel',
    'binary_sensor',
    'button',
    'camera',
    'climate',
    'cover',
    'device_tracker',
    'device_trigger',
    'event',
    'fan',
    'humidifier',
    'image',
    'lawn_mower',
    'light',
    'lock',
    'notify',
    'number',
    'scene',
    'select',
    'sensor',
    'siren',
    'switch',
    'tag',
    'text',
    'update',
    'vacuum',
    'valve',
    'water_heater',
]);

/** the topic a platform cannot do without */
const REQUIRED_TOPIC = {
    sensor: 'state_topic',
    binary_sensor: 'state_topic',
    event: 'state_topic',
    button: 'command_topic',
    notify: 'command_topic',
    scene: 'command_topic',
    switch: 'command_topic',
    number: 'command_topic',
    select: 'command_topic',
    text: 'command_topic',
    lock: 'command_topic',
    siren: 'command_topic',
    fan: 'command_topic',
    humidifier: 'command_topic',
    light: 'command_topic',
};

/** keys she sets itself; a script that passes them gets an error instead of a silently replaced value */
const RESERVED = {
    unique_id: 'she derives it from the device and the entity id',
    uniq_id: 'she derives it from the device and the entity id',
    platform: 'use component',
    p: 'use component',
    origin: 'the origin is she',
    o: 'the origin is she',
    dev: 'use device',
    availability_topic: "she's availability is added by itself; extra entries go into an availability list",
    avty_t: "she's availability is added by itself; extra entries go into an availability list",
    availability_template: 'belongs to the single-topic form; an availability list entry takes value_template',
    avty_tpl: 'belongs to the single-topic form; an availability list entry takes value_template',
    avty: 'use availability',
    availability_mode: 'she sets it to all when an entity has availability entries of its own',
    avty_mode: 'she sets it to all when an entity has availability entries of its own',
};

/** the keys Home Assistant accepts in an entry of an availability list — one more key rejects the whole device */
const AVAILABILITY_KEYS = new Set(['topic', 'payload_available', 'payload_not_available', 'value_template']);

/** device keys she sets itself */
const DEVICE_RESERVED = new Set(['identifiers', 'ids']);

/** `<id>` of a discovery topic: every character outside [A-Za-z0-9_-] replaced by `_` */
function sanitizeId(s) {
    return String(s).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** a readable object id from an entity name: lower case, runs of other characters as one `_` */
function slug(s) {
    return String(s)
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** the availability entry of she itself: online while she is connected (`<name>/connected` = 2) */
function sheAvailability(instance) {
    return {
        topic: `${instance}/connected`,
        value_template: "{{ 'online' if (value | int(0)) >= 2 else 'offline' }}",
    };
}

/** a plain object — also one made in a script's VM context, whose Object.prototype is another one */
function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
}

/** a topic key of an entity config: `state_topic`, `json_attributes_topic`, `stat_t`, … */
function isTopicKey(k) {
    return /(^|_)(topic|t)$/.test(k);
}

/** command topics are where Home Assistant writes; every other topic is one the script publishes */
function isCommandKey(k) {
    return /(^|_)(command|cmd)(_|$)/.test(k);
}

/** apply the `~` base-topic shorthand */
function applyBase(t, base) {
    if (!base || typeof t !== 'string') return t;
    if (t.startsWith('~')) return base + t.slice(1);
    if (t.endsWith('~')) return t.slice(0, -1) + base;
    return t;
}

/**
 * The rooms hint as a list of names.
 * @returns {string[]}
 */
function roomList(rooms, where) {
    if (rooms === undefined || rooms === null) return [];
    const list = Array.isArray(rooms) ? rooms : [rooms];
    for (const r of list) {
        if (typeof r !== 'string' || !r.trim()) throw new TypeError(`${where}: rooms must be a room name or a list of room names`);
    }
    return list.map((r) => r.trim());
}

/** a JSON value Home Assistant can take: no functions, no undefined, no non-finite numbers */
function checkJson(v, where) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new TypeError(`${where} is not a finite number`);
        return;
    }
    if (Array.isArray(v)) {
        v.forEach((x, i) => checkJson(x, `${where}[${i}]`));
        return;
    }
    if (isPlainObject(v)) {
        for (const [k, x] of Object.entries(v)) checkJson(x, `${where}.${k}`);
        return;
    }
    throw new TypeError(`${where} cannot be sent as JSON (${typeof v})`);
}

/**
 * Check a script's announcement and split it into the entity, the device and the rooms hint.
 * Throws a TypeError that names what is wrong.
 * @param {object} cfg what the script passed
 * @param {string} [api] the name in error messages
 * @returns {{component: string, objectId: string, entity: object, device: object|null, rooms: string[], stateTopics: string[]}}
 */
function validateAnnouncement(cfg, api = 'she.mqtt.announce') {
    if (!isPlainObject(cfg)) throw new TypeError(`${api}: expects an object { component, name, state_topic, command_topic, … }`);
    const { component, id, device, rooms, availability, ...rest } = cfg;
    if (typeof component !== 'string' || !COMPONENTS.has(component)) {
        throw new TypeError(`${api}: component must be a Home Assistant MQTT platform (switch, sensor, binary_sensor, number, …), got ${JSON.stringify(component)}`);
    }
    const where = `${api}(${component})`;
    for (const k of Object.keys(rest)) {
        if (RESERVED[k]) throw new TypeError(`${where}: "${k}" is not allowed — ${RESERVED[k]}`);
    }
    if (!('name' in rest) && id === undefined) throw new TypeError(`${where}: needs a name (or an id when the name is null)`);
    if ('name' in rest && rest.name !== null && (typeof rest.name !== 'string' || !rest.name.trim())) {
        throw new TypeError(`${where}: name must be a non-empty string, or null for the device's main entity`);
    }
    if (id !== undefined && (typeof id !== 'string' || !slug(id))) throw new TypeError(`${where}: id must be a non-empty string`);
    const objectId = id !== undefined ? sanitizeId(id) : slug(rest.name || '');
    if (!objectId) throw new TypeError(`${where}: cannot derive an id from the name ${JSON.stringify(rest.name)} — pass an id`);

    const base = typeof rest['~'] === 'string' ? rest['~'] : null;
    const stateTopics = [];
    for (const [k, v] of Object.entries(rest)) {
        if (!isTopicKey(k)) continue;
        if (typeof v !== 'string' || !v) throw new TypeError(`${where}: ${k} must be a non-empty topic`);
        const t = applyBase(v, base);
        if (/[+#]/.test(t)) throw new TypeError(`${where}: ${k} "${t}" contains a wildcard`);
        if (!isCommandKey(k)) stateTopics.push(t);
    }
    const required = REQUIRED_TOPIC[component];
    if (required && !rest[required]) throw new TypeError(`${where}: a ${component} needs a ${required}`);
    checkJson(rest, where);

    const entity = { platform: component, ...rest };
    if (availability !== undefined) {
        const list = Array.isArray(availability) ? availability : [availability];
        list.forEach((a, i) => {
            if (!isPlainObject(a)) throw new TypeError(`${where}: availability[${i}] must be an object { topic, payload_available, payload_not_available, value_template }`);
            for (const k of Object.keys(a)) {
                if (!AVAILABILITY_KEYS.has(k)) {
                    throw new TypeError(`${where}: availability[${i}] may only carry topic, payload_available, payload_not_available and value_template, not "${k}"`);
                }
            }
            if (typeof a.topic !== 'string' || !a.topic || /[+#]/.test(a.topic)) throw new TypeError(`${where}: availability[${i}].topic must be a topic without wildcards`);
            checkJson(a, `${where}: availability[${i}]`);
        });
        entity.availability = list.map((a) => ({ ...a }));
    }

    let dev = null;
    if (device !== undefined && device !== null) {
        if (typeof device === 'string') {
            if (!device.trim()) throw new TypeError(`${where}: device must be a device name or an object { name, … }`);
            dev = { name: device.trim() };
        } else if (isPlainObject(device)) {
            if (typeof device.name !== 'string' || !device.name.trim()) throw new TypeError(`${where}: device.name must be a non-empty string`);
            for (const k of Object.keys(device)) {
                if (DEVICE_RESERVED.has(k)) throw new TypeError(`${where}: device.${k} is not allowed — she derives the identifiers (device.id names the device)`);
            }
            if (device.id !== undefined && (typeof device.id !== 'string' || !sanitizeId(device.id).replace(/_/g, ''))) {
                throw new TypeError(`${where}: device.id must be a non-empty string`);
            }
            const { rooms: devRooms, ...devRest } = device;
            checkJson(devRest, `${where}: device`);
            dev = { ...devRest, name: device.name.trim(), rooms: roomList(devRooms, `${where}: device`) };
        } else {
            throw new TypeError(`${where}: device must be a device name or an object { name, … }`);
        }
    }

    return { component, objectId, entity, device: dev, rooms: roomList(rooms, where), stateTopics };
}

/**
 * The announcer of a she instance: holds every script's announcements and publishes them.
 *
 * @param {object} opts
 * @param {(topic: string, payload: string) => boolean} opts.publish publishes retained; false when not connected
 * @param {string} [opts.prefix] the discovery prefix
 * @param {string} opts.instance she's instance name — the `<name>/connected` topic and the id prefix
 * @param {{name: string, sw_version?: string, support_url?: string}} opts.origin
 * @param {number} [opts.graceMs] how long a stopped script's entities stay announced
 * @param {(fn: () => void) => void} [opts.defer] runs the coalesced publish (default setImmediate)
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(t: any) => void} [opts.clearTimer]
 */
function createAnnouncer(opts) {
    const prefix = String(opts.prefix || DEFAULT_PREFIX).replace(/\/+$/, '');
    const instance = opts.instance;
    const graceMs = opts.graceMs === undefined ? DEFAULT_GRACE_MS : opts.graceMs;
    const defer = opts.defer || ((fn) => setImmediate(fn));
    const setTimer =
        opts.setTimer ||
        ((fn, ms) => {
            const t = setTimeout(fn, ms);
            if (t && typeof t.unref === 'function') t.unref();
            return t;
        });
    const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));

    /**
     * deviceId → { topic, components: Map<objectId, {owner, entity, device, rooms, stateTopics, defaultName}> }
     * The map keeps the order of the announcements: the first one's device fields and rooms count first.
     */
    const devices = new Map();
    /** config topic → the payload last published (an empty string for a cleared one) */
    const published = new Map();
    /** devices whose config must be published at the next flush */
    const dirty = new Set();
    /** deviceId → timer of a delayed flush after a script stopped */
    const graceTimers = new Map();
    let flushQueued = false;
    let stopped = false;

    function deviceIdFor(owner, ownerLabel, dev) {
        if (dev) return sanitizeId(`she_${instance}_${dev.id !== undefined ? dev.id : slug(dev.name) || dev.name}`);
        return sanitizeId(`she_${instance}_script_${ownerLabel}`);
    }

    function topicOf(deviceId) {
        return `${prefix}/device/${deviceId}/config`;
    }

    /**
     * The config payload of a device, or null when it has no entities left.
     * @param {string} deviceId
     */
    function buildPayload(deviceId) {
        const d = devices.get(deviceId);
        if (!d || d.components.size === 0) return null;
        const device = { identifiers: [deviceId], name: null, manufacturer: 'she', model: 'Script' };
        let area = null;
        for (const c of d.components.values()) {
            if (c.device) {
                const { id: _id, rooms, ...fields } = c.device;
                Object.assign(device, fields);
                if (!area && rooms && rooms.length) area = rooms[0];
            } else if (!device.name) {
                device.name = c.defaultName;
            }
        }
        if (!device.name) device.name = d.components.values().next().value.defaultName;
        if (!area) {
            for (const c of d.components.values()) {
                if (c.rooms.length) {
                    area = c.rooms[0];
                    break;
                }
            }
        }
        if (area && !device.suggested_area) device.suggested_area = area;
        const availability = [sheAvailability(instance)];
        const components = {};
        for (const [objectId, c] of d.components) {
            const cmp = { ...c.entity, unique_id: `${deviceId}_${objectId}` };
            if (cmp.availability) {
                cmp.availability = [...availability, ...cmp.availability];
                cmp.availability_mode = 'all';
            }
            components[objectId] = cmp;
        }
        return { device, origin: { ...opts.origin }, availability, components };
    }

    /** publish what changed; a device without entities gets its config cleared */
    function flush(force = false) {
        flushQueued = false;
        if (stopped) return;
        // a device whose script just stopped waits for its grace timer, even on a reconnect
        const ids = force ? new Set([...[...devices.keys()].filter((id) => !graceTimers.has(id)), ...dirty]) : new Set(dirty);
        dirty.clear();
        for (const deviceId of ids) {
            const topic = topicOf(deviceId);
            const payload = buildPayload(deviceId);
            const text = payload ? JSON.stringify(payload) : '';
            if (!payload) devices.delete(deviceId);
            const last = published.get(topic);
            if (!payload && last === undefined) continue; // never published, nothing to clear
            if (!force && last === text) continue;
            if (opts.publish(topic, text)) {
                if (payload) published.set(topic, text);
                else published.delete(topic);
            } else {
                // not connected: the next connect publishes it
                dirty.add(deviceId);
            }
        }
    }

    function queueFlush(deviceId) {
        dirty.add(deviceId);
        const t = graceTimers.get(deviceId);
        if (t) {
            clearTimer(t);
            graceTimers.delete(deviceId);
        }
        if (flushQueued) return;
        flushQueued = true;
        defer(() => flush());
    }

    function removeComponent(deviceId, objectId) {
        const d = devices.get(deviceId);
        if (!d) return false;
        return d.components.delete(objectId);
    }

    return {
        prefix,

        /**
         * Announce (or announce again) an entity of a script.
         * @param {string} owner the script's file
         * @param {string} ownerLabel the script's name as shown to the user (`lights/garden`)
         * @param {object} cfg what the script passed
         * @returns {{id: string, device: string, topic: string, remove: () => boolean}}
         */
        announce(owner, ownerLabel, cfg) {
            const a = validateAnnouncement(cfg);
            const deviceId = deviceIdFor(owner, ownerLabel, a.device);
            let d = devices.get(deviceId);
            if (!d) {
                d = { topic: topicOf(deviceId), components: new Map() };
                devices.set(deviceId, d);
            }
            const prev = d.components.get(a.objectId);
            if (prev && prev.owner !== owner) {
                throw new TypeError(
                    `she.mqtt.announce(${a.component}): the entity "${a.objectId}" of device "${a.device ? a.device.name : ownerLabel}" is announced by another script already`,
                );
            }
            const entry = { owner, entity: a.entity, device: a.device, rooms: a.rooms, stateTopics: a.stateTopics, defaultName: ownerLabel };
            d.components.set(a.objectId, entry);
            queueFlush(deviceId);
            const uniqueId = `${deviceId}_${a.objectId}`;
            return {
                id: uniqueId,
                device: deviceId,
                topic: d.topic,
                remove: () => {
                    const cur = devices.get(deviceId);
                    if (!cur || cur.components.get(a.objectId) !== entry) return false;
                    removeComponent(deviceId, a.objectId);
                    queueFlush(deviceId);
                    return true;
                },
            };
        },

        /**
         * A script stopped: its entities are dropped. The devices they belonged to are published (or
         * cleared, when nothing is left) after the grace period, unless an announcement comes first.
         * @param {string} owner
         */
        unload(owner) {
            for (const [deviceId, d] of devices) {
                let changed = false;
                for (const [objectId, c] of d.components) {
                    if (c.owner === owner) {
                        d.components.delete(objectId);
                        changed = true;
                    }
                }
                if (!changed) continue;
                if (graceTimers.has(deviceId)) continue;
                if (graceMs <= 0) {
                    queueFlush(deviceId);
                    continue;
                }
                graceTimers.set(
                    deviceId,
                    setTimer(() => {
                        graceTimers.delete(deviceId);
                        dirty.add(deviceId);
                        flush();
                    }, graceMs),
                );
            }
        },

        /** publish every config again: on every broker connect (SPEC 8) */
        republish() {
            flush(true);
        },

        /** whether a script announced this topic as one it publishes (a state or attributes topic) */
        isAnnouncedState(topic) {
            for (const d of devices.values()) {
                for (const c of d.components.values()) if (c.stateTopics.includes(topic)) return true;
            }
            return false;
        },

        /** what is announced, for the UI and the tests */
        list() {
            const out = [];
            for (const [deviceId, d] of devices) {
                for (const [objectId, c] of d.components) {
                    out.push({ device: deviceId, id: `${deviceId}_${objectId}`, owner: c.owner, component: c.entity.platform, name: c.entity.name, topic: d.topic });
                }
            }
            return out;
        },

        /** the payload a device would be published with — for the tests */
        payloadOf(deviceId) {
            return buildPayload(deviceId);
        },

        /** stop publishing: she shuts down, the configs stay retained */
        stop() {
            stopped = true;
            for (const t of graceTimers.values()) clearTimer(t);
            graceTimers.clear();
        },
    };
}

module.exports = { createAnnouncer, validateAnnouncement, sheAvailability, sanitizeId, slug, COMPONENTS, DEFAULT_PREFIX, DEFAULT_GRACE_MS };
