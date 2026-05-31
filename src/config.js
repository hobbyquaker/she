'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Default config file location (can be overridden with --config on the CLI)
const configPath = path.join(os.homedir(), '.she', 'config', 'config.json');

const config = require('yargs')
    .option('dir', {
        alias: 'd',
        describe: 'directory to load user scripts from',
        default: path.join(os.homedir(), '.she', 'scripts'),
        type: 'string',
    })
    .option('db-path', {
        describe: 'path to sheDB data directory (empty string to disable)',
        default: path.join(os.homedir(), '.she', 'db'),
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
    .default('config', configPath)
    .hide('config')
    // Sensible defaults for values not present in config.json
    .default({
        latitude: 48.7408,
        longitude: 9.1778,
        name: 'logic',
        variablePrefix: 'var',
        verbosity: 'info',
        disableVariables: false,
        disableWatch: false,
        dbRetain: false,
        dbPrefix: 'she/db/',
        auth: 'none',
        proxyHeader: 'X-Remote-User',
        bindAddress: '0.0.0.0',
    })
    .version()
    .help('help')
    .parseSync();

module.exports = config;
