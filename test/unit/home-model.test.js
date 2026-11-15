'use strict';

/**
 * Unit tests for the home model: src/lib/ha-configs.js, src/lib/home-model.js, src/web/home.js and
 * the /she/home routes. The model runs on a real sheDB core, so "written" means what sheDB counts
 * as a change.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const { expandConfig } = require('../../src/lib/ha-configs');
const { HomeModel, escapeId, unescapeId, slug, matchRule } = require('../../src/lib/home-model');
const { DEFAULT_FUNCTIONS } = require('../../src/lib/home-defaults');
const home = require('../../src/web/home');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const FIXTURES = path.join(__dirname, 'fixtures', 'ha-discovery');

/** the corpus as the state store would hold it: [topic, {val}] */
function corpus(...files) {
    const names = files.length ? files : fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    return names.flatMap((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')).map((m) => [m.topic, { val: m.payload }]));
}

let tmpDir, core, model, clock, retained, updates, logged;

/** a lamp with a light and a diagnostic sensor, as an adapter announces it entity by entity */
const lampLight = (over = {}) => ({
    name: null,
    unique_id: 'lamp1_light',
    state_topic: 'z2m/lamp',
    command_topic: 'z2m/lamp/set',
    availability: [{ topic: 'z2m/bridge/state' }],
    device: { identifiers: ['z2m_lamp1'], name: 'Floor lamp', manufacturer: 'Signify', model: 'Hue', suggested_area: 'Wohnzimmer', via_device: 'z2m_bridge' },
    origin: { name: 'Zigbee2MQTT', sw: '2.9.2' },
    ...over,
});
const lampLinkquality = () => ({
    name: 'Linkquality',
    unique_id: 'lamp1_linkquality',
    state_topic: 'z2m/lamp',
    entity_category: 'diagnostic',
    device: { identifiers: ['z2m_lamp1'] },
});
const contact = (over = {}) => ({
    name: 'Contact',
    uniq_id: 'win1_contact',
    stat_t: 'z2m/window',
    dev_cla: 'window',
    dev: { ids: 'z2m_win1', name: 'Window left', sa: 'Bad' },
    ...over,
});

const T_LIGHT = 'homeassistant/light/lamp1/light/config';
const T_LQ = 'homeassistant/sensor/lamp1/linkquality/config';
const T_CONTACT = 'homeassistant/binary_sensor/win1/contact/config';
const E_LIGHT = 'she/entity/lamp1_light';
const E_LQ = 'she/entity/lamp1_linkquality';
const E_CONTACT = 'she/entity/win1_contact';
const D_LAMP = 'she/device/z2m_lamp1';
const D_WIN = 'she/device/z2m_win1';

function setRetained(obj) {
    retained = new Map(Object.entries(obj).map(([topic, val]) => [topic, { val }]));
}

function makeModel(opts = {}) {
    return new HomeModel({ core, entries: () => retained, log: { ...noop, info: (m) => logged.push(m), warn: (m) => logged.push(m) }, now: () => clock, goneDelay: 0, ...opts });
}

/** a model that is on and has mirrored the lamp and the window */
function started() {
    setRetained({ [T_LIGHT]: lampLight(), [T_LQ]: lampLinkquality(), [T_CONTACT]: contact() });
    model = makeModel();
    model.enable({ language: 'en' });
    model.start();
    updates.length = 0;
    return model;
}

const immediate = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-model-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    clock = 1000;
    retained = new Map();
    updates = [];
    logged = [];
    core.on('update', (id) => updates.push(id));
});

afterEach(async () => {
    if (model) model.stop();
    model = null;
    home.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ids', () => {
    test('escapeId escapes what a sheDB id cannot hold, reversibly', () => {
        expect(escapeId('gasmeter/status')).toBe('gasmeter%2Fstatus');
        expect(escapeId('a+b#c d%e')).toBe('a%2Bb%23c%20d%25e');
        for (const raw of ['gasmeter/status', 'a+b#c d%e', '%2F', 'plain_0x00124b', 'ä/ö']) expect(unescapeId(escapeId(raw))).toBe(raw);
    });

    test('slug makes a readable id', () => {
        expect(slug('Wohnzimmer')).toBe('wohnzimmer');
        expect(slug(' Küche (EG) ')).toBe('kueche-eg');
        expect(slug('Salle à manger')).toBe('salle-a-manger');
        expect(slug('書斎')).toBe('');
    });
});

describe('matchRule', () => {
    const light = { component: 'light', device_class: null, entity_category: null };
    const shutter = { component: 'cover', device_class: 'shutter', entity_category: null };
    const garage = { component: 'cover', device_class: 'garage', entity_category: null };
    const plainCover = { component: 'cover', device_class: null, entity_category: null };

    test('fields are values or lists, null stands for "not set"', () => {
        expect(matchRule({ component: 'light' }, light)).toBe(true);
        expect(matchRule({ component: ['climate', 'light'] }, light)).toBe(true);
        expect(matchRule({ component: 'cover', device_class: ['shutter', null] }, shutter)).toBe(true);
        expect(matchRule({ component: 'cover', device_class: ['shutter', null] }, plainCover)).toBe(true);
        expect(matchRule({ component: 'cover', device_class: ['shutter', null] }, garage)).toBe(false);
        expect(matchRule({ component: 'sensor', entity_category: null }, { component: 'sensor', entity_category: 'diagnostic' })).toBe(false);
    });

    test('not excludes, and a rule that names nothing matches nothing', () => {
        expect(matchRule({ component: 'cover', not: { device_class: ['garage', 'door'] } }, shutter)).toBe(true);
        expect(matchRule({ component: 'cover', not: [{ device_class: 'door' }, { device_class: 'garage' }] }, garage)).toBe(false);
        expect(matchRule({}, light)).toBe(false);
        expect(matchRule({ not: { component: 'sensor' } }, light)).toBe(false);
        expect(matchRule('light', light)).toBe(false);
    });
});

