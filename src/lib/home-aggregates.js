'use strict';

/**
 * Aggregates of the home model: what a room, a floor and the house as a whole are doing, computed
 * from their entities and published retained, so that a script, a dashboard or another tool works
 * with rooms instead of devices.
 *
 *   <name>/status/room/<room>/<aggregate>
 *   <name>/status/floor/<floor>/<aggregate>
 *   <name>/status/home/<aggregate>
 *
 *   light        is a light on                       {val: true}
 *   lights       how many                            {val: 2}
 *   open         is a window, a door, a cover open   {val: false}
 *   temperature  the mean of the room's sensors      {val: 21.4, min: 20.9, max: 21.9, unit: '°C'}
 *   humidity     likewise                            {val: 48, min: 45, max: 51, unit: '%'}
 *   occupied     does a sensor see somebody          {val: true}
 *   power        the sum of the power sensors        {val: 312.5, unit: 'W'}
 *   scene        the room's scene, when something provides it (rooms only)
 *
 * Every payload carries `ts`, `lc` (the last change of `val`) and `members`: the entities it was
 * computed from, each with what it contributed (`null` for one that is unavailable or has said
 * nothing yet). `val` is `null` when no member is known.
 *
 * Which entity counts where is in `home-aggregate-rules.js`. An entity in two rooms counts in
 * both; on a floor and in the house it counts once. An aggregate nothing counts in is not
 * published, and its topic is cleared.
 *
 * Rooms, floors and the house are announced through Home Assistant discovery as devices, one
 * entity per aggregate, so Home Assistant and a Matter bridge see rooms too. Those entities come
 * back into the home model like any other; the rules keep them out of the aggregates.
 *
 * The class reads state through the entity layer (it watches exactly the entities that count
 * somewhere) and collects changes for a moment before it publishes: a device that reports five
 * values in a row, or a power meter that reports every second, makes one publish per interval.
 */

const { aggregateNames, aggregatesOf, aggregateSetting, planScope } = require('./home-aggregate-rules');

const HOME = 'she/home';
const ROOM = 'she/room/';
const FLOOR = 'she/floor/';
const ENTITY = 'she/entity/';
const SCENEGROUP = 'she/scenegroup/';

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n, digits) => Number(n.toFixed(digits));

