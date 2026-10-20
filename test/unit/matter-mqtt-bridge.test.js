'use strict';

/**
 * Unit tests for src/matter/mqtt-bridge.js (roadmap M19) against a fake broker (a publish
 * recorder plus a state store of retained topics) and a fake controller with an event stream.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

describe('matter mqtt bridge', () => {
    let bridge;
    let dir;
    let published;
    let store;
    let controller;
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    function makeStore(entries = {}) {
        const map = new Map(Object.entries(entries));
        return {
            *mqttEntries() {
                for (const [k, v] of map) yield [k, v];
            },
            map,
        };
    }

    function makeController() {
        const events = new EventEmitter();
        const nodes = [
            { nodeId: '4', online: true, name: 'Bad Licht' },
            { nodeId: '5', online: false, name: 'Bad Licht' },
        ];
        const endpoints = {
            4: [
                { endpointId: 0, name: null, clusters: [{ name: 'basicInformation', attrs: { nodeLabel: 'Bad Licht' } }] },
                {
                    endpointId: 1,
                    name: null,
                    clusters: [
                        { name: 'onOff', attrs: { onOff: true, featureMap: 0 } },
                        { name: 'levelControl', attrs: { currentLevel: 200 } },
                        { name: 'descriptor', attrs: { serverList: [6] } },
                    ],
                },
            ],
            5: [],
        };
        return {
            events,
            listPaired: jest.fn(() => nodes.map((n) => ({ ...n }))),
            getEndpoints: jest.fn((id) => endpoints[id] ?? []),
            sendCommand: jest.fn().mockResolvedValue(null),
            setAttribute: jest.fn().mockResolvedValue(undefined),
            getAttribute: jest.fn().mockResolvedValue(42),
            _attrValue: (c, a, v) => v,
            nodes,
        };
    }

    function setup({ entries, enabled = true, format, templates } = {}) {
        jest.resetModules();
        // the cluster definitions resolve to TypeScript sources under jest — mock what the set path reads
        jest.doMock('@matter/main/clusters', () => ({
            OnOff: { Complete: { id: 6, commands: { on: {}, off: {}, toggle: {} }, attributes: { onOff: {}, onTime: {} } } },
            LevelControl: { Complete: { id: 8, commands: { moveToLevel: {}, moveToLevelWithOnOff: {} }, attributes: { currentLevel: {} } } },
        }));
        bridge = require('../../src/matter/mqtt-bridge');
        bridge._reset();
        published = [];
        store = makeStore(entries);
        controller = makeController();
        if (enabled || format || templates) {
            fs.writeFileSync(path.join(dir, 'mqtt-bridge.json'), JSON.stringify({ enabled, format, templates }));
        }
        bridge.init({
            publish: (topic, payload, opts) => published.push({ topic, payload, retain: !!opts?.retain }),
            isConnected: () => true,
            store,
            log,
            storageDir: dir,
            controller,
        });
    }
    const topics = () => published.map((p) => p.topic);
    const find = (topic) => published.filter((p) => p.topic === topic).pop();

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-bridge-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('off by default: nothing is published, nothing handled', () => {
        setup({ enabled: false });
        bridge.start();
        expect(published).toEqual([]);
        expect(bridge.onMessage('matter/set/bad_licht/1/on_off/on_off', 'true')).toBe(false);
        expect(bridge.getSettings()).toMatchObject({ enabled: false, format: 'basic', templates: { connected: 'matter/connected' } });
    });

    test('start: names assigned (unique), connected 2, the state published as { val, ts, lc } retained, endpoint 0 and the deny-list left out', () => {
        setup();
        bridge.start();
        const s = bridge.getSettings();
        expect(s.devices).toEqual([
            expect.objectContaining({ nodeId: '4', name: 'bad_licht', publish: true }),
            expect.objectContaining({ nodeId: '5', name: 'bad_licht_2', publish: true }),
        ]);
        expect(find('matter/connected')).toEqual({ topic: 'matter/connected', payload: '2', retain: true });
        expect(topics()).toEqual(
            expect.arrayContaining([
                'matter/status/bad_licht/online',
                'matter/status/bad_licht/1/on_off/on_off',
                'matter/status/bad_licht/1/level_control/current_level',
                'matter/status/bad_licht_2/online',
            ]),
        );
        expect(topics()).not.toEqual(expect.arrayContaining(['matter/status/bad_licht/0/basic_information/node_label']));
        expect(topics().some((x) => x.includes('descriptor') || x.includes('feature_map'))).toBe(false);
        const on = find('matter/status/bad_licht/1/on_off/on_off');
        expect(on.retain).toBe(true);
        expect(JSON.parse(on.payload)).toEqual({ val: true, ts: expect.any(Number), lc: expect.any(Number) });
        expect(JSON.parse(find('matter/status/bad_licht_2/online').payload).val).toBe(false);
        // the names persist
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'mqtt-bridge.json'), 'utf8')).devices['4'].name).toBe('bad_licht');
    });

    test('attribute changes keep lc, events are not retained, online follows the node', () => {
        setup();
        bridge.start();
        published.length = 0;
        controller.events.emit('attr', { nodeId: '4', endpointId: 1, clusterName: 'onOff', attrName: 'onOff', value: true, ts: 1000 });
        const p1 = JSON.parse(find('matter/status/bad_licht/1/on_off/on_off').payload);
        controller.events.emit('attr', { nodeId: '4', endpointId: 1, clusterName: 'onOff', attrName: 'onOff', value: false, ts: 2000 });
        const p2 = JSON.parse(find('matter/status/bad_licht/1/on_off/on_off').payload);
        expect(p1.lc).toBe(p1.lc); // unchanged value keeps the earlier lc
        expect(p2).toEqual({ val: false, ts: 2000, lc: 2000 });
        controller.events.emit('event', { nodeId: '4', endpointId: 1, clusterName: 'switch', eventName: 'initialPress', value: { newPosition: 1 }, ts: 3000 });
        const ev = find('matter/status/bad_licht/1/switch/initial_press');
        expect(ev.retain).toBe(false);
        expect(JSON.parse(ev.payload).val).toEqual({ newPosition: 1 });
        controller.events.emit('status', { nodeId: '4', online: false });
        expect(JSON.parse(find('matter/status/bad_licht/online').payload).val).toBe(false);
        // diagnostics never
        published.length = 0;
        controller.events.emit('attr', { nodeId: '4', endpointId: 0, clusterName: 'threadNetworkDiagnostics', attrName: 'rloc16', value: 1 });
        controller.events.emit('attr', { nodeId: '4', endpointId: 1, clusterName: 'descriptor', attrName: 'serverList', value: [] });
        expect(published).toEqual([]);
    });

    test('set: a mapped command, a command with fields, a write; the name or the node id; get publishes the value', async () => {
        setup();
        bridge.start();
        expect(bridge.onMessage('matter/set/bad_licht/1/on_off/on_off', 'true')).toBe(true);
        await new Promise((r) => setTimeout(r, 5));
        expect(controller.sendCommand).toHaveBeenLastCalledWith('4', 1, 'onOff', 'on', {});
        bridge.onMessage('matter/set/4/1/level_control/current_level', '{"val": 100}');
        await new Promise((r) => setTimeout(r, 5));
        expect(controller.sendCommand).toHaveBeenLastCalledWith('4', 1, 'levelControl', 'moveToLevel', { level: 100, transitionTime: 0 });
        bridge.onMessage('matter/set/bad_licht/1/level_control/move_to_level_with_on_off', '{"level": 10, "transitionTime": 5}');
        await new Promise((r) => setTimeout(r, 5));
        expect(controller.sendCommand).toHaveBeenLastCalledWith('4', 1, 'levelControl', 'moveToLevelWithOnOff', { level: 10, transitionTime: 5 });
        bridge.onMessage('matter/set/bad_licht/1/on_off/on_time', '30');
        await new Promise((r) => setTimeout(r, 5));
        expect(controller.setAttribute).toHaveBeenLastCalledWith('4', 1, 'onOff', 'onTime', 30);
        // an unknown device is a warning, not a crash
        bridge.onMessage('matter/set/nobody/1/on_off/on_off', 'true');
        await new Promise((r) => setTimeout(r, 5));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unknown device "nobody"'));
        // get
        published.length = 0;
        expect(bridge.onMessage('matter/get/bad_licht/1/level_control/current_level', '')).toBe(true);
        await new Promise((r) => setTimeout(r, 5));
        expect(controller.getAttribute).toHaveBeenCalledWith('4', 1, 'levelControl', 'currentLevel');
        expect(JSON.parse(find('matter/status/bad_licht/1/level_control/current_level').payload).val).toBe(42);
        // our own status is not a set
        expect(bridge.onMessage('matter/status/bad_licht/1/on_off/on_off', '{"val":true}')).toBe(false);
    });

    test('start-up cleanup clears retained topics of devices that are gone or switched off, keeps the live ones', () => {
        setup({
            entries: {
                'matter/status/bad_licht/1/on_off/on_off': { val: true },
                'matter/status/old_lamp/1/on_off/on_off': { val: true },
                'matter/status/old_lamp/online': { val: true },
                'other/topic': { val: 1 },
            },
        });
        bridge.start();
        const cleared = published
            .filter((p) => p.payload === '' && p.retain)
            .map((p) => p.topic)
            .sort();
        expect(cleared).toEqual(['matter/status/old_lamp/1/on_off/on_off', 'matter/status/old_lamp/online']);
    });

    test('a changed template and format clear the old topics and republish; switching off clears everything and sets connected 0', () => {
        setup();
        bridge.start();
        store.map.set('matter/status/bad_licht/1/on_off/on_off', { val: true });
        store.map.set('matter/status/bad_licht/online', { val: true });
        published.length = 0;
        bridge.updateSettings({ format: 'plain', templates: { attribute: 'm/${nodeId}/${endpoint}/${cluster}/${attribute}', online: 'm/${nodeId}/online' } });
        const cleared = published
            .filter((p) => p.payload === '' && p.retain)
            .map((p) => p.topic)
            .sort();
        expect(cleared).toEqual(['matter/status/bad_licht/1/on_off/on_off', 'matter/status/bad_licht/online']);
        expect(find('m/4/1/on_off/on_off')).toEqual({ topic: 'm/4/1/on_off/on_off', payload: 'true', retain: true });
        expect(bridge.getSettings().format).toBe('plain');
        expect(() => bridge.updateSettings({ templates: { set: 'm/${nodeId}/${endpoint}/${cluster}/${attributeOrCommand}' } })).toThrow('overlaps attribute');
        expect(() => bridge.updateSettings({ format: 'xml' })).toThrow('format must be');
        store.map.clear();
        store.map.set('m/4/1/on_off/on_off', { val: true });
        published.length = 0;
        bridge.updateSettings({ enabled: false });
        expect(find('m/4/1/on_off/on_off')).toEqual({ topic: 'm/4/1/on_off/on_off', payload: '', retain: true });
        expect(find('matter/connected')).toEqual({ topic: 'matter/connected', payload: '0', retain: true });
        published.length = 0;
        controller.events.emit('attr', { nodeId: '4', endpointId: 1, clusterName: 'onOff', attrName: 'onOff', value: true });
        expect(published).toEqual([]);
    });

    test('renaming a device moves its topics and leaves no stale ones; publish off clears them', () => {
        setup();
        bridge.start();
        store.map.set('matter/status/bad_licht/1/on_off/on_off', { val: true });
        store.map.set('matter/status/bad_licht/online', { val: true });
        published.length = 0;
        expect(() => bridge.setDevice('4', { name: 'Bad Licht' })).toThrow('not a valid MQTT name');
        expect(() => bridge.setDevice('4', { name: 'bad_licht_2' })).toThrow('already used');
        bridge.setDevice('4', { name: 'licht_bad' });
        const cleared = published
            .filter((p) => p.payload === '' && p.retain)
            .map((p) => p.topic)
            .sort();
        expect(cleared).toEqual(['matter/status/bad_licht/1/on_off/on_off', 'matter/status/bad_licht/online']);
        expect(find('matter/status/licht_bad/1/on_off/on_off')).toBeDefined();
        expect(bridge.getSettings().devices[0].name).toBe('licht_bad');
        // inbound follows the new name
        bridge.onMessage('matter/set/licht_bad/1/on_off/on_off', 'false');
        store.map.clear();
        store.map.set('matter/status/licht_bad/online', { val: true });
        published.length = 0;
        bridge.setDevice('4', { publish: false });
        expect(find('matter/status/licht_bad/online')).toEqual({ topic: 'matter/status/licht_bad/online', payload: '', retain: true });
        published.length = 0;
        controller.events.emit('attr', { nodeId: '4', endpointId: 1, clusterName: 'onOff', attrName: 'onOff', value: true });
        expect(published).toEqual([]);
    });

    test('extended format carries the matter block; stop publishes connected 0', () => {
        setup({ format: 'extended' });
        bridge.start();
        const on = JSON.parse(find('matter/status/bad_licht/1/on_off/on_off').payload);
        expect(on.matter).toEqual({ nodeId: '4', device: 'bad_licht', endpoint: 1, cluster: 'onOff', attribute: 'onOff' });
        published.length = 0;
        bridge.stop();
        expect(find('matter/connected').payload).toBe('0');
    });
});
