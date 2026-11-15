'use strict';

/**
 * The aggregates' place in the daemon: one instance over sheDB and the entity layer, started with
 * the scripts — the entity layer needs its library, and a value computed before the retained state
 * is in would be wrong.
 */

const { HomeAggregates } = require('../lib/home-aggregates');
const homeEntities = require('./home-entities');

let _deps = null;
let _aggregates = null;

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
    _aggregates = null;
    _deps = null;
}

module.exports = { init, start, getAggregates, connected, reset };
