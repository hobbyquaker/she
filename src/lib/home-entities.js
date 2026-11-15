'use strict';

/**
 * The entity layer of the home model: the live state of every entity, and commands in Home
 * Assistant's terms (`{state: 'ON', brightness: 102}`, `{position: 30}`).
 *
 * The home model keeps what discovery announced: an entity document per entity, with the expanded
 * config in `ha.config`. `mqtt-ha-entities` knows what such a config means — which topic carries
 * which attribute, through which template, and which publishes set it. This class joins the two
 * with the state store: it builds one library entity per document, reads its state from the last
 * payload of each of its topics, publishes its commands, and tells who asked when a state changes.
 *
 * It keeps no state of its own besides what it needs to notice a change.
 */

const { EventEmitter } = require('events');

const PREFIX = 'she/entity/';
const MQTT_NS = 'mqtt::';

/** marks a state object whose payload was a JSON object with `val` (see parse-payload.js) */
const { ENVELOPE } = require('./parse-payload');
const { escapeId } = require('./home-model');

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The payload a state object came from, as the library wants it: text, or a parsed value it turns
 * into JSON itself. The state store keeps parsed values; `{"val": 21, "ts": …}` — the form the
 * mqtt-smarthome adapters publish — is kept as the object it was, and a template that says
 * `value_json.val` has to find it again.
 * @param {{val: *}|undefined} obj
 */
function payloadOf(obj) {
    if (!obj) return undefined;
    if (obj[ENVELOPE]) return JSON.stringify(obj);
    return obj.val;
}

class HomeEntities extends EventEmitter {
    /**
     * @param {object} opts
     * @param {object} opts.lib      the exports of mqtt-ha-entities
     * @param {object} opts.core     the sheDB core (the entity documents are read from it)
     * @param {object} opts.store    the state store
     * @param {(topic: string, payload: string, options: {retain: boolean, qos: number}) => boolean} opts.publish
     *                               publish on the primary broker; false when it is not connected
     * @param {object} opts.log
     */
    constructor({ lib, core, store, publish, log }) {
        super();
        this.setMaxListeners(0);
        this.lib = lib;
        this.core = core;
        this.store = store;
        this.publish = publish;
        this.log = log;

        /** document id → {entity, config (JSON), topics: string[], last: string|undefined} */
        this._records = new Map();
        /** topic → Set of document ids that read it (state and availability) */
        this._readers = new Map();
        /** document id → Set of callbacks */
        this._watchers = new Map();
        /** callbacks that hear every entity */
        this._watchAll = new Set();

        this._messages = (topic) => payloadOf(this.store.getObject(MQTT_NS + topic));
        this._timestamps = (topic) => this.store.getObject(MQTT_NS + topic)?.ts;

        this._onDoc = (id, doc) => {
            if (typeof id === 'string' && id.startsWith(PREFIX)) this._take(id, isRecord(doc) ? doc : null, true);
        };
        this._onChange = (key) => {
            if (key.startsWith(MQTT_NS)) this._topicChanged(key.slice(MQTT_NS.length));
        };

        for (const id of Object.keys(core.docs)) {
            if (id.startsWith(PREFIX)) this._take(id, core.docs[id], false);
        }
        core.on('update', this._onDoc);
        store.on('change', this._onChange);
        store.on('delete', this._onChange);
    }

    /** Stop listening (shutdown, tests). */
    stop() {
        this.core.off('update', this._onDoc);
        this.store.off('change', this._onChange);
        this.store.off('delete', this._onChange);
        this._watchers.clear();
        this._watchAll.clear();
    }

    // ------------------------------------------------------------------
    // The entities
    // ------------------------------------------------------------------

