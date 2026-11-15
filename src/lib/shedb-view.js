'use strict';

/**
 * How a sheDB view is compiled and run — one place for the worker, the syntax check of the core and
 * the tests, so all three run a view the same way.
 *
 * A view is `{filter?, map, reduce?}`: `map` is a function body called with `this` = the document
 * for every document whose id matches `filter`, and collects items with `emit(item)`; `reduce` is a
 * function body that receives `result` (the emitted items) and returns the view's result — an array,
 * a plain object (she's own views group by key) or any other JSON value.
 */

const vm = require('vm');
const mqttWildcard = require('./mqtt-wildcards');

function getProp(obj, propPath) {
    if (obj == null || !propPath) return undefined;
    return propPath.split('.').reduce((cur, k) => (cur != null ? cur[k] : undefined), obj);
}

/**
 * The source the sandbox runs.
 * @param {{filter?: string, map: string, reduce?: string}} q
 */
function viewSource({ filter, map, reduce }) {
    let src = `api.map = function() {\n${map}\n};\napi._result = [];\n`;
    if (filter) {
        src += `api.forEachDocument(docId => { if (api.mqttWildcard(docId, ${JSON.stringify(filter)})) api.map.apply(api.getDocument(docId)); });\n`;
    } else {
        src += `api.forEachDocument(docId => { api.map.apply(api.getDocument(docId)); });\n`;
    }
    if (reduce) {
        src += `api.reduce = function(result) {\n${reduce}\n};\napi._result = api.reduce(api._result);\n`;
    }
    return src;
}

/**
 * Compile a view; throws a SyntaxError.
 * @param {string} id
 * @param {{filter?: string, map: string, reduce?: string}} q
 * @returns {vm.Script}
 */
function compileView(id, q) {
    return new vm.Script(viewSource(q), { filename: 'shedb-view-' + id });
}

/**
 * Run a compiled view over the documents.
 * @param {vm.Script} script
 * @param {Object<string, object>} docs
 * @param {number} [timeout]
 * @returns {*} the result — an array, or what a reduce returned (she's own views return objects)
 */
function runView(script, docs, timeout = 5000) {
    const sandbox = {
        api: {
            forEachDocument: (cb) => Object.keys(docs).forEach(cb),
            getDocument: (docId) => docs[docId],
            getProp,
            mqttWildcard,
            _result: [],
        },
    };
    sandbox.emit = (item) => sandbox.api._result.push(item);
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx, { timeout });
    const result = ctx.api._result;
    if (Array.isArray(result)) return Array.from(result);
    if (result === undefined || typeof result === 'function') return [];
    return result;
}

/** The number of items of a result: the array's length, or the object's keys. */
function resultLength(result) {
    if (Array.isArray(result)) return result.length;
    return result !== null && typeof result === 'object' ? Object.keys(result).length : 0;
}

module.exports = { viewSource, compileView, runView, resultLength, getProp };
