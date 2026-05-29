'use strict';

const { registerRoute } = require('../web/server');

/**
 * Sandbox module — adds she.api.{get,post,put,delete} to every script.
 *
 * Routes are registered under /api/<scriptName><routePath>, e.g.
 *   she.api.get('/hello', () => ({ ok: true }))
 *   → GET /api/myscript/hello
 *
 * Throws if the same method+path is registered more than once.
 *
 * @param {object} she        - per-script sandbox she object
 * @param {object} ctx
 * @param {string} ctx.scriptName - basename of the script file without extension
 */
module.exports = function (she, { scriptName }) {
    /**
     * Build the Express route handler that calls the user-supplied function.
     * - GET / DELETE: handler(req) → value | Promise
     * - POST / PUT:   handler(req, body) → value | Promise
     * req = { params, query, headers }
     */
    function makeExpressHandler(userHandler, hasBody) {
        return function (req, res) {
            let result;
            try {
                result = hasBody
                    ? userHandler({ params: req.params, query: req.query, headers: req.headers }, req.body)
                    : userHandler({ params: req.params, query: req.query, headers: req.headers });
            } catch (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            Promise.resolve(result)
                .then((val) => res.json(val !== undefined ? val : null))
                .catch((err) => res.status(500).json({ error: err.message }));
        };
    }

    function apiMethod(method, hasBody) {
        return function (routePath, handler) {
            if (typeof routePath !== 'string') throw new TypeError('path must be a string');
            if (typeof handler !== 'function') throw new TypeError('handler must be a function');
            const fullPath = '/api/' + scriptName + routePath;
            registerRoute(method, fullPath, makeExpressHandler(handler, hasBody));
        };
    }

    she.api = {
        get: apiMethod('get', false),
        post: apiMethod('post', true),
        put: apiMethod('put', true),
        delete: apiMethod('delete', false),
    };
};