describe('expandConfig', () => {
    test('expands abbreviations and ~, and sorts the topics by role', () => {
        const [e] = expandConfig('homeassistant/cover/node/blind/config', {
            '~': 'base/blind',
            'uniq_id': 'blind1',
            'stat_t': '~/state',
            'cmd_t': '~/set',
            'pos_t': '~/position',
            'set_pos_t': '~/position/set',
            'json_attr_t': '~',
            'avty': [{ t: '~/online', pl_avail: '1' }],
            'dev_cla': 'blind',
            'dev': { ids: ['d1'], mf: 'Acme', sa: 'Bad', mdl_id: 'B1' },
            'o': { name: 'x2mqtt', sw: '1.0', url: 'https://example.org' },
        });
        expect(e).toMatchObject({ component: 'cover', objectId: 'blind', uniqueId: 'blind1', deviceKey: 'd1', key: 'cover/node/blind' });
        expect(e.config).toEqual({
            unique_id: 'blind1',
            state_topic: 'base/blind/state',
            command_topic: 'base/blind/set',
            position_topic: 'base/blind/position',
            set_position_topic: 'base/blind/position/set',
            json_attributes_topic: 'base/blind',
            availability: [{ topic: 'base/blind/online', payload_available: '1' }],
            device_class: 'blind',
        });
        expect(e.device).toEqual({ identifiers: ['d1'], manufacturer: 'Acme', suggested_area: 'Bad', model_id: 'B1' });
        expect(e.origin).toEqual({ name: 'x2mqtt', sw_version: '1.0', support_url: 'https://example.org' });
        expect(e.topics).toEqual({
            state: ['base/blind/position', 'base/blind/state'],
            command: ['base/blind/position/set', 'base/blind/set'],
            availability: ['base/blind/online'],
            attributes: ['base/blind'],
        });
    });

    test('the device-based form: one record per component, shared options inherited, a bare platform removes', () => {
        const list = expandConfig('homeassistant/device/dev1/config', {
            '~': 'bla/dev1',
            'dev': { ids: 'dev1', name: 'Multi' },
            'o': { name: 'bla2mqtt' },
            'avty_t': '~/status',
            'qos': 1,
            'cmps': {
                temp: { p: 'sensor', uniq_id: 'dev1_temp', stat_t: '~/temp', dev_cla: 'temperature' },
                sw: { 'p': 'switch', 'uniq_id': 'dev1_sw', '~': 'other', 'stat_t': '~/sw', 'cmd_t': '~/sw/set', 'qos': 0 },
                old: { p: 'sensor' },
            },
        });
        expect(list.map((e) => [e.component, e.objectId, e.uniqueId, e.deviceKey])).toEqual([
            ['sensor', 'temp', 'dev1_temp', 'dev1'],
            ['switch', 'sw', 'dev1_sw', 'dev1'],
        ]);
        expect(list[0].config).toEqual({
            platform: 'sensor',
            unique_id: 'dev1_temp',
            state_topic: 'bla/dev1/temp',
            device_class: 'temperature',
            availability_topic: 'bla/dev1/status',
            qos: 1,
        });
        expect(list[1].config).toMatchObject({ state_topic: 'other/sw', command_topic: 'other/sw/set', availability_topic: 'bla/dev1/status', qos: 0 });
        expect(list[1].origin).toEqual({ name: 'bla2mqtt' });
    });

    test('what is not a config yields nothing', () => {
        expect(expandConfig('homeassistant/status', 'online')).toEqual([]);
        expect(expandConfig('homeassistant/light/x/config', 'garbage')).toEqual([]);
        expect(expandConfig('homeassistant/sensor/a/b/state', { x: 1 })).toEqual([]);
        expect(expandConfig('other/light/x/config', { name: 'x' })).toEqual([]);
        expect(expandConfig('ha/light/x/config', { name: 'x' }, 'ha')).toHaveLength(1);
    });
});

describe('the switch', () => {
    test('a new installation is switched on; the functions are seeded once a language is chosen', () => {
        setRetained({ [T_LIGHT]: lampLight() });
        model = makeModel();
        expect(model.init({ fresh: true })).toMatchObject({ enabled: true, decided: true, language: null, counts: { functions: 0 } });
        expect(core.get('she/home')).toMatchObject({ schema: 1, kind: 'home', enabled: true, language: null, enabled_at: 1000, seeded_functions: [] });
        // the mirror runs already
        model.start();
        expect(core.get(E_LIGHT).eff.functions).toEqual([]);

        clock = 2000;
        expect(model.enable({ language: 'de' })).toMatchObject({ enabled: true, language: 'de', enabled_at: 1000 });
        const functions = model.functions();
        expect(functions.map((f) => f.id)).toEqual(['lighting', 'shading', 'heating', 'climate', 'openings', 'security', 'energy', 'presence', 'media', 'maintenance']);
        expect(functions[0]).toMatchObject({ schema: 1, kind: 'function', name: 'Licht', seeded: true, order: 1, rules: [{ component: 'light' }] });
        expect(functions.map((f) => f.name)).toEqual(DEFAULT_FUNCTIONS.map((f) => f.name.de));
        expect(core.get(E_LIGHT).eff.functions).toEqual(['lighting']);
        // the names are the user's from then on: another language later changes nothing
        model.enable({ language: 'en' });
        expect(core.get('she/function/lighting').name).toBe('Licht');
    });

    test('an existing installation is left undecided: nothing is written, the status carries the hint', () => {
        setRetained({ [T_LIGHT]: lampLight() });
        model = makeModel();
        expect(model.init({ fresh: false })).toMatchObject({ enabled: false, decided: false });
        model.start();
        model.noteConfig(T_LQ, lampLinkquality());
        expect(model.flush()).toBe(0);
        expect(updates).toEqual([]);
        expect(() => model.createRoom({ name: 'Bad' })).toThrow(/switched off/);
    });

    test('switching on while running mirrors what is retained', () => {
        setRetained({ [T_LIGHT]: lampLight() });
        model = makeModel();
        model.init();
        model.start();
        expect(core.get(E_LIGHT)).toBeUndefined();
        model.enable({ language: 'en-GB' });
        expect(core.get('she/function/lighting').name).toBe('Lighting');
        expect(core.get(E_LIGHT).ha.present).toBe(true);
    });

    test('a deleted or edited function is not seeded again; switching off keeps every document', () => {
        started();
        model.deleteFunction('media');
        model.updateFunction('lighting', { name: 'Lampen' });
        const docs = Object.keys(core.docs).length;
        expect(model.disable()).toMatchObject({ enabled: false, decided: true });
        expect(Object.keys(core.docs)).toHaveLength(docs);
        model.enable({ language: 'de' });
        expect(core.get('she/function/media')).toBeUndefined();
        expect(core.get('she/function/lighting').name).toBe('Lampen');
        expect(core.get(E_LIGHT).eff.functions).toEqual(['lighting']);
    });

    test('nothing is mirrored while it is off, and the retained state is read again when it comes back on', () => {
        started();
        model.disable();
        model.noteConfig(T_LIGHT, '');
        retained.delete(T_LIGHT);
        expect(model.flush()).toBe(0);
        expect(core.get(E_LIGHT).ha.present).toBe(true);
        clock = 2000;
        model.enable({ language: 'en' });
        expect(core.get(E_LIGHT).ha).toMatchObject({ present: false, gone_since: 2000 });
    });
});

