'use strict';

/**
 * Home model sandbox module — adds the read part of she.home.* to every script.
 *
 *   she.home.floors()                       → [{id, name, level, order, rooms: [ids]}]
 *   she.home.rooms()                        → [{id, name, floor, order, icon, aliases, entities}]
 *   she.home.entities([selection])          → [entity summary]
 *   she.home.sub(selection, [opts], cb)     → handle {entities(), cancel()}; cb(entity, val, obj, prev, topic)
 *   she.home.assign(id, patch)              → the summary of the device or entity afterwards
 *
 * selection: { room, floor, function, label, component, hidden } — every given key must match; `room`
 * takes a room id, name or alias, `''` selects the entities without a room; `hidden: true` also
 * lists hidden entities. Entities that are no longer announced are never listed.
 *
 * The summaries are the ones of the standard views (lib/home-views.js), read from the model's
 * documents at the call, so they are current right after an assign.
 */

const home = require('../web/home');
const { entitySummary, deviceSummary, byName } = require('../lib/home-views');

const SELECTION_KEYS = ['room', 'floor', 'function', 'label', 'component', 'hidden'];

function model(api) {
    const m = home.getModel();
    if (!m) throw new Error(`she.home.${api}: the home model needs sheDB (--db-path)`);
    return m;
}

function order(a, b) {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    return oa - ob || String(a.name || a.id).localeCompare(String(b.name || b.id));
}

/**
 * The selection as the model's filter.
 * @param {object} m the model
 * @param {object} [sel]
 * @param {string} api
 */
function filterOf(m, sel, api) {
    if (sel === undefined || sel === null) sel = {};
    if (typeof sel !== 'object' || Array.isArray(sel)) throw new TypeError(`she.home.${api}: the selection is an object { room, floor, function, label, component }`);
    for (const k of Object.keys(sel)) {
        if (!SELECTION_KEYS.includes(k)) throw new TypeError(`she.home.${api}: unknown selection key "${k}" — ${SELECTION_KEYS.join(', ')}`);
    }
    const f = { present: true };
    if (sel.hidden !== true) f.hidden = false;
    if (sel.room !== undefined) {
        if (sel.room === '' || sel.room === null) f.room = '';
        else {
            const id = m.resolveRoom(String(sel.room));
            // an unknown room selects nothing, and says so once per call site
            f.room = id || { unknown: String(sel.room) };
        }
    }
    for (const k of ['floor', 'function', 'label', 'component']) {
        if (sel[k] === undefined) continue;
        if (typeof sel[k] !== 'string' || !sel[k]) throw new TypeError(`she.home.${api}: ${k} must be an id`);
        f[k] = sel[k];
    }
    return f;
}

function select(m, f) {
    if (f.room && typeof f.room === 'object') return [];
    return m.entities(f).map(entitySummary).sort(byName);
}

/** every she.home.sub of every script; one listener on the state store and one on sheDB serve them all */
const subs = new Set();
let attached = null; // {store, core, onChange, onDoc}

function attach(store, core) {
    if (attached && attached.store === store && attached.core === core) return;
    detach();
    const onChange = (key, val, obj, prev) => {
        if (!subs.size || !key.startsWith('mqtt::')) return;
        const topic = key.slice(6);
        for (const sub of subs) sub.deliver(topic, val, obj, prev);
    };
    // the model's documents changed: every selection is computed again, once per turn
    let queued = false;
    const onDoc = (id) => {
        if (queued || !subs.size || !String(id).startsWith('she/')) return;
        queued = true;
        setImmediate(() => {
            queued = false;
            for (const sub of subs) sub.refresh();
        });
    };
    store.on('change', onChange);
    core.on('update', onDoc);
    attached = { store, core, onChange, onDoc };
}

function detach() {
    if (!attached) return;
    attached.store.off('change', attached.onChange);
    attached.core.off('update', attached.onDoc);
    attached = null;
}

