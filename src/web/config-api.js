'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getConfigPath } = require('../lib/storage');

const DEFAULT_CONFIG_PATH = getConfigPath();

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
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf8');
        res.json({ ok: true, restartRequired: true, configPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, DEFAULT_CONFIG_PATH };
