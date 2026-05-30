const fs = require('fs');
const { getConfigPath } = require('./lib/storage');

const defaultConfigPath = getConfigPath();

const config = require('yargs')
    .env('MQTTSCRIPTS')
    .usage('Usage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('variable-prefix', 'topic prefix for $ substitution (shorthand for variables, see docs)')
    .describe('disable-variables', 'disable variable feedback (see docs)')
    .describe('url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('help', 'show help')
    .describe('dir', 'directory to scan for .js and .coffee files. can be used multiple times.')
    .describe('disable-watch', "disable file watching (don't exit process on file changes)")
    .describe('port', 'HTTP server port. 0 = OS-assigned random port. Omit to disable the web server.')
    .describe('api-key', 'Bearer token required on all /api/* requests. Omit to disable authentication.')
    .describe('db-path', 'path to shedb JSON data file (enables sheDB when set). Default when omitted: ~/.she/shedb')
    .describe('db-retain', 'publish shedb document changes as retained MQTT messages')
    .describe('matter-storage', 'path to Matter controller storage directory (enables Matter when set). Default when flag is present: ~/.she/matter')
    .describe('influx', 'InfluxDB connection options as a JSON object: { "url", "token", "org", "bucket" }. Enables she.influx.* when set.')
    .describe('elastic', 'Elasticsearch connection options as a JSON object: { "node", "auth": { "apiKey" } }. Enables she.elastic.* when set.')
    .alias({
        c: 'config',
        d: 'dir',
        h: 'help',
        k: 'api-key',
        p: 'port',
        s: 'variable-prefix',
        t: 'disable-variables',
        l: 'latitude',
        m: 'longitude',
        n: 'name',
        u: 'url',
        v: 'verbosity',
        w: 'disable-watch',
    })
    .default({
        'url': 'mqtt://127.0.0.1',
        'latitude': 48.7408,
        'longitude': 9.1778,
        'name': 'logic',
        'variable-prefix': 'var',
        'verbosity': 'info',
        'disable-variables': false,
        'disable-watch': false,
        'db-retain': false,
        'config': fs.existsSync(defaultConfigPath) ? defaultConfigPath : undefined,
    })
    .config('config')
    .version()
    .help('help')
    .parseSync();

module.exports = config;
