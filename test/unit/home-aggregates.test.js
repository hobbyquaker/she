'use strict';

/**
 * The aggregates of rooms, floors and the house (src/lib/home-aggregates.js, home-aggregate-rules.js),
 * the view she/rooms/aggregates, and their announcement through discovery — on a real sheDB core,
 * the home model, the entity layer and the announcer, with what is published fed back into the
 * state store as the broker would.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const parsePayload = require('../../src/lib/parse-payload');
const { HomeModel } = require('../../src/lib/home-model');
const { HomeEntities } = require('../../src/lib/home-entities');
const { HomeAggregates, contribution, combine, convert } = require('../../src/lib/home-aggregates');
const rules = require('../../src/lib/home-aggregate-rules');
const views = require('../../src/lib/home-views');
const { compileView, runView } = require('../../src/lib/shedb-view');
const { createAnnouncer } = require('../../src/lib/announce');
const haEntities = require('../../src/lib/ha-entities');
const homeEntities = require('../../src/web/home-entities');
const homeAggregates = require('../../src/web/home-aggregates');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const J = JSON.stringify;
const E = (uid) => 'she/entity/' + uid;

let lib, tmpDir, core, store, model, layer, announcer, agg, published, connected, clock, warnings;

/** a message as the daemon stores it */
function feed(topic, payload) {
    const text = typeof payload === 'string' ? payload : J(payload);
    if (text === '') return store.delete('mqtt::' + topic);
    const state = parsePayload(text);
    if (!state.ts) state.ts = clock;
    if (state.lc === undefined) state.lc = state.ts;
    store.setObject('mqtt::' + topic, state);
}

/** publish as the daemon does: to the broker, which sends it back */
function publish(topic, payload) {
    if (!connected) return false;
    published.push([topic, payload]);
    feed(topic, payload);
    return true;
}

const device = (id, name, area) => ({ identifiers: [id], name, ...(area ? { suggested_area: area } : {}) });
const config = (component, node, object, cfg) => feed(`homeassistant/${component}/${node}/${object}/config`, { unique_id: `${node}_${object}`, ...cfg });

/** a house: a living room and a kitchen on the ground floor, a bedroom upstairs, a sensor outside every room */
function house() {
    const wz = 'Wohnzimmer';
    config('light', 'l1', 'light', { name: null, state_topic: 'l1', command_topic: 'l1/set', device: device('l1', 'Ceiling', wz) });
    config('light', 'l2', 'light', { name: null, state_topic: 'l2', command_topic: 'l2/set', availability_topic: 'l2/online', device: device('l2', 'Floor lamp', wz) });
    config('switch', 's1', 'plug', { name: null, state_topic: 's1', command_topic: 's1/set', device: device('s1', 'Fairy lights', wz) });
    config('switch', 's2', 'plug', { name: null, state_topic: 's2', command_topic: 's2/set', device: device('s2', 'Aquarium pump', wz) });
    config('binary_sensor', 'w1', 'contact', { name: 'Contact', state_topic: 'w1', device_class: 'window', device: device('w1', 'Window', wz) });
    config('cover', 'c1', 'cover', { name: null, state_topic: 'c1', command_topic: 'c1/set', device_class: 'shutter', device: device('c1', 'Shutter', wz) });
    config('cover', 'c2', 'cover', { name: null, state_topic: 'c2', command_topic: 'c2/set', device_class: 'door', device: device('c2', 'Patio door', wz) });
    config('sensor', 't1', 'temperature', {
        name: 'Temperature',
        state_topic: 't1',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        device: device('t1', 'Climate one', wz),
    });
    config('sensor', 't1', 'humidity', { name: 'Humidity', state_topic: 't1h', device_class: 'humidity', unit_of_measurement: '%', device: device('t1', 'Climate one', wz) });
    config('sensor', 't2', 'temperature', {
        name: 'Temperature',
        state_topic: 't2',
        device_class: 'temperature',
        unit_of_measurement: '°F',
        device: device('t2', 'Climate two', wz),
    });
    config('sensor', 't2', 'devtemp', {
        name: 'Device temperature',
        state_topic: 't2d',
        device_class: 'temperature',
        entity_category: 'diagnostic',
        device: device('t2', 'Climate two', wz),
    });
    config('binary_sensor', 'o1', 'occupancy', { name: 'Occupancy', state_topic: 'o1', device_class: 'occupancy', device: device('o1', 'Radar', wz) });
    config('binary_sensor', 'm1', 'motion', { name: 'Motion', state_topic: 'm1', device_class: 'motion', device: device('m1', 'PIR', wz) });
    config('sensor', 'p1', 'power', { name: 'Power', state_topic: 'p1', device_class: 'power', unit_of_measurement: 'W', device: device('p1', 'TV plug', wz) });
    config('sensor', 'p2', 'power', { name: 'Power', state_topic: 'p2', device_class: 'power', unit_of_measurement: 'kW', device: device('p2', 'Heater', wz) });
    config('sensor', 'p2', 'energy', { name: 'Energy', state_topic: 'p2e', device_class: 'energy', unit_of_measurement: 'kWh', device: device('p2', 'Heater', wz) });
    // the kitchen, and the hallway light that serves both rooms
    config('light', 'l3', 'light', { name: null, state_topic: 'l3', command_topic: 'l3/set', device: device('l3', 'Worktop', 'Küche') });
    config('light', 'l4', 'light', { name: null, state_topic: 'l4', command_topic: 'l4/set', device: device('l4', 'Hallway') });
    config('sensor', 't3', 'temperature', {
        name: 'Temperature',
        state_topic: 't3',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        device: device('t3', 'Fridge', 'Küche'),
    });
    // upstairs
    config('sensor', 't4', 'temperature', {
        name: 'Temperature',
        state_topic: 't4',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        device: device('t4', 'Bedroom climate', 'Schlafzimmer'),
    });
    // in no room
    config('sensor', 'p3', 'power', { name: 'Power', state_topic: 'p3', device_class: 'power', unit_of_measurement: 'W', device: device('p3', 'Grid meter') });

    model = new HomeModel({ core, entries: () => store.mqttEntries(), log: noop, goneDelay: 0, now: () => clock });
    model.enable({ language: 'en' });
    model.start({ authoritative: true });
    store.on('change', (key, val) => key.startsWith('mqtt::homeassistant/') && model.noteConfig(key.slice(6), val));
    store.on('delete', (key) => key.startsWith('mqtt::homeassistant/') && model.noteConfig(key.slice(6), null));
    model.createFloor({ id: 'ground', name: 'Erdgeschoss', level: 0 });
    model.createFloor({ id: 'upper', name: 'Obergeschoss', level: 1 });
    model.updateRoom('wohnzimmer', { floor: 'ground' });
    model.updateRoom('kueche', { floor: 'ground' });
    model.updateRoom('schlafzimmer', { floor: 'upper' });
    model.assign(E('s1_plug'), { functions: ['lighting'] });
    model.assign(E('l4_light'), { rooms: ['wohnzimmer', 'kueche'] });

    layer = new HomeEntities({ lib, core, store, log: { ...noop, warn: (m) => warnings.push(m) }, publish: () => true });
    announcer = createAnnouncer({ prefix: 'homeassistant', instance: 'she', origin: { name: 'she', sw_version: '0.0.0' }, publish, graceMs: 0, defer: (fn) => fn() });
    return aggregates();
}

