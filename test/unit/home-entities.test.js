/**
 * The entity layer of the home model: state and commands of discovery entities through
 * mqtt-ha-entities, from the state store, with the documents the home model writes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// eslint-disable-next-line n/no-deprecated-api -- the daemon binds a script's callbacks to its domain
const domain = require('domain');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const parsePayload = require('../../src/lib/parse-payload');
const { HomeModel } = require('../../src/lib/home-model');
const { HomeEntities, payloadOf } = require('../../src/lib/home-entities');
const haEntities = require('../../src/lib/ha-entities');
const home = require('../../src/web/home');
const homeEntities = require('../../src/web/home-entities');
const homeSandbox = require('../../src/sandbox/home-sandbox');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const FIXTURES = path.join(__dirname, 'fixtures', 'ha-discovery');
const J = JSON.stringify;

let lib, tmpDir, core, store, model, layer, published, connected, warnings;

/** a message as the daemon stores it */
function feed(topic, payload) {
    const text = typeof payload === 'string' ? payload : J(payload);
    if (text === '') return store.delete('mqtt::' + topic);
    const state = parsePayload(text);
    if (!state.ts) state.ts = Date.now();
    if (state.lc === undefined) state.lc = state.ts;
    store.setObject('mqtt::' + topic, state);
}

/** the discovery corpus into the state store, the model switched on and started over it */
function withCorpus(...files) {
    const names = files.length ? files : fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    for (const name of names) {
        for (const m of JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))) feed(m.topic, m.payload);
    }
    return withModel();
}

function withModel() {
    model = new HomeModel({ core, entries: () => store.mqttEntries(), log: noop, goneDelay: 0 });
    model.enable({ language: 'en' });
    model.start({ authoritative: true });
    layer = new HomeEntities({
        lib,
        core,
        store,
        log: { ...noop, warn: (m) => warnings.push(m) },
        publish: (topic, payload, options) => {
            if (!connected) return false;
            published.push([topic, payload, options]);
            return true;
        },
    });
    return layer;
}

/** the document id of the corpus entity with that unique_id */
function id(uniqueId) {
    const found = layer.resolve(uniqueId);
    if (!found) throw new Error('no entity ' + uniqueId);
    return found;
}

const sent = (entityId, attributes) => layer.command(entityId, attributes).sent.map((p) => [p.topic, p.payload]);

beforeAll(async () => {
    lib = await haEntities.load();
});

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-entities-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    store = new StateStore();
    published = [];
    warnings = [];
    connected = true;
});

afterEach(async () => {
    if (layer) layer.stop();
    if (model) model.stop();
    layer = null;
    model = null;
    home.reset();
    homeEntities.reset();
    homeSandbox.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the library', () => {
    test('is an ES module that a CommonJS daemon imports once', async () => {
        expect(haEntities.get()).toBe(lib);
        expect(await haEntities.load()).toBe(lib);
        expect(typeof lib.createEntity).toBe('function');
        expect(lib.COMPONENTS).toEqual(expect.arrayContaining(['light', 'cover', 'climate']));
    });
});

describe('payloads from the state store', () => {
    test('a parsed value goes back as it is, a state object that was the payload as its JSON', () => {
        expect(payloadOf(undefined)).toBeUndefined();
        expect(payloadOf(parsePayload('ON'))).toBe('ON');
        expect(payloadOf(parsePayload('21.5'))).toBe(21.5);
        expect(payloadOf(parsePayload('true'))).toBe(true);
        expect(payloadOf(parsePayload('{"state":"ON","brightness":3}'))).toEqual({ state: 'ON', brightness: 3 });
        // {"val": …} is what the mqtt-smarthome adapters publish: `value_json.val` must find it
        expect(JSON.parse(payloadOf(parsePayload('{"val":true,"ts":5}')))).toEqual({ val: true, ts: 5 });
        // … and the mark does not show in the state object
        expect(parsePayload('{"val":true,"ts":5}')).toEqual({ val: true, ts: 5 });
        expect(Object.keys(parsePayload('{"val":1}'))).toEqual(['val']);
        expect(J(parsePayload('{"val":1}'))).toBe('{"val":1}');
    });

    test('a template over {"val": …} reads the state: a light of an mqtt-smarthome adapter', () => {
        withCorpus('device-based.json');
        const light = id('govee2mqtt_govee-bridge_h606a_0001_power');
        const base = 'govee-bridge/status/h606a_0001';
        feed(`${base}/power`, { val: true, ts: 1 });
        feed(`${base}/brightness`, { val: 40, ts: 1 });
        feed(`${base}/color`, { val: { r: 1, g: 2, b: 3 }, ts: 1 });
        expect(layer.state(light)).toEqual({ state: 'ON', brightness: 102, rgb: [1, 2, 3] });
        feed(`${base}/power`, { val: false, ts: 2 });
        expect(layer.state(light).state).toBe('OFF');
    });
});