describe('the mirror', () => {
    test('a device and its entities, in the sections ha / user / eff', () => {
        started();
        const device = core.get(D_LAMP);
        expect(device).toMatchObject({
            _id: D_LAMP,
            schema: 1,
            kind: 'device',
            source: 'ha',
            user: {},
            eff: { name: 'Floor lamp', rooms: ['wohnzimmer'], floors: [], labels: [], hidden: false, adapter: 'Zigbee2MQTT' },
        });
        expect(device.ha).toEqual({
            identifiers: ['z2m_lamp1'],
            connections: [],
            name: 'Floor lamp',
            manufacturer: 'Signify',
            model: 'Hue',
            model_id: null,
            hw_version: null,
            sw_version: null,
            serial_number: null,
            suggested_area: 'Wohnzimmer',
            via_device: 'z2m_bridge',
            configuration_url: null,
            origin: { name: 'Zigbee2MQTT', sw_version: '2.9.2', support_url: null },
            config_topics: [T_LIGHT, T_LQ],
            entities: [E_LIGHT, E_LQ],
            triggers: [],
            present: true,
            first_seen: 1000,
            gone_since: null,
        });

        const light = core.get(E_LIGHT);
        expect(light).toMatchObject({ _id: E_LIGHT, schema: 1, kind: 'entity', source: 'ha', user: {} });
        expect(light.ha).toEqual({
            unique_id: 'lamp1_light',
            device: D_LAMP,
            component: 'light',
            object_id: 'light',
            device_class: null,
            entity_category: null,
            name: null,
            icon: null,
            unit: null,
            config: { name: null, unique_id: 'lamp1_light', state_topic: 'z2m/lamp', command_topic: 'z2m/lamp/set', availability: [{ topic: 'z2m/bridge/state' }] },
            config_topic: T_LIGHT,
            topics: { state: ['z2m/lamp'], command: ['z2m/lamp/set'], availability: ['z2m/bridge/state'], attributes: [] },
            present: true,
            first_seen: 1000,
            gone_since: null,
        });
        expect(light.eff).toEqual({ name: 'Floor lamp', rooms: ['wohnzimmer'], floors: [], functions: ['lighting'], labels: [], hidden: false });

        // abbreviated keys arrive expanded; a diagnostic entity is hidden
        expect(core.get(E_CONTACT).ha).toMatchObject({ unique_id: 'win1_contact', device_class: 'window', device: D_WIN, config: { state_topic: 'z2m/window' } });
        expect(core.get(E_CONTACT).eff).toMatchObject({ name: 'Window left Contact', functions: ['openings'], rooms: ['bad'] });
        expect(core.get(E_LQ).eff).toMatchObject({ name: 'Floor lamp Linkquality', hidden: true, functions: [] });
    });

    test('ids are escaped, the original is kept in the document', () => {
        setRetained({
            'homeassistant/sensor/meter/value/config': {
                name: 'Value',
                unique_id: 'gas meter/status+value#1',
                state_topic: 'gas/value',
                device: { identifiers: 'gasmeter/status', name: 'Gas' },
            },
        });
        model = makeModel();
        model.enable({ language: 'en' });
        model.start();
        const entity = core.get('she/entity/gas%20meter%2Fstatus%2Bvalue%231');
        expect(entity.ha).toMatchObject({ unique_id: 'gas meter/status+value#1', device: 'she/device/gasmeter%2Fstatus' });
        expect(core.get('she/device/gasmeter%2Fstatus').ha.identifiers).toEqual(['gasmeter/status']);
        expect(model.entity('gas meter/status+value#1')._id).toBe(entity._id);
        expect(model.device('gasmeter/status').ha.entities).toEqual([entity._id]);
    });

    test('an entity without unique_id is identified by its place in the discovery tree; one without a device has none', () => {
        setRetained({ 'homeassistant/sensor/node/temp/config': { name: 'Temp', state_topic: 'x/temp', device_class: 'temperature' } });
        model = makeModel();
        model.enable({ language: 'en' });
        model.start();
        const entity = core.get('she/entity/sensor%2Fnode%2Ftemp');
        expect(entity.ha).toMatchObject({ unique_id: null, device: null, component: 'sensor' });
        expect(entity.eff).toMatchObject({ name: 'Temp', rooms: [], functions: ['climate'] });
        expect(model.devices()).toEqual([]);
    });

    test('the same unique_id under two components gives two documents; a plain repetition is ignored', () => {
        setRetained({
            'homeassistant/sensor/a/x/config': { unique_id: 'dup', state_topic: 'a' },
            'homeassistant/binary_sensor/a/x/config': { unique_id: 'dup', state_topic: 'b' },
            'homeassistant/sensor/b/x/config': { unique_id: 'dup', state_topic: 'c' },
        });
        model = makeModel();
        model.enable({ language: 'en' });
        model.start();
        expect(core.get('she/entity/dup').ha).toMatchObject({ component: 'binary_sensor' });
        expect(core.get('she/entity/dup@sensor').ha).toMatchObject({ component: 'sensor', config_topic: 'homeassistant/sensor/a/x/config' });
        expect(model.entities()).toHaveLength(2);
        expect(logged.some((m) => /homeassistant\/sensor\/b\/x\/config announces sensor "dup" a second time/.test(m))).toBe(true);
        // the documents keep their entity when the order of arrival would now decide otherwise
        retained.delete('homeassistant/binary_sensor/a/x/config');
        model.reconcile();
        expect(core.get('she/entity/dup').ha).toMatchObject({ component: 'binary_sensor', present: false });
        expect(core.get('she/entity/dup@sensor').ha.present).toBe(true);
    });

    test('device triggers are kept on the device and keep it present', () => {
        setRetained({
            'homeassistant/device_automation/remote1/single/config': {
                automation_type: 'trigger',
                type: 'action',
                subtype: 'single',
                topic: 'z2m/remote/action',
                payload: 'single',
                device: { identifiers: ['z2m_remote1'], name: 'Remote' },
            },
        });
        model = makeModel();
        model.enable({ language: 'en' });
        model.start();
        expect(model.entities()).toEqual([]);
        expect(core.get('she/device/z2m_remote1').ha).toMatchObject({
            present: true,
            entities: [],
            config_topics: ['homeassistant/device_automation/remote1/single/config'],
            triggers: [{ type: 'action', subtype: 'single', topic: 'z2m/remote/action', payload: 'single', config_topic: 'homeassistant/device_automation/remote1/single/config' }],
        });
        clock = 2000;
        model.noteConfig('homeassistant/device_automation/remote1/single/config', '');
        model.flush();
        expect(core.get('she/device/z2m_remote1').ha).toMatchObject({ present: false, gone_since: 2000 });
    });

    test('the device block is merged over all configs of the device', () => {
        started();
        // only the light carries the full block; the device still has it when the light is read second
        expect(core.get(D_LAMP).ha).toMatchObject({ name: 'Floor lamp', manufacturer: 'Signify' });
        expect(core.get(D_WIN).ha).toMatchObject({ identifiers: ['z2m_win1'], name: 'Window left', suggested_area: 'Bad', origin: null });
    });
});