/** the discovery entity of each aggregate */
const ANNOUNCE = {
    light: { component: 'binary_sensor', name: 'Light', device_class: 'light' },
    lights: { component: 'sensor', name: 'Lights on', state_class: 'measurement', icon: 'mdi:lightbulb-group' },
    open: { component: 'binary_sensor', name: 'Open', device_class: 'opening' },
    temperature: { component: 'sensor', name: 'Temperature', device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' },
    humidity: { component: 'sensor', name: 'Humidity', device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' },
    occupied: { component: 'binary_sensor', name: 'Occupied', device_class: 'occupancy' },
    power: { component: 'sensor', name: 'Power', device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
};

/** a payload whose `val` is null renders to `None`, which Home Assistant takes as "unknown" */
const TEMPLATE_BINARY = "{{ 'None' if value_json.val is none else ('ON' if value_json.val else 'OFF') }}";
const TEMPLATE_NUMBER = "{{ 'None' if value_json.val is none else value_json.val }}";

const UNITS = { temperature: '°C', humidity: '%', power: 'W' };

/** a number in the aggregate's unit, from what a sensor says in its own */
function convert(name, value, unit) {
    const u = typeof unit === 'string' ? unit.trim() : '';
    if (name === 'temperature') {
        if (u === '°F') return (value - 32) / 1.8;
        if (u === 'K') return value - 273.15;
    }
    if (name === 'power') {
        if (u === 'kW') return value * 1000;
        if (u === 'mW') return value / 1000;
        if (u === 'MW') return value * 1e6;
    }
    return value;
}

/**
 * What one entity contributes to an aggregate: true/false, a number, or null when it is not known.
 * @param {string} name  the aggregate
 * @param {{component: string, unit: string|null}} member
 * @param {object} state  the entity's state in Home Assistant's terms
 */
function contribution(name, member, state) {
    if (name === 'temperature' || name === 'humidity' || name === 'power') {
        // a sensor's attribute is `value`
        const s = state ? state.value : undefined;
        if (s === undefined || s === null || s === '' || typeof s === 'boolean') return null;
        const n = Number(s);
        return Number.isFinite(n) ? convert(name, n, member.unit) : null;
    }
    const s = state ? state.state : undefined;
    if (name === 'open' && member.component === 'cover') {
        if (s === 'closed') return false;
        if (s === 'open' || s === 'opening' || s === 'closing' || s === 'stopped') return true;
        return typeof state?.position === 'number' ? state.position > 0 : null;
    }
    if (s === 'ON') return true;
    if (s === 'OFF') return false;
    return null;
}

/**
 * An aggregate from its members' contributions.
 * @param {string} name
 * @param {(boolean|number|null)[]} values
 * @returns {{val: *, min?: number|null, max?: number|null, unit?: string}}
 */
function combine(name, values) {
    const known = values.filter((v) => v !== null);
    if (name === 'temperature' || name === 'humidity') {
        if (!known.length) return { val: null, min: null, max: null, unit: UNITS[name] };
        return { val: round(known.reduce((a, b) => a + b, 0) / known.length, 2), min: round(Math.min(...known), 2), max: round(Math.max(...known), 2), unit: UNITS[name] };
    }
    if (name === 'power')
        return {
            val: known.length
                ? round(
                      known.reduce((a, b) => a + b, 0),
                      1,
                  )
                : null,
            unit: UNITS[name],
        };
    if (name === 'lights') return { val: known.length ? known.filter(Boolean).length : null };
    return { val: known.length ? known.some(Boolean) : null };
}

class HomeAggregates {
    /**
     * @param {object} opts
     * @param {object} opts.core      the sheDB core (rooms, floors, entities are read from it)
     * @param {object} opts.layer     the entity layer (`state`, `available`, `watch`)
     * @param {(topic: string, payload: string) => boolean} opts.publish  publish retained on the
     *        primary broker; false when it is not connected
     * @param {(config: object) => {remove: () => boolean}} [opts.announce]  announce a discovery entity
     * @param {{get: (topic: string) => object|undefined, topics: () => Iterable<string>}} [opts.retained]
     *        the retained MQTT state: the state object of a topic, and every topic
     * @param {string} [opts.instance]  she's instance name: the first level of the topics
     * @param {object} [opts.log]
     * @param {() => number} [opts.now]
     * @param {number} [opts.debounce]  ms changes are collected before they are published
     */
    constructor({ core, layer, publish, announce, retained, instance = 'she', log, now = Date.now, debounce = 250 }) {
        this.core = core;
        this.layer = layer;
        this.publish = publish;
        this.announce = announce || null;
        this.retained = retained || { get: () => undefined, topics: () => [] };
        this.base = `${instance}/status/`;
        this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
        this.now = now;
        this.debounce = debounce;

        /** scope key (`room/kitchen`, `floor/ground`, `home`) → {kind, id, name, area, aggregates: Map<name, member[]>, scene: boolean} */
        this._scopes = new Map();
        /** topic → {key (what was compared), val, lc} of what is published */
        this._last = new Map();
        /** topic → the announcement's handle */
        this._announced = new Map();
        /** entity id → {stop, scopes: Set<scope key>} */
        this._watching = new Map();
        this._dirty = new Set();
        this._replan = false;
        this._timer = null;
        this._started = false;
        this._swept = false;
        /** (room id) → the room's scene, or undefined; set by whoever knows scenes */
        this._scene = null;

        this._onDoc = (id) => {
            if (typeof id !== 'string') return;
            if (id === HOME || id.startsWith(ROOM) || id.startsWith(FLOOR) || id.startsWith(ENTITY)) {
                this._replan = true;
                this._schedule();
            } else if (this._scene && id.startsWith(SCENEGROUP)) {
                // a group that is given to another room keeps its value: nobody would say so
                this.sceneChanged();
            }
        };
        this._onState = (id) => {
            const w = this._watching.get(id);
            if (!w) return;
            for (const key of w.scopes) this._dirty.add(key);
            this._schedule();
        };
    }

    /** Compute and publish everything, and follow the documents and the entities from now on. */
    start() {
        if (this._started) return;
        this._started = true;
        this.core.on('update', this._onDoc);
        this._replan = true;
        this.flush();
    }

    /** Stop following. What is published stays retained (shutdown, tests). */
    stop() {
        this._started = false;
        clearTimeout(this._timer);
        this._timer = null;
        this.core.off('update', this._onDoc);
        for (const w of this._watching.values()) w.stop();
        this._watching.clear();
    }

    /** Publish every aggregate again: after a broker connect, what could not be sent is sent. */
    republish() {
        if (!this._started) return;
        for (const last of this._last.values()) last.key = null;
        for (const key of this._scopes.keys()) this._dirty.add(key);
        this._schedule();
    }

    /**
     * Let something provide the rooms' scenes: `scene(roomId)` returns what to publish on
     * `…/room/<room>/scene` — a value, or `{val, …}` with more for the payload — or undefined for a
     * room without one. Call {@link sceneChanged} when it changes.
     * @param {((roomId: string) => *)|null} scene
     */
    setSceneSource(scene) {
        this._scene = typeof scene === 'function' ? scene : null;
        this.sceneChanged();
    }

    /** A room's scene (or, without an id, any) may have changed. */
    sceneChanged(roomId) {
        for (const [key, scope] of this._scopes) if (scope.kind === 'room' && (roomId === undefined || scope.id === roomId)) this._dirty.add(key);
        this._schedule();
    }

    /** What is computed and from what — for a page and the tests: `{[scope key]: {[aggregate]: entity ids}}`. */
    plan() {
        const out = {};
        for (const [key, scope] of this._scopes) out[key] = Object.fromEntries([...scope.aggregates].map(([name, members]) => [name, members.map((m) => m.id)]));
        return out;
    }

    /** The topic of an aggregate: `topicOf('room', 'kitchen', 'light')`, `topicOf('home', null, 'power')`. */
    topicOf(kind, id, name) {
        return this.base + (kind === 'home' ? 'home' : `${kind}/${id}`) + '/' + name;
    }

    _schedule() {
        if (!this._started || this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            try {
                this.flush();
            } catch (err) {
                this.log.warn('home aggregates: ' + err.message);
            }
        }, this.debounce);
        this._timer.unref?.();
    }

    /** Do now what was collected: plan again when the structure changed, compute, publish what differs. */
    flush() {
        clearTimeout(this._timer);
        this._timer = null;
        if (!this._started) return;
        if (this._replan) {
            this._replan = false;
            this._plan();
        }
        const dirty = this._dirty;
        this._dirty = new Set();
        for (const key of dirty) {
            const scope = this._scopes.get(key);
            if (scope) this._publishScope(key, scope);
        }
    }

    // ------------------------------------------------------------------
    // The plan: which scope has which aggregate from which entities
    // ------------------------------------------------------------------

    _plan() {
        const home = this.core.get(HOME);
        const scopes = new Map();

        if (home && home.enabled === true) {
            const rooms = new Map();
            const floors = new Map();
            const entities = [];
            for (const [id, doc] of Object.entries(this.core.docs)) {
                if (!isRecord(doc)) continue;
                if (id.startsWith(ROOM)) {
                    const short = id.slice(ROOM.length);
                    if (doc.kind === 'room' && !doc.rejected && !short.includes('/')) rooms.set(short, doc);
                } else if (id.startsWith(FLOOR)) {
                    const short = id.slice(FLOOR.length);
                    if (doc.kind === 'floor' && !short.includes('/')) floors.set(short, doc);
                } else if (id.startsWith(ENTITY)) {
                    const kinds = aggregatesOf(doc);
                    if (!kinds.length) continue;
                    entities.push({
                        id,
                        name: doc.eff.name || null,
                        kinds,
                        rooms: doc.eff.rooms || [],
                        floors: doc.eff.floors || [],
                        component: doc.ha.component,
                        unit: doc.ha.unit || null,
                    });
                }
            }
            const byId = new Map(entities.map((e) => [e.id, e]));
            const members = (plan) => new Map(Object.entries(plan.aggregates).map(([name, a]) => [name, a.entities.map((m) => ({ ...byId.get(m.id), name: m.name }))]));

            for (const [id, doc] of rooms) {
                const plan = planScope(
                    doc,
                    entities.filter((e) => e.rooms.includes(id)),
                );
                scopes.set('room/' + id, { kind: 'room', id, name: doc.name || id, area: doc.name || null, holder: doc, aggregates: members(plan) });
            }
            // what a room leaves out is left out of its floor and the house as well — unless another
            // room of the same entity keeps it
            const wider = entities.map((e) => {
                const known = e.rooms.filter((r) => rooms.has(r));
                if (!known.length) return e;
                return { ...e, kinds: e.kinds.filter((k) => !known.every((r) => aggregateSetting(rooms.get(r), k).exclude.includes(e.id))) };
            });
            for (const [id, doc] of floors) {
                const plan = planScope(
                    doc,
                    wider.filter((e) => e.floors.includes(id)),
                );
                scopes.set('floor/' + id, { kind: 'floor', id, name: doc.name || id, area: null, holder: doc, aggregates: members(plan) });
            }
            scopes.set('home', { kind: 'home', id: null, name: 'Home', area: null, holder: home, aggregates: members(planScope(home, wider)) });
        }

        // watch exactly the entities that count somewhere
        const wanted = new Map();
        for (const [key, scope] of scopes) {
            for (const list of scope.aggregates.values()) {
                for (const m of list) {
                    if (!wanted.has(m.id)) wanted.set(m.id, new Set());
                    wanted.get(m.id).add(key);
                }
            }
        }
        for (const [id, w] of this._watching) {
            if (wanted.has(id)) continue;
            w.stop();
            this._watching.delete(id);
        }
        for (const [id, keys] of wanted) {
            const w = this._watching.get(id);
            if (w) w.scopes = keys;
            else this._watching.set(id, { stop: this.layer.watch(id, this._onState), scopes: keys });
        }

        this._scopes = scopes;
        for (const key of scopes.keys()) this._dirty.add(key);

        // what is no longer planned: clear its topic, drop its entity
        const planned = new Set();
        for (const scope of scopes.values()) {
            for (const name of scope.aggregates.keys()) planned.add(this.topicOf(scope.kind, scope.id, name));
            if (scope.kind === 'room') planned.add(this.topicOf('room', scope.id, 'scene'));
        }
        const stale = new Set([...this._last.keys(), ...this._announced.keys()].filter((t) => !planned.has(t)));
        if (!this._swept) {
            // once: what an earlier run left retained for a room that is gone
            const own = [this.base + 'room/', this.base + 'floor/', this.base + 'home/'];
            let complete = true;
            for (const topic of this.retained.topics()) {
                if (own.some((p) => topic.startsWith(p)) && !planned.has(topic)) stale.add(topic);
            }
            for (const topic of stale) if (!this._clear(topic)) complete = false;
            this._swept = complete;
        } else for (const topic of stale) this._clear(topic);

        this._announce(scopes);
    }

    /** Clear a topic and withdraw its entity. @returns {boolean} false when the broker could not be told */
    _clear(topic) {
        const handle = this._announced.get(topic);
        if (handle) {
            handle.remove();
            this._announced.delete(topic);
        }
        if (!this.publish(topic, '')) return false;
        this._last.delete(topic);
        return true;
    }

    /** Announce every planned aggregate; announcing one again with the same config costs nothing. */
    _announce(scopes) {
        if (!this.announce) return;
        for (const scope of scopes.values()) {
            const device = {
                id: scope.kind === 'home' ? 'home' : `${scope.kind}_${scope.id}`,
                name: scope.name,
                model: scope.kind === 'room' ? 'Room' : scope.kind === 'floor' ? 'Floor' : 'Home',
            };
            if (scope.area) device.suggested_area = scope.area;
            for (const name of scope.aggregates.keys()) {
                const topic = this.topicOf(scope.kind, scope.id, name);
                const { component, ...rest } = ANNOUNCE[name];
                try {
                    this._announced.set(
                        topic,
                        this.announce({
                            component,
                            id: name,
                            ...rest,
                            state_topic: topic,
                            value_template: component === 'binary_sensor' ? TEMPLATE_BINARY : TEMPLATE_NUMBER,
                            json_attributes_topic: topic,
                            device,
                        }),
                    );
                } catch (err) {
                    this.log.warn(`home aggregates: ${topic} could not be announced: ${err.message}`);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Values
    // ------------------------------------------------------------------

    _publishScope(key, scope) {
        for (const [name, members] of scope.aggregates) {
            const listed = members.map((m) => {
                let val = null;
                try {
                    if (this.layer.available(m.id) !== false) val = contribution(name, m, this.layer.state(m.id));
                } catch (err) {
                    this.log.warn(`home aggregates: ${m.id}: ${err.message}`);
                }
                return { id: m.id, name: m.name, val: typeof val === 'number' ? round(val, 2) : val };
            });
            const result = combine(
                name,
                listed.map((m) => m.val),
            );
            this._emit(this.topicOf(scope.kind, scope.id, name), { ...result, members: listed });
        }
        if (scope.kind === 'room') {
            const topic = this.topicOf('room', scope.id, 'scene');
            let val;
            if (this._scene && aggregateSetting(scope.holder, 'scene').enabled) {
                try {
                    val = this._scene(scope.id);
                } catch (err) {
                    this.log.warn(`home aggregates: scene of ${scope.id}: ${err.message}`);
                }
            }
            // a source may say more than the value: `{val, …}` is the payload
            if (val !== undefined) this._emit(topic, isRecord(val) && 'val' in val ? val : { val });
            else if (this._last.has(topic)) this._clear(topic);
        }
    }

    /** Publish a payload when it differs from what is published. */
    _emit(topic, body) {
        const key = JSON.stringify(body);
        let last = this._last.get(topic);
        if (!last) {
            // the first time in this run: what an earlier run left retained may still be right
            last = { key: null, val: undefined, lc: undefined };
            const before = this.retained.get(topic);
            if (isRecord(before)) {
                last.val = before.val;
                last.lc = typeof before.lc === 'number' ? before.lc : undefined;
                const same = Object.keys(before).every((k) => k === 'ts' || k === 'lc' || k in body);
                if (same && JSON.stringify(Object.fromEntries(Object.keys(body).map((k) => [k, before[k]]))) === key) last.key = key;
            }
            this._last.set(topic, last);
        }
        if (last.key === key) return;
        const ts = this.now();
        const lc = last.lc !== undefined && JSON.stringify(last.val) === JSON.stringify(body.val) ? last.lc : ts;
        const { val, ...rest } = body;
        if (!this.publish(topic, JSON.stringify({ val, ts, lc, ...rest }))) {
            // not connected: republish() sends it after the next connect
            last.key = null;
            return;
        }
        last.key = key;
        last.val = body.val;
        last.lc = lc;
    }
}

module.exports = { HomeAggregates, contribution, combine, convert, ANNOUNCE, names: aggregateNames };
