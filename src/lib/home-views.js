'use strict';

/* global emit */

/**
 * The home model's standard views: sheDB views she defines and keeps herself under `she/…`, so that a
 * script, a dashboard or another tool gets the structure — rooms, floors, which entities are where —
 * without reading every document. Each can be published on MQTT like any view.
 *
 * They are ordinary sheDB views (filter, map, reduce), computed in the view worker. The map and
 * reduce code is written here as functions and turned into the view's source, together with the
 * helpers below; the same helpers make the summaries of `she.home.*`, so a view and the API give
 * the same objects.
 *
 * - **Read-only**: the views editor shows them, but only `mqttpub` and `retain` can be changed.
 * - **Recreated at start**: `install()` writes a definition that differs from the current one
 *   (the switches set by the user are kept), and removes she's views that no longer exist.
 * - **Versioned**: every definition carries `version`; a change here raises `VERSION`.
 *
 * What the by-… views list: entities that are present and not hidden. `she/topics` and
 * `she/entities/battery` also list hidden ones (a battery sensor is often diagnostic).
 */

/** raised whenever a view's definition or result shape changes */
const VERSION = 1;

/** marks she's own views among the view definitions */
const SYSTEM = 'home';

// ---------------------------------------------------------------------------
// Helpers — self-contained: their source is copied into the views
// ---------------------------------------------------------------------------

/**
 * The entity summary: small and stable. It carries the topics, so a script can subscribe without
 * reading the document.
 * @param {object} doc  an entity document
 */
function entitySummary(doc) {
    const ha = doc.ha || {};
    const eff = doc.eff || {};
    const cfg = ha.config || {};
    const topics = ha.topics || {};
    return {
        id: doc._id,
        source: doc.source || null,
        name: eff.name || ha.name || null,
        rooms: eff.rooms || [],
        floors: eff.floors || [],
        functions: eff.functions || [],
        labels: eff.labels || [],
        component: ha.component || null,
        device_class: ha.device_class || null,
        unit: ha.unit || null,
        state_topic: typeof cfg.state_topic === 'string' ? cfg.state_topic : (topics.state && topics.state[0]) || null,
        command_topic: typeof cfg.command_topic === 'string' ? cfg.command_topic : (topics.command && topics.command[0]) || null,
        device: ha.device || null,
    };
}

/**
 * The device summary.
 * @param {object} doc  a device document
 */
function deviceSummary(doc) {
    const ha = doc.ha || {};
    const eff = doc.eff || {};
    return {
        id: doc._id,
        name: eff.name || ha.name || null,
        rooms: eff.rooms || [],
        floors: eff.floors || [],
        labels: eff.labels || [],
        adapter: eff.adapter || null,
        manufacturer: ha.manufacturer || null,
        model: ha.model || null,
        present: ha.present !== false,
        gone_since: ha.gone_since || null,
        entities: (ha.entities || []).length,
    };
}

/** an entity the by-… views list: mirrored, present, not hidden */
function isListed(doc) {
    return !!doc && doc.kind === 'entity' && !!doc.ha && !!doc.eff && doc.ha.present !== false && !doc.eff.hidden;
}

/** by name, then id — stable lists */
function byName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id));
}

/** summaries grouped by the keys a function returns; an empty key list puts it under `empty` (unless null) */
function groupBy(list, keysOf, empty) {
    const out = {};
    for (const item of list) {
        let keys = keysOf(item) || [];
        if (!keys.length) {
            if (empty === null || empty === undefined) continue;
            keys = [empty];
        }
        for (const k of keys) (out[k] = out[k] || []).push(item);
    }
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k].sort(byName);
    return sorted;
}

/** the short id of a document below a prefix, or null when the id goes deeper */
function shortId(id, prefix) {
    if (typeof id !== 'string' || id.indexOf(prefix) !== 0) return null;
    const rest = id.slice(prefix.length);
    return rest && rest.indexOf('/') === -1 ? rest : null;
}

/** sort by `order` (unset last), then name */
function byOrder(a, b) {
    const oa = typeof a.order === 'number' ? a.order : Infinity;
    const ob = typeof b.order === 'number' ? b.order : Infinity;
    return oa - ob || String(a.name || a.id).localeCompare(String(b.name || b.id));
}

/* global aggregatesOf, planScope */
const HELPERS = [entitySummary, deviceSummary, isListed, byName, groupBy, shortId, byOrder, ...require('./home-aggregate-rules').HELPERS];

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/** the listed entities' summaries: the map of every by-… view */
function mapListed() {
    if (isListed(this)) emit(entitySummary(this));
}

/** floors, rooms and listed entities, tagged: for the views that join them */
function mapStructure() {
    const floor = shortId(this._id, 'she/floor/');
    const room = shortId(this._id, 'she/room/');
    if (floor && this.kind === 'floor')
        emit({ t: 'floor', id: floor, name: this.name || floor, level: typeof this.level === 'number' ? this.level : null, order: this.order ?? null });
    else if (room && this.kind === 'room' && !this.rejected) {
        emit({ t: 'room', id: room, name: this.name || room, floor: this.floor || null, order: this.order ?? null, icon: this.icon || null, aliases: this.aliases || [] });
    } else if (isListed(this)) emit({ t: 'entity', rooms: (this.eff && this.eff.rooms) || [] });
}