describe('write only on a real change', () => {
    test('the same announcements again write nothing', () => {
        started();
        const revs = Object.fromEntries(Object.entries(core.docs).map(([id, doc]) => [id, doc._rev]));
        const rev = core.rev;
        clock = 5000;

        expect(model.reconcile()).toBe(3);
        model.noteConfig(T_LIGHT, lampLight());
        model.noteConfig(T_CONTACT, contact());
        expect(model._timer).toBeNull();
        expect(model.flush()).toBe(0);
        model.recompute();

        expect(updates).toEqual([]);
        expect(core.rev).toBe(rev);
        expect(Object.fromEntries(Object.entries(core.docs).map(([id, doc]) => [id, doc._rev]))).toEqual(revs);
    });

    test('a changed config writes exactly the documents it changes', () => {
        started();
        model.noteConfig(T_LIGHT, lampLight({ brightness: true }));
        model.flush();
        expect(updates).toEqual([E_LIGHT]);
        expect(core.get(E_LIGHT)).toMatchObject({ _rev: 1, ha: { config: { brightness: true }, first_seen: 1000 } });

        updates.length = 0;
        const renamed = lampLight({ brightness: true });
        renamed.device.name = 'Reading lamp';
        model.noteConfig(T_LIGHT, renamed);
        model.flush();
        // the device, and the entities whose effective name follows it
        expect(updates.sort()).toEqual([D_LAMP, E_LIGHT, E_LQ].sort());
        expect(core.get(E_LQ).eff.name).toBe('Reading lamp Linkquality');
    });

    test('announcements are collected and written together', async () => {
        started();
        model.stop();
        model = makeModel({ debounce: 20 });
        model.start();
        updates.length = 0;
        model.noteConfig('homeassistant/switch/plug1/switch/config', { unique_id: 'plug1', command_topic: 'p/set', device: { identifiers: ['plug1'], name: 'Plug' } });
        model.noteConfig('homeassistant/sensor/plug1/power/config', { unique_id: 'plug1_power', state_topic: 'p', device_class: 'power', device: { identifiers: ['plug1'] } });
        expect(updates).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 60));
        // one write per document, the device included
        expect(updates.sort()).toEqual(['she/device/plug1', 'she/entity/plug1', 'she/entity/plug1_power']);
        expect(core.get('she/entity/plug1_power').eff).toMatchObject({ name: 'Plug Power', functions: ['energy'] });
    });

    test('the documents do not share objects with the state store', () => {
        const payload = lampLight({ effect_list: ['a', 'b'] });
        setRetained({ [T_LIGHT]: payload });
        model = makeModel();
        model.enable({ language: 'en' });
        model.start();
        payload.effect_list.push('c');
        expect(core.get(E_LIGHT).ha.config.effect_list).toEqual(['a', 'b']);
    });
});

describe('gone and back', () => {
    test('a cleared config leaves the documents, marked as gone; the assignments survive the return', () => {
        started();
        model.createRoom({ name: 'Flur' });
        model.assign(E_LIGHT, { name: 'Stehlampe', rooms: ['flur'], labels: ['evening'] });

        clock = 2000;
        model.noteConfig(T_LIGHT, '');
        model.flush();
        expect(core.get(E_LIGHT).ha).toMatchObject({ present: false, gone_since: 2000, first_seen: 1000, config_topic: T_LIGHT });
        expect(core.get(E_LIGHT).user).toEqual({ name: 'Stehlampe', rooms: ['flur'], labels: ['evening'] });
        // the device stays present as long as one entity announces it
        expect(core.get(D_LAMP).ha).toMatchObject({ present: true, entities: [E_LQ], config_topics: [T_LQ] });

        clock = 3000;
        model.noteConfig(T_LQ, '');
        model.flush();
        expect(core.get(D_LAMP).ha).toMatchObject({ present: false, gone_since: 3000, first_seen: 1000, name: 'Floor lamp', entities: [E_LQ] });
        expect(model.devices({ present: false }).map((d) => d._id)).toEqual([D_LAMP]);
        expect(model.status().counts.gone).toBe(1);
        // the other device is untouched
        expect(core.get(D_WIN).ha.present).toBe(true);

        clock = 4000;
        model.noteConfig(T_LIGHT, lampLight());
        model.noteConfig(T_LQ, lampLinkquality());
        model.flush();
        expect(core.get(E_LIGHT).ha).toMatchObject({ present: true, gone_since: null, first_seen: 1000 });
        expect(core.get(E_LIGHT).user).toEqual({ name: 'Stehlampe', rooms: ['flur'], labels: ['evening'] });
        expect(core.get(E_LIGHT).eff).toMatchObject({ name: 'Stehlampe', rooms: ['flur'], labels: ['evening'] });
        expect(core.get(D_LAMP).ha).toMatchObject({ present: true, gone_since: null, first_seen: 1000, entities: [E_LIGHT, E_LQ] });
    });

    test('a start with the complete retained state marks what is no longer announced', () => {
        started();
        model.stop();
        retained.delete(T_CONTACT);
        clock = 2000;
        model = makeModel();
        expect(model.start()).toBe(2);
        expect(core.get(E_CONTACT).ha).toMatchObject({ present: false, gone_since: 2000 });
        expect(core.get(D_WIN).ha).toMatchObject({ present: false, gone_since: 2000 });
        expect(core.get(E_LIGHT).ha.present).toBe(true);
    });

    test('the sweep for what has gone follows the start after a delay, so that late retained messages count', async () => {
        started();
        model.stop();
        // the daemon considers the retained state complete, but the lamp's configs are still on their way
        retained.delete(T_LIGHT);
        retained.delete(T_LQ);
        retained.delete(T_CONTACT);
        clock = 2000;
        model = makeModel({ goneDelay: 40 });
        expect(model.start()).toBe(0);
        expect(updates).toEqual([]);
        retained.set(T_LIGHT, { val: lampLight() });
        retained.set(T_LQ, { val: lampLinkquality() });
        model.noteConfig(T_LIGHT, lampLight());
        model.noteConfig(T_LQ, lampLinkquality());
        model.flush();
        expect(updates).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        // the lamp was never touched; the window, which did not come, has gone
        expect(updates.sort()).toEqual([D_WIN, E_CONTACT]);
        expect(core.get(E_CONTACT).ha).toMatchObject({ present: false, gone_since: 2000 });
        expect(core.get(D_LAMP)._rev).toBe(0);
    });

    test('a start without the complete retained state marks nothing, and announcements still come in', () => {
        started();
        model.stop();
        retained.clear();
        clock = 2000;
        model = makeModel();
        model.start({ authoritative: false });
        expect(updates).toEqual([]);
        expect(core.get(D_LAMP).ha.present).toBe(true);

        // the broker comes back: one config of the lamp arrives first
        model.noteConfig(T_LQ, lampLinkquality());
        model.flush();
        expect(updates).toEqual([]);
        expect(core.get(D_LAMP).ha).toMatchObject({ present: true, name: 'Floor lamp', entities: [E_LIGHT, E_LQ], config_topics: [T_LIGHT, T_LQ] });
        // and a clear is still a clear
        model.noteConfig(T_LQ, '');
        model.flush();
        expect(core.get(E_LQ).ha.present).toBe(false);
        expect(core.get(E_LIGHT).ha.present).toBe(true);
    });

    test('an entity that changes its unique_id on the same topic leaves the old document as gone', () => {
        started();
        clock = 2000;
        model.noteConfig(T_CONTACT, contact({ uniq_id: 'win1_contact_v2' }));
        model.flush();
        expect(core.get(E_CONTACT).ha).toMatchObject({ present: false, gone_since: 2000 });
        expect(core.get('she/entity/win1_contact_v2').ha).toMatchObject({ present: true, first_seen: 2000 });
        expect(core.get(D_WIN).ha).toMatchObject({ present: true, entities: ['she/entity/win1_contact_v2'] });
    });

    test('remove deletes what has gone, and refuses what is still announced', () => {
        started();
        expect(() => model.remove(D_LAMP)).toThrow(/still announced/);
        model.noteConfig(T_LIGHT, '');
        model.noteConfig(T_LQ, '');
        model.flush();
        expect(model.remove(D_LAMP).sort()).toEqual([D_LAMP, E_LIGHT, E_LQ].sort());
        expect(core.get(D_LAMP)).toBeUndefined();
        expect(core.get(E_LIGHT)).toBeUndefined();
        expect(core.get(D_WIN)).toBeDefined();
    });
});

