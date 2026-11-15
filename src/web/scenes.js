'use strict';

/**
 * The scene engine's place in the daemon: one instance over sheDB and the entity layer.
 *
 * `init()` remembers what the engine is built from; `getEngine()` builds it at the first call after
 * the entity layer is there (it waits for a library that is imported asynchronously), and `start()`
 * — called when the scripts start, so the retained state is in — lets it load the scenes and
 * publish their states.
 */

const { SceneEngine } = require('../lib/scenes');
const homeEntities = require('./home-entities');

let _deps = null;
let _engine = null;
let _started = false;

/**
 * @param {object} deps
 * @param {object} deps.core       the sheDB core
 * @param {Function} deps.publish  (topic, payload, {retain}) → boolean
 * @param {string} deps.name       she's instance name
 * @param {object} deps.log
 * @param {object} [deps.announcer]
 */
function init(deps) {
    reset();
    _deps = deps;
}

/** a readable name for an entity document id, from the home model's documents */
function entityName(core, id) {
    const doc = core.docs[id];
    if (!doc) return null;
    const own = (doc.eff && doc.eff.name) || (doc.ha && doc.ha.name) || null;
    const device = doc.ha && doc.ha.device ? core.docs[doc.ha.device] : null;
    const deviceName = device ? (device.eff && device.eff.name) || (device.ha && device.ha.name) || null : null;
    if (own && deviceName && !own.includes(deviceName)) return `${deviceName} ${own}`;
    return own || deviceName;
}

/** The engine, or null when sheDB is off or the entity layer is not there (yet). */
function getEngine() {
    if (_engine) return _engine;
    if (!_deps) return null;
    const layer = homeEntities.getLayer();
    if (!layer) return null;
    _engine = new SceneEngine({ ..._deps, layer, entityName: (id) => entityName(_deps.core, id) });
    if (_started) _engine.start();
    return _engine;
}

/** The retained state is in: load the scenes, publish their states. */
function start() {
    _started = true;
    const engine = getEngine();
    if (!engine) return;
    try {
        engine.start();
        const n = engine.list().length;
        if (n) _deps.log.info(`scenes: ${n} scene${n === 1 ? '' : 's'}, ${engine.groups().length} group${engine.groups().length === 1 ? '' : 's'}`);
    } catch (err) {
        _deps.log.error('scenes: start failed: ' + err.message);
    }
}

/** Drop the instance (shutdown, tests). */
function reset() {
    if (_engine) _engine.stop();
    _engine = null;
    _deps = null;
    _started = false;
}

module.exports = { init, getEngine, start, reset };