const DEFS = {
    'she/floors': {
        description: 'Floors with their rooms — [{id, name, level, order, rooms}]',
        filter: 'she/#',
        map: mapStructure,
        reduce: function (result) {
            const floors = result.filter((x) => x.t === 'floor');
            const rooms = result.filter((x) => x.t === 'room').sort(byOrder);
            return floors
                .sort((a, b) => byOrder(a, b) || (a.level ?? 0) - (b.level ?? 0))
                .map((f) => ({ id: f.id, name: f.name, level: f.level, order: f.order, rooms: rooms.filter((r) => r.floor === f.id).map((r) => r.id) }));
        },
    },
    'she/rooms': {
        description: 'Rooms by floor and order — [{id, name, floor, order, icon, aliases, entities}]',
        filter: 'she/#',
        map: mapStructure,
        reduce: function (result) {
            const floorOrder = {};
            result
                .filter((x) => x.t === 'floor')
                .sort((a, b) => byOrder(a, b) || (a.level ?? 0) - (b.level ?? 0))
                .forEach((f, i) => (floorOrder[f.id] = i));
            const count = {};
            for (const x of result) if (x.t === 'entity') for (const r of x.rooms) count[r] = (count[r] || 0) + 1;
            const pos = (r) => (r.floor !== null && r.floor in floorOrder ? floorOrder[r.floor] : Infinity);
            return result
                .filter((x) => x.t === 'room')
                .sort((a, b) => pos(a) - pos(b) || byOrder(a, b))
                .map((r) => ({ id: r.id, name: r.name, floor: r.floor, order: r.order, icon: r.icon, aliases: r.aliases, entities: count[r.id] || 0 }));
        },
    },
    'she/entities/by-room': {
        description: 'Entity summaries by room — an entity in two rooms is in both, unassigned ones under ""',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            return groupBy(result, (e) => e.rooms, '');
        },
    },
    'she/entities/by-floor': {
        description: 'Entity summaries by floor — once per floor, those without a floor under ""',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            return groupBy(result, (e) => e.floors, '');
        },
    },
    'she/entities/by-function': {
        description: 'Entity summaries by function',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            return groupBy(result, (e) => e.functions, null);
        },
    },
    'she/entities/by-room-function': {
        description: 'Entity summaries by room, then function — rooms["kitchen"].lighting; unassigned under ""',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            const rooms = groupBy(result, (e) => e.rooms, '');
            const out = {};
            for (const r of Object.keys(rooms)) out[r] = groupBy(rooms[r], (e) => e.functions, null);
            return out;
        },
    },
    'she/entities/by-component': {
        description: 'Entity summaries by component (light, cover, sensor, …)',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            return groupBy(result, (e) => [e.component], null);
        },
    },
    'she/entities/by-label': {
        description: 'Entity summaries by label',
        filter: 'she/entity/#',
        map: mapListed,
        reduce: function (result) {
            return groupBy(result, (e) => e.labels, null);
        },
    },
    'she/topics': {
        description: 'Every state topic → the entities that read it (a list: one topic can carry several entities)',
        filter: 'she/entity/#',
        map: function () {
            if (!this || this.kind !== 'entity' || !this.ha || this.ha.present === false) return;
            const s = entitySummary(this);
            const topics = (this.ha.topics && this.ha.topics.state) || [];
            for (const t of topics) emit({ topic: t, entity: s });
        },
        reduce: function (result) {
            const out = {};
            for (const x of result) (out[x.topic] = out[x.topic] || []).push(x.entity);
            const sorted = {};
            for (const k of Object.keys(out).sort()) sorted[k] = out[k].sort(byName);
            return sorted;
        },
    },
    'she/devices/by-adapter': {
        description: 'Device summaries by the adapter that announces them (origin name; none under "")',
        filter: 'she/device/#',
        map: function () {
            if (this && this.kind === 'device' && this.ha && this.eff) emit(deviceSummary(this));
        },
        reduce: function (result) {
            return groupBy(result, (d) => [d.adapter || ''], '');
        },
    },
    'she/devices/unassigned': {
        description: 'What has no room: {devices, entities} — present, not hidden; entities only where their device has a room or there is none',
        filter: 'she/#',
        map: function () {
            if (this && this.kind === 'device' && this.ha && this.eff && this.ha.present !== false) emit({ t: 'device', d: deviceSummary(this), hidden: !!this.eff.hidden });
            else if (isListed(this)) emit({ t: 'entity', e: entitySummary(this) });
        },
        reduce: function (result) {
            const devices = {};
            for (const x of result) if (x.t === 'device') devices[x.d.id] = x;
            const lonely = (x) => !x.hidden && !x.d.rooms.length;
            return {
                devices: Object.values(devices)
                    .filter(lonely)
                    .map((x) => x.d)
                    .sort(byName),
                entities: result
                    .filter((x) => x.t === 'entity' && !x.e.rooms.length && !(x.e.device && devices[x.e.device] && lonely(devices[x.e.device])))
                    .map((x) => x.e)
                    .sort(byName),
            };
        },
    },
    'she/rooms/aggregates': {
        description: 'Per room: the aggregates she publishes for it and the entities each is computed from — {room: {name, floor, aggregates: {light: {entities, excluded}}, off}}',
        filter: 'she/#',
        map: function () {
            const room = shortId(this._id, 'she/room/');
            if (room && this.kind === 'room' && !this.rejected)
                emit({ t: 'room', id: room, name: this.name || room, floor: this.floor || null, aggregates: this.aggregates || null });
            else {
                const kinds = aggregatesOf(this);
                if (kinds.length) emit({ t: 'entity', id: this._id, name: (this.eff && this.eff.name) || null, rooms: (this.eff && this.eff.rooms) || [], kinds: kinds });
            }
        },
        reduce: function (result) {
            const entities = result.filter((x) => x.t === 'entity');
            const out = {};
            for (const room of result.filter((x) => x.t === 'room').sort((a, b) => a.id.localeCompare(b.id))) {
                const plan = planScope(
                    room,
                    entities.filter((e) => e.rooms.indexOf(room.id) !== -1),
                );
                out[room.id] = { name: room.name, floor: room.floor, aggregates: plan.aggregates, off: plan.off };
            }
            return out;
        },
    },
    'she/devices/gone': {
        description: 'Devices no longer announced, the most recent first — [device summary with gone_since]',
        filter: 'she/device/#',
        map: function () {
            if (this && this.kind === 'device' && this.ha && this.ha.present === false) emit(deviceSummary(this));
        },
        reduce: function (result) {
            return result.sort((a, b) => (b.gone_since || 0) - (a.gone_since || 0) || byName(a, b));
        },
    },
    'she/entities/battery': {
        description: 'Battery entities (device_class battery, hidden ones too) with their device, by room and name',
        filter: 'she/#',
        map: function () {
            if (this && this.kind === 'device' && this.ha && this.eff) emit({ t: 'device', id: this._id, name: this.eff.name || this.ha.name || null });
            else if (this && this.kind === 'entity' && this.ha && this.ha.present !== false && this.ha.device_class === 'battery') emit({ t: 'entity', e: entitySummary(this) });
        },
        reduce: function (result) {
            const names = {};
            for (const x of result) if (x.t === 'device') names[x.id] = x.name;
            const room = (e) => e.rooms[0] || '￿';
            return result
                .filter((x) => x.t === 'entity')
                .map((x) => Object.assign({}, x.e, { device_name: x.e.device ? names[x.e.device] || null : null }))
                .sort((a, b) => room(a).localeCompare(room(b)) || byName(a, b));
        },
    },
};