describe('rooms', () => {
    test('a new suggested_area becomes a room; the same area in another spelling does not', () => {
        started();
        expect(model.rooms().map((r) => [r.id, r.name, r.aliases, r.auto])).toEqual([
            ['bad', 'Bad', ['Bad'], true],
            ['wohnzimmer', 'Wohnzimmer', ['Wohnzimmer'], true],
        ]);
        expect(logged).toContain('home model: new room "Wohnzimmer" (wohnzimmer) from discovery, 1 device');

        updates.length = 0;
        model.noteConfig('homeassistant/switch/plug1/switch/config', {
            unique_id: 'plug1',
            command_topic: 'p/set',
            device: { identifiers: ['plug1'], suggested_area: '  wohnZIMMER ' },
        });
        model.flush();
        expect(model.rooms()).toHaveLength(2);
        expect(core.get('she/entity/plug1').eff.rooms).toEqual(['wohnzimmer']);
        expect(updates.some((id) => id.startsWith('she/room/'))).toBe(false);
    });

    test('an area matches a room by id, name or alias; an id that is taken gets a suffix', () => {
        started();
        model.createRoom({ id: 'kitchen', name: 'Küche', aliases: ['Kochen'] });
        model.createRoom({ id: 'buero', name: 'Arbeitszimmer' });
        const announce = (n, area) =>
            model.noteConfig(`homeassistant/switch/p${n}/switch/config`, { unique_id: 'p' + n, command_topic: 'p/set', device: { identifiers: ['p' + n], suggested_area: area } });
        announce(1, 'küche');
        announce(2, 'KOCHEN');
        announce(3, 'kitchen');
        announce(4, 'Büro');
        model.flush();
        expect(core.get('she/entity/p1').eff.rooms).toEqual(['kitchen']);
        expect(core.get('she/entity/p2').eff.rooms).toEqual(['kitchen']);
        expect(core.get('she/entity/p3').eff.rooms).toEqual(['kitchen']);
        // "Büro" would be "buero", which is the id of another room
        expect(core.get('she/entity/p4').eff.rooms).toEqual(['buero-2']);
        expect(model.rooms().map((r) => [r.id, r.name])).toEqual([
            ['buero', 'Arbeitszimmer'],
            ['bad', 'Bad'],
            ['buero-2', 'Büro'],
            ['kitchen', 'Küche'],
            ['wohnzimmer', 'Wohnzimmer'],
        ]);
    });

    test('a deleted room is remembered as a rejected area and not created again', () => {
        started();
        model.assign(E_CONTACT, { rooms: ['wohnzimmer', 'bad'] });
        model.deleteRoom('wohnzimmer');
        expect(core.get('she/room/wohnzimmer')).toMatchObject({ kind: 'room', name: 'Wohnzimmer', aliases: ['Wohnzimmer'], rejected: true });
        expect(model.rooms().map((r) => r.id)).toEqual(['bad']);
        expect(model.rooms({ rejected: true }).map((r) => r.id)).toEqual(['wohnzimmer']);
        expect(core.get(E_LIGHT).eff.rooms).toEqual([]);
        expect(core.get(E_CONTACT).user.rooms).toEqual(['bad']);
        expect(model.resolveRoom('Wohnzimmer')).toBeNull();

        model.reconcile();
        model.noteConfig(T_LIGHT, lampLight({ brightness: true }));
        model.flush();
        expect(model.rooms().map((r) => r.id)).toEqual(['bad']);
        expect(model.entities({ room: '' }).map((e) => e._id)).toEqual([E_LIGHT, E_LQ]);

        // the user takes it back
        expect(model.createRoom({ name: 'Wohnzimmer' })).toBe('wohnzimmer');
        expect(core.get('she/room/wohnzimmer').rejected).toBeUndefined();
        expect(core.get(E_LIGHT).eff.rooms).toEqual(['wohnzimmer']);

        // purge forgets it: the next announcement creates it again
        model.deleteRoom('wohnzimmer', { purge: true });
        expect(core.get('she/room/wohnzimmer')).toBeUndefined();
        model.reconcile();
        expect(core.get('she/room/wohnzimmer')).toMatchObject({ auto: true });
    });

    test('create, update, validation', () => {
        started();
        model.createFloor({ id: 'ground', name: 'Erdgeschoss', level: 0 });
        expect(model.createRoom({ name: 'Küche', floor: 'ground', facade: 'south' })).toBe('kueche');
        expect(core.get('she/room/kueche')).toMatchObject({
            schema: 1,
            kind: 'room',
            name: 'Küche',
            aliases: ['Küche'],
            floor: 'ground',
            icon: null,
            order: null,
            facade: 'south',
        });
        expect(() => model.createRoom({ name: 'küche' })).toThrow(/exists/);
        expect(() => model.createRoom({ id: 'bad', name: 'Other' })).toThrow(/exists/);
        expect(() => model.createRoom({ name: 'X', floor: 'attic' })).toThrow(/unknown floor/);
        expect(() => model.createRoom({ id: 'a/b', name: 'X' })).toThrow(/invalid id/);
        expect(() => model.createRoom({})).toThrow(/needs a name/);
        expect(model.updateRoom('kueche', { order: 2, icon: 'mdi:stove', simulate: true })).toMatchObject({ order: 2, icon: 'mdi:stove', simulate: true, facade: 'south' });
        expect(() => model.updateRoom('kueche', { rejected: true })).toThrow(/cannot be changed/);
        expect(() => model.updateRoom('kueche', { floor: 'attic' })).toThrow(/unknown floor/);
        expect(() => model.updateRoom('nowhere', { order: 1 })).toThrow(/unknown room/);
        // a failed change writes nothing
        expect(core.get('she/room/kueche').floor).toBe('ground');
    });
});