describe('the entities of the home model', () => {
    test('every entity document with a config has a library entity; the corpus has 266', () => {
        withCorpus();
        expect(layer.ids().length).toBe(model.status().counts.entities);
        expect(layer.ids().length).toBe(266);
        for (const entityId of layer.ids()) {
            expect(entityId.startsWith('she/entity/')).toBe(true);
            // nothing has been said yet: no state, and nothing throws
            expect(layer.state(entityId)).toEqual({});
            expect(layer.describe(entityId).component).toBe(core.get(entityId).ha.component);
        }
        expect(warnings).toEqual([]);
    });

    test('resolve: a document id, its short form, a unique_id, a config topic, a topic of the entity', () => {
        withCorpus('zigbee2mqtt.json');
        const light = 'she/entity/0x00124b0000000001_light_zigbee2mqtt';
        expect(layer.resolve(light)).toBe(light);
        expect(layer.resolve('0x00124b0000000001_light_zigbee2mqtt')).toBe(light);
        expect(layer.resolve('homeassistant/light/0x00124b0000000001/light/config')).toBe(light);
        // the state topic is read by the light and by a dozen sensors: what can be commanded wins
        expect(layer.resolve('zigbee2mqtt/light_cellar_1')).toBe(light);
        expect(layer.resolve('zigbee2mqtt/light_cellar_1/set')).toBe(light);
        expect(layer.resolve('zigbee2mqtt/nothing')).toBeNull();
        expect(layer.resolve('')).toBeNull();
        expect(layer.resolve(undefined)).toBeNull();
        expect(layer.describe('she/entity/nope')).toBeNull();
        expect(layer.entity(light).component).toBe('light');
    });

    test('describe: what an entity tells and takes', () => {
        withCorpus('zigbee2mqtt.json');
        const what = layer.describe(id('0x00124b0000000001_light_zigbee2mqtt'));
        expect(what).toMatchObject({ component: 'light', supported: true, stateless: false, primary: 'state' });
        expect(Object.keys(what.attributes)).toEqual(['state', 'brightness', 'color_temp', 'xy', 'color_mode', 'effect']);
        expect(what.attributes.color_temp).toEqual({ read: true, write: true, unit: 'mired', min: 153, max: 500 });
        expect(what.topics.state).toEqual(['zigbee2mqtt/light_cellar_1']);
        expect(what.topics.command).toEqual(['zigbee2mqtt/light_cellar_1/set']);
    });

    test('a changed config replaces the entity, a cleared one removes it, a renamed room does neither', async () => {
        withCorpus('zigbee2mqtt.json');
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        const before = layer.entity(light);
        const changes = [];
        layer.on('config', (entityId) => changes.push(entityId));

        model.assign(light, { name: 'Cellar lamp' });
        expect(layer.entity(light)).toBe(before);
        expect(changes).toEqual([]);

        const topic = 'homeassistant/light/0x00124b0000000001/light/config';
        const config = JSON.parse(J(store.get('mqtt::' + topic)));
        config.command_topic = 'zigbee2mqtt/light_cellar_1/set2';
        feed(topic, config);
        model.noteConfig(topic, config);
        model.flush();
        expect(layer.entity(light)).not.toBe(before);
        expect(layer.describe(light).topics.command).toEqual(['zigbee2mqtt/light_cellar_1/set2']);
        expect(changes).toEqual([light]);

        core.del(light);
        expect(layer.entity(light)).toBeNull();
        expect(layer.resolve('zigbee2mqtt/light_cellar_1/set2')).toBeNull();
        expect(layer.state(light)).toEqual({});
        expect(layer.available(light)).toBe(false);
        expect(changes).toEqual([light, light]);
    });
});

