'use strict';

/**
 * Unit tests for src/lib/ha-discovery.js and the /she/mqtt/ha-discovery routes.
 */

const http = require('http');
const express = require('express');
const { analyzeDiscovery, parseConfigTopic, collectTopics, identifierKey } = require('../../src/lib/ha-discovery');

const T = 1700000000000;

function entries(obj) {
    return Object.entries(obj).map(([topic, val]) => [topic, { val, ts: T }]);
}

describe('parseConfigTopic', () => {
    test('entity format with and without node_id', () => {
        expect(parseConfigTopic('homeassistant/light/node1/obj1/config', 'homeassistant')).toEqual({ component: 'light', nodeId: 'node1', objectId: 'obj1' });
        expect(parseConfigTopic('homeassistant/sensor/obj1/config', 'homeassistant')).toEqual({ component: 'sensor', nodeId: null, objectId: 'obj1' });
    });
    test('rejects non-config and foreign topics', () => {
        expect(parseConfigTopic('homeassistant/light/obj1/state', 'homeassistant')).toBeNull();
        expect(parseConfigTopic('zigbee2mqtt/light/obj1/config', 'homeassistant')).toBeNull();
        expect(parseConfigTopic('homeassistant/a/b/c/d/config', 'homeassistant')).toBeNull();
    });
});

describe('collectTopics / identifierKey', () => {
    test('expands ~ and collects availability list', () => {
        const cfg = { state_topic: '~/state', command_topic: '~/set', availability: [{ topic: 'z2m/bridge/state' }], name: 'x' };
        const r = collectTopics(cfg, 'z2m/lamp');
        expect(r.state.sort()).toEqual(['z2m/lamp/set', 'z2m/lamp/state']);
        expect(r.availability).toEqual(['z2m/bridge/state']);
    });
    test('identifierKey handles string, array and nested array', () => {
        expect(identifierKey('abc')).toBe('abc');
        expect(identifierKey(['abc', 'def'])).toBe('abc');
        expect(identifierKey([['z2m', '0x1']])).toBe('z2m:0x1');
        expect(identifierKey([])).toBeNull();
        expect(identifierKey(undefined)).toBeNull();
    });
});