describe('merging rooms', () => {
    function threeSpellings() {
        started();
        const announce = (n, area) =>
            model.noteConfig(`homeassistant/light/l${n}/light/config`, { unique_id: 'l' + n, command_topic: 'l/set', device: { identifiers: ['l' + n], suggested_area: area } });
        announce(1, 'Living room');
        announce(2, 'wz');
        model.flush();
        expect(model.rooms().map((r) => r.id)).toEqual(['bad', 'living-room', 'wohnzimmer', 'wz']);
        return announce;
    }

    test('one room keeps its id and takes names, aliases and ids of the others; every reference moves', () => {
        const announce = threeSpellings();
        model.createFloor({ id: 'ground', name: 'EG' });
        model.updateRoom('wz', { floor: 'ground' });
        model.assign(E_CONTACT, { rooms: ['bad', 'living-room', 'wz'] });
        model.assign(D_WIN, { rooms: ['wz'] });
        core.set('she/scene/evening', { name: 'Abend', area: 'living-room', members: [] });
        core.set('she/scenegroup/wz', { name: 'Wohnzimmer', room: 'wz', rooms: ['wz', 'bad'], scenes: ['evening'] });
        core.set('she/scene/other', { name: 'Bad', area: 'bad' });

        const kept = model.mergeRooms('wohnzimmer', ['living-room', 'wz']);
        expect(kept).toMatchObject({ _id: 'she/room/wohnzimmer', name: 'Wohnzimmer', floor: 'ground', aliases: ['Wohnzimmer', 'Living room', 'living-room', 'wz'] });
        expect(model.rooms().map((r) => r.id)).toEqual(['bad', 'wohnzimmer']);
        expect(core.get('she/room/wz')).toBeUndefined();

        // assignments
        expect(core.get(E_CONTACT).user.rooms).toEqual(['bad', 'wohnzimmer']);
        expect(core.get(D_WIN).user.rooms).toEqual(['wohnzimmer']);
        // inherited through the area
        expect(core.get('she/entity/l1').eff).toMatchObject({ rooms: ['wohnzimmer'], floors: ['ground'] });
        expect(core.get('she/entity/l2').eff.rooms).toEqual(['wohnzimmer']);
        // scenes
        expect(core.get('she/scene/evening').area).toBe('wohnzimmer');
        expect(core.get('she/scenegroup/wz')).toMatchObject({ room: 'wohnzimmer', rooms: ['wohnzimmer', 'bad'] });
        expect(core.get('she/scene/other')._rev).toBe(0);

        // the old ids and names still resolve
        expect(model.resolveRoom('wz')).toBe('wohnzimmer');
        expect(model.resolveRoom('living-room')).toBe('wohnzimmer');
        expect(model.resolveRoom(' LIVING ROOM ')).toBe('wohnzimmer');
        expect(model.assign(E_LIGHT, { rooms: ['wz'] }).user.rooms).toEqual(['wohnzimmer']);

        // a later announcement with an old area lands in the kept room
        announce(3, 'Living room');
        model.flush();
        expect(core.get('she/entity/l3').eff.rooms).toEqual(['wohnzimmer']);
        expect(model.rooms().map((r) => r.id)).toEqual(['bad', 'wohnzimmer']);
    });

    test('an old id written straight into a document still resolves', async () => {
        threeSpellings();
        model.mergeRooms('wohnzimmer', ['wz']);
        core.prop(E_CONTACT, { method: 'set', prop: 'user.rooms', val: ['wz', 'nowhere'] });
        await immediate();
        expect(core.get(E_CONTACT).eff.rooms).toEqual(['wohnzimmer']);
    });

    test('unknown rooms are refused and nothing is written', () => {
        threeSpellings();
        updates.length = 0;
        expect(() => model.mergeRooms('wohnzimmer', ['wz', 'nowhere'])).toThrow(/unknown room: nowhere/);
        expect(() => model.mergeRooms('nowhere', ['wz'])).toThrow(/unknown room: nowhere/);
        expect(updates).toEqual([]);
        expect(model.mergeRooms('wohnzimmer', ['wohnzimmer']).aliases).toEqual(['Wohnzimmer']);
    });
});

