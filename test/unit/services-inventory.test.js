'use strict';

/**
 * Unit tests for src/lib/services-inventory.js (roadmap I4, Tier 0).
 */

const { analyzeServices, wipeTopics, parseConnected, parseInfo } = require('../../src/lib/services-inventory');

const T = 1700000000000;
const NOW = T + 90 * 60 * 1000; // 90 min later

function entries(obj) {
    return Object.entries(obj).map(([topic, val]) => [topic, { val, ts: T, lc: T }]);
}

const culInfo = {
    name: 'cul2mqtt',
    version: '1.1.1',
    spec: '2.0',
    node: 'v22.12.0',
    host: 'zigbee',
    pid: 1234,
    started: new Date(T).toISOString(),
    maintenance: true,
    serialport: '/dev/ttyACM0',
};

describe('parseConnected / parseInfo', () => {
    test('connected accepts numbers, strings, {val} and JSON strings', () => {
        expect(parseConnected(2)).toBe(2);
        expect(parseConnected('1')).toBe(1);
        expect(parseConnected(' 0 ')).toBe(0);
        expect(parseConnected({ val: 2 })).toBe(2);
        expect(parseConnected('{"val":1}')).toBe(1);
        expect(parseConnected('3')).toBeNull();
        expect(parseConnected('x')).toBeNull();
        expect(parseConnected(null)).toBeNull();
        expect(parseConnected('{bad')).toBeNull();
    });
    test('info accepts objects, JSON strings and {val} wrappers', () => {
        expect(parseInfo(culInfo)).toEqual(culInfo);
        expect(parseInfo(JSON.stringify(culInfo))).toEqual(culInfo);
        expect(parseInfo({ val: culInfo })).toEqual(culInfo);
        expect(parseInfo('not json')).toBeNull();
        expect(parseInfo(['a'])).toBeNull();
        expect(parseInfo(42)).toBeNull();
    });
});

describe('analyzeServices', () => {
    test('core instance: identity, uptime, connected, status count', () => {
        const r = analyzeServices(
            entries({
                'cul/info': culInfo,
                'cul/connected': 2,
                'cul/status/FS20/1234/state': { val: 'on', ts: T, lc: T },
                'cul/status/EM/01/power': { val: 12, ts: T, lc: T },
                'cul/set/FS20/1234': '', // not retained in practice, must not count
                'homeassistant/device/cul2mqtt_cul/config': {},
            }),
            { now: NOW },
        );
        expect(r.coreCount).toBe(1);
        expect(r.legacyCount).toBe(0);
        expect(r.instances).toHaveLength(1);
        const i = r.instances[0];
        expect(i).toMatchObject({
            instance: 'cul',
            legacy: false,
            adapter: 'cul2mqtt',
            version: '1.1.1',
            spec: '2.0',
            host: 'zigbee',
            node: 'v22.12.0',
            pid: 1234,
            started: T,
            uptime: 90 * 60 * 1000,
            maintenance: true,
            connected: 2,
            statusTopics: 2,
        });
        expect(i.info).toEqual(culInfo);
    });

    test('legacy instance: connected without info', () => {
        const r = analyzeServices(entries({ 'hm/connected': '2', 'hm/status/x': 1 }), { now: NOW });
        expect(r.legacyCount).toBe(1);
        expect(r.instances[0]).toMatchObject({
            instance: 'hm',
            legacy: true,
            adapter: null,
            version: null,
            connected: 2,
            uptime: null,
            maintenance: false,
            statusTopics: 1,
        });
    });

    test('dead instance keeps its retained info but has no uptime', () => {
        const r = analyzeServices(entries({ 'lgtv/info': { ...culInfo, name: 'lgtv2mqtt' }, 'lgtv/connected': 0 }), { now: NOW });
        expect(r.instances[0]).toMatchObject({ adapter: 'lgtv2mqtt', connected: 0, uptime: null, started: T });
    });

    test('info without connected is still listed (connected null)', () => {
        const r = analyzeServices(entries({ 'alexa/info': { ...culInfo, name: 'alexa-remote-mqtt' } }), { now: NOW });
        expect(r.instances[0]).toMatchObject({ instance: 'alexa', connected: null, legacy: false });
    });

    test('ignores deeper topics, $SYS, malformed info and unrelated topics', () => {
        const r = analyzeServices(
            entries({
                '$SYS/broker/info': 'x',
                'a/b/info': culInfo,
                'bad/info': 'not json',
                'noname/info': { version: '1.0.0' },
                'home/kitchen/temp': 21,
                'logic/connected': 2,
            }),
            { now: NOW },
        );
        expect(r.instances.map((i) => i.instance)).toEqual(['logic']);
        expect(r.instances[0].legacy).toBe(true);
    });

    test('sorted by instance name; invalid started ignored', () => {
        const r = analyzeServices(
            entries({
                'zzz/connected': 1,
                'aaa/info': { ...culInfo, started: 'yesterday' },
                'aaa/connected': 1,
            }),
            { now: NOW },
        );
        expect(r.instances.map((i) => i.instance)).toEqual(['aaa', 'zzz']);
        expect(r.instances[0].started).toBeNull();
        expect(r.instances[0].uptime).toBeNull();
    });
});

describe('wipeTopics', () => {
    const state = {
        'cul/info': culInfo,
        'cul/connected': 0,
        'cul/status/FS20/1234/state': { val: 'on' },
        'cul/status/EM/01/power': { val: 12 },
        'cul/maintenance/foo': 1,
        'culinary/status/x': 1, // different instance with the same prefix characters
        'other/status/x': 1,
        // device-level discovery announcement of the instance (availability = cul/connected)
        'homeassistant/device/cul2mqtt_cul/config': {
            dev: { ids: ['cul2mqtt_cul'], name: 'cul' },
            avty: [{ t: 'cul/connected', pl_avail: '2' }],
            cmps: {
                power: { p: 'sensor', uniq_id: 'cul2mqtt_cul_power', stat_t: 'cul/status/EM/01/power' },
            },
        },
        // another adapter's announcement must stay
        'homeassistant/sensor/other_x/config': {
            name: 'other',
            unique_id: 'other_x',
            state_topic: 'other/status/x',
            device: { identifiers: ['other_dev'] },
        },
    };

    test('own topics and the instance discovery announcements', () => {
        const r = wipeTopics(entries(state), 'cul');
        expect(r.own).toEqual(['cul/connected', 'cul/info', 'cul/maintenance/foo', 'cul/status/EM/01/power', 'cul/status/FS20/1234/state']);
        expect(r.discovery).toEqual(['homeassistant/device/cul2mqtt_cul/config']);
    });

    test('unknown instance → nothing', () => {
        const r = wipeTopics(entries(state), 'nope');
        expect(r).toEqual({ own: [], discovery: [] });
    });

    test('custom discovery prefix', () => {
        const r = wipeTopics(entries({ ...state, 'ha2/device/cul2mqtt_cul/config': state['homeassistant/device/cul2mqtt_cul/config'] }), 'cul', {
            haPrefix: 'ha2',
        });
        expect(r.discovery).toEqual(['ha2/device/cul2mqtt_cul/config']);
    });
});