function aggregates(opts = {}) {
    agg = new HomeAggregates({
        core,
        layer,
        publish,
        announce: (cfg) => announcer.announce('\0home-aggregates', 'home', cfg),
        retained: {
            get: (topic) => store.getObject('mqtt::' + topic),
            topics: function* () {
                for (const [topic] of store.mqttEntries()) yield topic;
            },
        },
        instance: 'she',
        log: { ...noop, warn: (m) => warnings.push(m) },
        now: () => clock,
        debounce: 60000,
        ...opts,
    });
    return agg;
}

const immediate = () => new Promise((resolve) => setImmediate(resolve));

/** let the model follow (its own announcements included), then publish what changed */
async function settle() {
    for (let i = 0; i < 3; i++) {
        await immediate();
        model.flush();
        await immediate();
        agg.flush();
    }
}

/** the retained payload of an aggregate */
function at(path) {
    const obj = store.getObject('mqtt::she/status/' + path);
    return obj ? JSON.parse(J(obj)) : undefined;
}

const val = (path) => at(path)?.val;
const members = (path) => Object.fromEntries(at(path).members.map((m) => [m.id.slice('she/entity/'.length), m.val]));
const topicsPublished = () => published.filter(([t]) => t.startsWith('she/status/')).map(([t]) => t.slice('she/status/'.length));

beforeAll(async () => {
    lib = await haEntities.load();
});

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-aggregates-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    store = new StateStore();
    published = [];
    warnings = [];
    connected = true;
    clock = 1000;
});