describe('state and commands per component (the corpus)', () => {
    beforeEach(() => {
        withCorpus();
    });

    test('light, json schema (zigbee2mqtt)', () => {
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 102, color_mode: 'color_temp', color_temp: 370, color: { x: 0.4, y: 0.39 }, linkquality: 80 });
        expect(layer.state(light)).toEqual({ state: 'ON', brightness: 102, color_mode: 'color_temp', color_temp: 370, xy: [0.4, 0.39] });
        const snapshot = layer.snapshot(light);
        expect(sent(light, snapshot)).toEqual([['zigbee2mqtt/light_cellar_1/set', '{"state":"ON","brightness":102,"color_temp":370}']]);
        expect(sent(light, { state: 'OFF' })).toEqual([['zigbee2mqtt/light_cellar_1/set', '{"state":"OFF"}']]);
        expect(published.at(-1)[2]).toEqual({ retain: false, qos: 0 });
    });

    test('light, default schema with JSON state words and a hex colour (AWTRIX)', () => {
        const light = id('aa0000000008_mat');
        feed('awtrix/state/device', { matrixPower: true, brightness: 120 });
        feed('awtrix/state/settings', { textColor: '#A0B0C0' });
        expect(layer.state(light)).toEqual({ state: 'ON', brightness: 120, rgb: [160, 176, 192] });
        expect(sent(light, { state: 'ON', brightness: 128, rgb: [1, 2, 3] })).toEqual([
            ['awtrix/cmd/settings', '{"brightness":128}'],
            ['awtrix/cmd/settings', '{"textColor":[1,2,3]}'],
            ['awtrix/cmd/display', '{"power":true}'],
        ]);
    });

    test('light whose level is its on command (Tasmota): the present level is used', () => {
        const light = id('AABBCC_LI_1');
        feed('tele/tasmota_AABBCC/STATE', { POWER: 'OFF', Dimmer: 50, CT: 300, Color: '255,128,0,0,0', Scheme: 0 });
        expect(layer.state(light)).toEqual({ state: 'OFF', brightness: 128, color_temp: 300, rgb: [255, 128, 0], effect: '0' });
        expect(sent(light, { state: 'ON' })).toEqual([['cmnd/tasmota_AABBCC/Dimmer', '50']]);
    });

    test('switch and binary_sensor (ESPHome, plain payloads)', () => {
        const relay = layer.ids().find((e) => layer.describe(e).component === 'switch' && core.get(e).ha.config.state_topic?.startsWith('seedling/'));
        const { state_topic: stateTopic, command_topic: commandTopic } = core.get(relay).ha.config;
        feed(stateTopic, 'ON');
        expect(layer.state(relay)).toEqual({ state: 'ON' });
        expect(sent(relay, { state: 'OFF' })).toEqual([[commandTopic, 'OFF']]);
        const binary = layer.ids().find((e) => layer.describe(e).component === 'binary_sensor' && !core.get(e).ha.config.value_template);
        feed(core.get(binary).ha.config.state_topic, 'OFF');
        expect(layer.state(binary)).toEqual({ state: 'OFF' });
        expect(layer.command(binary, { state: 'ON' })).toEqual({ sent: [], problems: ['binary_sensor: state cannot be set'] });
    });

    test('cover with position and state on one topic (zigbee2mqtt), and one with a template (Shelly)', () => {
        const blind = id('0x00124b0000000002_cover_zigbee2mqtt');
        feed('zigbee2mqtt/blind_kitchen', { position: 30, state: 'OPEN' });
        expect(layer.state(blind)).toEqual({ position: 30, state: 'open' });
        expect(sent(blind, { position: 55 })).toEqual([['zigbee2mqtt/blind_kitchen/set', '{ "position": 55 }']]);
        expect(sent(blind, { state: 'closed' })).toEqual([['zigbee2mqtt/blind_kitchen/set', 'CLOSE']]);
        const shutter = id('shellyplus2pm-d4e5f6-cover_0');
        feed('shellyplus2pm-d4e5f6/status/cover:0', { state: 'opening', current_pos: 20 });
        expect(layer.state(shutter)).toEqual({ position: 20, state: 'opening' });
        expect(sent(shutter, { position: 70 })).toEqual([['shellyplus2pm-d4e5f6/command/cover:0', 'pos,70']]);
    });

    test('climate: a topic per attribute (ESPHome), numbers on the wire (Z-Wave JS UI)', () => {
        const thermostat = id('ESPclimatethermostat');
        const base = 'seedling/climate/thermostat';
        feed(`${base}/mode/state`, 'heat');
        feed(`${base}/target_temperature/state`, '21.5');
        feed(`${base}/current_temperature/state`, '20.1');
        expect(layer.state(thermostat)).toEqual({ mode: 'heat', temperature: 21.5, current_temperature: 20.1 });
        expect(layer.snapshot(thermostat)).toEqual({ mode: 'heat', temperature: 21.5 });
        expect(sent(thermostat, { mode: 'off', temperature: 18 })).toEqual([
            [`${base}/mode/command`, 'off'],
            [`${base}/target_temperature/command`, '18'],
        ]);
        const zwave = id('zwavejs2mqtt_0xd1e5f8a1_11-64-0-mode');
        feed('zwave/11/64/0/mode', { value: 1 });
        feed('zwave/11/67/0/setpoint/1', { value: 21 });
        expect(layer.state(zwave)).toEqual({ mode: 'heat', temperature: 21 });
        expect(sent(zwave, { mode: 'cool' })).toEqual([['zwave/11/64/0/mode/set', '2']]);
    });

    test('fan with a lookup table (zigbee2mqtt)', () => {
        const fan = id('0x00124b0000000003_fan_zigbee2mqtt');
        feed('zigbee2mqtt/starkvind', { fan_state: 'ON', fan_mode: '5' });
        expect(layer.state(fan)).toEqual({ state: 'ON', percentage: 55 });
        expect(sent(fan, { state: 'ON', percentage: 100 })).toEqual([
            ['zigbee2mqtt/starkvind/set/fan_state', 'ON'],
            ['zigbee2mqtt/starkvind/set/fan_mode', '9'],
        ]);
    });

    test('lock (Z-Wave JS UI)', () => {
        const lock = id('zwavejs2mqtt_0xd1e5f8a1_10-98-0-currentMode');
        feed('zwave/10/98/0/currentMode', { value: 255 });
        expect(layer.state(lock)).toEqual({ state: 'LOCKED' });
        expect(sent(lock, { state: 'UNLOCKED' })).toEqual([['zwave/10/98/0/targetMode/set', '0']]);
    });

    test('select and number with command templates (AWTRIX)', () => {
        feed('awtrix/state/settings', { autoBrightness: true, volume: 15 });
        expect(layer.state(id('aa0000000008_brimode'))).toEqual({ option: 'Auto' });
        expect(sent(id('aa0000000008_brimode'), { option: 'Manual' })).toEqual([['awtrix/cmd/settings', '{"autoBrightness":false}']]);
        expect(layer.state(id('aa0000000008_vol'))).toEqual({ value: 15 });
        expect(sent(id('aa0000000008_vol'), { value: 20 })).toEqual([['awtrix/cmd/settings', '{"volume":20}']]);
    });

    test('scene and button: triggered with nothing', () => {
        const scene = id('2_scene_1_zigbee2mqtt');
        expect(layer.describe(scene)).toMatchObject({ stateless: true, primary: null, attributes: {} });
        expect(sent(scene, {})).toEqual([['zigbee2mqtt/light_garden_group/set', '{ "scene_recall": 1 }']]);
        const button = layer.ids().find((e) => layer.describe(e).component === 'button');
        expect(layer.command(button).sent.length).toBe(1);
    });

    test('sensor: a number when it is one', () => {
        const sensor = layer.ids().find((e) => {
            const c = core.get(e).ha.config;
            return layer.describe(e).component === 'sensor' && c.unit_of_measurement && !c.value_template;
        });
        feed(core.get(sensor).ha.config.state_topic, '21.34');
        expect(layer.state(sensor)).toEqual({ value: 21.34 });
        expect(layer.describe(sensor).attributes.value.write).toBe(false);
    });
});

