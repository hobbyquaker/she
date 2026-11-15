'use strict';

/**
 * The entity layer's place in the daemon: one instance over sheDB and the state store, once
 * `mqtt-ha-entities` is loaded (it is an ES module, imported asynchronously — `lib/ha-entities.js`).
 *
 * `init()` only remembers what the layer is built from; `getLayer()` builds it at the first call
 * after the library has arrived. The daemon waits for the library before it starts the scripts, so
 * a script never sees the layer missing for that reason.
 */

const haEntities = require('../lib/ha-entities');
const { HomeEntities } = require('../lib/home-entities');

let _deps = null;
let _layer = null;

/**
 * @param {object} deps
 * @param {object} deps.core     the sheDB core
 * @param {object} deps.store    the state store
 * @param {Function} deps.publish (topic, payload, {retain, qos}) → boolean
 * @param {object} deps.log
 */
function init(deps) {
    reset();
    _deps = deps;
}

/** The layer, or null when sheDB is off or the library is not loaded (yet). */
function getLayer() {
    if (_layer) return _layer;
    const lib = haEntities.get();
    if (!_deps || !lib) return null;
    _layer = new HomeEntities({ lib, ..._deps });
    return _layer;
}

/** Drop the instance (shutdown, tests). */
function reset() {
    if (_layer) _layer.stop();
    _layer = null;
    _deps = null;
}

module.exports = { init, getLayer, reset };