afterEach(async () => {
    if (agg) agg.stop();
    if (announcer) announcer.stop();
    if (layer) layer.stop();
    if (model) model.stop();
    agg = announcer = layer = model = null;
    homeAggregates.reset();
    homeEntities.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the rules', () => {
    const entity = (component, device_class, functions, more = {}) => ({
        kind: 'entity',
        ha: { component, device_class, unique_id: 'x', ...more.ha },
        eff: { functions, hidden: false, ...more.eff },
    });

    test('which entity counts in which aggregate', () => {
        expect(rules.aggregatesOf(entity('light', null, ['lighting']))).toEqual(['light', 'lights']);
        expect(rules.aggregatesOf(entity('switch', null, ['lighting']))).toEqual(['light', 'lights']);
        expect(rules.aggregatesOf(entity('switch', null, []))).toEqual([]);
        expect(rules.aggregatesOf(entity('select', null, ['lighting']))).toEqual([]);
        expect(rules.aggregatesOf(entity('binary_sensor', 'window', ['openings']))).toEqual(['open']);
        expect(rules.aggregatesOf(entity('cover', 'garage', ['openings']))).toEqual(['open']);
        expect(rules.aggregatesOf(entity('cover', 'shutter', ['shading']))).toEqual([]);
        expect(rules.aggregatesOf(entity('sensor', 'temperature', ['climate']))).toEqual(['temperature']);
        expect(rules.aggregatesOf(entity('sensor', 'temperature', ['heating']))).toEqual([]);
        expect(rules.aggregatesOf(entity('sensor', 'humidity', ['climate']))).toEqual(['humidity']);
        expect(rules.aggregatesOf(entity('sensor', 'pm25', ['climate']))).toEqual([]);
        expect(rules.aggregatesOf(entity('binary_sensor', 'occupancy', ['security']))).toEqual(['occupied']);
        expect(rules.aggregatesOf(entity('binary_sensor', 'presence', []))).toEqual(['occupied']);
        expect(rules.aggregatesOf(entity('binary_sensor', 'motion', ['security', 'openings']))).toEqual(['open', 'occupied']);
        expect(rules.aggregatesOf(entity('sensor', 'power', ['energy']))).toEqual(['power']);
        expect(rules.aggregatesOf(entity('sensor', 'energy', ['energy']))).toEqual([]);
    });

    test('hidden, gone and the aggregates themselves never count', () => {
        expect(rules.aggregatesOf(entity('light', null, ['lighting'], { eff: { hidden: true } }))).toEqual([]);
        expect(rules.aggregatesOf(entity('light', null, ['lighting'], { ha: { present: false } }))).toEqual([]);
        expect(rules.aggregatesOf(entity('sensor', 'temperature', ['climate'], { ha: { unique_id: 'she_she_room_kueche_temperature' } }))).toEqual([]);
        expect(rules.isAggregateEntity({ ha: { unique_id: 'she_lab_home_power' } })).toBe(true);
        expect(rules.isAggregateEntity({ ha: { unique_id: 'she_she_floor_ground_occupied' } })).toBe(true);
        expect(rules.isAggregateEntity({ ha: { unique_id: 'she_she_script_garden_light' } })).toBe(false);
        expect(rules.isAggregateEntity({ ha: { unique_id: null } })).toBe(false);
        expect(rules.aggregatesOf(null)).toEqual([]);
        expect(rules.aggregatesOf({ kind: 'room' })).toEqual([]);
    });

    test('the setting of a room: off, or with entities left out', () => {
        expect(rules.aggregateSetting(null, 'light')).toEqual({ enabled: true, exclude: [] });
        expect(rules.aggregateSetting({ aggregates: { light: false } }, 'light')).toEqual({ enabled: false, exclude: [] });
        expect(rules.aggregateSetting({ aggregates: { light: { enabled: false } } }, 'light').enabled).toBe(false);
        expect(rules.aggregateSetting({ aggregates: { light: { exclude: ['a', 7] } } }, 'light')).toEqual({ enabled: true, exclude: ['a'] });
        // a lamp left out of "is a light on" is not counted either
        expect(rules.aggregateSetting({ aggregates: { light: { exclude: ['a'] }, lights: { exclude: ['b'] } } }, 'lights')).toEqual({ enabled: true, exclude: ['b', 'a'] });
        expect(rules.aggregateSetting({ aggregates: 'nonsense' }, 'power')).toEqual({ enabled: true, exclude: [] });
    });

    test('what an entity contributes', () => {
        const light = { component: 'light', unit: null };
        expect(contribution('light', light, { state: 'ON' })).toBe(true);
        expect(contribution('light', light, { state: 'OFF' })).toBe(false);
        expect(contribution('light', light, {})).toBeNull();
        const cover = { component: 'cover', unit: null };
        expect(contribution('open', cover, { state: 'closed', position: 0 })).toBe(false);
        expect(contribution('open', cover, { state: 'open', position: 30 })).toBe(true);
        expect(contribution('open', cover, { state: 'opening' })).toBe(true);
        expect(contribution('open', cover, { position: 0 })).toBe(false);
        expect(contribution('open', cover, {})).toBeNull();
        expect(contribution('open', { component: 'binary_sensor' }, { state: 'ON' })).toBe(true);
        expect(contribution('temperature', { unit: '°C' }, { value: '21.5' })).toBe(21.5);
        expect(contribution('temperature', { unit: '°C' }, { value: 'unavailable' })).toBeNull();
        expect(contribution('temperature', { unit: '°C' }, { value: '' })).toBeNull();
        expect(contribution('power', { unit: 'kW' }, { value: 1.5 })).toBe(1500);
        expect(convert('temperature', 68, '°F')).toBeCloseTo(20);
        expect(convert('temperature', 293.15, 'K')).toBeCloseTo(20);
        expect(convert('power', 250, 'mW')).toBe(0.25);
        expect(convert('humidity', 50, '%')).toBe(50);
    });

    test('how contributions combine', () => {
        expect(combine('light', [false, true, null])).toEqual({ val: true });
        expect(combine('light', [false, null])).toEqual({ val: false });
        expect(combine('light', [null, null])).toEqual({ val: null });
        expect(combine('lights', [true, true, false, null])).toEqual({ val: 2 });
        expect(combine('lights', [null])).toEqual({ val: null });
        expect(combine('temperature', [20, 21, 23.5, null])).toEqual({ val: 21.5, min: 20, max: 23.5, unit: '°C' });
        expect(combine('temperature', [20.111, 20.222])).toEqual({ val: 20.17, min: 20.11, max: 20.22, unit: '°C' });
        expect(combine('humidity', [])).toEqual({ val: null, min: null, max: null, unit: '%' });
        expect(combine('power', [100.04, 1500, null])).toEqual({ val: 1600, unit: 'W' });
        expect(combine('power', [null])).toEqual({ val: null, unit: 'W' });
    });
});