describe('availability and comparing', () => {
    beforeEach(() => {
        withCorpus('zigbee2mqtt.json', 'esphome.json');
    });

    test('available: true, false, or undefined while nothing was said', () => {
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        expect(layer.available(light)).toBeUndefined();
        feed('zigbee2mqtt/bridge/state', { state: 'online' });
        feed('zigbee2mqtt/light_cellar_1/availability', { state: 'online' });
        expect(layer.available(light)).toBe(true);
        feed('zigbee2mqtt/light_cellar_1/availability', { state: 'offline' });
        expect(layer.available(light)).toBe(false);
        const thermostat = id('ESPclimatethermostat');
        feed('seedling/status', 'online');
        expect(layer.available(thermostat)).toBe(true);
    });

    test('compare: tolerances, what is unknown, and an entity that is offline never matches', () => {
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        const expected = { state: 'ON', brightness: 102 };
        expect(layer.compare(light, expected)).toEqual({ match: false, available: undefined, unknown: ['state', 'brightness'], mismatches: [], state: {} });
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 101 });
        expect(layer.compare(light, expected)).toMatchObject({ match: true, unknown: [], mismatches: [] });
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 80 });
        expect(layer.compare(light, expected)).toMatchObject({ match: false, mismatches: [{ attribute: 'brightness', expected: 102, actual: 80 }] });
        expect(layer.compare(light, expected, { tolerances: { brightness: 30 } }).match).toBe(true);
        feed('zigbee2mqtt/bridge/state', { state: 'offline' });
        feed('zigbee2mqtt/light_cellar_1/availability', { state: 'online' });
        expect(layer.compare(light, expected, { tolerances: { brightness: 30 } })).toMatchObject({ match: false, available: false, mismatches: [] });
        expect(layer.compare('she/entity/nope', expected)).toEqual({ match: false, available: false, unknown: ['state', 'brightness'], mismatches: [], state: {} });
    });
});