describe('analyzeDiscovery', () => {
    const lampOld = (suffix) => ({
        name: 'Kitchen Lamp',
        unique_id: '0x1_light_' + suffix,
        state_topic: suffix + '/kitchen_lamp',
        command_topic: suffix + '/kitchen_lamp/set',
        availability: [{ topic: suffix + '/bridge/state' }, { topic: suffix + '/kitchen_lamp/availability' }],
        device: { identifiers: [suffix + '_0x1'], name: 'Kitchen Lamp', manufacturer: 'IKEA', model: 'LED' },
    });

    test('groups entities by device identifiers and derives state topics', () => {
        const r = analyzeDiscovery(
            entries({
                'homeassistant/light/0x1/light/config': lampOld('z2m'),
                'homeassistant/sensor/0x1/linkquality/config': {
                    name: 'Kitchen Lamp linkquality',
                    stat_t: 'z2m/kitchen_lamp',
                    dev: { ids: ['z2m_0x1'] },
                },
                'z2m/kitchen_lamp': { state: 'ON' },
                'z2m/kitchen_lamp/availability': 'online',
                'z2m/bridge/state': 'online',
            }),
        );
        expect(r.prefix).toBe('homeassistant');
        expect(r.entityCount).toBe(2);
        expect(r.devices).toHaveLength(1);
        const d = r.devices[0];
        expect(d.id).toBe('z2m_0x1');
        expect(d.name).toBe('Kitchen Lamp');
        expect(d.manufacturer).toBe('IKEA');
        expect(d.entities.map((e) => e.component).sort()).toEqual(['light', 'sensor']);
        expect(d.configTopics).toEqual(['homeassistant/light/0x1/light/config', 'homeassistant/sensor/0x1/linkquality/config']);
        expect(d.statePrefixes).toEqual(['z2m/kitchen_lamp']);
        expect(d.stateTopics).toEqual(['z2m/kitchen_lamp', 'z2m/kitchen_lamp/availability']);
        expect(d.orphaned).toBe(false);
        expect(d.duplicate).toBe(false);
        expect(d.lastSeen).toBe(T);
    });

    test('flags orphaned + duplicate after a prefix change and never touches shared topics', () => {
        const r = analyzeDiscovery(
            entries({
                'homeassistant/light/z2m_0x1/light/config': lampOld('z2m'),
                'homeassistant/light/zigbee_0x1/light/config': lampOld('zigbee'),
                // new prefix is alive, old one is gone
                'zigbee/kitchen_lamp': { state: 'ON' },
                'zigbee/bridge/state': 'online',
                'z2m/bridge/state': 'online',
            }),
        );
        expect(r.devices).toHaveLength(2);
        const old = r.devices.find((d) => d.id === 'z2m_0x1');
        const neu = r.devices.find((d) => d.id === 'zigbee_0x1');
        expect(old.orphaned).toBe(true);
        expect(old.duplicate).toBe(true);
        expect(neu.orphaned).toBe(false);
        expect(neu.duplicate).toBe(true);
        // availability topics (bridge/state) never end up in the wipe list unless
        // they sit under a prefix derived from the device's own state topics
        expect(neu.stateTopics).toEqual(['zigbee/kitchen_lamp']);
        expect(old.stateTopics).toEqual([]);
        expect(old.refTopics).toContain('z2m/bridge/state');
    });

    test('shared availability topics across devices are excluded', () => {
        const r = analyzeDiscovery(
            entries({
                'homeassistant/light/a/light/config': {
                    name: 'A',
                    stat_t: 'z2m/a',
                    avty_t: 'z2m/bridge/state',
                    dev: { ids: ['a'] },
                },
                'homeassistant/light/b/light/config': {
                    name: 'B',
                    stat_t: 'z2m/b',
                    avty_t: 'z2m/bridge/state',
                    dev: { ids: ['b'] },
                },
                'z2m/a': 1,
                'z2m/bridge/state': 'online',
                'z2m/bridge/info': {},
            }),
        );
        const a = r.devices.find((d) => d.id === 'a');
        const b = r.devices.find((d) => d.id === 'b');
        expect(a.stateTopics).toEqual(['z2m/a']);
        expect(a.statePrefixes).toEqual([]);
        expect(b.stateTopics).toEqual([]);
        expect(b.orphaned).toBe(true); // its own state topic is gone; the alive shared bridge topic does not count
        expect(a.orphaned).toBe(false);
    });

    test('tasmota-style split prefixes (tele/cmnd/stat) are all derived', () => {
        const r = analyzeDiscovery(
            entries({
                'homeassistant/switch/tas1/relay/config': {
                    name: 'Plug',
                    stat_t: 'stat/tas1/RESULT',
                    cmd_t: 'cmnd/tas1/POWER',
                    avty_t: 'tele/tas1/LWT',
                    dev: { ids: ['tas1'] },
                },
                'homeassistant/sensor/tas1/temp/config': {
                    name: 'Temp',
                    stat_t: 'tele/tas1/SENSOR',
                    avty_t: 'tele/tas1/LWT',
                    dev: { ids: ['tas1'] },
                },
                'tele/tas1/LWT': 'Online',
                'tele/tas1/SENSOR': { t: 1 },
                'tele/tas2/LWT': 'Online',
                'homeassistant/switch/tas1/relay/state': 'x',
            }),
        );
        const d = r.devices[0];
        expect(d.statePrefixes).toEqual(['cmnd/tas1', 'stat/tas1', 'tele/tas1']);
        expect(d.stateTopics).toEqual(['tele/tas1/LWT', 'tele/tas1/SENSOR']);
    });

    test('device-level discovery format with cmps', () => {
        const r = analyzeDiscovery(
            entries({
                'homeassistant/device/dev1/config': {
                    'dev': { ids: ['dev1'], name: 'Multi' },
                    'o': { name: 'bla2mqtt' },
                    '~': 'bla/dev1',
                    'avty_t': '~/status',
                    'cmps': {
                        temp: { p: 'sensor', stat_t: '~/temp', name: 'Temp' },
                        sw: { p: 'switch', stat_t: '~/sw', cmd_t: '~/sw/set' },
                    },
                },
                'bla/dev1/temp': 21,
            }),
        );
        expect(r.entityCount).toBe(2);
        const d = r.devices[0];
        expect(d.id).toBe('dev1');
        expect(d.entities.map((e) => e.component).sort()).toEqual(['sensor', 'switch']);
        expect(d.refTopics).toEqual(['bla/dev1/status', 'bla/dev1/sw', 'bla/dev1/sw/set', 'bla/dev1/temp']);
        expect(d.statePrefixes).toEqual(['bla/dev1']);
        expect(d.stateTopics).toEqual(['bla/dev1/temp']);
    });

    test('custom prefix and non-object payloads are tolerated', () => {
        const r = analyzeDiscovery(entries({ 'ha/light/x/config': 'garbage', 'ha/light/y/config': { name: 'Y' } }), { prefix: 'ha/' });
        expect(r.prefix).toBe('ha');
        expect(r.devices).toHaveLength(1);
        expect(r.devices[0].id).toBe('entity:light/y');
        expect(r.devices[0].orphaned).toBe(false);
    });
});