describe('each aggregate', () => {
    beforeEach(async () => {
        house();
        agg.start();
        await settle();
        published.length = 0;
    });

    test('what is computed from what', () => {
        expect(agg.plan()['room/wohnzimmer']).toEqual({
            light: [E('l1_light'), E('s1_plug'), E('l2_light'), E('l4_light')],
            lights: [E('l1_light'), E('s1_plug'), E('l2_light'), E('l4_light')],
            open: [E('c2_cover'), E('w1_contact')],
            temperature: [E('t1_temperature'), E('t2_temperature')],
            humidity: [E('t1_humidity')],
            occupied: [E('m1_motion'), E('o1_occupancy')],
            power: [E('p2_power'), E('p1_power')],
        });
        expect(agg.plan()['room/kueche']).toEqual({ light: [E('l4_light'), E('l3_light')], lights: [E('l4_light'), E('l3_light')], temperature: [E('t3_temperature')] });
        expect(Object.keys(agg.plan()).sort()).toEqual(['floor/ground', 'floor/upper', 'home', 'room/kueche', 'room/schlafzimmer', 'room/wohnzimmer']);
        expect(agg.plan()['floor/upper']).toEqual({ temperature: [E('t4_temperature')] });
        expect(agg.plan().home.power).toEqual([E('p3_power'), E('p2_power'), E('p1_power')]);
    });

    test('before anything has reported: null, with every member listed', () => {
        expect(at('room/wohnzimmer/light')).toEqual({
            val: null,
            ts: 1000,
            lc: 1000,
            members: [
                { id: E('l1_light'), name: 'Ceiling', val: null },
                { id: E('s1_plug'), name: 'Fairy lights', val: null },
                { id: E('l2_light'), name: 'Floor lamp', val: null },
                { id: E('l4_light'), name: 'Hallway', val: null },
            ],
        });
        expect(at('room/wohnzimmer/temperature')).toMatchObject({ val: null, min: null, max: null, unit: '°C' });
        expect(val('room/wohnzimmer/power')).toBeNull();
        // an aggregate nothing counts in is not published
        expect(at('room/kueche/open')).toBeUndefined();
        expect(at('room/schlafzimmer/light')).toBeUndefined();
    });

    test('light and lights: lights and the switches that are lighting', async () => {
        feed('l1', 'OFF');
        feed('s2', 'ON'); // a switch that is not lighting
        clock = 2000;
        await settle();
        expect(at('room/wohnzimmer/light')).toMatchObject({ val: false, ts: 2000, lc: 2000 });
        expect(val('room/wohnzimmer/lights')).toBe(0);

        feed('l1', 'ON');
        feed('s1', 'ON');
        clock = 3000;
        await settle();
        expect(at('room/wohnzimmer/light')).toMatchObject({ val: true, ts: 3000, lc: 3000 });
        expect(at('room/wohnzimmer/lights')).toMatchObject({ val: 2, lc: 3000 });
        expect(members('room/wohnzimmer/lights')).toEqual({ l1_light: true, s1_plug: true, l2_light: null, l4_light: null });

        // one more: the count changes, "a light is on" does not — its lc stays
        feed('l2', 'ON');
        feed('l2/online', 'online');
        clock = 4000;
        await settle();
        expect(at('room/wohnzimmer/light')).toMatchObject({ val: true, ts: 4000, lc: 3000 });
        expect(at('room/wohnzimmer/lights')).toMatchObject({ val: 3, ts: 4000, lc: 4000 });

        // a lamp that goes offline is not on
        feed('l2/online', 'offline');
        await settle();
        expect(val('room/wohnzimmer/lights')).toBe(2);
        expect(members('room/wohnzimmer/lights').l2_light).toBeNull();
    });

    test('open: contacts and the covers that are openings', async () => {
        feed('w1', 'OFF');
        feed('c1', 'open'); // a shutter is shading, not an opening
        feed('c2', 'closed');
        await settle();
        expect(val('room/wohnzimmer/open')).toBe(false);
        feed('c2', 'open');
        await settle();
        expect(at('room/wohnzimmer/open')).toMatchObject({ val: true });
        expect(members('room/wohnzimmer/open')).toEqual({ c2_cover: true, w1_contact: false });
        feed('c2', 'closed');
        feed('w1', 'ON');
        await settle();
        expect(members('room/wohnzimmer/open')).toEqual({ c2_cover: false, w1_contact: true });
        expect(val('home/open')).toBe(true);
    });

    test('temperature and humidity: the mean, with min, max and the members', async () => {
        feed('t1', '21.5');
        feed('t2d', '45'); // the device's own temperature is diagnostic
        await settle();
        expect(at('room/wohnzimmer/temperature')).toMatchObject({ val: 21.5, min: 21.5, max: 21.5, unit: '°C' });
        feed('t2', '68'); // °F
        feed('t1h', '48');
        await settle();
        expect(at('room/wohnzimmer/temperature')).toEqual({
            val: 20.75,
            ts: 1000,
            lc: 1000,
            min: 20,
            max: 21.5,
            unit: '°C',
            members: [
                { id: E('t1_temperature'), name: 'Climate one Temperature', val: 21.5 },
                { id: E('t2_temperature'), name: 'Climate two Temperature', val: 20 },
            ],
        });
        expect(at('room/wohnzimmer/humidity')).toMatchObject({ val: 48, min: 48, max: 48, unit: '%' });
        // a sensor that says nonsense does not count
        feed('t1', 'unknown');
        await settle();
        expect(at('room/wohnzimmer/temperature')).toMatchObject({ val: 20, min: 20, max: 20 });
    });

    test('occupied: occupancy, presence and motion sensors', async () => {
        feed('o1', 'OFF');
        feed('m1', 'OFF');
        await settle();
        expect(val('room/wohnzimmer/occupied')).toBe(false);
        feed('m1', 'ON');
        await settle();
        expect(val('room/wohnzimmer/occupied')).toBe(true);
        expect(val('floor/ground/occupied')).toBe(true);
        expect(val('home/occupied')).toBe(true);
        expect(at('floor/upper/occupied')).toBeUndefined();
    });

    test('power: the sum, in watts', async () => {
        feed('p1', '112.5');
        feed('p2', '1.5'); // kW
        feed('p2e', '300');
        feed('p3', '2000');
        await settle();
        expect(at('room/wohnzimmer/power')).toMatchObject({ val: 1612.5, unit: 'W' });
        expect(members('room/wohnzimmer/power')).toEqual({ p2_power: 1500, p1_power: 112.5 });
        // the house also counts what is in no room
        expect(val('home/power')).toBe(3612.5);
        expect(val('floor/ground/power')).toBe(1612.5);
    });

    test('an entity in two rooms counts in each, and once on the floor and in the house', async () => {
        feed('l4', 'ON');
        feed('l1', 'OFF');
        feed('l3', 'OFF');
        await settle();
        expect(val('room/wohnzimmer/light')).toBe(true);
        expect(val('room/kueche/light')).toBe(true);
        expect(val('room/wohnzimmer/lights')).toBe(1);
        expect(val('room/kueche/lights')).toBe(1);
        expect(val('floor/ground/lights')).toBe(1);
        expect(val('home/lights')).toBe(1);
        expect(at('floor/ground/lights').members.filter((m) => m.id === E('l4_light'))).toHaveLength(1);
        expect(at('floor/upper/light')).toBeUndefined();
    });

    test('a sensor left out of a room is left out of its floor and the house; an aggregate can be switched off', async () => {
        feed('t1', '21');
        feed('t2', '68');
        feed('t3', '5'); // the fridge
        feed('t4', '18');
        feed('t1h', '50');
        await settle();
        expect(val('room/kueche/temperature')).toBe(5);
        expect(at('floor/ground/temperature')).toMatchObject({ val: 15.33, min: 5, max: 21 });
        expect(at('home/temperature')).toMatchObject({ val: 16, min: 5, max: 21 });
        published.length = 0;

        model.updateRoom('kueche', { aggregates: { temperature: { exclude: [E('t3_temperature')] } } });
        model.updateRoom('wohnzimmer', { aggregates: { humidity: false, temperature: { exclude: [E('t2_temperature')] } } });
        await settle();
        // the kitchen has no temperature any more: its topic is cleared
        expect(at('room/kueche/temperature')).toBeUndefined();
        expect(published).toContainEqual(['she/status/room/kueche/temperature', '']);
        expect(at('room/wohnzimmer/temperature')).toMatchObject({ val: 21, min: 21, max: 21 });
        expect(members('room/wohnzimmer/temperature')).toEqual({ t1_temperature: 21 });
        expect(at('floor/ground/temperature')).toMatchObject({ val: 21 });
        expect(at('home/temperature')).toMatchObject({ val: 19.5, min: 18, max: 21 });
        // switched off in the room only
        expect(at('room/wohnzimmer/humidity')).toBeUndefined();
        expect(val('floor/ground/humidity')).toBe(50);
        expect(agg.plan()['room/wohnzimmer'].humidity).toBeUndefined();

        // a floor and the house have the same switch
        model.updateFloor('ground', { aggregates: { humidity: false } });
        core.extend('she/home', { aggregates: { power: false, temperature: { exclude: [E('t4_temperature')] } } });
        await settle();
        expect(at('floor/ground/humidity')).toBeUndefined();
        expect(at('home/power')).toBeUndefined();
        expect(at('home/temperature')).toMatchObject({ val: 21 });
        expect(val('home/humidity')).toBe(50);

        // and back
        model.updateRoom('wohnzimmer', { aggregates: null });
        await settle();
        expect(val('room/wohnzimmer/humidity')).toBe(50);
        expect(members('room/wohnzimmer/temperature')).toEqual({ t1_temperature: 21, t2_temperature: 20 });
    });

    test('the structure is followed: a room, a function, a new device, a device that goes', async () => {
        feed('l3', 'ON');
        await settle();
        expect(val('room/kueche/lights')).toBe(1);
        // the worktop light moves
        model.assign(E('l3_light'), { rooms: ['schlafzimmer'] });
        await settle();
        expect(val('room/kueche/lights')).toBeNull();
        expect(val('room/schlafzimmer/light')).toBe(true);
        expect(val('floor/upper/light')).toBe(true);
        // the pump becomes lighting
        feed('s2', 'ON');
        model.assign(E('s2_plug'), { functions: ['lighting'] });
        await settle();
        expect(members('room/wohnzimmer/light').s2_plug).toBe(true);
        // a new device
        config('binary_sensor', 'w2', 'contact', { name: 'Contact', state_topic: 'w2', device_class: 'door', device: device('w2', 'Door', 'Küche') });
        feed('w2', 'ON');
        await settle();
        expect(at('room/kueche/open')).toMatchObject({ val: true, members: [{ id: E('w2_contact'), name: 'Door Contact', val: true }] });
        // and it goes again
        feed('homeassistant/binary_sensor/w2/contact/config', '');
        await settle();
        expect(at('room/kueche/open')).toBeUndefined();
        // a room that is deleted takes its topics along
        model.deleteRoom('schlafzimmer');
        await settle();
        expect(at('room/schlafzimmer/light')).toBeUndefined();
        expect(at('room/schlafzimmer/temperature')).toBeUndefined();
        expect(Object.keys(agg.plan())).not.toContain('room/schlafzimmer');
    });

    test('switching the model off clears everything, switching it on brings it back', async () => {
        feed('l1', 'ON');
        await settle();
        expect(store.keys('mqtt::she/status/').length).toBeGreaterThan(20);
        model.disable();
        await settle();
        expect(store.keys('mqtt::she/status/')).toEqual([]);
        expect(agg.plan()).toEqual({});
        expect(store.keys('mqtt::homeassistant/device/she_she_')).toEqual([]);
        model.enable();
        await settle();
        expect(val('room/wohnzimmer/light')).toBe(true);
    });
});

