'use strict';

/**
 * The home model: she's own sheDB documents about the house.
 *
 *   she/home             the switch and what was seeded
 *   she/device/<id>      a device announced through Home Assistant MQTT discovery
 *   she/entity/<id>      one entity of it (or one without a device)
 *   she/floor/<id>       a floor
 *   she/room/<id>        a room — created from a device's `suggested_area`, edited and merged by the user
 *   she/function/<id>    a purpose ("lighting", "openings"), with the rules that assign entities to it
 *   she/label/<id>       a free label
 *
 * A device or entity document has three sections:
 *
 *   ha    what the source announced. Written here, replaced when the announcement changes.
 *   user  what a person assigned (name, rooms, functions, labels, hidden, notes). Never written
 *         here, except through the assign/merge/delete calls a person makes.
 *   eff   the effective values, computed from both and from the rooms, floors and functions, so
 *         that a view or a script does not repeat the inheritance rules.
 *
 * Rules the code keeps:
 *
 *   - A document is written only when it differs: adapters announce again at every connect, and
 *     every sheDB view is recomputed on every document change.
 *   - Nothing disappears by itself. A config that is cleared leaves its document, marked
 *     `present: false` with `gone_since`; when it comes back, the assignments are still there.
 *   - Ids are stable: a device is its first discovery identifier, an entity its `unique_id`, with
 *     the characters sheDB ids cannot hold (`/`, `+`, `#`, space, `%`) percent-escaped.
 *   - Every document carries `schema`.
 *
 * Live values are not stored: structure is here, state is on MQTT.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { expandConfig, identifierList } = require('./ha-configs');
const { parseConfigTopic, DEFAULT_PREFIX } = require('./ha-discovery');
const { DEFAULT_FUNCTIONS, normaliseLanguage } = require('./home-defaults');
const { isAggregateEntity } = require('./home-aggregate-rules');

const SCHEMA = 1;

const P = {
    home: 'she/home',
    device: 'she/device/',
    entity: 'she/entity/',
    floor: 'she/floor/',
    room: 'she/room/',
    function: 'she/function/',
    label: 'she/label/',
};

/** documents that are not part of the model but point at rooms (`area`, `room`, `rooms`) */
const ROOM_REFERRERS = ['she/scene/', 'she/scenegroup/'];

/** discovery components that announce no entity: a device's triggers, a tag scanner */
const NO_ENTITY = ['device_automation', 'tag'];

const USER_FIELDS = {
    device: ['name', 'rooms', 'labels', 'hidden', 'notes'],
    entity: ['name', 'rooms', 'functions', 'labels', 'hidden', 'notes'],
};

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const norm = (s) => String(s).trim().toLowerCase();
const scalar = (v) => (typeof v === 'string' || typeof v === 'number' ? v : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
const unique = (list) => [...new Set(list)];

function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => kb[i] === k && deepEqual(a[k], b[k]));
}

/**
 * Escape what a sheDB id cannot hold: `/` separates path segments, `+` and `#` are the wildcards of
 * id filters, a space breaks MQTT topics built from the id; `%` is escaped to keep it reversible.
 * @param {string} raw
 */