describe('effective values: inheritance and several rooms', () => {
    beforeEach(() => {
        started();
        model.createFloor({ id: 'ground', name: 'Erdgeschoss', level: 0, order: 1 });
        model.createFloor({ id: 'upper', name: 'Obergeschoss', level: 1, order: 2 });
        model.createRoom({ id: 'hall', name: 'Flur', floor: 'ground' });
        model.createRoom({ id: 'stairs', name: 'Treppe', floor: 'upper' });
        model.updateRoom('wohnzimmer', { floor: 'ground' });
    });

    test('rooms: entity → device → suggested area → none', () => {
        // the area
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: ['wohnzimmer'], floors: ['ground'] });
        // the device
        model.assign(D_LAMP, { rooms: ['hall'] });
        expect(core.get(D_LAMP).eff).toMatchObject({ rooms: ['hall'], floors: ['ground'] });
        expect(core.get(E_LIGHT).eff.rooms).toEqual(['hall']);
        expect(core.get(E_LQ).eff.rooms).toEqual(['hall']);
        // the entity, in several rooms on two floors
        model.assign(E_LIGHT, { rooms: ['hall', 'stairs'] });
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: ['hall', 'stairs'], floors: ['ground', 'upper'] });
        expect(core.get(E_LQ).eff.rooms).toEqual(['hall']);
        // none, on purpose
        model.assign(E_LIGHT, { rooms: [] });
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: [], floors: [] });
        // back to inheriting
        model.assign(E_LIGHT, { rooms: null });
        expect(core.get(E_LIGHT).user).toEqual({});
        expect(core.get(E_LIGHT).eff.rooms).toEqual(['hall']);
        model.assign(D_LAMP, { rooms: [] });
        expect(core.get(E_LIGHT).eff.rooms).toEqual([]);
        model.assign(D_LAMP, { rooms: null });
        expect(core.get(E_LIGHT).eff.rooms).toEqual(['wohnzimmer']);
    });

    test('an entity in two rooms is listed in both, and once per floor', () => {
        model.assign(E_LIGHT, { rooms: ['hall', 'wohnzimmer'] });
        expect(core.get(E_LIGHT).eff.floors).toEqual(['ground']);
        expect(model.entities({ room: 'hall' }).map((e) => e._id)).toEqual([E_LIGHT]);
        expect(model.entities({ room: 'wohnzimmer' }).map((e) => e._id)).toEqual([E_LIGHT, E_LQ]);
        expect(model.entities({ floor: 'ground', hidden: false }).map((e) => e._id)).toEqual([E_LIGHT]);
        expect(model.entities({ floor: 'upper' })).toEqual([]);
        expect(model.devices({ room: 'wohnzimmer' }).map((d) => d._id)).toEqual([D_LAMP]);
    });

    test('floors follow the room; a floor that goes leaves its rooms without one', () => {
        model.updateRoom('wohnzimmer', { floor: 'upper' });
        expect(core.get(E_LIGHT).eff.floors).toEqual(['upper']);
        model.deleteFloor('upper');
        expect(core.get('she/room/wohnzimmer').floor).toBeNull();
        expect(core.get('she/room/stairs').floor).toBeNull();
        expect(core.get(E_LIGHT).eff.floors).toEqual([]);
        expect(model.floors().map((f) => f.id)).toEqual(['ground']);
    });

    test('functions: by hand → by rule → none', () => {
        expect(core.get(E_LIGHT).eff.functions).toEqual(['lighting']);
        expect(core.get(E_CONTACT).eff.functions).toEqual(['openings']);
        model.assign(E_CONTACT, { functions: ['security', 'openings'] });
        expect(core.get(E_CONTACT).eff.functions).toEqual(['security', 'openings']);
        model.assign(E_CONTACT, { functions: [] });
        expect(core.get(E_CONTACT).eff.functions).toEqual([]);
        model.assign(E_CONTACT, { functions: null });
        expect(core.get(E_CONTACT).eff.functions).toEqual(['openings']);
        expect(() => model.assign(E_CONTACT, { functions: ['nonsense'] })).toThrow(/unknown function/);
        expect(() => model.assign(D_WIN, { functions: ['openings'] })).toThrow(/no "functions"/);

        // a rule the user adds takes effect at once, in the order of the functions
        model.updateFunction('security', { rules: [{ component: 'binary_sensor', device_class: 'window' }] });
        expect(core.get(E_CONTACT).eff.functions).toEqual(['openings', 'security']);
        const id = model.createFunction({ name: 'Garten', rules: [{ component: 'light' }], order: 0 });
        expect(id).toBe('garten');
        expect(core.get(E_LIGHT).eff.functions).toEqual(['garten', 'lighting']);
        model.assign(E_LIGHT, { functions: ['garten'] });
        model.deleteFunction('garten');
        expect(core.get(E_LIGHT).user.functions).toEqual([]);
        expect(model.entities({ function: 'lighting' })).toEqual([]);
        expect(model.entities({ function: 'security' }).map((e) => e._id)).toEqual([E_CONTACT]);
    });

    test("labels: the device's and the entity's; a new label gets a document", () => {
        model.assign(D_LAMP, { labels: ['Christmas'] });
        model.assign(E_LIGHT, { labels: ['evening', 'christmas'] });
        expect(model.labels().map((l) => [l.id, l.name])).toEqual([
            ['christmas', 'Christmas'],
            ['evening', 'evening'],
        ]);
        expect(core.get(D_LAMP).eff.labels).toEqual(['christmas']);
        expect(core.get(E_LIGHT).eff.labels).toEqual(['christmas', 'evening']);
        expect(core.get(E_LQ).eff.labels).toEqual(['christmas']);
        expect(model.entities({ label: 'evening' }).map((e) => e._id)).toEqual([E_LIGHT]);
        model.updateLabel('evening', { name: 'Abend', icon: 'mdi:weather-night' });
        model.deleteLabel('christmas');
        expect(core.get(E_LIGHT).eff.labels).toEqual(['evening']);
        expect(core.get(D_LAMP).user.labels).toEqual([]);
    });

    test('hidden: entity → device → diagnostic and config entities', () => {
        expect(core.get(E_LIGHT).eff.hidden).toBe(false);
        expect(core.get(E_LQ).eff.hidden).toBe(true);
        model.assign(D_LAMP, { hidden: true });
        expect(core.get(D_LAMP).eff.hidden).toBe(true);
        expect(core.get(E_LIGHT).eff.hidden).toBe(true);
        model.assign(E_LIGHT, { hidden: false });
        expect(core.get(E_LIGHT).eff.hidden).toBe(false);
        model.assign(D_LAMP, { hidden: false });
        expect(core.get(E_LQ).eff.hidden).toBe(false);
        model.assign(D_LAMP, { hidden: null });
        expect(core.get(E_LQ).eff.hidden).toBe(true);
        expect(() => model.assign(E_LQ, { hidden: 'yes' })).toThrow(/hidden must be/);

        model.noteConfig('homeassistant/sensor/lamp1/age/config', { unique_id: 'lamp1_age', state_topic: 'x', enabled_by_default: false, device: { identifiers: ['z2m_lamp1'] } });
        model.flush();
        expect(core.get('she/entity/lamp1_age').eff.hidden).toBe(true);
    });

    test("names: the user's → the device's plus the entity's → the device's", () => {
        expect(core.get(E_LIGHT).eff.name).toBe('Floor lamp');
        expect(core.get(E_LQ).eff.name).toBe('Floor lamp Linkquality');
        model.assign(D_LAMP, { name: 'Stehlampe' });
        expect(core.get(D_LAMP).eff.name).toBe('Stehlampe');
        expect(core.get(E_LIGHT).eff.name).toBe('Stehlampe');
        expect(core.get(E_LQ).eff.name).toBe('Stehlampe Linkquality');
        model.assign(E_LQ, { name: 'Funk', notes: 'schwach' });
        expect(core.get(E_LQ).eff.name).toBe('Funk');
        expect(core.get(E_LQ).user).toEqual({ name: 'Funk', notes: 'schwach' });

        const announce = (id, cfg) =>
            model.noteConfig(`homeassistant/sensor/lamp1/${id}/config`, { unique_id: 'lamp1_' + id, state_topic: 'x', device: { identifiers: ['z2m_lamp1'] }, ...cfg });
        announce('t', { device_class: 'temperature' }); // no name at all: the device class names it
        announce('full', { name: 'Stehlampe energy' }); // already carries the device's name
        model.flush();
        expect(core.get('she/entity/lamp1_t').eff.name).toBe('Stehlampe Temperature');
        expect(core.get('she/entity/lamp1_full').eff.name).toBe('Stehlampe energy');
    });

    test('assign refuses what it does not know and writes nothing then', () => {
        updates.length = 0;
        expect(() => model.assign(E_LIGHT, { rooms: ['hall', 'nowhere'] })).toThrow(/unknown room: nowhere/);
        expect(() => model.assign(E_LIGHT, { colour: 'red' })).toThrow(/no "colour"/);
        expect(() => model.assign(E_LIGHT, { rooms: 'hall' })).toThrow(/list of ids/);
        expect(() => model.assign('she/entity/nothing', { name: 'x' })).toThrow(/unknown entity/);
        expect(() => model.assign('she/room/hall', { name: 'x' })).toThrow(/not a device or entity/);
        expect(updates).toEqual([]);
    });

    test('a change written straight into sheDB is followed', async () => {
        // the user section, by a script or the DB page
        core.prop(E_LIGHT, { method: 'set', prop: 'user.rooms', val: ['stairs'] });
        core.prop(D_LAMP, { method: 'set', prop: 'user.name', val: 'Leselampe' });
        await immediate();
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: ['stairs'], floors: ['upper'], name: 'Leselampe' });
        // a room, a function
        core.extend('she/room/stairs', { floor: 'ground' });
        core.extend('she/function/lighting', { rules: [] });
        await immediate();
        expect(core.get(E_LIGHT).eff).toMatchObject({ floors: ['ground'], functions: [] });
        // and its own writes do not make it run in circles
        updates.length = 0;
        await immediate();
        await immediate();
        expect(updates).toEqual([]);
    });

    test('what is read is a copy', () => {
        const entity = model.entity(E_LIGHT);
        entity.eff.rooms.push('x');
        model.rooms()[0].aliases.push('x');
        expect(core.get(E_LIGHT).eff.rooms).toEqual(['wohnzimmer']);
        expect(model.rooms()[0].aliases).not.toContain('x');
        expect(model.entity('nothing')).toBeNull();
        expect(model.entities({ component: 'light', present: true, device: 'z2m_lamp1' }).map((e) => e._id)).toEqual([E_LIGHT]);
        expect(model.devices({ adapter: 'Zigbee2MQTT' }).map((d) => d._id)).toEqual([D_LAMP]);
    });
});