    /** A document became, changed or went: keep the library entity in line with its config. */
    _take(id, doc, announce) {
        const usable = doc && doc.kind === 'entity' && isRecord(doc.ha) && isRecord(doc.ha.config) && typeof doc.ha.component === 'string';
        const prev = this._records.get(id);
        if (!usable) {
            if (!prev) return;
            this._unindex(id, prev);
            this._records.delete(id);
            if (announce) this._configChanged(id);
            return;
        }
        // the model rewrites a document for every change of a room or a name: only a config counts here
        const config = JSON.stringify(doc.ha.config) + '\n' + doc.ha.component;
        if (prev && prev.config === config) return;
        if (prev) this._unindex(id, prev);
        let entity;
        try {
            entity = this.lib.createEntity({
                id,
                topic: typeof doc.ha.config_topic === 'string' ? doc.ha.config_topic : '',
                component: doc.ha.component,
                objectId: typeof doc.ha.object_id === 'string' ? doc.ha.object_id : '',
                config: JSON.parse(JSON.stringify(doc.ha.config)),
            });
        } catch (err) {
            this.log.warn(`home model: ${id}: ${err.message}`);
            this._records.delete(id);
            return;
        }
        const t = entity.topics();
        const record = { entity, config, topics: [...new Set([...t.state, ...t.availability])], last: undefined };
        this._records.set(id, record);
        for (const topic of record.topics) {
            if (!this._readers.has(topic)) this._readers.set(topic, new Set());
            this._readers.get(topic).add(id);
        }
        if (announce) this._configChanged(id);
    }

    _unindex(id, record) {
        for (const topic of record.topics) {
            const set = this._readers.get(topic);
            if (!set) continue;
            set.delete(id);
            if (!set.size) this._readers.delete(topic);
        }
    }

    /** An entity's config is new, different or gone: its state may be another one now. */
    _configChanged(id) {
        this.emit('config', id);
        this._evaluate(id);
    }

    /**
     * The document id of an entity, or null.
     * @param {string} ref  a document id (`she/entity/…`), its short form, a `unique_id`, a discovery
     *                      config topic, or a topic the entity reads or writes. Several entities on
     *                      one topic: the one that can be commanded wins over sensors, then the first.
     */
    resolve(ref) {
        if (typeof ref !== 'string' || ref === '') return null;
        if (this._records.has(ref)) return ref;
        if (this._records.has(PREFIX + ref)) return PREFIX + ref;
        const escaped = PREFIX + escapeId(ref);
        if (this._records.has(escaped)) return escaped;
        let found = null;
        let foundRank = Infinity;
        for (const [id, record] of this._records) {
            const { entity } = record;
            if (entity.uniqueId === ref) return id;
            let rank;
            if (entity.topic === ref) rank = 3;
            else {
                const t = entity.topics();
                if (t.command.includes(ref)) rank = 0;
                else if (t.state.includes(ref)) rank = t.command.length ? 1 : 2;
                else continue;
            }
            if (rank < foundRank) {
                found = id;
                foundRank = rank;
            }
        }
        return found;
    }

    /** The ids of all entities the layer knows. */
    ids() {
        return [...this._records.keys()];
    }

    /** The library's entity object for a document id, or null. */
    entity(id) {
        return this._records.get(id)?.entity ?? null;
    }

