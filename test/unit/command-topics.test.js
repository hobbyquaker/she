'use strict';

const { deriveConfirm, offlineReason, confirms, statusTopicWarning, scanPublishTopics } = require('../../src/lib/command-topics');

describe('deriveConfirm()', () => {
    it('mqtt-smarthome: <inst>/set/<path> → <inst>/status/<path>, expecting the payload (or its val)', () => {
        expect(deriveConfirm('hm/set/lamp/STATE', true)).toEqual({ topic: 'hm/status/lamp/STATE', field: null, expect: true });
        expect(deriveConfirm('hm/set/lamp/LEVEL', { val: 0.5 })).toEqual({ topic: 'hm/status/lamp/LEVEL', field: null, expect: 0.5 });
    });

    it('zigbee2mqtt: <base>/<dev>/set → <base>/<dev>, the field from the single key, or `state` for a bare value', () => {
        expect(deriveConfirm('zigbee2mqtt/lamp/set', { state: 'ON' })).toEqual({ topic: 'zigbee2mqtt/lamp', field: 'state', expect: 'ON' });
        expect(deriveConfirm('zigbee2mqtt/lamp/set', 'OFF')).toEqual({ topic: 'zigbee2mqtt/lamp', field: 'state', expect: 'OFF' });
        expect(deriveConfirm('zigbee2mqtt/lamp/set', { brightness: 100 }, { path: 'brightness' })).toEqual({ topic: 'zigbee2mqtt/lamp', field: 'brightness', expect: 100 });
        // two keys without a path: the whole object must match
        expect(deriveConfirm('zigbee2mqtt/lamp/set', { state: 'ON', brightness: 100 })).toEqual({
            topic: 'zigbee2mqtt/lamp',
            field: null,
            expect: { state: 'ON', brightness: 100 },
        });
    });

    it('zigbee2mqtt attribute form <base>/<dev>/set/<attr> when the device object exists and no status topic does', () => {
        const has = (t) => t === 'zigbee2mqtt/lamp';
        expect(deriveConfirm('zigbee2mqtt/lamp/set/state', 'ON', {}, has)).toEqual({ topic: 'zigbee2mqtt/lamp', field: 'state', expect: 'ON' });
        // with a status topic present it is mqtt-smarthome
        expect(deriveConfirm('hm/set/lamp/STATE', true, {}, (t) => t === 'hm/status/lamp/STATE')).toEqual({ topic: 'hm/status/lamp/STATE', field: null, expect: true });
    });

    it('opts.confirm wins; opts.path picks the field', () => {
        expect(deriveConfirm('shelly/relay/0/command', 'on', { confirm: 'shelly/relay/0' })).toEqual({ topic: 'shelly/relay/0', field: null, expect: 'on' });
        expect(deriveConfirm('tasmota/cmnd/POWER', 'ON', { confirm: 'tasmota/tele/STATE', path: 'POWER' })).toEqual({ topic: 'tasmota/tele/STATE', field: 'POWER', expect: 'ON' });
    });

    it('null when nothing can be derived', () => {
        expect(deriveConfirm('shelly/relay/0/command', 'on')).toBeNull();
        expect(deriveConfirm('plain', 1)).toBeNull();
    });
});

describe('offlineReason()', () => {
    const state = { 'hm/connected': 1, 'hue/connected': 2, 'zigbee2mqtt/lamp/availability': 'offline', 'zigbee2mqtt/plug/availability': { state: 'online' } };
    const get = (t) => state[t];
    it('mqtt-smarthome: <inst>/connected below 2', () => {
        expect(offlineReason('hm/set/lamp/STATE', get)).toBe('hm/connected = 1');
        expect(offlineReason('hue/set/lamp/on', get)).toBeNull();
        expect(offlineReason('unknown/set/x', get)).toBeNull();
    });
    it('zigbee2mqtt: <base>/<dev>/availability offline, as a string or an object', () => {
        expect(offlineReason('zigbee2mqtt/lamp/set', get)).toBe('zigbee2mqtt/lamp/availability = offline');
        expect(offlineReason('zigbee2mqtt/plug/set', get)).toBeNull();
        expect(offlineReason('zigbee2mqtt/other/set', get)).toBeNull();
    });
});

describe('confirms()', () => {
    it('compares numbers with a tolerance, booleans and on/off loosely, strings case-insensitively', () => {
        expect(confirms(21.4, 21.5, 0.2)).toBe(true);
        expect(confirms(21.4, 21.5)).toBe(false);
        expect(confirms('21', 21)).toBe(true);
        expect(confirms(true, 1)).toBe(true);
        expect(confirms('ON', true)).toBe(true);
        expect(confirms('off', 0)).toBe(true);
        expect(confirms('ON', 'on')).toBe(true);
        expect(confirms('ON', 'OFF')).toBe(false);
        expect(confirms(undefined, 1)).toBe(false);
    });
    it('a function decides; an object expects every field', () => {
        expect(confirms(5, (v) => v > 3)).toBe(true);
        expect(confirms({ state: 'ON', brightness: 100, linkquality: 50 }, { state: 'ON', brightness: 100 })).toBe(true);
        expect(confirms({ state: 'ON', brightness: 90 }, { state: 'ON', brightness: 100 })).toBe(false);
        expect(confirms('ON', { state: 'ON' })).toBe(false);
    });
});

describe('statusTopicWarning()', () => {
    const has = (t) => t === 'zigbee2mqtt/bridge/info';
    it('<inst>/status/… is a status topic', () => {
        expect(statusTopicWarning('hm/status/lamp/STATE', has)).toMatch(/status topic.*"hm\/set\/lamp\/STATE"/);
        expect(statusTopicWarning('hm/set/lamp/STATE', has)).toBeNull();
    });
    it('a zigbee2mqtt device topic when the bridge is known; not its /set, /get or bridge topics', () => {
        expect(statusTopicWarning('zigbee2mqtt/lamp', has)).toMatch(/zigbee2mqtt.*"zigbee2mqtt\/lamp\/set"/);
        expect(statusTopicWarning('zigbee2mqtt/lamp/set', has)).toBeNull();
        expect(statusTopicWarning('zigbee2mqtt/lamp/get', has)).toBeNull();
        expect(statusTopicWarning('zigbee2mqtt/bridge/request/permit_join', has)).toBeNull();
        expect(statusTopicWarning('other/lamp', has)).toBeNull();
    });
});

describe('scanPublishTopics()', () => {
    it('finds the literal topics of pub, mqttpub, setValue and command with their lines', () => {
        const src = [
            "she.mqtt.sub('a/status/x', () => {",
            "    she.mqtt.pub('hm/status/lamp/STATE', 1);",
            '    she.mqttpub("b//c", 2);',
            '    she.setValue(`d/set/e`, 3);',
            '});',
            "she.mqtt.command('zigbee2mqtt/lamp/set', { state: 'ON' });",
            'she.mqtt.pub(topicVar, 1);',
            'she.mqtt.pub(`x/${y}`, 1);',
        ].join('\n');
        expect(scanPublishTopics(src)).toEqual([
            { line: 2, api: 'she.mqtt.pub', topic: 'hm/status/lamp/STATE' },
            { line: 3, api: 'she.mqttpub', topic: 'b/set/c' },
            { line: 4, api: 'she.setValue', topic: 'd/set/e' },
            { line: 6, api: 'she.mqtt.command', topic: 'zigbee2mqtt/lamp/set' },
        ]);
        expect(scanPublishTopics('')).toEqual([]);
    });
});