module.exports = function (she, ctx = {}) {
    const { scriptDomain, store, onUnload, warn } = ctx;

    she.home = {
        /** Floors with the ids of their rooms, by order. */
        floors() {
            const m = model('floors');
            const rooms = m.rooms().sort(order);
            return m
                .floors()
                .map((f) => ({ id: f.id, name: f.name, level: f.level ?? null, order: f.order ?? null, rooms: rooms.filter((r) => r.floor === f.id).map((r) => r.id) }));
        },

        /** Rooms by floor and order, each with the number of its (present, not hidden) entities. */
        rooms() {
            const m = model('rooms');
            const floorPos = {};
            m.floors().forEach((f, i) => (floorPos[f.id] = i));
            const count = {};
            for (const e of m.entities({ present: true, hidden: false })) for (const r of e.eff.rooms || []) count[r] = (count[r] || 0) + 1;
            const pos = (r) => (typeof r.floor === 'string' && r.floor in floorPos ? floorPos[r.floor] : Infinity);
            return m
                .rooms()
                .sort((a, b) => pos(a) - pos(b) || order(a, b))
                .map((r) => ({
                    id: r.id,
                    name: r.name,
                    floor: r.floor ?? null,
                    order: r.order ?? null,
                    icon: r.icon ?? null,
                    aliases: Array.isArray(r.aliases) ? r.aliases : [],
                    entities: count[r.id] || 0,
                }));
        },

        /** The entity summaries of a selection, by name. */
        entities(selection) {
            const m = model('entities');
            const f = filterOf(m, selection, 'entities');
            if (f.room && typeof f.room === 'object' && typeof warn === 'function') warn(`she.home.entities: no room "${f.room.unknown}"`);
            return select(m, f);
        },

        /**
         * Follow the state topics of a selection: cb(entity, val, obj, prev, topic) for every message
         * on one of them. When entities are added, moved or removed, the subscription follows.
         * opts.change: only when the value changes.
         */
        sub(selection, opts, cb) {
            if (typeof opts === 'function') {
                cb = opts;
                opts = {};
            }
            if (typeof cb !== 'function') throw new TypeError('she.home.sub: callback is not a function');
            opts = opts || {};
            const m = model('sub');
            filterOf(m, selection, 'sub'); // a mistake in the selection throws here, at the call
            if (!store) throw new Error('she.home.sub: not available here');
            const bound = scriptDomain ? scriptDomain.bind(cb) : cb;

            const sub = {
                byTopic: new Map(), // state topic → [entity summary]
                current: [],
                refresh() {
                    sub.current = select(m, filterOf(m, selection, 'sub'));
                    const next = new Map();
                    for (const e of sub.current) {
                        if (!e.state_topic) continue;
                        if (!next.has(e.state_topic)) next.set(e.state_topic, []);
                        next.get(e.state_topic).push(e);
                    }
                    sub.byTopic = next;
                },
                deliver(topic, val, obj, prev) {
                    const list = sub.byTopic.get(topic);
                    if (!list) return;
                    if (opts.change && prev && JSON.stringify(prev.val) === JSON.stringify(val)) return;
                    for (const e of list) bound(e, val, obj, prev, topic);
                },
            };
            sub.refresh();
            attach(store, m.core);
            subs.add(sub);
            const cancel = () => subs.delete(sub);
            if (typeof onUnload === 'function') onUnload(cancel);
            return {
                /** the entities followed now */
                entities: () => sub.current.slice(),
                cancel,
            };
        },

        /**
         * Change what is assigned to a device or an entity: name, rooms, functions (entities), labels,
         * hidden, notes; null inherits again, [] means none on purpose.
         * @param {string} id  she/entity/…, she/device/…, or an entity's unique_id
         * @param {object} patch
         */
        assign(id, patch) {
            const m = model('assign');
            if (typeof id !== 'string' || !id) throw new TypeError('she.home.assign: id must be a document id (she/entity/…, she/device/…) or a unique_id');
            let docId = id;
            if (!id.startsWith('she/entity/') && !id.startsWith('she/device/')) {
                const e = m.entity(id);
                const d = e ? null : m.device(id);
                if (!e && !d) throw new Error(`she.home.assign: no entity or device "${id}"`);
                docId = (e || d)._id;
            }
            const doc = m.assign(docId, patch);
            const cur = (docId.startsWith('she/entity/') ? m.entity(docId) : m.device(docId)) || doc;
            return docId.startsWith('she/entity/') ? entitySummary(cur) : deviceSummary(cur);
        },
    };
};

/** Drop every subscription and the listeners (tests). */
module.exports.reset = function () {
    subs.clear();
    detach();
};