    /**
     * What an entity is, without its state: `{id, component, supported, stateless, primary,
     * attributes, topics}`, or null. `attributes` says what it tells and takes
     * (`{brightness: {read, write, min, max}, …}`).
     */
    describe(id) {
        const record = this._records.get(id);
        if (!record) return null;
        const { entity } = record;
        return {
            id,
            component: entity.component,
            supported: entity.supported,
            stateless: entity.stateless,
            primary: entity.primary ?? null,
            attributes: entity.attributes(),
            topics: entity.topics(),
        };
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /**
     * The state in Home Assistant's terms, from the state store: `{state: 'ON', brightness: 102}`.
     * An attribute nothing has been received for is left out; `{}` for an unknown entity.
     * @param {string} id
     * @param {{problems?: string[]}} [options]  `problems` collects why an attribute is missing
     */
    state(id, options = {}) {
        const record = this._records.get(id);
        return record ? record.entity.readState(this._messages, options) : {};
    }

    /** The part of the state that can be set again — what a scene stores. */
    snapshot(id, options = {}) {
        const record = this._records.get(id);
        return record ? record.entity.snapshot(this._messages, options) : {};
    }

    /**
     * Is the entity available? true, false, or undefined while its availability topics have said
     * nothing that can be understood. An entity without availability is available; an unknown
     * entity is not.
     */
    available(id) {
        const record = this._records.get(id);
        if (!record) return false;
        return record.entity.available(this._messages, { timestamps: this._timestamps });
    }

    /**
     * An expected state against the present one.
     * @param {string} id
     * @param {object} expected                       attributes as {@link state} returns them
     * @param {{tolerances?: object}} [options]       per attribute, over the library's defaults
     * @returns {{match: boolean, available: boolean|undefined, unknown: string[], mismatches: {attribute: string, expected: *, actual: *}[], state: object}}
     *          `match` is false for an entity that is unknown or not available
     */
    compare(id, expected, options = {}) {
        const record = this._records.get(id);
        if (!record) return { match: false, available: false, unknown: Object.keys(expected || {}), mismatches: [], state: {} };
        const state = this.state(id);
        const available = this.available(id);
        const result = record.entity.compare(expected, state, options);
        return { ...result, match: result.match && available !== false, available, state };
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    /**
     * Set attributes: build the publishes and send them on the primary broker.
     * @param {string} id
     * @param {object} attributes   `{state: 'ON', brightness: 102}`, `{position: 30}`, `{}` for a button or a scene
     * @param {{dryRun?: boolean}} [options]  `dryRun`: build, do not send
     * @returns {{sent: {topic: string, payload: string, retain: boolean, qos: number}[], problems: string[]}}
     *          `problems` says what could not be set and why; nothing is thrown for it
     */
    command(id, attributes = {}, options = {}) {
        const record = this._records.get(id);
        if (!record) return { sent: [], problems: [`${id}: no such entity`] };
        if (!isRecord(attributes)) return { sent: [], problems: ['the attributes are not an object'] };
        const problems = [];
        const publishes = record.entity.command(attributes, { problems, current: this.state(id) });
        if (options.dryRun) return { sent: publishes, problems };
        const sent = [];
        for (const p of publishes) {
            if (this.publish(p.topic, p.payload, { retain: p.retain, qos: p.qos })) sent.push(p);
            else {
                problems.push('not connected to the broker: nothing more was sent');
                break;
            }
        }
        return { sent, problems };
    }

    // ------------------------------------------------------------------
    // Change notifications
    // ------------------------------------------------------------------

    /**
     * Hear when an entity's state or availability changes.
     * @param {string|null} id   a document id, or null for every entity
     * @param {(id: string, now: {state: object, available: boolean|undefined, present: boolean}, before: object|undefined) => void} callback
     *        `present: false` when the entity is no longer known to the layer
     * @returns {() => void} stop hearing
     */
    watch(id, callback) {
        if (id === null || id === undefined) {
            this._watchAll.add(callback);
            return () => this._watchAll.delete(callback);
        }
        if (!this._watchers.has(id)) this._watchers.set(id, new Set());
        this._watchers.get(id).add(callback);
        // the state to compare the next message with
        const record = this._records.get(id);
        if (record && record.last === undefined) record.last = JSON.stringify(this._now(id));
        return () => {
            const set = this._watchers.get(id);
            if (!set) return;
            set.delete(callback);
            if (!set.size) this._watchers.delete(id);
        };
    }

    _now(id) {
        const present = this._records.has(id);
        return { state: this.state(id), available: present ? this.available(id) : false, present };
    }

    _topicChanged(topic) {
        const ids = this._readers.get(topic);
        if (!ids) return;
        for (const id of [...ids]) this._evaluate(id);
    }

    /** Tell the watchers of an entity when what they would read has changed. Nobody watching: nothing is read. */
    _evaluate(id) {
        const own = this._watchers.get(id);
        if (!this._watchAll.size && !own) return;
        const record = this._records.get(id);
        let now;
        try {
            now = this._now(id);
        } catch (err) {
            this.log.warn(`home model: ${id}: ${err.message}`);
            return;
        }
        const text = JSON.stringify(now);
        const before = record ? record.last : undefined;
        if (record) {
            if (before === text) return;
            record.last = text;
        }
        const prev = before === undefined ? undefined : JSON.parse(before);
        for (const cb of [...(own || []), ...this._watchAll]) {
            try {
                cb(id, now, prev);
            } catch (err) {
                this.log.warn(`home model: a watcher of ${id} failed: ${err.message}`);
            }
        }
    }
}

module.exports = { HomeEntities, payloadOf, PREFIX };
