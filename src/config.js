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
    // Sensible defaults for values not present in config.json. Declared as typed options
    // rather than bare defaults: without a type, a value arriving from the environment
    // stays a string, and `SHE_DISABLE_WATCH=false` would be truthy.
    .option('url', {
        describe: 'MQTT broker URL, e.g. mqtt://localhost — MQTT is disabled when omitted',
        type: 'string',
    })
    .option('name', {
        describe: 'instance name — MQTT client id and prefix of the connected topic',
        default: 'she',
        type: 'string',
    })
    .option('verbosity', {
        describe: 'log level: error, warn, info, debug',
        default: 'info',
        type: 'string',
    })
    .option('latitude', {
        describe: 'latitude for solar-event scheduling',
        default: 48.7408,
        type: 'number',
    })
    .option('longitude', {
        describe: 'longitude for solar-event scheduling',
        default: 9.1778,
        type: 'number',
    })
    .option('timezone', {
        describe: 'IANA timezone for schedules (default: the system timezone)',
        default: '',
        type: 'string',
    })
    .option('variable-prefix', {
        describe: 'topic prefix for the variable system',
        default: 'var',
        type: 'string',
    })
    .option('disable-variables', {
        describe: 'disable the variable feedback loop — set on all but one instance sharing a broker',
        default: false,
        type: 'boolean',
    })
    .option('disable-watch', {
        describe: 'disable file watching: scripts are not reloaded when they change',
        default: false,
        type: 'boolean',
    })
    .option('db-retain', {
        describe: 'publish sheDB document changes as retained MQTT messages',
        default: false,
        type: 'boolean',
    })
    .option('db-prefix', {
        describe: 'topic prefix for sheDB publications',
        default: 'she/db/',
        type: 'string',
    })
    .option('auth', {
        describe: 'authentication mode: none, password, proxy',
        default: 'none',
        type: 'string',
    })
    .option('proxy-header', {
        describe: 'HTTP header carrying the authenticated user in proxy mode',
        default: 'X-Remote-User',
        type: 'string',
    })
    .option('bind-address', {
        describe: 'interface the HTTP server binds to — 127.0.0.1 when behind a reverse proxy',
        default: '0.0.0.0',
        type: 'string',
    })
    .option('mqtt-version', {
        describe: 'MQTT protocol version to force (3, 4 or 5; default: negotiated)',
        default: '',
        type: 'string',
    })
    .option('safe-mode', {
        describe: 'start without loading any user script (recovery mode — see safeModeAutoDetect)',
        default: false,
        type: 'boolean',
    })
    .option('safe-mode-auto-detect', {
        describe: 'enter safe mode automatically after an unclean shutdown (default: true)',
        default: true,
        type: 'boolean',
    })
    .option('script-timeout', {
        describe: "ms a script's synchronous top-level code may run before it is terminated, 0 = no limit (default: 5000)",
        default: 5000,
        type: 'number',
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
    // Every option is also settable as SHE_<OPTION> (SCREAMING_SNAKE_CASE), e.g. SHE_PORT,
    // SHE_BIND_ADDRESS, SHE_SAFE_MODE_AUTO_DETECT. Precedence: CLI > env > config file >
    // default. The trailing underscore in the prefix matters — yargs matches the prefix as
    // a plain string, so 'SHE' alone would also swallow SHELL (SHE + LL → config.ll).
    .env('SHE_')
    .version()
    .help('help')
    .parseSync();

// SHE_SECRETS_KEY is not an option: lib/secrets.js reads it straight from the environment.
// The prefix match picks it up anyway, and the config object is debug-logged at startup —
// so drop the master key here rather than print it.
delete config.secretsKey;
delete config['secrets-key'];

module.exports = config;
