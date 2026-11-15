'use strict';

/**
 * The home model's place in the daemon: one instance over sheDB, fed from the state store.
 *
 * The model itself (`lib/home-model.js`) knows nothing about MQTT clients or files. This module
 * decides whether an installation is new, hands every discovery config that arrives, changes or
 * is cleared to the model, and tells it when the broker's retained state is in.
 */

const fs = require('fs');
const path = require('path');
const { HomeModel } = require('../lib/home-model');
const { DEFAULT_PREFIX } = require('../lib/ha-discovery');

let _model = null;

/**
 * A new installation has nothing yet: no config file, no sheDB file, no script. Only then is the
 * home model switched on without asking — an existing sheDB has documents of its own, and the
 * first mirror writes hundreds.
 * @param {{configPath?: string, dbPath?: string, scriptDirs?: string[]}} paths
 */
function isFreshInstall({ configPath, dbPath, scriptDirs = [] }) {
    if (configPath && fs.existsSync(configPath)) return false;
    if (dbPath && fs.existsSync(path.join(dbPath, 'docs.json'))) return false;
    for (const dir of scriptDirs) {
        try {
            if (fs.readdirSync(dir).some((f) => f.endsWith('.js'))) return false;
        } catch {
            /* no such directory: nothing in it */
        }
    }
    return true;
}

/**
 * @param {object} opts
 * @param {object} opts.core   the sheDB core
 * @param {object} opts.store  the state store
 * @param {object} opts.log
 * @param {boolean} [opts.fresh]     a new installation: switch the model on
 * @param {string} [opts.prefix]     the discovery prefix
 * @returns {HomeModel}
 */
function init({ core, store, log, fresh = false, prefix = DEFAULT_PREFIX }) {
    _model = new HomeModel({ core, entries: () => store.mqttEntries(), log, prefix });
    _model.init({ fresh });

    // every message on the broker passes here: one string comparison, nothing else
    const ns = 'mqtt::' + prefix + '/';
    store.on('change', (key, val) => {
        if (key.startsWith(ns)) _model.noteConfig(key.slice(6), val);
    });
    store.on('delete', (key) => {
        if (key.startsWith(ns)) _model.noteConfig(key.slice(6), null);
    });
    return _model;
}

/**
 * The daemon starts its scripts: the retained state is as complete as it gets.
 * @param {{authoritative: boolean}} opts  false when the retained state was not received completely
 */
function start({ authoritative }) {
    if (!_model) return;
    try {
        const n = _model.start({ authoritative });
        if (_model.enabled) _model.log.info(`home model: ${n} entities in the retained state` + (authoritative ? '' : ' (incomplete: nothing will be marked as gone)'));
    } catch (err) {
        _model.log.error('home model: start failed: ' + err.message);
    }
}

/** The instance, or null when sheDB is off. */
function getModel() {
    return _model;
}

/** Drop the instance (tests). */
function reset() {
    if (_model) _model.stop();
    _model = null;
}

module.exports = { init, start, getModel, isFreshInstall, reset };
