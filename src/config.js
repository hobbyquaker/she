'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Pre-parse --dir/-d before yargs runs so we know where to load config.json from.
function getRootDir() {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if ((argv[i] === '--dir' || argv[i] === '-d') && argv[i + 1]) return argv[i + 1];
        const m = argv[i].match(/^--dir=(.+)$/);
        if (m) return m[1];
    }
    return path.join(os.homedir(), '.she');
}

const rootDir = getRootDir();
const configPath = path.join(rootDir, 'config.json');

const config = require('yargs')
    .option('dir', {
        alias: 'd',
        describe: 'root directory for scripts and config (config.json is read from here)',
        default: path.join(os.homedir(), '.she'),
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
    })
    .version()
    .help('help')
    .parseSync();

module.exports = config;