/** the body of a function, for a view's map or reduce */
function body(fn) {
    const src = fn.toString();
    return src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).trim();
}

const HELPER_SOURCE = HELPERS.map((f) => f.toString()).join('\n');

/**
 * The view definitions as sheDB stores them.
 * @returns {Object<string, {description: string, filter: string, map: string, reduce: string, system: string, version: number}>}
 */
function definitions() {
    const out = {};
    for (const [id, d] of Object.entries(DEFS)) {
        out[id] = {
            description: d.description,
            filter: d.filter,
            map: `${HELPER_SOURCE}\n// --- map ---\n${body(d.map)}`,
            reduce: `${HELPER_SOURCE}\n// --- reduce ---\n${body(d.reduce)}`,
            system: SYSTEM,
            version: VERSION,
        };
    }
    return out;
}

const DEFINITIONS = definitions();

/** whether a stored view definition is one of she's */
function isSystemView(query) {
    return !!query && query.system === SYSTEM;
}

/**
 * Write she's views into a sheDB core: those that are missing or differ, keeping `mqttpub` and
 * `retain`; she's views that no longer exist are removed.
 * @param {object} core  the sheDB core
 * @returns {{written: string[], removed: string[]}}
 */
function install(core) {
    const written = [];
    const removed = [];
    for (const [id, def] of Object.entries(DEFINITIONS)) {
        const cur = core.queries[id];
        const want = { ...def };
        if (cur && cur.mqttpub) want.mqttpub = true;
        if (cur && cur.retain) want.retain = true;
        if (cur && sameDefinition(cur, want)) continue;
        core.query(id, want);
        written.push(id);
    }
    for (const [id, q] of Object.entries(core.queries)) {
        if (isSystemView(q) && !DEFINITIONS[id]) {
            core.query(id, '');
            removed.push(id);
        }
    }
    return { written, removed };
}

/** Remove she's views (the home model was switched off). */
function uninstall(core) {
    const removed = [];
    for (const [id, q] of Object.entries(core.queries)) {
        if (isSystemView(q)) {
            core.query(id, '');
            removed.push(id);
        }
    }
    return removed;
}

function sameDefinition(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
    return true;
}

module.exports = {
    VERSION,
    SYSTEM,
    DEFINITIONS,
    install,
    uninstall,
    isSystemView,
    entitySummary,
    deviceSummary,
    isListed,
    byName,
};
