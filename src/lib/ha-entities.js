'use strict';

/**
 * The door to `mqtt-ha-entities`, the library that reads and commands Home Assistant discovery
 * entities. It is published as ES modules only, and this daemon is CommonJS, so it is imported once
 * — asynchronously — and handed out synchronously afterwards.
 *
 * `load()` is awaited before the scripts start (index.js) and in a test's `beforeAll`; `get()` then
 * returns the module, or null while it is not loaded or when loading failed.
 */

let lib = null;
let pending = null;

/**
 * Import the library (once).
 * @returns {Promise<object>} the module's exports
 */
function load() {
    if (!pending) {
        pending = import('mqtt-ha-entities').then(
            (m) => {
                lib = m;
                return m;
            },
            (err) => {
                // a later call may try again (a test that mocks the module, a repaired installation)
                pending = null;
                throw err;
            },
        );
    }
    return pending;
}

/** The module's exports, or null before {@link load} has resolved. */
function get() {
    return lib;
}

module.exports = { load, get };