describe('a capture of homeassistant/#', () => {
    test('the corpus becomes documents, and a second run writes nothing', () => {
        retained = new Map(corpus());
        model = makeModel();
        model.init({ fresh: true });
        model.enable({ language: 'en' });
        const entities = model.start();
        expect(entities).toBeGreaterThan(250);

        const status = model.status();
        expect(status.counts).toMatchObject({ entities, floors: 0, functions: 10, labels: 0, gone: 0 });
        expect(status.counts.devices).toBeGreaterThan(40);
        expect(model.rooms().map((r) => r.id)).toEqual(['bedroom', 'boiler-room', 'kueche', 'living-room']);

        // every document is well-formed
        for (const [id, doc] of Object.entries(core.docs)) {
            expect(id).toMatch(/^she\/(home|device|entity|room|function)(\/[^/+# ]+)?$/);
            expect(doc.schema).toBe(1);
            if (doc.kind === 'entity' || doc.kind === 'device') {
                expect(doc).toMatchObject({ source: 'ha', ha: { present: true, gone_since: null }, user: {} });
                expect(typeof doc.eff.name).toBe('string');
                expect(doc.eff.rooms.every((r) => core.get('she/room/' + r))).toBe(true);
            }
            if (doc.kind === 'entity') {
                expect(doc.ha.config).not.toHaveProperty('device');
                expect(doc.ha.config).not.toHaveProperty('~');
                if (doc.ha.device) expect(core.get(doc.ha.device).ha.entities).toContain(id);
            }
        }

        // samples from different publishers
        expect(model.entity('0x00124b0000000001_light_zigbee2mqtt')).toMatchObject({
            ha: { component: 'light', device: 'she/device/zigbee2mqtt_0x00124b0000000001', topics: { command: [expect.stringMatching(/\/set$/)] } },
            eff: { functions: ['lighting'], hidden: false },
        });
        expect(model.device('zigbee2mqtt_0x00124b0000000004').ha.triggers.length).toBe(8);
        expect(model.entity('shellyht-abc123-temperature').eff).toMatchObject({ rooms: ['bedroom'], functions: ['climate'] });
        expect(model.entity('shellyplus1-a1b2c3-temperature').eff).toMatchObject({ functions: [], hidden: true });
        expect(model.device('gasmeter/status')._id).toBe('she/device/gasmeter%2Fstatus');
        // the device-based form with abbreviated keys
        expect(model.entity('aa0000000008_mat')).toMatchObject({
            ha: { component: 'light', object_id: 'mat', config: { command_topic: 'awtrix/cmd/display' } },
            eff: { name: 'awtrix-ng Matrix' },
        });
        expect(model.entities({ function: 'openings' }).length).toBeGreaterThan(0);
        expect(model.entities({ function: 'security' }).some((e) => e.ha.component === 'lock')).toBe(true);
        expect(model.devices({ adapter: 'Zigbee2MQTT' }).length).toBeGreaterThan(3);

        updates.length = 0;
        model.reconcile();
        for (const [topic, obj] of corpus()) model.noteConfig(topic, obj.val);
        model.flush();
        expect(updates).toEqual([]);
    });
});

describe('in the daemon', () => {
    test('isFreshInstall: no config file, no sheDB file, no script', () => {
        const dir = path.join(tmpDir, 'install');
        const paths = { configPath: path.join(dir, 'config', 'config.json'), dbPath: path.join(dir, 'db'), scriptDirs: [path.join(dir, 'scripts')] };
        expect(home.isFreshInstall(paths)).toBe(true);
        fs.mkdirSync(paths.scriptDirs[0], { recursive: true });
        fs.writeFileSync(path.join(paths.scriptDirs[0], 'package.json'), '{}');
        expect(home.isFreshInstall(paths)).toBe(true);
        fs.writeFileSync(path.join(paths.scriptDirs[0], 'lights.js'), '');
        expect(home.isFreshInstall(paths)).toBe(false);
        fs.rmSync(path.join(paths.scriptDirs[0], 'lights.js'));
        fs.mkdirSync(paths.dbPath, { recursive: true });
        fs.writeFileSync(path.join(paths.dbPath, 'docs.json'), '{}');
        expect(home.isFreshInstall(paths)).toBe(false);
        fs.rmSync(path.join(paths.dbPath, 'docs.json'));
        fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
        fs.writeFileSync(paths.configPath, '{}');
        expect(home.isFreshInstall(paths)).toBe(false);
    });

    test('the state store feeds the model: announced, changed, cleared', () => {
        const store = new StateStore();
        store.setObject('mqtt::' + T_LIGHT, { val: lampLight(), ts: 1 });
        store.setObject('mqtt::zigbee2mqtt/lamp', { val: { state: 'ON' }, ts: 1 });
        const m = home.init({ core, store, log: noop, fresh: true });
        expect(home.getModel()).toBe(m);
        expect(m.enabled).toBe(true);
        // before the start nothing is mirrored: the retained state is still arriving
        store.setObject('mqtt::' + T_LQ, { val: lampLinkquality(), ts: 1 });
        expect(core.get(E_LIGHT)).toBeUndefined();
        home.start({ authoritative: true });
        expect(core.get(D_LAMP).ha.entities).toEqual([E_LIGHT, E_LQ]);

        store.setObject('mqtt::' + T_CONTACT, { val: contact(), ts: 2 });
        store.setObject('mqtt@other::' + T_CONTACT, { val: contact({ uniq_id: 'elsewhere' }), ts: 2 });
        store.delete('mqtt::' + T_LQ);
        m.flush();
        expect(core.get(E_CONTACT).ha.present).toBe(true);
        expect(core.get(E_LQ).ha.present).toBe(false);
        expect(core.get('she/entity/elsewhere')).toBeUndefined();
    });

    describe('/she/home', () => {
        let server, port;

        function request(method, body) {
            return new Promise((resolve, reject) => {
                const payload = body !== undefined ? JSON.stringify(body) : undefined;
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path: '/she/home',
                        method,
                        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
                    },
                    (res) => {
                        let data = '';
                        res.on('data', (c) => (data += c));
                        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
                    },
                );
                req.on('error', reject);
                if (payload) req.write(payload);
                req.end();
            });
        }

        beforeEach((done) => {
            const app = express();
            app.use(express.json());
            app.use('/she/home', require('../../src/web/home-api').router);
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                done();
            });
        });

        afterEach((done) => {
            server.close(done);
        });

        test('without sheDB it says so', async () => {
            expect(await request('GET')).toEqual({ status: 200, body: { available: false, enabled: false, decided: false, reason: expect.stringMatching(/sheDB/) } });
            expect((await request('PUT', { enabled: true })).status).toBe(503);
        });

        test('status, switching on with the language asked for, switching off', async () => {
            const store = new StateStore();
            store.setObject('mqtt::' + T_LIGHT, { val: lampLight(), ts: 1 });
            home.init({ core, store, log: noop, fresh: false });
            home.start({ authoritative: true });
            expect((await request('GET')).body).toMatchObject({ available: true, enabled: false, decided: false, counts: { entities: 0 } });
            expect((await request('PUT', {})).status).toBe(400);

            // the first switch-on needs the language of the seeded names
            expect(await request('PUT', { enabled: true })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/language/) } });
            expect((await request('PUT', { enabled: true, language: 'fr' })).status).toBe(400);
            expect(core.get('she/home')).toBeUndefined();

            const on = await request('PUT', { enabled: true, language: 'de' });
            expect(on).toMatchObject({
                status: 200,
                body: { available: true, enabled: true, decided: true, language: 'de', counts: { devices: 1, entities: 1, rooms: 1, functions: 10 } },
            });
            expect(core.get('she/function/openings').name).toBe('Fenster und Türen');

            const off = await request('PUT', { enabled: false });
            expect(off.body).toMatchObject({ enabled: false, decided: true, counts: { entities: 1 } });
            // on again: nobody is asked twice
            expect((await request('PUT', { enabled: true })).body).toMatchObject({ enabled: true, language: 'de' });
        });
    });
});
