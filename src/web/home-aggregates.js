'use strict';

/**
 * The aggregates' place in the daemon: one instance over sheDB and the entity layer, started with
 * the scripts — the entity layer needs its library, and a value computed before the retained state
 * is in would be wrong.
 */

const { HomeAggregates } = require('../lib/home-aggregates');
const homeEntities = require('./home-entities');
const scenes = require('./scenes');

let _deps = null;
let _aggregates = null;
/** the scene engine whose groups are followed, and the listener on it */
let _engine = null;
const _onGroup = () => {
    // a group may have changed its room as well: every room is looked at, only what differs is published
    if (_aggregates) _aggregates.sceneChanged();
};

/**
 * The scene of a room, from its scene groups: `{val, group, groups}`, or undefined for a room
 * without a group.
 *
 * A group is a set of scenes of which one applies at a time ("off, evening, movie"), and `val` is
 * the id of that scene, or '' when none matches. A room with several groups (the lights, the
 * blinds) publishes the first group — by name — that has a matching scene; `groups` has them all.
 * Scenes outside a group are not looked at: several of them can apply at once.
 * @param {object} engine  the scene engine
 * @param {string} roomId
 */
function roomScene(engine, roomId) {
    const groups = engine.groups({ area: roomId });
    if (!groups.length) return undefined;
    const active = groups.find((g) => g.val);
    return { val: active ? active.val : '', group: active ? active.id : null, groups: Object.fromEntries(groups.map((g) => [g.id, g.val])) };
}

/** Listen to the scene engine there is now; it may be built after the aggregates, or again. */
function followEngine() {
    const engine = scenes.getEngine();
    if (engine === _engine) return engine;
    if (_engine) _engine.off('group', _onGroup);
    _engine = engine;
    if (engine) engine.on('group', _onGroup);
    return engine;
}

/**
 * @param {object} deps
 * @param {object} deps.core      the sheDB core
 * @param {object} deps.store     the state store
 * @param {Function} deps.publish (topic, payload) → boolean, retained on the primary broker
 * @param {Function} deps.announce (config) → handle, a discovery entity of she itself
 * @param {string} deps.instance  she's instance name
 * @param {object} deps.log
 */
function init(deps) {
    reset();
    _deps = deps;
}

/** Start computing. Without sheDB or the entity library there are no aggregates. */
function start() {
    if (_aggregates || !_deps) return null;
    const layer = homeEntities.getLayer();
    if (!layer) return null;
    const { store, ...rest } = _deps;
    _aggregates = new HomeAggregates({
        ...rest,
        layer,
        retained: {
            get: (topic) => store.getObject('mqtt::' + topic),
            topics: function* () {
                for (const [topic] of store.mqttEntries()) yield topic;
            },
        },
    });
    try {
        _aggregates.start();
        // the rooms' scenes come from the scene engine, whenever it is there
        _aggregates.setSceneSource((roomId) => {
            const engine = followEngine();
            return engine ? roomScene(engine, roomId) : undefined;
        });
        followEngine();
    } catch (err) {
        _deps.log.error('home aggregates: start failed: ' + err.message);
    }
    return _aggregates;
}

/** The instance, or null. */
function getAggregates() {
    return _aggregates;
}

/** The broker is connected (again): what could not be published is. */
function connected() {
    if (_aggregates) _aggregates.republish();
}

/** Drop the instance (shutdown, tests). */
function reset() {
    if (_aggregates) _aggregates.stop();
    if (_engine) _engine.off('group', _onGroup);
    _engine = null;
    _aggregates = null;
    _deps = null;
}

module.exports = { init, start, getAggregates, connected, reset, roomScene };
