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
        console.log(process.env.FAKE_HELPER_VERSION || '11');
        break;
    case 'list':
        console.log(
            JSON.stringify({
                helper: Number(process.env.FAKE_HELPER_VERSION || 11),
                hostname: 'zigbee',
                node: 'v22.12.0',
                brokerEnv: true,
                adapters: [
                    { name: 'cul2mqtt', version: '1.1.1', origin: state.origin || 'registry', path: '/usr/local/lib/node_modules/cul2mqtt', node: '/usr/bin/node' },
                    {
                        name: 'homeconnect2mqtt',
                        version: '0.1.1',
                        origin: 'registry',
                        path: '/usr/local/lib/node_modules/homeconnect2mqtt',
                        node: '/usr/bin/node',
                        brokerEnv: false,
                        unit: false,
                    },
                    { name: 'ecoflow2mqtt', version: '0.3.0', origin: 'registry', path: '/usr/local/lib/node_modules/ecoflow2mqtt', node: '/usr/bin/node', unit: false },
                ],
                instances: [
                    {
                        adapter: 'cul2mqtt',
                        instance: 'cul',
                        active: 'active',
                        sub: 'running',
                        unitFile: 'enabled',
                        since: 'Sat 2026-08-22 10:00:00 CEST',
                        restarts: 0,
                        pid: 4242,
                        memory: 52428800,
                        cpuNs: Number(process.env.FAKE_CPU_NS || 1000000000),
                    },
                ],
                legacy: [
                    {
                        adapter: 'alexa-remote-mqtt',
                        unit: 'alexa-remote-mqtt.service',
                        active: 'active',
                        sub: 'running',
                        unitFile: 'enabled',
                        since: 'Sat 2026-08-22 08:20:00 CEST',
                        restarts: 0,
                        envFile: '/etc/default/alexa-remote-mqtt',
                    },
                ],
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
        if (args[2] === '-' && args[3] === 'read') process.stdout.write('ALEXA_REMOTE_MQTT_MQTT_URL=mqtt://broker\nALEXA_REMOTE_MQTT_TOPIC_PREFIX=alexa\n');
        else if (args[3] === 'read')
            process.stdout.write('# cul2mqtt instance "cul"\nCUL2MQTT_SERIALPORT=/dev/ttyACM0\nCUL2MQTT_MQTT_PASSWORD=hunter2\nCUL2MQTT_MQTT_URL=mqtt://broker\n');
        else console.log('wrote /etc/cul2mqtt/cul.env');
        break;
    case 'broker-env':
        if (args[1] === 'read') process.stdout.write('MQTT_URL=mqtt://broker\nMQTT_PASSWORD=pw\n');
        else console.log('wrote /etc/mqtt-interfaces/broker.env');
        break;
    case 'schema':
        if (args[1] === 'ecoflow2mqtt') {
            // a cloud adapter that *is* discoverable: the vendor is asked, and the scan is an
            // account login, so the schema names what it needs first (core 0.12+)
            console.log(
                JSON.stringify({
                    'title': 'ecoflow2mqtt',
                    'type': 'object',
                    'properties': {
                        name: { 'type': 'string', 'x-env': 'ECOFLOW2MQTT_NAME', 'default': 'ecoflow' },
                        email: { 'type': 'string', 'x-env': 'ECOFLOW2MQTT_EMAIL', 'x-secret': true },
                        password: { 'type': 'string', 'x-env': 'ECOFLOW2MQTT_PASSWORD', 'x-secret': true },
                        sn: { 'type': 'string', 'x-env': 'ECOFLOW2MQTT_SN', 'x-secret': true, 'x-discover': 'cloud', 'x-discover-needs': ['email', 'password'] },
                    },
                    'required': ['email', 'password', 'sn'],
                    'x-adapter': { name: 'ecoflow2mqtt', version: '0.3.0', envPrefix: 'ECOFLOW2MQTT' },
                }),
            );
            break;
        }
        if (args[1] === 'homeconnect2mqtt') {
            // a cloud adapter: nothing on the network to find, so no x-discover marker
            console.log(
                JSON.stringify({
                    'title': 'homeconnect2mqtt',
                    'type': 'object',
                    'properties': {
                        'name': { 'type': 'string', 'x-env': 'HOMECONNECT2MQTT_NAME', 'default': 'homeconnect' },
                        'client-id': { 'type': 'string', 'x-env': 'HOMECONNECT2MQTT_CLIENT_ID' },
                    },
                    'x-adapter': { name: 'homeconnect2mqtt', version: '0.1.1', envPrefix: 'HOMECONNECT2MQTT' },
                }),
            );
            break;
        }
        console.log(
            JSON.stringify({
                'title': 'cul2mqtt',
                'type': 'object',
                'properties': {
                    'name': { 'type': 'string', 'x-env': 'CUL2MQTT_NAME', 'default': 'cul' },
                    'serialport': { 'type': 'string', 'x-env': 'CUL2MQTT_SERIALPORT', 'default': '/dev/ttyACM0', 'x-discover': 'serial' },
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
    case 'discover':
        if (args[1] === 'ecoflow2mqtt') {
            // the scan is a login: without the credentials on stdin the adapter itself refuses
            if (!args.includes('--env')) die('Missing required arguments: email, password');
            if (!/^ECOFLOW2MQTT_EMAIL=.+$/m.test(stdin) || !/^ECOFLOW2MQTT_PASSWORD=.+$/m.test(stdin)) {
                die('Missing required arguments: email, password');
            }
            console.log(JSON.stringify([{ address: 'BK01ZXXXXXXXXXXX', name: 'Balcony', model: 'STREAM Microinverter', online: true, sources: ['cloud'] }]));
            break;
        }
        // two sticks: the first is the one instance "cul" already runs on (/dev/ttyACM0)
        console.log(
            JSON.stringify([
                { address: '/dev/serial/by-id/usb-busware.de_CUL868-if00', id: 'usb-busware.de_CUL868-if00', device: '/dev/ttyACM0', sources: ['serial'] },
                { address: '/dev/serial/by-id/usb-busware.de_CUL433-if00', id: 'usb-busware.de_CUL433-if00', device: '/dev/ttyACM1', sources: ['serial'] },
            ]),
        );
        break;
    case 'install':
        console.log('cul2mqtt@' + args[2] + '.service enabled and started.');
        break;
    case 'uninstall':
        console.log('cul2mqtt@' + args[2] + '.service removed.');
        break;
    case 'migrate':
        console.log('migrated ' + args[1] + '.service to ' + args[1] + '@' + args[2] + '.service; old unit and env kept as .migrated');
        break;
    case 'remove-key':
        if (!/^ssh-/.test(stdin)) die('not a public key');
        console.log('removed 1 key(s) from /home/she-services/.ssh/authorized_keys, ' + (process.env.FAKE_OTHER_KEYS || 0) + ' remaining');
        break;
    case 'teardown':
        if (Number(process.env.FAKE_OTHER_KEYS || 0) > 0 && args[1] !== '--force') {
            process.stderr.write(
                'she-servicectl: teardown: ' +
                    process.env.FAKE_OTHER_KEYS +
                    ' other key(s) still in the authorized_keys of she-services — another she instance may manage this host; remove everything anyway with --force\n',
            );
            process.exit(3);
        }
        console.log(
            (stdin.trim() ? 'removed 1 key(s) from /home/she-services/.ssh/authorized_keys, 0 remaining\n' : '') +
                'removed /etc/sudoers.d/she-services\nremoved user she-services and its home directory\nremoved /usr/local/bin/she-servicectl',
        );
        break;
    case 'self-update':
        if (process.env.FAKE_NO_SELF_UPDATE) die('unknown command: self-update');
        if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG + '.selfupdate', stdin);
        console.log('she-servicectl updated 10 -> 11 at /usr/local/bin/she-servicectl');
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
        if (args[2] === 'uninstall')
            console.log('removed /etc/systemd/system/' + args[1] + '@.service\nremoved /etc/' + args[1] + '\nremoved /var/lib/' + args[1] + '\n' + args[1] + ' uninstalled');
        else if (args[2] === 'origin') console.log(state.origin || 'registry');
        else if (args[2] === 'version') console.log('"1.1.1"');
        else console.log('changed 1 package');
        break;
    default:
        die('unknown command: ' + cmd);
}