describe('publishing', () => {
    test('changes are collected: one publish per aggregate and interval, none when nothing differs', async () => {
        house();
        aggregates({ debounce: 30 });
        agg.start();
        await settle();
        published.length = 0;

        feed('l1', 'ON');
        feed('l1', 'OFF');
        feed('l1', 'ON');
        feed('p1', '100');
        feed('p1', '101');
        feed('p1', '102');
        expect(topicsPublished()).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const topics = topicsPublished();
        expect(topics.sort()).toEqual(['room/wohnzimmer', 'floor/ground', 'home'].flatMap((s) => [s + '/light', s + '/lights', s + '/power']).sort());
        expect(val('room/wohnzimmer/power')).toBe(102);

        // the same values again, and a message that changes nothing for an aggregate
        published.length = 0;
        feed('l1', 'ON');
        feed('p1', '102');
        feed('t1', '21');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(topicsPublished().sort()).toEqual(['floor/ground/temperature', 'home/temperature', 'room/wohnzimmer/temperature']);
    });

    test('a restart publishes only what differs from what is retained, and keeps lc', async () => {
        house();
        agg.start();
        feed('l1', 'ON');
        feed('t1', '21');
        clock = 2000;
        await settle();
        expect(at('room/wohnzimmer/light')).toMatchObject({ val: true, lc: 2000 });
        agg.stop();
        // while she was away: a lamp went off, a room was deleted behind her back
        feed('l3', 'OFF');
        feed('she/status/room/gone/light', { val: true, ts: 1, lc: 1, members: [] });
        published.length = 0;
        clock = 9000;
        aggregates();
        agg.start();
        await settle();
        expect(topicsPublished().sort()).toEqual([
            'floor/ground/light',
            'floor/ground/lights',
            'home/light',
            'home/lights',
            'room/gone/light',
            'room/kueche/light',
            'room/kueche/lights',
        ]);
        expect(published).toContainEqual(['she/status/room/gone/light', '']);
        expect(at('room/wohnzimmer/light')).toMatchObject({ val: true, ts: 2000, lc: 2000 });
        // on the floor a member changed, the value did not: published, lc kept
        expect(at('floor/ground/light')).toMatchObject({ val: true, ts: 9000, lc: 2000 });
        expect(at('room/kueche/light')).toMatchObject({ val: false, ts: 9000, lc: 9000 });
        expect(at('floor/ground/lights')).toMatchObject({ val: 1, ts: 9000, lc: 2000 });
    });

    test('without a connection nothing is lost: it is published after the connect', async () => {
        house();
        agg.start();
        await settle();
        connected = false;
        published.length = 0;
        feed('l1', 'ON');
        await settle();
        expect(published).toEqual([]);
        expect(val('room/wohnzimmer/light')).toBeNull();
        connected = true;
        agg.republish();
        announcer.republish();
        await settle();
        expect(val('room/wohnzimmer/light')).toBe(true);
        expect(val('home/lights')).toBe(1);
    });

    test('the scene of a room comes from whoever knows scenes', async () => {
        house();
        agg.start();
        await settle();
        expect(at('room/wohnzimmer/scene')).toBeUndefined();
        const scenes = { wohnzimmer: 'evening' };
        agg.setSceneSource((room) => scenes[room]);
        clock = 2000;
        await settle();
        expect(at('room/wohnzimmer/scene')).toEqual({ val: 'evening', ts: 2000, lc: 2000 });
        expect(at('room/kueche/scene')).toBeUndefined();
        scenes.wohnzimmer = 'movie';
        scenes.kueche = 'cooking';
        agg.sceneChanged('wohnzimmer');
        clock = 3000;
        await settle();
        expect(at('room/wohnzimmer/scene')).toEqual({ val: 'movie', ts: 3000, lc: 3000 });
        expect(at('room/kueche/scene')).toBeUndefined();
        agg.sceneChanged();
        await settle();
        expect(val('room/kueche/scene')).toBe('cooking');
        // switched off per room, and gone with the source
        model.updateRoom('kueche', { aggregates: { scene: false } });
        await settle();
        expect(at('room/kueche/scene')).toBeUndefined();
        agg.setSceneSource(null);
        await settle();
        expect(at('room/wohnzimmer/scene')).toBeUndefined();
    });
});

