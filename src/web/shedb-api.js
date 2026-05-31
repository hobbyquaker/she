'use strict';

/**
 * sheDB REST API — Express router mounted at /she/db
 *
 * Document IDs may contain slashes (MQTT-topic style), so all document and
 * view routes use router.use() to read req.path directly instead of named
 * params, avoiding path-to-regexp v8 wildcard incompatibilities with Express 5.
 *
 * Routes:
 *   GET    /she/db/docs              → sorted list of document IDs
 *   GET    /she/db/docs/<id>         → get document
 *   PUT    /she/db/docs/<id>         → set document (full overwrite)
 *   PATCH  /she/db/docs/<id>         → extend document (deep merge)
 *   DELETE /she/db/docs/<id>         → delete document
 *
 *   GET    /she/db/views             → sorted list of view IDs
 *   GET    /she/db/views/<id>        → get view definition { filter, map, reduce }
 *   PUT    /she/db/views/<id>        → create/update view
 *   GET    /she/db/views/<id>/result → get computed view result
 *   DELETE /she/db/views/<id>        → delete view
 */

const express = require('express');
const { getCore } = require('./shedb');

const router = express.Router();

function core503(res) {
    return res.status(503).json({ error: 'shedb not initialised' });
}

// ---------------------------------------------------------------------------
// /she/db/docs — document CRUD
// ---------------------------------------------------------------------------

router.use('/docs', (req, res) => {
    const core = getCore();
    if (!core) return core503(res);

    const method = req.method.toUpperCase();
    // Strip leading slash; empty → list all
    const id = req.path.replace(/^\/+/, '');

    // GET /she/db/docs  — list all IDs
    if (method === 'GET' && !id) {
        return res.json(Object.keys(core.docs).sort());
    }

    // GET /she/db/docs/<id>
    if (method === 'GET') {
        const doc = core.get(id);
        return doc ? res.json(doc) : res.status(404).json({ error: 'not found' });
    }

    // PUT /she/db/docs/<id>
    if (method === 'PUT') {
        if (!id) return res.status(400).json({ error: 'id required' });
        if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be a JSON object' });
        core.set(id, req.body);
        return res.json({ ok: true });
    }

    // PATCH /she/db/docs/<id>  — deep merge
    if (method === 'PATCH') {
        if (!id) return res.status(400).json({ error: 'id required' });
        if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'body must be a JSON object' });
        core.extend(id, req.body);
        return res.json({ ok: true });
    }

    // DELETE /she/db/docs/<id>
    if (method === 'DELETE') {
        if (!id) return res.status(400).json({ error: 'id required' });
        core.del(id);
        return res.json({ ok: true });
    }

    res.status(405).json({ error: 'method not allowed' });
});

// ---------------------------------------------------------------------------
// /she/db/views — named view CRUD
// ---------------------------------------------------------------------------

router.use('/views', (req, res) => {
    const core = getCore();
    if (!core) return core503(res);

    const method = req.method.toUpperCase();
    // Strip leading slash; detect /result suffix
    const rawPath = req.path.replace(/^\/+/, '');
    const isResult = rawPath.endsWith('/result');
    const id = isResult ? rawPath.slice(0, -'/result'.length) : rawPath;

    // GET /she/db/views  — list all view IDs
    if (method === 'GET' && !rawPath) {
        return res.json(Object.keys(core.queries).sort());
    }

    // GET /she/db/views/<id>/result
    if (method === 'GET' && isResult) {
        if (!id) return res.status(400).json({ error: 'id required' });
        const view = core.views[id];
        return view ? res.json(view) : res.status(404).json({ error: 'not found' });
    }

    // GET /she/db/views/<id>  — definition
    if (method === 'GET') {
        const query = core.queries[id];
        return query ? res.json(query) : res.status(404).json({ error: 'not found' });
    }

    // PUT /she/db/views/<id>  — create/update view
    if (method === 'PUT') {
        if (!id || isResult) return res.status(400).json({ error: 'id required' });
        const { filter, map, reduce, mqttpub, retain } = req.body || {};
        if (typeof map !== 'string' || !map.trim()) return res.status(400).json({ error: '"map" function string is required' });
        const payload = {
            filter: filter || undefined,
            map,
            reduce: reduce || undefined,
            ...(mqttpub ? { mqttpub: true } : {}),
            ...(retain   ? { retain:   true } : {}),
        };
        core.query(id, payload);
        return res.json({ ok: true });
    }

    // DELETE /she/db/views/<id>
    if (method === 'DELETE') {
        if (!id || isResult) return res.status(400).json({ error: 'id required' });
        core.query(id, '');
        return res.json({ ok: true });
    }

    res.status(405).json({ error: 'method not allowed' });
});

module.exports = { router };
