'use strict';

/**
 * Home model REST API — Express router mounted at /she/home
 *
 *   GET /she/home  → { available, enabled, decided, language, enabled_at, live, counts }
 *                    `available: false` when sheDB is off (the model needs it);
 *                    `decided: false` on an installation that has never switched it on or off;
 *                    `language: null` while the default functions have not been seeded
 *   PUT /she/home  { enabled, language? } → the same, after switching. `language` (`en` or `de`)
 *                    names the seeded functions and is required until they are seeded.
 */

const express = require('express');
const home = require('./home');
const { LANGUAGES } = require('../lib/home-defaults');

const router = express.Router();

const UNAVAILABLE = { available: false, enabled: false, decided: false, reason: 'The home model is kept in sheDB, which is switched off.' };

router.get('/', (req, res) => {
    const model = home.getModel();
    res.json(model ? { available: true, ...model.status() } : UNAVAILABLE);
});

router.put('/', (req, res) => {
    const model = home.getModel();
    if (!model) return res.status(503).json({ error: UNAVAILABLE.reason });
    const { enabled, language } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true or false) is required' });
    if (language !== undefined && !LANGUAGES.includes(language)) return res.status(400).json({ error: `language must be one of: ${LANGUAGES.join(', ')}` });
    if (enabled && !language && !model.status().language)
        return res.status(400).json({ error: `language (${LANGUAGES.join(' or ')}) is required: the functions are seeded with names in it` });
    try {
        const status = enabled ? model.enable({ language }) : model.disable();
        res.json({ available: true, ...status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router };
