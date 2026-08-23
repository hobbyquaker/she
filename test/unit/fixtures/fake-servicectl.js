#!/usr/bin/env node
// Fake she-servicectl for unit tests: canned answers, records calls to $FAKE_LOG.
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
let stdin = '';
try {
    stdin = fs.readFileSync(0, 'utf8');
} catch {
    /* no stdin */
}
if (log) fs.appendFileSync(log, JSON.stringify({ args, stdin }) + '\n');
const state = process.env.FAKE_STATE ? JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8')) : {};
const die = (m) => {
    process.stderr.write('she-servicectl: ' + m + '\n');
    process.exit(2);
};
const [cmd] = args;
switch (cmd) {
    case 'version':
        console.log(process.env.FAKE_HELPER_VERSION || '4');
        break;
    case 'list':
        console.log(
            JSON.stringify({
                helper: Number(process.env.FAKE_HELPER_VERSION || 4),
                hostname: 'zigbee',
                node: 'v22.12.0',
                brokerEnv: true,
                adapters: [{ name: 'cul2mqtt', version: '1.1.1', origin: state.origin || 'registry', path: '/usr/local/lib/node_modules/cul2mqtt', node: '/usr/bin/node' }],
                instances: [{ adapter: 'cul2mqtt', instance: 'cul', active: 'active', sub: 'running', unitFile: 'enabled', since: 'Sat 2026-08-22 10:00:00 CEST', restarts: 0 }],
            }),
        );
        break;
    case 'unit':
        if (args[3] === 'status') console.log('ActiveState=active\nSubState=running');
        break;
    case 'logs':
        console.log(JSON.stringify({ __REALTIME_TIMESTAMP: '1700000000000000', PRIORITY: '6', MESSAGE: 'mqtt < connected', _PID: '42' }));
        console.log(JSON.stringify({ __REALTIME_TIMESTAMP: '1700000001000000', PRIORITY: '4', MESSAGE: 'device unreachable', _PID: '42' }));
        break;
    case 'env':
        if (args[3] === 'read')
            process.stdout.write('# cul2mqtt instance "cul"\nCUL2MQTT_SERIALPORT=/dev/ttyACM0\nCUL2MQTT_MQTT_PASSWORD=hunter2\nCUL2MQTT_MQTT_URL=mqtt://broker\n');
        else console.log('wrote /etc/cul2mqtt/cul.env');
        break;
    case 'broker-env':
        if (args[1] === 'read') process.stdout.write('MQTT_URL=mqtt://broker\nMQTT_PASSWORD=pw\n');
        else console.log('wrote /etc/mqtt-interfaces/broker.env');
        break;
    case 'schema':
        console.log(
            JSON.stringify({
                'title': 'cul2mqtt',
                'type': 'object',
                'properties': {
                    'serialport': { 'type': 'string', 'x-env': 'CUL2MQTT_SERIALPORT', 'default': '/dev/ttyACM0' },
                    'mqtt-url': { 'type': 'string', 'x-env': 'CUL2MQTT_MQTT_URL' },
                    'map-file': { 'type': 'string', 'x-env': 'CUL2MQTT_MAP_FILE', 'x-file': { format: 'json', example: 'example-map.json', schema: 'map.schema.json' } },
                    'mqtt-password': { 'type': 'string', 'x-env': 'CUL2MQTT_MQTT_PASSWORD', 'x-secret': true },
                    'api-token': { 'type': 'string', 'x-env': 'CUL2MQTT_API_TOKEN' },
                },
                'required': ['serialport'],
                'x-adapter': { name: 'cul2mqtt', version: '1.1.1', envPrefix: 'CUL2MQTT' },
            }),
        );
        break;
    case 'install':
        console.log('cul2mqtt@' + args[2] + '.service enabled and started.');
        break;
    case 'uninstall':
        console.log('cul2mqtt@' + args[2] + '.service removed.');
        break;
    case 'self-update':
        if (process.env.FAKE_NO_SELF_UPDATE) die('unknown command: self-update');
        if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG + '.selfupdate', stdin);
        console.log('she-servicectl updated 3 -> 4 at /usr/local/bin/she-servicectl');
        break;
    case 'files':
        console.log(
            JSON.stringify([
                { path: '/etc/cul2mqtt/cul.env', kind: 'file', size: 120, mtime: 1700000000 },
                { path: '/etc/cul2mqtt/cul.map.json', kind: 'file', size: 60, mtime: 1700000000 },
                { path: '/var/lib/cul2mqtt/cul/intervals.json', kind: 'file', size: 10, mtime: 1700000000 },
            ]),
        );
        break;
    case 'file':
        if (args[3] === 'read') {
            if (args[4] === '/etc/cul2mqtt/cul.map.json') process.stdout.write('{"EM/0205": "power"}\n');
            else die('no such file: ' + args[4]);
        } else console.log('wrote ' + args[4]);
        break;
    case 'asset':
        if (args[2] === 'example-map.json') process.stdout.write('{"EM/0205": "example"}\n');
        else if (args[2] === 'map.schema.json') process.stdout.write('{"type":"object"}\n');
        else die('no such asset: ' + args[2]);
        break;
    case 'npm':
        if (args[2] === 'origin') console.log(state.origin || 'registry');
        else if (args[2] === 'version') console.log('"1.1.1"');
        else console.log('changed 1 package');
        break;
    default:
        die('unknown command: ' + cmd);
}
