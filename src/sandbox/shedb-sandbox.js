'use strict';

/**
 * sheDB sandbox module — adds she.db.* to every script context.
 *
 * Called by loadSandbox() in index.js; receives (she, { scriptDomain, scriptName }).
 *
 * she.db API:
 *   she.db.get(id)                    → document or undefined
 *   she.db.set(id, doc)               → void (create/overwrite)
 *   she.db.extend(id, partial)        → void (deep merge)
 *   she.db.delete(id)                 → void
 *   she.db.prop(id, method, prop, val)→ void  (method: 'set'|'create'|'del')
 *   she.db.sub(pattern, callback)     → void  (callback(id, doc))
 *   she.db.query(filter, mapFn, reduceFn) → Array (ad-hoc synchronous query)
 */

const { getCore, addListener, removeListenersByScript } = require('../web/shedb');

module.exports = function (she, { scriptDomain, scriptName }) {
    const core = getCore();

    // sheDB may not be initialised (--db-path not given or startup still in progress).
    // We expose stubs that are no-ops / return undefined so user scripts don't crash.
    she.db = {
        get(id) {
            return core ? core.get(id) : undefined;
        },

        set(id, doc) {
            if (core) core.set(id, doc);
        },

        extend(id, partial) {
            if (core) core.extend(id, partial);
        },

        delete(id) {
            if (core) core.del(id);
        },

        /**
         * Set/create/del a nested property on a document.
         * @param {string} id
         * @param {'set'|'create'|'del'} method
         * @param {string} prop  - dot-notation path, e.g. 'config.network.ip'
         * @param {*}      val   - value (not used for 'del')
         */
        prop(id, method, prop, val) {
            if (core) core.prop(id, { method, prop, val });
        },

        /**
         * Subscribe to document changes matching an MQTT wildcard pattern.
         * The callback fires when any matching document is created, updated, or deleted.
         * Subscriptions are automatically removed when the script is hot-reloaded.
         *
         * @param {string}   pattern  - MQTT wildcard, e.g. 'devices/#'
         * @param {Function} callback - called as callback(id, doc) where doc is null on delete
         */
        sub(pattern, callback) {
            if (!core) return;
            // Wrap in script domain so errors don't crash the process
            const wrapped = scriptDomain.bind(callback);
            addListener(pattern, wrapped, scriptName);
        },

        /**
         * Ad-hoc synchronous query — does NOT persist; runs immediately.
         *
         * @param {string|null} filter   - MQTT wildcard to pre-filter document IDs (null = all)
         * @param {Function}    mapFn    - called as mapFn(doc, emit); call emit(item) to add to result
         * @param {Function}   [reduceFn]- called as reduceFn(resultArray); return value replaces result
         * @returns {Array}
         */
        query(filter, mapFn, reduceFn) {
            if (!core) return [];
            return core.adhocQuery(filter, mapFn, reduceFn);
        },
    };
};

/**
 * Called by unloadScript() in index.js to clean up subscriptions for the given script file.
 * @param {string} scriptFile - absolute file path (matches scriptName used when registering)
 */
module.exports.cleanup = function (scriptFile) {
    removeListenersByScript(scriptFile);
};