/* ── Routes ──────────────────────────────────────────────────────────────── */

function httpRequest(method, port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    let b;
                    try {
                        b = JSON.parse(data);
                    } catch {
                        b = data;
                    }
                    resolve({ status: res.statusCode, body: b });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('/she/mqtt/ha-discovery routes', () => {
    let srv, port, published;

    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../../src/web/log-ws', () => ({ broadcast: () => {}, broadcastBrokerLog: () => {} }));
        const StateStore = require('../../src/lib/state-store');
        const store = new StateStore();
        store.setObject('mqtt::homeassistant/light/x/light/config', { val: { name: 'X', stat_t: 'p/x', dev: { ids: ['x'] } }, ts: T });
        published = [];
        const mqtt = {
            publish: (topic, payload, opts, cb) => {
                published.push({ topic, payload, opts });
                cb(topic === 'fail' ? new Error('boom') : null);
            },
        };
        const api = require('../../src/web/mqtt-api');
        api.init(store, () => mqtt);
        const app = express();
        app.use(express.json());
        app.use('/she/mqtt', api.router);
        srv = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        port = srv.address().port;
    });
    afterAll(() => srv.close());

    test('GET returns grouped devices', async () => {
        const r = await httpRequest('GET', port, '/she/mqtt/ha-discovery');
        expect(r.status).toBe(200);
        expect(r.body.devices).toHaveLength(1);
        expect(r.body.devices[0].id).toBe('x');
        expect(r.body.devices[0].orphaned).toBe(true);
    });

    test('GET rejects wildcard prefix', async () => {
        const r = await httpRequest('GET', port, '/she/mqtt/ha-discovery?prefix=ha%2F%23');
        expect(r.status).toBe(400);
    });

    test('DELETE validates input', async () => {
        expect((await httpRequest('DELETE', port, '/she/mqtt/ha-discovery', {})).status).toBe(400);
        expect((await httpRequest('DELETE', port, '/she/mqtt/ha-discovery', { topics: ['a/#'] })).status).toBe(400);
        expect((await httpRequest('DELETE', port, '/she/mqtt/ha-discovery', { topics: [''] })).status).toBe(400);
    });

    test('DELETE publishes empty retained messages, dedupes and reports errors', async () => {
        published.length = 0;
        const r = await httpRequest('DELETE', port, '/she/mqtt/ha-discovery', { topics: ['a/b', 'a/b', 'fail'] });
        expect(r.status).toBe(200);
        expect(published).toEqual([
            { topic: 'a/b', payload: '', opts: { retain: true, qos: 0 } },
            { topic: 'fail', payload: '', opts: { retain: true, qos: 0 } },
        ]);
        expect(r.body).toEqual({ ok: false, cleared: 1, errors: [{ topic: 'fail', error: 'boom' }] });
    });
});
