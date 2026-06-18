'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve data root: --data-dir is pre-parsed in index.js and written to SHE_DATA_DIR
// so that this module and storage.js both see the same root when first required.
const DATA_ROOT = process.env.SHE_DATA_DIR || path.join(os.homedir(), '.she');

const config = require('yargs')
    .option('data-dir', {
        describe: 'root data directory for scripts, db, config, etc. (default: ~/.she)',
        default: DATA_ROOT,
        type: 'string',
    })
    .option('dir', {
        alias: 'd',
        describe: 'directory to load user scripts from',
        default: path.join(DATA_ROOT, 'scripts'),
        type: 'string',
    })
    .option('db-path', {
        describe: 'path to sheDB data directory (empty string to disable)',
        default: path.join(DATA_ROOT, 'db'),
        type: 'string',
    })
    .option('matter-storage', {
        describe: 'enable Matter controller; pass a directory path or true to use <data-dir>/matter',
        type: 'string',
    })
    .option('port', {
        alias: 'p',
        describe: 'HTTP server port (0 = OS-assigned random port)',
        type: 'number',
        default: 8080,
    })
    .config('config', 'path to JSON config file', (cfgPath) => {
        try {
            return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        } catch {
            return {};
        }
    })
    .default('config', path.join(DATA_ROOT, 'config', 'config.json'))
    .hide('config')
    // Sensible defaults for values not present in config.json
    .default({
        latitude: 48.7408,
        longitude: 9.1778,
        name: 'she',
        variablePrefix: 'var',
        verbosity: 'info',
        disableVariables: false,
        disableWatch: false,
        dbRetain: false,
        dbPrefix: 'she/db/',
        auth: 'none',
        proxyHeader: 'X-Remote-User',
        bindAddress: '0.0.0.0',
        timezone: '',
        mqttVersion: '',
    })
    .option('sentinel-timeout', {
        describe: 'ms to wait for the retained-state sentinel after connecting to MQTT (default: 5000)',
        default: 5000,
        type: 'number',
    })
    .option('install', {
        describe: 'create system user and install systemd service, then exit (run as root)',
        type: 'boolean',
    })
    .version()
    .help('help')
    .parseSync();

module.exports = config;
