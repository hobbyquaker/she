'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getConfigPath } = require('../lib/storage');

const DEFAULT_CONFIG_PATH = getConfigPath();

/**
 * Config keys that are consumed only by the frontend (no daemon restart needed).
 * All other keys require a daemon restart when changed.
 */
const FRONTEND_ONLY_KEYS = new Set(['gitAutoCommit', 'gitAutoPush', 'pinnedPackages']);

const router = express.Router();

router.get('/', (req, res) => {
    const configPath = req.app.locals.configPath || DEFAULT_CONFIG_PATH;
    let fileConfig = {};
    try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        // config file does not exist yet — return empty object
    }
    res.json(fileConfig);
});

router.put('/', (req, res) => {
    const configPath = req.app.locals.configPath || DEFAULT_CONFIG_PATH;
    try {
        let oldConfig = {};
        try { oldConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ok — file may not exist yet */ }

        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf8');

        // Restart is only required when a daemon-critical key changed.
        const newConfig = req.body || {};
        const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);
        const restartRequired = [...allKeys].some(
            (k) => !FRONTEND_ONLY_KEYS.has(k) && JSON.stringify(oldConfig[k]) !== JSON.stringify(newConfig[k]),
        );

        res.json({ ok: true, restartRequired, configPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, DEFAULT_CONFIG_PATH };
