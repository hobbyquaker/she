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
        try {
            oldConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
            /* ok — file may not exist yet */
        }

        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf8');

        // Restart is only required when a daemon-critical key changed.
        const newConfig = req.body || {};
        const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);
        const restartRequired = [...allKeys].some((k) => !FRONTEND_ONLY_KEYS.has(k) && JSON.stringify(oldConfig[k]) !== JSON.stringify(newConfig[k]));

        res.json({ ok: true, restartRequired, configPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PATCH / — write a single subtree, leaving the rest of the file as it is on disk.
 *
 * Body: { path: 'broker.ssh', value: … }. A page that edits one branch of the config
 * must not send the whole document back: it would carry a snapshot taken when the page
 * was opened and silently revert anything another page wrote in the meantime (that is
 * how a freshly configured services.hosts list disappeared when the broker SSH page was
 * saved afterwards). Omitting `value` deletes the key.
 */
router.patch('/', (req, res) => {
    const configPath = req.app.locals.configPath || DEFAULT_CONFIG_PATH;
    try {
        const { path: dotted, value } = req.body || {};
        if (typeof dotted !== 'string' || !dotted) return res.status(400).json({ error: 'path required' });
        const segments = dotted.split('.');
        if (segments.length > 5 || !segments.every((k) => /^[A-Za-z0-9_-]+$/.test(k))) {
            return res.status(400).json({ error: `invalid config path: ${dotted}` });
        }

        let config = {};
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
            /* ok — file may not exist yet */
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};

        const before = JSON.stringify(config[segments[0]]);
        let node = config;
        for (const key of segments.slice(0, -1)) {
            if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
            node = node[key];
        }
        const last = segments[segments.length - 1];
        if (value === undefined) delete node[last];
        else node[last] = value;

        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

        const restartRequired = !FRONTEND_ONLY_KEYS.has(segments[0]) && before !== JSON.stringify(config[segments[0]]);
        res.json({ ok: true, restartRequired, configPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, DEFAULT_CONFIG_PATH };