function escapeId(raw) {
    return String(raw).replace(/[%/+# ]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** The reverse of {@link escapeId}. */
function unescapeId(id) {
    return String(id).replace(/%(25|2F|2B|23|20)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** A readable id from a name: `Wohnzimmer` → `wohnzimmer`, `Küche (EG)` → `kueche-eg`. */
function slug(name) {
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** a room, a floor or the house as she announces it for its aggregates (lib/home-aggregates.js) */
function isAggregateDevice(doc) {
    const ha = doc.ha || {};
    return ha.manufacturer === 'she' && ['Room', 'Floor', 'Home'].includes(ha.model) && (ha.identifiers || []).some((i) => /^she_.+_(room_.+|floor_.+|home)$/.test(i));
}

const humanise = (s) => {
    const t = String(s).replace(/_/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Does a function rule match an entity?
 * @param {object} rule  `{component?, device_class?, entity_category?, not?}`
 * @param {{component:string, device_class:string|null, entity_category:string|null}} ha
 */
function matchRule(rule, ha) {
    if (!isRecord(rule)) return false;
    let positive = 0;
    for (const field of ['component', 'device_class', 'entity_category']) {
        if (rule[field] === undefined) continue;
        positive++;
        const have = ha[field] ?? null;
        if (!(Array.isArray(rule[field]) ? rule[field] : [rule[field]]).some((want) => (want ?? null) === have)) return false;
    }
    // a rule that names nothing would take every entity
    if (!positive) return false;
    if (rule.not !== undefined && (Array.isArray(rule.not) ? rule.not : [rule.not]).some((r) => matchRule(r, ha))) return false;
    return true;
}

/** A set of pending writes over the document store: read through, change copies, commit at the end. */
class Tx {
    constructor(core) {
        this.core = core;
        this.docs = new Map(); // id → changed copy | null (deleted)
    }

    /** The document as it will be — never change what this returns. */
    get(id) {
        return this.docs.has(id) ? this.docs.get(id) || undefined : this.core.get(id);
    }

    /** A copy of the document that may be changed and is written at commit. */
    edit(id) {
        if (!this.docs.get(id)) {
            const cur = this.core.get(id);
            this.docs.set(id, cur && !this.docs.has(id) ? clone(cur) : {});
        }
        return this.docs.get(id);
    }

    put(id, doc) {
        this.docs.set(id, doc);
    }

    del(id) {
        this.docs.set(id, null);
    }

    /** The ids below a prefix, as they will be. */
    ids(prefix) {
        const out = new Set();
        for (const id of Object.keys(this.core.docs)) if (id.startsWith(prefix) && this.docs.get(id) !== null) out.add(id);
        for (const [id, doc] of this.docs) if (doc && id.startsWith(prefix)) out.add(id);
        return [...out].sort();
    }

    /** @returns {number} how many documents changed */
    commit() {
        let changed = 0;
        for (const [id, doc] of this.docs) {
            if (doc === null) {
                if (this.core.get(id)) {
                    this.core.del(id);
                    changed++;
                }
            } else if (this.core.set(id, doc)) changed++;
        }
        return changed;
    }
}

class HomeModel extends EventEmitter {
    /**
     * @param {object} opts
     * @param {object} opts.core  the sheDB core (`get`, `set`, `del`, `docs`, `on('update')`)
     * @param {() => Iterable<[string, {val:*}]>} [opts.entries]  the retained MQTT state: `[topic, {val}]`
     * @param {object} [opts.log]
     * @param {string} [opts.prefix]  the discovery prefix
     * @param {() => number} [opts.now]
     * @param {number} [opts.debounce]  ms to collect announcements before they are written
     * @param {number} [opts.goneDelay]  ms after the start before what is not announced is marked as gone
     */
    constructor({ core, entries, log, prefix = DEFAULT_PREFIX, now = Date.now, debounce = 500, goneDelay = 30000 }) {
        super();
        this.core = core;
        this.entries = entries || (() => []);
        this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
        this.prefix = prefix.replace(/\/+$/, '');
        this.now = now;
        this.debounce = debounce;
        this.goneDelay = goneDelay;

        /** config topic → payload, as far as this instance knows them */
        this._configs = new Map();
        this._dirty = new Set();
        this._timer = null;
        this._sweepTimer = null;
        this._recomputeQueued = false;
        this._live = false;
        this._authoritative = false;
        this._writing = 0;
        this._warned = new Set();

        this._onUpdate = (id) => {
            // a person (the DB page, a script) changed a document the effective values depend on
            if (this._writing || typeof id !== 'string' || id === P.home) return;
            if (![P.device, P.entity, P.floor, P.room, P.function].some((p) => id.startsWith(p))) return;
            if (this._recomputeQueued) return;
            this._recomputeQueued = true;
            setImmediate(() => {
                this._recomputeQueued = false;
                if (this._stopped) return;
                try {
                    this.recompute();
                } catch (err) {
                    this.log.warn('home model: recompute failed: ' + err.message);
                }
            });
        };
        this.core.on('update', this._onUpdate);
    }

    // ------------------------------------------------------------------
    // The switch
    // ------------------------------------------------------------------

    /** Is the model switched on? */
    get enabled() {
        const doc = this.core.get(P.home);
        return !!doc && doc.enabled === true;
    }

    /**
     * Decide the switch for an installation that has none yet: on for a new installation, left
     * undecided for an existing one — the UI then shows a hint and the user switches it on.
     * @param {{fresh?: boolean}} [opts]
     */
    init({ fresh = false } = {}) {
        if (!this.core.get(P.home) && fresh) this.enable();
        return this.status();
    }

    /**
     * Switch the model on and, when the retained state is known, mirror it. The default functions
     * are seeded once a language for their names is known: given here, or with a later call — a new
     * installation is switched on before anybody could be asked.
     * @param {{language?: string}} [opts]  `en` or `de`
     */
    enable({ language } = {}) {
        this._run((tx) => {
            const cur = tx.get(P.home) || {};
            const doc = tx.edit(P.home);
            const lang = language || cur.language ? normaliseLanguage(language || cur.language) : null;
            doc.schema = SCHEMA;
            doc.kind = 'home';
            doc.enabled = true;
            doc.language = lang;
            doc.enabled_at = cur.enabled_at ?? this.now();
            // what was seeded is remembered: a function the user deleted stays deleted
            const seeded = Array.isArray(cur.seeded_functions) ? [...cur.seeded_functions] : [];
            DEFAULT_FUNCTIONS.forEach((f, i) => {
                if (!lang || seeded.includes(f.id)) return;
                seeded.push(f.id);
                if (tx.get(P.function + f.id)) return;
                tx.put(P.function + f.id, { schema: SCHEMA, kind: 'function', name: f.name[lang], icon: f.icon, order: i + 1, rules: clone(f.rules), seeded: true });
            });
            doc.seeded_functions = seeded;
            if (this._live) {
                this._loadConfigs();
                this._sync(tx, { authoritative: this._authoritative });
            }
        });
        this.log.info('home model: on');
        return this.status();
    }

    /** Switch the model off. Every document stays; nothing is mirrored or computed until it is on again. */
    disable() {
        clearTimeout(this._timer);
        this._timer = null;
        this._dirty.clear();
        this._configs.clear();
        const tx = new Tx(this.core);
        const doc = tx.edit(P.home);
        doc.schema = SCHEMA;
        doc.kind = 'home';
        doc.enabled = false;
        this._commit(tx);
        this.log.info('home model: off');
        return this.status();
    }

    /**
     * What a settings page needs. `decided: false` is the hint for an existing installation;
     * `language: null` while it is on means that the functions wait for a language to be seeded in.
     */
    status() {
        const doc = this.core.get(P.home);
        const count = (prefix) => Object.keys(this.core.docs).filter((id) => id.startsWith(prefix)).length;
        return {
            enabled: this.enabled,
            decided: !!doc,
            language: doc?.language ?? null,
            enabled_at: doc?.enabled_at ?? null,
            live: this._live,
            counts: {
                devices: count(P.device),
                entities: count(P.entity),
                floors: count(P.floor),
                rooms: this.rooms().length,
                functions: count(P.function),
                labels: count(P.label),
                gone: this.devices({ present: false }).length,
            },
        };
    }

    // ------------------------------------------------------------------
    // The mirror
    // ------------------------------------------------------------------

    /**
     * The retained state is in: mirror it.
     *
     * What the retained state does not announce any more is marked as gone — but not at once. A
     * broker may deliver the last retained messages after the daemon considers them complete, and
     * marking a house as gone to take it back a moment later would be two writes per document and a
     * false alarm for everything that watches. So the mirror only adds at first, and the sweep
     * follows after `goneDelay`.
     * @param {{authoritative?: boolean}} [opts]  false when the broker's retained state could not be
     *   read completely (no broker, a timeout): then nothing is marked as gone for being absent.
     * @returns {number} the number of entities announced
     */
    start({ authoritative = true } = {}) {
        this._live = true;
        this._authoritative = false;
        clearTimeout(this._sweepTimer);
        this._sweepTimer = null;
        if (authoritative && this.goneDelay > 0) {
            this._sweepTimer = setTimeout(() => {
                this._sweepTimer = null;
                this._authoritative = true;
                try {
                    this.reconcile();
                } catch (err) {
                    this.log.warn('home model: sync failed: ' + err.message);
                }
            }, this.goneDelay);
            this._sweepTimer.unref?.();
        } else this._authoritative = authoritative;
        return this.reconcile();
    }

    /** Read every discovery config again and bring the documents in line. */
    reconcile() {
        if (!this._live || !this.enabled) return 0;
        this._loadConfigs();
        return this._run((tx) => this._sync(tx, { authoritative: this._authoritative }));
    }

    /**
     * A discovery config arrived, changed or was cleared. Announcements come in bursts, so they are
     * collected and written together ({@link flush}).
     * @param {string} topic
     * @param {*} payload  the parsed config, or anything that is not an object for a cleared one
     */
    noteConfig(topic, payload) {
        if (!this._live || !this.enabled || !parseConfigTopic(topic, this.prefix)) return;
        const prev = this._configs.get(topic);
        if (isRecord(payload)) {
            if (prev !== undefined && deepEqual(prev, payload)) return;
            // a copy: the documents must not share objects with the state store
            this._configs.set(topic, clone(payload));
        } else {
            if (prev === undefined) return;
            this._configs.delete(topic);
        }
        this._dirty.add(topic);
        if (!this._timer) {
            this._timer = setTimeout(() => {
                try {
                    this.flush();
                } catch (err) {
                    this.log.warn('home model: sync failed: ' + err.message);
                }
            }, this.debounce);
            this._timer.unref?.();
        }
    }

    /** Write what {@link noteConfig} collected. */
    flush() {
        clearTimeout(this._timer);
        this._timer = null;
        if (!this._dirty.size || !this.enabled) return 0;
        const dirty = this._dirty;
        this._dirty = new Set();
        return this._run((tx) => this._sync(tx, { authoritative: false, dirty }));
    }

    /** Stop listening and drop pending work (shutdown, tests). */
    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        clearTimeout(this._sweepTimer);
        this._timer = null;
        this._sweepTimer = null;
        this.core.off('update', this._onUpdate);
    }

    _loadConfigs() {
        this._configs.clear();
        this._dirty.clear();
        for (const [topic, obj] of this.entries()) {
            if (!topic.startsWith(this.prefix + '/') || !parseConfigTopic(topic, this.prefix)) continue;
            if (obj && isRecord(obj.val)) this._configs.set(topic, clone(obj.val));
        }
    }

    _warnOnce(key, message) {
        if (this._warned.has(key)) return;
        this._warned.add(key);
        this.log.warn('home model: ' + message);
    }

    /**
     * Bring the device and entity documents in line with the known configs.
     * @param {Tx} tx
     * @param {{authoritative: boolean, dirty?: Set<string>}} opts  what may be marked as gone when
     *   nothing announces it: everything, or only what the config topics in `dirty` announced before
     */
    _sync(tx, { authoritative, dirty = new Set() }) {
        const now = this.now();
        const records = [];
        const triggers = []; // device triggers are no entities: they are kept on their device
        for (const topic of [...this._configs.keys()].sort()) {
            for (const r of expandConfig(topic, this._configs.get(topic), this.prefix)) {
                if (NO_ENTITY.includes(r.component)) triggers.push(r);
                else records.push(r);
            }
        }

        // which document is which entity: the unique_id, or the place in the discovery tree without one
        const byBase = new Map();
        for (const r of records) {
            const base = r.uniqueId ?? r.key;
            if (!byBase.has(base)) byBase.set(base, []);
            byBase.get(base).push(r);
        }
        const claimed = new Map(); // entity document id → record
        for (const [base, list] of byBase) {
            // A unique_id is unique per component only, and some firmware repeats one on every device.
            // The first of a component gets the document, a second component one of its own
            // (`<id>@<component>`) — and a document stays with what it held, whatever arrives first.
            const plain = P.entity + escapeId(base);
            const alt = (r) => P.entity + escapeId(base + '@' + r.component);
            const components = new Set();
            const placed = new Set();
            const place = (r, id) => {
                claimed.set(id, r);
                placed.add(r);
                components.add(r.component);
            };
            const held = (id, r, exact) => {
                const ha = tx.get(id)?.ha;
                return !claimed.has(id) && isRecord(ha) && ha.component === r.component && (!exact || ha.config_topic === r.configTopic);
            };
            for (const exact of [true, false]) {
                for (const r of list) {
                    if (components.has(r.component)) continue;
                    const id = [plain, alt(r)].find((x) => held(x, r, exact));
                    if (id) place(r, id);
                }
            }
            for (const r of list) {
                if (placed.has(r)) continue;
                const id = components.has(r.component) ? null : [plain, alt(r)].find((x) => !claimed.has(x));
                if (id) place(r, id);
                else this._warnOnce('dup:' + r.configTopic, `${r.configTopic} announces ${r.component} "${base}" a second time, ignored`);
            }
        }

        // the device blocks of all of a device's configs, merged: an adapter may send the full block once
        const announced = new Map(); // device document id → {device, origin, topics, triggers}
        const deviceOf = (r) => (r.deviceKey ? P.device + escapeId(r.deviceKey) : null);
        for (const r of [...claimed.values(), ...triggers]) {
            const id = deviceOf(r);
            if (!id) continue;
            if (!announced.has(id)) announced.set(id, { device: {}, origin: {}, topics: new Set(), triggers: [] });
            const info = announced.get(id);
            info.topics.add(r.configTopic);
            if (r.component === 'device_automation' && r.config.automation_type === 'trigger') {
                info.triggers.push({
                    type: scalar(r.config.type),
                    subtype: scalar(r.config.subtype),
                    topic: text(r.config.topic),
                    payload: r.config.payload ?? null,
                    config_topic: r.configTopic,
                });
            }
            for (const [k, v] of Object.entries(r.device)) if (!(k in info.device) && v !== undefined && v !== null && v !== '') info.device[k] = v;
            for (const [k, v] of Object.entries(r.origin || {})) if (!(k in info.origin) && v !== undefined && v !== null && v !== '') info.origin[k] = v;
        }

        for (const [id, r] of claimed) {
            const prev = tx.get(id);
            const doc = prev ? clone({ ...prev, ha: undefined }) : {};
            const cfg = r.config;
            doc.schema = SCHEMA;
            doc.kind = 'entity';
            doc.source = 'ha';
            doc.ha = {
                unique_id: r.uniqueId,
                device: deviceOf(r),
                component: r.component,
                object_id: r.objectId,
                device_class: text(cfg.device_class),
                entity_category: text(cfg.entity_category),
                name: text(cfg.name),
                icon: text(cfg.icon),
                unit: text(cfg.unit_of_measurement),
                config: cfg,
                config_topic: r.configTopic,
                topics: r.topics,
                present: true,
                first_seen: (isRecord(prev?.ha) && prev.ha.first_seen) || now,
                gone_since: null,
            };
            if (!isRecord(doc.user)) doc.user = {};
            if (!isRecord(doc.eff)) doc.eff = {};
            tx.put(id, doc);
        }

        for (const id of tx.ids(P.entity)) {
            if (claimed.has(id)) continue;
            const doc = tx.get(id);
            if (!doc || doc.source !== 'ha' || !isRecord(doc.ha) || doc.ha.present === false) continue;
            if (!authoritative && !dirty.has(doc.ha.config_topic)) continue;
            const gone = tx.edit(id);
            gone.ha.present = false;
            gone.ha.gone_since = now;
        }

        // a device is present as long as something announces it: an entity, or a trigger
        const members = new Map(); // device document id → {entities, topics}
        for (const id of tx.ids(P.entity)) {
            const doc = tx.get(id);
            if (doc.source !== 'ha' || !isRecord(doc.ha) || !doc.ha.device || !doc.ha.present) continue;
            if (!members.has(doc.ha.device)) members.set(doc.ha.device, { entities: [], topics: new Set() });
            members.get(doc.ha.device).entities.push(id);
            members.get(doc.ha.device).topics.add(doc.ha.config_topic);
        }
        for (const id of unique([...announced.keys(), ...tx.ids(P.device)]).sort()) {
            const prev = tx.get(id);
            const info = announced.get(id);
            const m = members.get(id);
            if (!info) {
                if (!prev || prev.source !== 'ha' || !isRecord(prev.ha)) continue;
                const mayGo = authoritative || (Array.isArray(prev.ha.config_topics) && prev.ha.config_topics.some((t) => dirty.has(t)));
                if (!m && mayGo && prev.ha.present !== false) {
                    const gone = tx.edit(id);
                    gone.ha.present = false;
                    gone.ha.gone_since = now;
                }
                continue;
            }
            // What no config says now stays as it was last said: an adapter may send the full device
            // block with one entity only, and that one may be the one that has just gone.
            const before = isRecord(prev?.ha) ? prev.ha : {};
            const d = { ...before, ...info.device };
            if (!Object.keys(info.origin).length && isRecord(before.origin)) info.origin = before.origin;
            const doc = prev ? clone({ ...prev, ha: undefined }) : {};
            doc.schema = SCHEMA;
            doc.kind = 'device';
            doc.source = 'ha';
            doc.ha = {
                identifiers: identifierList(d.identifiers),
                connections: Array.isArray(d.connections) ? d.connections : [],
                name: text(d.name),
                manufacturer: text(d.manufacturer),
                model: text(d.model),
                model_id: scalar(d.model_id),
                hw_version: scalar(d.hw_version),
                sw_version: scalar(d.sw_version),
                serial_number: scalar(d.serial_number),
                suggested_area: text(d.suggested_area),
                via_device: scalar(d.via_device),
                configuration_url: text(d.configuration_url),
                origin: Object.keys(info.origin).length
                    ? { name: text(info.origin.name), sw_version: scalar(info.origin.sw_version), support_url: text(info.origin.support_url) }
                    : null,
                config_topics: unique([...info.topics, ...(m ? m.topics : [])]).sort(),
                entities: m ? [...m.entities].sort() : [],
                triggers: info.triggers,
                present: true,
                first_seen: (isRecord(prev?.ha) && prev.ha.first_seen) || now,
                gone_since: null,
            };
            if (!isRecord(doc.user)) doc.user = {};
            if (!isRecord(doc.eff)) doc.eff = {};
            tx.put(id, doc);
        }

        // a suggested area nobody knows becomes a room; its spellings are merged by the user later
        const ctx = this._context(tx);
        const newRooms = new Map(); // room id → number of devices
        for (const id of announced.keys()) {
            const area = tx.get(id).ha.suggested_area;
            if (!area) continue;
            let roomId = ctx.lookup.get(norm(area));
            if (!roomId) {
                roomId = this._freeId(tx, P.room, slug(area) || 'room-' + crypto.createHash('sha1').update(area).digest('hex').slice(0, 8));
                tx.put(P.room + roomId, { schema: SCHEMA, kind: 'room', name: area.trim(), aliases: [area.trim()], floor: null, icon: null, order: null, auto: true });
                ctx.lookup.set(norm(area), roomId);
                ctx.lookup.set(norm(roomId), roomId);
                newRooms.set(roomId, 0);
            }
            if (newRooms.has(roomId)) newRooms.set(roomId, newRooms.get(roomId) + 1);
        }
        for (const [roomId, n] of newRooms) this.log.info(`home model: new room "${tx.get(P.room + roomId).name}" (${roomId}) from discovery, ${n} device${n === 1 ? '' : 's'}`);

        return claimed.size;
    }

    // ------------------------------------------------------------------
    // Effective values
    // ------------------------------------------------------------------

    /** Compute every `eff` again. Runs by itself after a change; a no-op when nothing differs. */
    recompute() {
        if (!this.enabled) return 0;
        return this._commit(this._eff(new Tx(this.core)));
    }

    /** What the effective values depend on besides the document itself. */
    _context(tx) {
        const rooms = new Map();
        for (const id of tx.ids(P.room)) {
            const doc = tx.get(id);
            if (isRecord(doc) && !id.slice(P.room.length).includes('/')) rooms.set(id.slice(P.room.length), doc);
        }
        // a room answers to its id, its name and its aliases; live rooms before rejected ones
        const lookup = new Map();
        const ordered = [...rooms].sort((a, b) => Number(!!a[1].rejected) - Number(!!b[1].rejected));
        for (const [id, doc] of ordered) {
            for (const key of [id, doc.name, ...(Array.isArray(doc.aliases) ? doc.aliases : [])]) {
                if (typeof key === 'string' && key.trim() && !lookup.has(norm(key))) lookup.set(norm(key), id);
            }
        }
        const floors = new Set(tx.ids(P.floor).map((id) => id.slice(P.floor.length)));
        const functions = tx
            .ids(P.function)
            .map((id) => ({ id: id.slice(P.function.length), doc: tx.get(id) }))
            .filter((f) => isRecord(f.doc))
            .sort((a, b) => (a.doc.order ?? Infinity) - (b.doc.order ?? Infinity) || a.id.localeCompare(b.id));
        return { rooms, lookup, floors, functions };
    }

    /** A room reference (id, old id, name, alias) → the id of a live room, or null. */
    _resolveRoom(ref, ctx) {
        if (typeof ref !== 'string' || !ref.trim()) return null;
        const exact = ctx.rooms.get(ref);
        if (exact && !exact.rejected) return ref;
        const id = ctx.lookup.get(norm(ref));
        return id && !ctx.rooms.get(id).rejected ? id : null;
    }

    _floorsOf(rooms, ctx) {
        return unique(rooms.map((r) => ctx.rooms.get(r).floor).filter((f) => typeof f === 'string' && ctx.floors.has(f)));
    }

    _deviceEff(doc, ctx) {
        const user = isRecord(doc.user) ? doc.user : {};
        let rooms;
        if (Array.isArray(user.rooms)) rooms = unique(user.rooms.map((r) => this._resolveRoom(r, ctx)).filter(Boolean));
        else rooms = [this._resolveRoom(doc.ha.suggested_area, ctx)].filter(Boolean);
        return {
            name: text(user.name) || doc.ha.name || (doc.ha.identifiers || [])[0] || null,
            rooms,
            floors: this._floorsOf(rooms, ctx),
            labels: unique((Array.isArray(user.labels) ? user.labels : []).filter((l) => typeof l === 'string')),
            // she's own room, floor and house devices (the aggregates) are not devices of the house
            hidden: typeof user.hidden === 'boolean' ? user.hidden : isAggregateDevice(doc),
            adapter: doc.ha.origin?.name ?? null,
        };
    }

    _entityEff(doc, device, deviceEff, ctx) {
        const user = isRecord(doc.user) ? doc.user : {};
        const deviceUser = isRecord(device?.user) ? device.user : {};
        const ha = doc.ha;

        let name = text(user.name);
        if (!name) {
            const own = isRecord(ha.config) ? ha.config.name : ha.name;
            const base = deviceEff?.name || null;
            if (typeof own === 'string' && own.trim()) name = !base || norm(own).startsWith(norm(base)) ? own : base + ' ' + own;
            // an entity without a name is the device's main entity; left out altogether, the device class names it
            else if (base) name = own === undefined && ha.device_class ? base + ' ' + humanise(ha.device_class) : base;
            else name = ha.device_class ? humanise(ha.device_class) : ha.object_id || ha.unique_id || null;
        }

        const rooms = Array.isArray(user.rooms) ? unique(user.rooms.map((r) => this._resolveRoom(r, ctx)).filter(Boolean)) : deviceEff ? [...deviceEff.rooms] : [];

        let functions;
        if (Array.isArray(user.functions)) functions = unique(user.functions.filter((f) => ctx.functions.some((x) => x.id === f)));
        else functions = ctx.functions.filter((f) => Array.isArray(f.doc.rules) && f.doc.rules.some((rule) => matchRule(rule, ha))).map((f) => f.id);

        let hidden;
        if (typeof user.hidden === 'boolean') hidden = user.hidden;
        else if (typeof deviceUser.hidden === 'boolean') hidden = deviceUser.hidden;
        else {
            hidden =
                ha.entity_category === 'diagnostic' || ha.entity_category === 'config' || (isRecord(ha.config) && ha.config.enabled_by_default === false) || isAggregateEntity(doc);
        }

        return {
            name,
            rooms,
            floors: this._floorsOf(rooms, ctx),
            functions,
            labels: unique([...(deviceEff?.labels || []), ...(Array.isArray(user.labels) ? user.labels : []).filter((l) => typeof l === 'string')]),
            hidden,
        };
    }

    /** Compute every `eff` into the transaction; only documents whose `eff` differs are touched. */
    _eff(tx) {
        const ctx = this._context(tx);
        const deviceEffs = new Map();
        for (const id of tx.ids(P.device)) {
            const doc = tx.get(id);
            if (!isRecord(doc) || !isRecord(doc.ha)) continue;
            const eff = this._deviceEff(doc, ctx);
            deviceEffs.set(id, eff);
            if (!deepEqual(doc.eff, eff)) tx.edit(id).eff = eff;
        }
        for (const id of tx.ids(P.entity)) {
            const doc = tx.get(id);
            if (!isRecord(doc) || !isRecord(doc.ha)) continue;
            const eff = this._entityEff(doc, doc.ha.device ? tx.get(doc.ha.device) : null, deviceEffs.get(doc.ha.device), ctx);
            if (!deepEqual(doc.eff, eff)) tx.edit(id).eff = eff;
        }
        return tx;
    }

    // ------------------------------------------------------------------
    // Plumbing
    // ------------------------------------------------------------------

    _commit(tx) {
        this._writing++;
        try {
            return tx.commit();
        } finally {
            this._writing--;
        }
    }

    /** Run a change, compute the effective values it touches and write everything at once. */
    _run(fn) {
        const tx = new Tx(this.core);
        const result = fn(tx);
        if (tx.get(P.home)?.enabled === true) this._eff(tx);
        const changed = this._commit(tx);
        if (changed) this.emit('change', changed);
        return result;
    }

    _mutate(fn) {
        if (!this.enabled) throw new Error('the home model is switched off');
        return this._run(fn);
    }

    _freeId(tx, prefix, base) {
        let id = base;
        for (let n = 2; tx.get(prefix + id); n++) id = base + '-' + n;
        return id;
    }

    _checkId(id) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid id "${id}": letters, digits, ".", "_" and "-" only`);
        return id;
    }

    /** `she/entity/…` stays; a raw unique_id or device identifier is escaped. */
    static entityId(raw) {
        return String(raw).startsWith(P.entity) ? String(raw) : P.entity + escapeId(raw);
    }

    static deviceId(raw) {
        return String(raw).startsWith(P.device) ? String(raw) : P.device + escapeId(raw);
    }

    // ------------------------------------------------------------------
    // Read
    // ------------------------------------------------------------------

    /** A device document (copy) by document id or discovery identifier. */
    device(id) {
        const doc = this.core.get(HomeModel.deviceId(id));
        return doc ? clone(doc) : null;
    }

    /** An entity document (copy) by document id or unique_id. */
    entity(id) {
        const doc = this.core.get(HomeModel.entityId(id));
        return doc ? clone(doc) : null;
    }

    _list(prefix, filter, match) {
        const out = [];
        for (const id of Object.keys(this.core.docs).sort()) {
            if (!id.startsWith(prefix)) continue;
            const doc = this.core.docs[id];
            if (!isRecord(doc.ha) || !isRecord(doc.eff)) continue;
            if (match(doc, filter)) out.push(clone(doc));
        }
        return out;
    }

    /**
     * Device documents (copies).
     * @param {{room?: string, floor?: string, label?: string, adapter?: string, present?: boolean, hidden?: boolean}} [filter]
     *   `room: ''` selects the unassigned ones
     */
    devices(filter = {}) {
        return this._list(P.device, filter, (doc, f) => HomeModel._matches(doc, f) && (f.adapter === undefined || doc.eff.adapter === f.adapter));
    }

    /**
     * Entity documents (copies).
     * @param {{room?: string, floor?: string, function?: string, label?: string, component?: string, device?: string, present?: boolean, hidden?: boolean}} [filter]
     *   `room: ''` selects the unassigned ones
     */
    entities(filter = {}) {
        const device = filter.device === undefined ? undefined : HomeModel.deviceId(filter.device);
        return this._list(
            P.entity,
            filter,
            (doc, f) =>
                HomeModel._matches(doc, f) &&
                (f.function === undefined || (doc.eff.functions || []).includes(f.function)) &&
                (f.component === undefined || doc.ha.component === f.component) &&
                (device === undefined || doc.ha.device === device),
        );
    }

    static _matches(doc, f) {
        const rooms = doc.eff.rooms || [];
        if (f.room !== undefined && (f.room === '' || f.room === null ? rooms.length > 0 : !rooms.includes(f.room))) return false;
        if (f.floor !== undefined && !(doc.eff.floors || []).includes(f.floor)) return false;
        if (f.label !== undefined && !(doc.eff.labels || []).includes(f.label)) return false;
        if (f.present !== undefined && (doc.ha.present !== false) !== f.present) return false;
        if (f.hidden !== undefined && !!doc.eff.hidden !== f.hidden) return false;
        return true;
    }

    _plain(prefix, keep = () => true) {
        const out = [];
        for (const id of Object.keys(this.core.docs)) {
            if (!id.startsWith(prefix) || id.slice(prefix.length).includes('/')) continue;
            const doc = this.core.docs[id];
            if (isRecord(doc) && keep(doc)) out.push({ ...clone(doc), id: id.slice(prefix.length) });
        }
        const order = (d) => (typeof d.order === 'number' ? d.order : Infinity);
        return out.sort((a, b) => order(a) - order(b) || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
    }

    /** Floors, each with its short `id`, by `order`, then `level`, then name. */
    floors() {
        return this._plain(P.floor).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.level ?? 0) - (b.level ?? 0));
    }

    /**
     * Rooms, each with its short `id`, by `order`, then name.
     * @param {{rejected?: boolean}} [opts]  true lists the rejected areas instead
     */
    rooms({ rejected = false } = {}) {
        return this._plain(P.room, (doc) => !!doc.rejected === rejected);
    }

    functions() {
        return this._plain(P.function);
    }

    labels() {
        return this._plain(P.label);
    }

    /** A room reference — id, an id merged away, a name, an alias — → the id of the room, or null. */
    resolveRoom(ref) {
        return this._resolveRoom(ref, this._context(new Tx(this.core)));
    }

    // ------------------------------------------------------------------
    // Assign
    // ------------------------------------------------------------------

    /**
     * Change what a person assigned to a device or an entity.
     * @param {string} id  the document id (`she/device/…`, `she/entity/…`)
     * @param {object} patch  `name`, `rooms`, `functions` (entities), `labels`, `hidden`, `notes`;
     *   `null` removes the assignment, so the value is inherited again; `[]` means "none, on purpose"
     * @returns {object} the document afterwards
     */
    assign(id, patch) {
        const kind = String(id).startsWith(P.device) ? 'device' : String(id).startsWith(P.entity) ? 'entity' : null;
        if (!kind) throw new Error(`not a device or entity document: ${id}`);
        if (!isRecord(patch)) throw new Error('a patch object is required');
        this._mutate((tx) => {
            if (!isRecord(tx.get(id)?.ha)) throw new Error(`unknown ${kind}: ${id}`);
            const ctx = this._context(tx);
            const doc = tx.edit(id);
            if (!isRecord(doc.user)) doc.user = {};
            for (const [key, value] of Object.entries(patch)) {
                if (!USER_FIELDS[kind].includes(key)) throw new Error(`a ${kind} has no "${key}" to assign`);
                if (value === null || value === undefined) {
                    delete doc.user[key];
                    continue;
                }
                if (key === 'name' || key === 'notes') {
                    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
                    doc.user[key] = value;
                } else if (key === 'hidden') {
                    if (typeof value !== 'boolean') throw new Error('hidden must be true, false or null');
                    doc.user.hidden = value;
                } else {
                    if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && x.trim())) throw new Error(`${key} must be a list of ids`);
                    if (key === 'rooms') {
                        doc.user.rooms = unique(
                            value.map((ref) => {
                                const room = this._resolveRoom(ref, ctx);
                                if (!room) throw new Error(`unknown room: ${ref}`);
                                return room;
                            }),
                        );
                    } else if (key === 'functions') {
                        for (const f of value) if (!ctx.functions.some((x) => x.id === f)) throw new Error(`unknown function: ${f}`);
                        doc.user.functions = unique(value);
                    } else doc.user.labels = unique(value.map((ref) => this._ensureLabel(tx, ref)));
                }
            }
        });
        return clone(this.core.get(id));
    }

    /** A label by id or name; one that does not exist yet is created. */
    _ensureLabel(tx, ref) {
        if (tx.get(P.label + ref)) return ref;
        for (const id of tx.ids(P.label)) if (norm(tx.get(id).name ?? '') === norm(ref)) return id.slice(P.label.length);
        const id = this._freeId(tx, P.label, slug(ref) || 'label');
        tx.put(P.label + id, { schema: SCHEMA, kind: 'label', name: ref.trim(), icon: null, order: null });
        return id;
    }

    /**
     * Delete a device (with its entities) or an entity that has gone. What is still announced
     * would come back at once, so that needs `force`.
     */
    remove(id, { force = false } = {}) {
        return this._mutate((tx) => {
            const doc = tx.get(id);
            if (!isRecord(doc?.ha)) throw new Error(`unknown device or entity: ${id}`);
            if (doc.ha.present !== false && !force) throw new Error(`${id} is still announced`);
            const removed = [id];
            if (id.startsWith(P.device)) for (const e of tx.ids(P.entity)) if (tx.get(e).ha?.device === id) removed.push(e);
            for (const r of removed) tx.del(r);
            return removed;
        });
    }

    // ------------------------------------------------------------------
    // Floors, rooms, functions, labels
    // ------------------------------------------------------------------

    _create(kind, prefix, input, defaults) {
        if (!isRecord(input) || !text(input.name)) throw new Error(`a ${kind} needs a name`);
        return this._mutate((tx) => {
            const id = input.id === undefined ? this._freeId(tx, prefix, slug(input.name) || kind) : this._checkId(input.id);
            if (tx.get(prefix + id)) throw new Error(`${kind} "${id}" exists`);
            const doc = { schema: SCHEMA, kind, ...defaults };
            for (const [k, v] of Object.entries(input)) if (k !== 'id' && !k.startsWith('_') && k !== 'schema' && k !== 'kind' && v !== undefined) doc[k] = v;
            this._validate(tx, kind, doc);
            tx.put(prefix + id, doc);
            return id;
        });
    }

    _update(kind, prefix, id, patch) {
        if (!isRecord(patch)) throw new Error('a patch object is required');
        this._mutate((tx) => {
            const cur = tx.get(prefix + id);
            if (!isRecord(cur) || cur.rejected) throw new Error(`unknown ${kind}: ${id}`);
            const doc = tx.edit(prefix + id);
            for (const [k, v] of Object.entries(patch)) {
                if (k === 'id' || k.startsWith('_') || k === 'schema' || k === 'kind' || k === 'rejected') throw new Error(`"${k}" cannot be changed`);
                if (v === undefined) delete doc[k];
                else doc[k] = v;
            }
            this._validate(tx, kind, doc);
        });
        return clone(this.core.get(prefix + id));
    }

    _validate(tx, kind, doc) {
        if (!text(doc.name)) throw new Error(`a ${kind} needs a name`);
        if (kind === 'room') {
            if (doc.floor !== null && doc.floor !== undefined && !tx.get(P.floor + doc.floor)) throw new Error(`unknown floor: ${doc.floor}`);
            if (!Array.isArray(doc.aliases) || !doc.aliases.every((a) => typeof a === 'string')) throw new Error('aliases must be a list of strings');
        }
        if (kind === 'function' && (!Array.isArray(doc.rules) || !doc.rules.every(isRecord))) throw new Error('rules must be a list of rule objects');
    }

    /** Remove an id from a list field in `user` of every device and entity. */
    _dropReference(tx, field, id) {
        for (const docId of [...tx.ids(P.device), ...tx.ids(P.entity)]) {
            const list = tx.get(docId)?.user?.[field];
            if (Array.isArray(list) && list.includes(id)) tx.edit(docId).user[field] = list.filter((x) => x !== id);
        }
    }

    /** @param {{id?: string, name: string, level?: number, order?: number, icon?: string}} input @returns {string} the id */
    createFloor(input) {
        return this._create('floor', P.floor, input, { level: null, order: null, icon: null });
    }

    updateFloor(id, patch) {
        return this._update('floor', P.floor, id, patch);
    }

    /** Delete a floor; its rooms are left without one. */
    deleteFloor(id) {
        this._mutate((tx) => {
            if (!tx.get(P.floor + id)) throw new Error(`unknown floor: ${id}`);
            tx.del(P.floor + id);
            for (const r of tx.ids(P.room)) if (tx.get(r).floor === id) tx.edit(r).floor = null;
        });
    }

    /**
     * Create a room. A rejected area of the same id, name or alias is taken back into use.
     * @param {{id?: string, name: string, floor?: string, order?: number, icon?: string, aliases?: string[]}} input
     *   further fields are kept as the user's own (a facade, a flag for a script)
     * @returns {string} the id
     */
    createRoom(input) {
        if (!isRecord(input) || !text(input.name)) throw new Error('a room needs a name');
        const revive = this._run((tx) => {
            if (!this.enabled) throw new Error('the home model is switched off');
            const ctx = this._context(tx);
            const known = input.id !== undefined ? (ctx.rooms.has(input.id) ? input.id : null) : ctx.lookup.get(norm(input.name));
            if (!known) return null;
            if (!ctx.rooms.get(known).rejected) throw new Error(`room "${known}" exists`);
            tx.del(P.room + known);
            return known;
        });
        const aliases = unique([input.name.trim(), ...(Array.isArray(input.aliases) ? input.aliases : [])]);
        return this._create('room', P.room, { ...input, id: input.id ?? revive ?? undefined, aliases }, { floor: null, icon: null, order: null });
    }

    updateRoom(id, patch) {
        return this._update('room', P.room, id, patch);
    }

    /**
     * Delete a room. Its names are remembered as a rejected area, so that the next announcement
     * of the same `suggested_area` does not create it again; `purge` forgets it altogether.
     */
    deleteRoom(id, { purge = false } = {}) {
        this._mutate((tx) => {
            const doc = tx.get(P.room + id);
            if (!isRecord(doc)) throw new Error(`unknown room: ${id}`);
            if (purge) tx.del(P.room + id);
            else tx.put(P.room + id, { schema: SCHEMA, kind: 'room', name: doc.name, aliases: Array.isArray(doc.aliases) ? [...doc.aliases] : [], rejected: true });
            this._dropReference(tx, 'rooms', id);
        });
    }

    /**
     * Merge rooms into one: `keep` stays, takes the names, aliases and ids of the others as aliases,
     * and every device, entity and scene that pointed at one of the others points at it. A later
     * announcement with one of the old areas lands in the kept room, and an old id still resolves.
     * @param {string} keep
     * @param {string[]} others
     * @returns {object} the kept room
     */
    mergeRooms(keep, others) {
        const merged = unique((Array.isArray(others) ? others : [others]).filter((o) => o !== keep));
        this._mutate((tx) => {
            const target = tx.get(P.room + keep);
            if (!isRecord(target) || target.rejected) throw new Error(`unknown room: ${keep}`);
            for (const o of merged) if (!isRecord(tx.get(P.room + o))) throw new Error(`unknown room: ${o}`);
            const room = tx.edit(P.room + keep);
            const aliases = Array.isArray(room.aliases) ? [...room.aliases] : [];
            const add = (a) => {
                if (typeof a === 'string' && a.trim() && !aliases.some((x) => norm(x) === norm(a))) aliases.push(a.trim());
            };
            for (const o of merged) {
                const doc = tx.get(P.room + o);
                add(doc.name);
                (Array.isArray(doc.aliases) ? doc.aliases : []).forEach(add);
                add(o);
                if (!room.floor && doc.floor && !doc.rejected) room.floor = doc.floor;
                tx.del(P.room + o);
            }
            room.aliases = aliases;

            const gone = new Set(merged);
            const move = (list) => unique(list.map((r) => (gone.has(r) ? keep : r)));
            for (const id of [...tx.ids(P.device), ...tx.ids(P.entity)]) {
                const list = tx.get(id)?.user?.rooms;
                if (Array.isArray(list) && list.some((r) => gone.has(r))) tx.edit(id).user.rooms = move(list);
            }
            for (const prefix of ROOM_REFERRERS) {
                for (const id of tx.ids(prefix)) {
                    const doc = tx.get(id);
                    if (!isRecord(doc)) continue;
                    for (const field of ['area', 'room']) if (gone.has(doc[field])) tx.edit(id)[field] = keep;
                    if (Array.isArray(doc.rooms) && doc.rooms.some((r) => gone.has(r))) tx.edit(id).rooms = move(doc.rooms);
                }
            }
        });
        return clone(this.core.get(P.room + keep));
    }

    /** @param {{id?: string, name: string, icon?: string, order?: number, rules?: object[]}} input @returns {string} the id */
    createFunction(input) {
        return this._create('function', P.function, input, { icon: null, order: null, rules: [] });
    }

    updateFunction(id, patch) {
        return this._update('function', P.function, id, patch);
    }

    /** Delete a function, and the assignments to it. A seeded one is not seeded again. */
    deleteFunction(id) {
        this._mutate((tx) => {
            if (!tx.get(P.function + id)) throw new Error(`unknown function: ${id}`);
            tx.del(P.function + id);
            this._dropReference(tx, 'functions', id);
        });
    }

    /** @param {{id?: string, name: string, icon?: string, order?: number}} input @returns {string} the id */
    createLabel(input) {
        return this._create('label', P.label, input, { icon: null, order: null });
    }

    updateLabel(id, patch) {
        return this._update('label', P.label, id, patch);
    }

    /** Delete a label, and the assignments of it. */
    deleteLabel(id) {
        this._mutate((tx) => {
            if (!tx.get(P.label + id)) throw new Error(`unknown label: ${id}`);
            tx.del(P.label + id);
            this._dropReference(tx, 'labels', id);
        });
    }
}

module.exports = { HomeModel, SCHEMA, PREFIXES: P, escapeId, unescapeId, slug, matchRule };