describe('announced through discovery', () => {
    beforeEach(async () => {
        house();
        agg.start();
        feed('she/connected', '2');
        feed('l1', 'ON');
        feed('t1', '21.5');
        await settle();
    });

    test('a room, a floor and the house are devices with one entity per aggregate', () => {
        const room = store.get('mqtt::homeassistant/device/she_she_room_wohnzimmer/config');
        expect(room.device).toEqual({ identifiers: ['she_she_room_wohnzimmer'], name: 'Wohnzimmer', manufacturer: 'she', model: 'Room', suggested_area: 'Wohnzimmer' });
        expect(room.origin).toMatchObject({ name: 'she' });
        expect(room.availability).toEqual([{ topic: 'she/connected', value_template: expect.any(String) }]);
        expect(Object.keys(room.components).sort()).toEqual(['humidity', 'light', 'lights', 'occupied', 'open', 'power', 'temperature']);
        expect(room.components.light).toEqual({
            platform: 'binary_sensor',
            name: 'Light',
            device_class: 'light',
            state_topic: 'she/status/room/wohnzimmer/light',
            value_template: expect.stringContaining('value_json.val'),
            json_attributes_topic: 'she/status/room/wohnzimmer/light',
            unique_id: 'she_she_room_wohnzimmer_light',
        });
        expect(room.components.temperature).toMatchObject({ platform: 'sensor', device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' });
        expect(room.components.power).toMatchObject({ platform: 'sensor', device_class: 'power', unit_of_measurement: 'W' });

        expect(Object.keys(store.get('mqtt::homeassistant/device/she_she_room_kueche/config').components).sort()).toEqual(['light', 'lights', 'temperature']);
        const floor = store.get('mqtt::homeassistant/device/she_she_floor_ground/config');
        expect(floor.device).toEqual({ identifiers: ['she_she_floor_ground'], name: 'Erdgeschoss', manufacturer: 'she', model: 'Floor' });
        const all = store.get('mqtt::homeassistant/device/she_she_home/config');
        expect(all.device).toMatchObject({ identifiers: ['she_she_home'], name: 'Home', model: 'Home' });
        expect(all.components.power.state_topic).toBe('she/status/home/power');
    });

    test('she reads her own announcements like any other: the values come out of the templates', async () => {
        const id = (uid) => layer.resolve(uid);
        expect(layer.state(id('she_she_room_wohnzimmer_light')).state).toBe('ON');
        expect(Number(layer.state(id('she_she_room_wohnzimmer_temperature')).value)).toBe(21.5);
        expect(Number(layer.state(id('she_she_home_lights')).value)).toBe(1);
        expect(layer.available(id('she_she_home_lights'))).toBe(true);
        // null is "unknown", not a value
        expect(layer.state(id('she_she_room_wohnzimmer_power')).value).toBeUndefined();
        expect(layer.state(id('she_she_room_wohnzimmer_occupied')).state).toBeUndefined();
        feed('l1', 'OFF');
        await settle();
        expect(layer.state(id('she_she_room_wohnzimmer_light')).state).toBe('OFF');
        expect(warnings).toEqual([]);
    });

    test('but they are hidden in the home model and never count in an aggregate', () => {
        expect(core.get('she/device/she_she_room_wohnzimmer')).toMatchObject({ ha: { model: 'Room' }, eff: { rooms: ['wohnzimmer'], hidden: true } });
        expect(core.get('she/device/she_she_home').eff.hidden).toBe(true);
        expect(core.get(E('she_she_room_wohnzimmer_temperature'))).toMatchObject({
            ha: { device_class: 'temperature' },
            eff: { rooms: ['wohnzimmer'], functions: ['climate'], hidden: true },
        });
        expect(members('room/wohnzimmer/temperature')).toEqual({ t1_temperature: 21.5, t2_temperature: null });
        expect(agg.plan().home.temperature).toEqual([E('t4_temperature'), E('t1_temperature'), E('t2_temperature'), E('t3_temperature')]);
        // no room was made of them, and nothing loops: a second pass publishes nothing
        expect(model.rooms().map((r) => r.id)).toEqual(['kueche', 'schlafzimmer', 'wohnzimmer']);
        published.length = 0;
        agg._replan = true;
        agg.flush();
        expect(published).toEqual([]);
        // even when the user unhides one
        model.assign(E('she_she_room_wohnzimmer_temperature'), { hidden: false });
        agg.flush();
        expect(agg.plan()['room/wohnzimmer'].temperature).toEqual([E('t1_temperature'), E('t2_temperature')]);
    });

    test('a renamed room is announced under its new name; an aggregate that ends leaves the device', async () => {
        model.updateRoom('kueche', { name: 'Kochen' });
        model.updateRoom('kueche', { aggregates: { temperature: false } });
        await settle();
        const room = store.get('mqtt::homeassistant/device/she_she_room_kueche/config');
        expect(room.device).toMatchObject({ name: 'Kochen', suggested_area: 'Kochen' });
        expect(Object.keys(room.components).sort()).toEqual(['light', 'lights']);
        // the room still answers to its old name, so the device stays in it
        expect(core.get('she/device/she_she_room_kueche').eff.rooms).toEqual(['kueche']);
        model.deleteRoom('schlafzimmer');
        await settle();
        expect(store.get('mqtt::homeassistant/device/she_she_room_schlafzimmer/config')).toBeUndefined();
    });
});

describe('the view she/rooms/aggregates', () => {
    test('per room: the aggregates, their entities, what is left out and what is off', async () => {
        house();
        agg.start();
        await settle();
        model.updateRoom('wohnzimmer', { aggregates: { humidity: false, temperature: { exclude: [E('t2_temperature')] } } });
        await settle();
        const result = structuredClone(runView(compileView('she/rooms/aggregates', views.DEFINITIONS['she/rooms/aggregates']), core.docs));
        expect(Object.keys(result)).toEqual(['kueche', 'schlafzimmer', 'wohnzimmer']);
        expect(result.kueche).toEqual({
            name: 'Küche',
            floor: 'ground',
            aggregates: {
                light: {
                    entities: [
                        { id: E('l4_light'), name: 'Hallway' },
                        { id: E('l3_light'), name: 'Worktop' },
                    ],
                    excluded: [],
                },
                lights: {
                    entities: [
                        { id: E('l4_light'), name: 'Hallway' },
                        { id: E('l3_light'), name: 'Worktop' },
                    ],
                    excluded: [],
                },
                temperature: { entities: [{ id: E('t3_temperature'), name: 'Fridge Temperature' }], excluded: [] },
            },
            off: [],
        });
        expect(result.wohnzimmer.off).toEqual(['humidity']);
        expect(result.wohnzimmer.aggregates.temperature).toEqual({ entities: [{ id: E('t1_temperature'), name: 'Climate one Temperature' }], excluded: [E('t2_temperature')] });
        expect(Object.keys(result.wohnzimmer.aggregates)).toEqual(['light', 'lights', 'open', 'temperature', 'occupied', 'power']);
        // the view and the aggregates agree
        for (const [room, r] of Object.entries(result)) {
            expect(Object.fromEntries(Object.entries(r.aggregates).map(([name, a]) => [name, a.entities.map((e) => e.id)]))).toEqual(agg.plan()['room/' + room]);
        }
    });
});

describe('in the daemon', () => {
    test('started with the scripts, over the entity layer; nothing without it', async () => {
        house();
        agg.stop();
        expect(homeAggregates.start()).toBeNull();
        homeAggregates.init({ core, store, log: noop, instance: 'lab', publish, announce: (cfg) => announcer.announce('\0home-aggregates', 'home', cfg) });
        // the entity layer is not there (sheDB off, or its library did not load)
        expect(homeAggregates.start()).toBeNull();
        expect(homeAggregates.getAggregates()).toBeNull();
        homeEntities.init({ core, store, log: noop, publish: () => true });
        feed('l1', 'ON');
        agg = homeAggregates.start();
        expect(homeAggregates.getAggregates()).toBe(agg);
        expect(homeAggregates.start()).toBeNull();
        expect(store.getObject('mqtt::lab/status/room/wohnzimmer/light')).toMatchObject({ val: true });
        connected = false;
        feed('l1', 'OFF');
        agg.flush();
        connected = true;
        homeAggregates.connected();
        agg.flush();
        expect(store.getObject('mqtt::lab/status/room/wohnzimmer/light')).toMatchObject({ val: false });
    });
});
