'use strict';

/**
 * Secrets HTTP API (roadmap A5) — write-only: names and change times come back, values never do.
 *
 *   GET    /she/secrets                  { status, error, keySource, groups: [{ name, changed, fields: [{ name, changed }] }] }
 *   PUT    /she/secrets/:group/:field    { value }  → { ok, group, field, changed }
 *   DELETE /she/secrets/:group           → { ok }
 *   DELETE /she/secrets/:group/:field    → { ok }
 */

const express = require('express');
const secrets = require('../lib/secrets');

const router = express.Router();
router.use(express.json({ limit: '128kb' }));

function fail(res, err) {
    if (err.code === 'LOCKED') return res.status(409).json({ error: err.message, code: 'LOCKED' });
    if (err.code === 'INVALID_NAME' || err.code === 'INVALID_VALUE') return res.status(400).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: err.message });
}

router.get('/', (req, res) => {
    const st = secrets.status();
    res.json({ status: st.status, error: st.error, keySource: st.keySource, file: st.file, keyFile: st.keyFile, groups: secrets.list() });
});

router.put('/:group/:field', (req, res) => {
    const value = req.body && req.body.value;
    try {
        const r = secrets.set(req.params.group, req.params.field, value);
        res.json({ ok: true, ...r });
    } catch (err) {
        fail(res, err);
    }
});

function del(req, res) {
    try {
        if (!secrets.remove(req.params.group, req.params.field)) return res.status(404).json({ error: 'no such secret' });
        res.json({ ok: true });
    } catch (err) {
        fail(res, err);
    }
}
router.delete('/:group', del);
router.delete('/:group/:field', del);

module.exports = { router };