describe('commands', () => {
    beforeEach(() => {
        withCorpus('zigbee2mqtt.json');
    });

    test('what cannot be set is a problem, not an exception; a dry run sends nothing', () => {
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        expect(layer.command(light, { state: 'ON', volume: 3 })).toEqual({
            sent: [{ topic: 'zigbee2mqtt/light_cellar_1/set', payload: '{"state":"ON"}', retain: false, qos: 0 }],
            problems: ['light: volume cannot be set'],
        });
        expect(published.length).toBe(1);
        expect(layer.command(light, { state: 'OFF' }, { dryRun: true }).sent.length).toBe(1);
        expect(published.length).toBe(1);
        expect(layer.command(light, 'ON')).toEqual({ sent: [], problems: ['the attributes are not an object'] });
        expect(layer.command('she/entity/nope', {})).toEqual({ sent: [], problems: ['she/entity/nope: no such entity'] });
    });

    test('without a broker connection nothing is sent, and the result says so', () => {
        connected = false;
        const light = id('0x00124b0000000001_light_zigbee2mqtt');
        expect(layer.command(light, { state: 'ON' })).toEqual({ sent: [], problems: ['not connected to the broker: nothing more was sent'] });
    });
});

describe('change notifications', () => {
    const light = 'she/entity/0x00124b0000000001_light_zigbee2mqtt';
    const linkquality = 'she/entity/0x00124b0000000001_linkquality_zigbee2mqtt';

    beforeEach(() => {
        withCorpus('zigbee2mqtt.json');
    });

    test('a watcher hears a change of its entity once, with the state before', () => {
        const calls = [];
        const stop = layer.watch(light, (entityId, now, before) => calls.push([entityId, now, before]));
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 102, linkquality: 80 });
        expect(calls).toEqual([[light, { state: { state: 'ON', brightness: 102 }, available: undefined, present: true }, { state: {}, present: true }]]);
        // the same light, another link quality: nothing for the light
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 102, linkquality: 60 });
        expect(calls.length).toBe(1);
        feed('zigbee2mqtt/light_cellar_1', { state: 'OFF', brightness: 102, linkquality: 60 });
        expect(calls.length).toBe(2);
        expect(calls[1][1].state.state).toBe('OFF');
        expect(calls[1][2].state.state).toBe('ON');
        stop();
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 1 });
        expect(calls.length).toBe(2);
    });

    test('availability is part of what is watched; a cleared topic too', () => {
        const calls = [];
        layer.watch(light, (entityId, now) => calls.push(now.available));
        feed('zigbee2mqtt/bridge/state', { state: 'online' });
        expect(calls).toEqual([]); // one of two topics: still unknown
        feed('zigbee2mqtt/light_cellar_1/availability', { state: 'online' });
        feed('zigbee2mqtt/light_cellar_1/availability', { state: 'offline' });
        feed('zigbee2mqtt/light_cellar_1/availability', '');
        expect(calls).toEqual([true, false, undefined]);
    });

    test('a watcher of everything hears every entity that reads the topic', () => {
        const heard = [];
        const stop = layer.watch(null, (entityId) => heard.push(entityId));
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', linkquality: 80 });
        expect(heard).toContain(light);
        expect(heard).toContain(linkquality);
        const n = heard.length;
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', linkquality: 80 });
        expect(heard.length).toBe(n);
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', linkquality: 81 });
        expect(heard.slice(n)).toEqual([linkquality]);
        stop();
        feed('zigbee2mqtt/light_cellar_1', { state: 'OFF', linkquality: 1 });
        expect(heard.length).toBe(n + 1);
    });

    test('an entity that goes is told as not present; a failing watcher stops nobody', () => {
        const calls = [];
        layer.watch(light, () => {
            throw new Error('boom');
        });
        layer.watch(light, (entityId, now) => calls.push(now));
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON' });
        expect(calls.length).toBe(1);
        expect(warnings).toEqual([`home model: a watcher of ${light} failed: boom`]);
        core.del(light);
        expect(calls[1]).toEqual({ state: {}, available: false, present: false });
    });

    test('nobody watching: a message costs a lookup, nothing is read', () => {
        const entity = layer.entity(light);
        const spy = jest.spyOn(entity, 'readState');
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON' });
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('she.home.entity()', () => {
    let she, unload;

    /** the she.home of one script, as loadScript() builds it */
    function sandbox() {
        she = {};
        unload = [];
        homeSandbox(she, { scriptDomain: domain.create(), store, onUnload: (fn) => unload.push(fn), warn: (m) => warnings.push(m) });
        return she;
    }

    /** the daemon's wiring: the model and the layer behind the web modules */
    function daemon(...files) {
        const names = files.length ? files : ['zigbee2mqtt.json'];
        for (const name of names) {
            for (const m of JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))) feed(m.topic, m.payload);
        }
        model = home.init({ core, store, log: noop });
        model.enable({ language: 'en' });
        home.start({ authoritative: true });
        homeEntities.init({
            core,
            store,
            log: noop,
            publish: (topic, payload) => {
                published.push([topic, payload]);
                return true;
            },
        });
        layer = homeEntities.getLayer();
        return sandbox();
    }

    test('needs the home model; null for an entity nobody announced', () => {
        expect(homeEntities.getLayer()).toBeNull();
        expect(() => sandbox().home.entity('anything')).toThrow(/needs sheDB/);
        daemon();
        expect(she.home.entity('nope')).toBeNull();
        expect(typeof she.home.rooms).toBe('function');
    });

    test('the summary, the state and the commands of a light', () => {
        daemon();
        model.assign('she/entity/0x00124b0000000001_light_zigbee2mqtt', { name: 'Cellar lamp' });
        const lamp = she.home.entity('zigbee2mqtt/light_cellar_1');
        expect(lamp).toMatchObject({
            id: 'she/entity/0x00124b0000000001_light_zigbee2mqtt',
            name: 'Cellar lamp',
            component: 'light',
            device: 'she/device/zigbee2mqtt_0x00124b0000000001',
            source: 'ha',
            state_topic: 'zigbee2mqtt/light_cellar_1',
            command_topic: 'zigbee2mqtt/light_cellar_1/set',
            present: true,
            hidden: false,
            supported: true,
            stateless: false,
            primary: 'state',
        });
        expect(Array.isArray(lamp.rooms)).toBe(true);
        expect(lamp.functions).toEqual(['lighting']);
        expect(lamp.attributes.brightness).toEqual({ read: true, write: true, min: 0, max: 255 });

        expect(lamp.state()).toEqual({});
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON', brightness: 102 });
        expect(lamp.state()).toEqual({ state: 'ON', brightness: 102 });
        expect(lamp.snapshot()).toEqual({ state: 'ON', brightness: 102 });
        expect(lamp.matches({ state: 'ON', brightness: 100 }).match).toBe(true);
        expect(lamp.available()).toBeUndefined();

        // the lamp counts to 254
        expect(lamp.turnOn({ brightness: 128 })).toEqual([{ topic: 'zigbee2mqtt/light_cellar_1/set', payload: '{"state":"ON","brightness":127}', retain: false, qos: 0 }]);
        lamp.turnOff();
        lamp.set({ color_temp: 300 });
        expect(published.map((p) => p[1])).toEqual(['{"state":"ON","brightness":127}', '{"state":"OFF"}', '{"state":"ON","color_temp":300}']);
        expect(warnings).toEqual([]);
    });

    test('a command the entity cannot take is said in the script log, and nothing is sent', () => {
        daemon();
        const lamp = she.home.entity('0x00124b0000000001_light_zigbee2mqtt');
        expect(lamp.setPosition(30)).toEqual([]);
        expect(lamp.setTemperature(21)).toEqual([]);
        expect(lamp.trigger()).toEqual([]);
        lamp.set({ volume: 3 });
        expect(published).toEqual([]);
        expect(warnings).toEqual([
            "she.home.entity('0x00124b0000000001_light_zigbee2mqtt').setPosition(): a light entity has no position",
            "she.home.entity('0x00124b0000000001_light_zigbee2mqtt').setTemperature(): a light entity has no temperature",
            "she.home.entity('0x00124b0000000001_light_zigbee2mqtt').trigger(): a light entity is not triggered, it is set",
            "she.home.entity('0x00124b0000000001_light_zigbee2mqtt'): light: volume cannot be set",
        ]);
        const sensor = she.home.entity('0x00124b0000000001_linkquality_zigbee2mqtt');
        expect(sensor.turnOn()).toEqual([]);
        expect(warnings.at(-1)).toMatch(/turnOn\(\): a sensor entity has no state/);
    });

    test('cover, thermostat, scene: the convenience commands', () => {
        daemon('zigbee2mqtt.json', 'esphome.json');
        const blind = she.home.entity('0x00124b0000000002_cover_zigbee2mqtt');
        blind.setPosition(30);
        blind.turnOn();
        blind.turnOff();
        she.home.entity('ESPclimatethermostat').setTemperature(21);
        she.home.entity('2_scene_1_zigbee2mqtt').trigger();
        she.home.entity('2_scene_1_zigbee2mqtt').turnOn();
        expect(she.home.entities({ component: 'cover' })[0].id).toBe(blind.id);
        expect(published).toEqual([
            ['zigbee2mqtt/blind_kitchen/set', '{ "position": 30 }'],
            ['zigbee2mqtt/blind_kitchen/set', 'OPEN'],
            ['zigbee2mqtt/blind_kitchen/set', 'CLOSE'],
            ['seedling/climate/thermostat/target_temperature/command', '21'],
            ['zigbee2mqtt/light_garden_group/set', '{ "scene_recall": 1 }'],
            ['zigbee2mqtt/light_garden_group/set', '{ "scene_recall": 1 }'],
        ]);
        expect(warnings).toEqual([]);
    });

    test('a lock is locked and unlocked by name, never by turning something on', () => {
        daemon('zwave-js-ui.json');
        const lock = she.home.entity('zwavejs2mqtt_0xd1e5f8a1_10-98-0-currentMode');
        expect(lock.turnOn()).toEqual([]);
        expect(lock.turnOff()).toEqual([]);
        expect(published).toEqual([]);
        expect(warnings.length).toBe(2);
        expect(warnings[0]).toMatch(/a lock is not turned on or off/);
        lock.set({ state: 'UNLOCKED' });
        expect(published).toEqual([['zwave/10/98/0/targetMode/set', '0']]);
    });

    test('sub: the script hears changes until it is unloaded', () => {
        daemon();
        const lamp = she.home.entity('0x00124b0000000001_light_zigbee2mqtt');
        const calls = [];
        lamp.sub((now, before) => calls.push([now.state, before.state]));
        expect(() => lamp.sub('no function')).toThrow(TypeError);
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON' });
        expect(calls).toEqual([[{ state: 'ON' }, {}]]);
        feed('zigbee2mqtt/light_cellar_1', { state: 'OFF' });
        expect(calls.length).toBe(2);
        for (const fn of unload) fn();
        feed('zigbee2mqtt/light_cellar_1', { state: 'ON' });
        expect(calls.length).toBe(2);
    });
});
