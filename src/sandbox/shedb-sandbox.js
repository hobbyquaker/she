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
 *   she.db.getView(id)                → Array|undefined (current view result)
 *   she.db.subView(pattern, callback) → void  (callback(id, result))
 *   she.db.setView(id, definition)    → void  (create/update named view)
 */

const { getCore, addListener, removeListenersByScript, addViewListener, removeViewListenersByScript } = require('../web/shedb');

module.exports = function (she, { scriptDomain, scriptName, scriptFile }) {
    const core = getCore();
    // Use the full file path as the tracking key so cleanup() in index.js
    // (which passes the full path) matches what was registered here.
    const trackingKey = scriptFile || scriptName;

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
            addListener(pattern, wrapped, trackingKey);
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

        /**
         * Return the current computed result array for a named view, or undefined if
         * the view does not exist, has not yet completed, or produced an error.
         *
         * @param {string} id - view name
         * @returns {Array|undefined}
         */
        getView(id) {
            if (!core) return undefined;
            const view = core.views[id];
            if (!view || view.error) return undefined;
            return view.result;
        },

        /**
         * Subscribe to view result changes matching an MQTT wildcard pattern.
         * callback(id, result) fires whenever a matching view's result changes;
         * result is undefined if the view errored.
         * Subscriptions are automatically removed when the script is hot-reloaded.
         *
         * @param {string}   pattern  - MQTT wildcard, e.g. 'stats/#'
         * @param {Function} callback - called as callback(id, result)
         */
        subView(pattern, callback) {
            if (!core) return;
            const wrapped = scriptDomain.bind(callback);
            addViewListener(pattern, wrapped, trackingKey);
        },

        /**
         * Create or update a named persistent view.
         * Definition: { map, filter?, reduce?, publish?, retain?, description? }
         * `publish` maps to `mqttpub` internally.
         *
         * @param {string} id
         * @param {{ map: string, filter?: string, reduce?: string, publish?: boolean, retain?: boolean, description?: string }} definition
         */
        setView(id, definition) {
            if (!core) return;
            if (!definition || typeof definition !== 'object') return;
            const { map, filter, reduce, publish, retain, description } = definition;
            if (typeof map !== 'string' || !map.trim()) return;
            const payload = { map };
            if (filter) payload.filter = filter;
            if (reduce) payload.reduce = reduce;
            if (publish) payload.mqttpub = true;
            if (retain) payload.retain = true;
            if (description) payload.description = String(description).slice(0, 500);
            core.query(id, payload);
        },
    };
};

/**
 * Called by unloadScript() in index.js to clean up subscriptions for the given script file.
 * @param {string} scriptFile - absolute file path (matches scriptName used when registering)
 */
module.exports.cleanup = function (scriptFile) {
    removeListenersByScript(scriptFile);
    removeViewListenersByScript(scriptFile);
};
