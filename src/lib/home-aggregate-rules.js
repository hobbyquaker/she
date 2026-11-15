'use strict';

/**
 * Which entity counts in which aggregate of a room, a floor or the house — the rules, without any
 * state. The aggregates themselves (`lib/home-aggregates.js`) and the view `she/rooms/aggregates`
 * (`lib/home-views.js`) both use them, and the view runs in the view worker: every function here is
 * self-contained, its source is copied into the view. So no constants outside the functions, and
 * nothing but each other is called.
 *
 *   light, lights   what the function `lighting` holds and can be on: lights and switches
 *   open            what the function `openings` holds: contacts and covers
 *   temperature     sensors of that device class in the function `climate`
 *   humidity        likewise
 *   occupied        occupancy, presence and motion sensors
 *   power           power sensors in the function `energy`
 *
 * A room, a floor and the house (`she/home`) can carry `aggregates`: `{temperature: false}`
 * switches one off, `{temperature: {exclude: ['she/entity/…']}}` leaves a sensor out.
 */

/** the aggregates computed from entities, in the order they are listed */
function aggregateNames() {
    return ['light', 'lights', 'open', 'temperature', 'humidity', 'occupied', 'power'];
}

/**
 * Is this entity one of the aggregates themselves? They are announced through discovery, so they
 * come back as entities of the home model — and must never count in what they are computed from.
 * @param {object} doc  an entity document
 */
function isAggregateEntity(doc) {
    const uid = doc && doc.ha && doc.ha.unique_id;
    return typeof uid === 'string' && /^she_.+_(room_.+|floor_.+|home)_(light|lights|open|temperature|humidity|occupied|power)$/.test(uid);
}

/**
 * The aggregates an entity counts in, by what it is.
 * @param {object} doc  an entity document
 * @returns {string[]}
 */
function aggregatesOf(doc) {
    if (!doc || doc.kind !== 'entity' || !doc.ha || !doc.eff) return [];
    if (doc.ha.present === false || doc.eff.hidden || isAggregateEntity(doc)) return [];
    const component = doc.ha.component;
    const cls = doc.ha.device_class || null;
    const functions = doc.eff.functions || [];
    const out = [];
    if (functions.indexOf('lighting') !== -1 && (component === 'light' || component === 'switch')) out.push('light', 'lights');
    if (functions.indexOf('openings') !== -1 && (component === 'binary_sensor' || component === 'cover')) out.push('open');
    if (component === 'sensor' && functions.indexOf('climate') !== -1 && (cls === 'temperature' || cls === 'humidity')) out.push(cls);
    if (component === 'binary_sensor' && (cls === 'occupancy' || cls === 'presence' || cls === 'motion')) out.push('occupied');
    if (component === 'sensor' && cls === 'power' && functions.indexOf('energy') !== -1) out.push('power');
    return out;
}

/**
 * What a room, a floor or the house says about one aggregate.
 * @param {object|null} holder  the document that carries `aggregates`
 * @param {string} name
 * @returns {{enabled: boolean, exclude: string[]}}
 */
function aggregateSetting(holder, name) {
    const all = holder && holder.aggregates && typeof holder.aggregates === 'object' ? holder.aggregates : {};
    const one = (n) => {
        const cfg = all[n];
        if (cfg === false) return { enabled: false, exclude: [] };
        if (cfg && typeof cfg === 'object') return { enabled: cfg.enabled !== false, exclude: Array.isArray(cfg.exclude) ? cfg.exclude.filter((x) => typeof x === 'string') : [] };
        return { enabled: true, exclude: [] };
    };
    const own = one(name);
    // a lamp left out of "is a light on" is not counted in "how many" either
    if (name === 'lights') own.exclude = own.exclude.concat(one('light').exclude);
    return own;
}

/**
 * The aggregates of one room, floor or the house.
 * @param {object|null} holder  the document that carries `aggregates`
 * @param {{id: string, name: string|null, kinds: string[]}[]} entities  the entities in it, with
 *        what {@link aggregatesOf} said about each
 * @returns {{aggregates: Object<string, {entities: {id: string, name: string|null}[], excluded: string[]}>, off: string[]}}
 *          an aggregate without an entity is not listed
 */
function planScope(holder, entities) {
    const aggregates = {};
    const off = [];
    for (const name of aggregateNames()) {
        const setting = aggregateSetting(holder, name);
        if (!setting.enabled) {
            off.push(name);
            continue;
        }
        const members = [];
        const excluded = [];
        for (const e of entities) {
            if (e.kinds.indexOf(name) === -1) continue;
            if (setting.exclude.indexOf(e.id) !== -1) excluded.push(e.id);
            else members.push({ id: e.id, name: e.name });
        }
        if (!members.length) continue;
        members.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));
        aggregates[name] = { entities: members, excluded: excluded.sort() };
    }
    return { aggregates, off };
}

const HELPERS = [aggregateNames, isAggregateEntity, aggregatesOf, aggregateSetting, planScope];

module.exports = { aggregateNames, isAggregateEntity, aggregatesOf, aggregateSetting, planScope, HELPERS };
