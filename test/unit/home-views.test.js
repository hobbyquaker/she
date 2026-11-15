'use strict';

/**
 * The home model's standard views (src/lib/home-views.js), the view runner they share with the
 * sheDB worker, and the read part of she.home (src/sandbox/home-sandbox.js) — on the discovery corpus.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const { HomeModel } = require('../../src/lib/home-model');
const views = require('../../src/lib/home-views');
const { compileView, runView, resultLength } = require('../../src/lib/shedb-view');
const home = require('../../src/web/home');
const haEntities = require('../../src/lib/ha-entities');
const homeSandbox = require('../../src/sandbox/home-sandbox');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const FIXTURES = path.join(__dirname, 'fixtures', 'ha-discovery');

function corpus() {
    return fs
        .readdirSync(FIXTURES)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')).map((m) => [m.topic, { val: m.payload }]));
}

/** run one of she's views over the documents, the way the worker does (its result crosses postMessage) */
function run(id, docs = core.docs) {
    return structuredClone(runView(compileView(id, views.DEFINITIONS[id]), docs));
}

let tmpDir, core, model, retained;

async function newCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-views-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
}

/** the corpus mirrored, plus floors, a room on a floor, an entity in two rooms, a label, a hidden and a gone one */
function corpusModel() {
    retained = new Map(corpus());
    model = new HomeModel({ core, entries: () => retained, log: noop, goneDelay: 0 });
    model.init({ fresh: true });
    model.enable({ language: 'en' });
    model.start();
    model.createFloor({ id: 'ground', name: 'Ground floor', level: 0, order: 1 });
    model.createFloor({ id: 'upper', name: 'Upper floor', level: 1, order: 2 });
    model.updateRoom('living-room', { floor: 'ground', order: 1 });
    model.updateRoom('kueche', { floor: 'ground', order: 2 });
    model.updateRoom('bedroom', { floor: 'upper' });
    // the hallway light: in the living room and the kitchen
    model.assign('she/entity/0x00124b0000000001_light_zigbee2mqtt', { rooms: ['living-room', 'Küche'], labels: ['evening'] });
    return model;
}

// the model expands discovery with mqtt-ha-entities, loaded before it starts
beforeAll(() => haEntities.load());

beforeEach(newCore);

afterEach(async () => {
    if (model) model.stop();
    model = null;
    home.reset();
    homeSandbox.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const LIGHT = 'she/entity/0x00124b0000000001_light_zigbee2mqtt';

describe('the view runner', () => {
    test('a reduce may return an object, or any JSON value; the length counts keys', () => {
        const docs = { a: { _id: 'a', n: 1 }, b: { _id: 'b', n: 2 } };
        expect(runView(compileView('x', { map: 'emit(this.n)' }), docs)).toEqual([1, 2]);
        expect(runView(compileView('x', { map: 'emit(this.n)', reduce: 'return { sum: result[0] + result[1] }' }), docs)).toEqual({ sum: 3 });
        expect(runView(compileView('x', { map: 'emit(this.n)', reduce: 'return result.length' }), docs)).toBe(2);
        expect(runView(compileView('x', { filter: 'b', map: 'emit(this.n)' }), docs)).toEqual([2]);
        expect(resultLength({ a: 1, b: 2 })).toBe(2);
        expect(resultLength([1])).toBe(1);
        expect(() => compileView('x', { map: 'emit(' })).toThrow(/Unexpected/);
    });
});

describe('the standard views on the corpus', () => {
    beforeEach(corpusModel);

    test('every definition compiles and is marked as she’s, with the version', () => {
        expect(Object.keys(views.DEFINITIONS).sort()).toEqual([
            'she/devices/by-adapter',
            'she/devices/gone',
            'she/devices/unassigned',
            'she/entities/battery',
            'she/entities/by-component',
            'she/entities/by-floor',
            'she/entities/by-function',
            'she/entities/by-label',
            'she/entities/by-room',
            'she/entities/by-room-function',
            'she/floors',
            'she/rooms',
            'she/rooms/aggregates',
            'she/scenes/by-entity',
            'she/scenes/by-room',
            'she/topics',
        ]);
        for (const [id, def] of Object.entries(views.DEFINITIONS)) {
            expect(def).toMatchObject({ system: 'home', version: views.VERSION, filter: expect.any(String), description: expect.any(String) });
            expect(() => compileView(id, def)).not.toThrow();
        }
    });

    test('she/floors and she/rooms', () => {
        expect(run('she/floors')).toEqual([
            { id: 'ground', name: 'Ground floor', level: 0, order: 1, rooms: ['living-room', 'kueche'] },
            { id: 'upper', name: 'Upper floor', level: 1, order: 2, rooms: ['bedroom'] },
        ]);
        const rooms = run('she/rooms');
        expect(rooms.map((r) => [r.id, r.floor])).toEqual([
            ['living-room', 'ground'],
            ['kueche', 'ground'],
            ['bedroom', 'upper'],
            ['boiler-room', null],
        ]);
        expect(rooms[0]).toMatchObject({ name: 'Living room', order: 1, icon: null, aliases: ['Living room'] });
        const byRoom = run('she/entities/by-room');
        for (const r of rooms) expect(r.entities).toBe((byRoom[r.id] || []).length);
    });

    test('she/entities/by-room: an entity in two rooms is in both, unassigned under "", hidden ones nowhere', () => {
        const byRoom = run('she/entities/by-room');
        expect(Object.keys(byRoom)).toEqual(['', 'bedroom', 'boiler-room', 'kueche', 'living-room']);
        expect(byRoom['living-room'].map((e) => e.id)).toContain(LIGHT);
        expect(byRoom.kueche.map((e) => e.id)).toContain(LIGHT);
        const light = byRoom.kueche.find((e) => e.id === LIGHT);
        expect(light).toEqual({
            id: LIGHT,
            source: 'ha',
            name: expect.any(String),
            rooms: ['living-room', 'kueche'],
            floors: ['ground'],
            functions: ['lighting'],
            labels: ['evening'],
            component: 'light',
            device_class: null,
            unit: null,
            state_topic: expect.any(String),
            command_topic: expect.stringMatching(/\/set$/),
            device: 'she/device/zigbee2mqtt_0x00124b0000000001',
        });
        const all = Object.values(byRoom).flat();
        expect(all.some((e) => e.id === 'she/entity/shellyplus1-a1b2c3-temperature')).toBe(false); // hidden (diagnostic)
        // sorted by name
        for (const list of Object.values(byRoom)) expect(list.map((e) => e.name)).toEqual([...list.map((e) => e.name)].sort((a, b) => a.localeCompare(b)));
    });

    test('she/entities/by-floor: once per floor', () => {
        const byFloor = run('she/entities/by-floor');
        expect(Object.keys(byFloor)).toEqual(['', 'ground', 'upper']);
        expect(byFloor.ground.filter((e) => e.id === LIGHT)).toHaveLength(1);
        expect(byFloor.upper.every((e) => e.floors.includes('upper'))).toBe(true);
    });

    test('she/entities/by-function and by-room-function', () => {
        const byFunction = run('she/entities/by-function');
        expect(Object.keys(byFunction)).toEqual(expect.arrayContaining(['lighting', 'climate', 'openings', 'security']));
        expect(byFunction.lighting.map((e) => e.id)).toContain(LIGHT);
        expect(Object.values(byFunction).every((list) => list.every((e) => e.functions.length > 0))).toBe(true);

        const rf = run('she/entities/by-room-function');
        expect(rf.kueche.lighting.map((e) => e.id)).toContain(LIGHT);
        expect(rf['living-room'].lighting.map((e) => e.id)).toContain(LIGHT);
        expect(rf.bedroom.climate.map((e) => e.id)).toContain('she/entity/shellyht-abc123-temperature');
    });

    test('she/entities/by-component and by-label', () => {
        const byComponent = run('she/entities/by-component');
        expect(byComponent.light.map((e) => e.id)).toContain(LIGHT);
        expect(Object.entries(byComponent).every(([c, list]) => list.every((e) => e.component === c))).toBe(true);
        expect(run('she/entities/by-label')).toEqual({ evening: [expect.objectContaining({ id: LIGHT })] });
    });

    test('she/topics: every state topic → the entities that read it', () => {
        const topics = run('she/topics');
        const light = model.entity(LIGHT);
        for (const t of light.ha.topics.state) expect(topics[t].map((e) => e.id)).toContain(LIGHT);
        // hidden entities are there too: a reverse lookup should explain every message
        const hidden = model.entity('shellyplus1-a1b2c3-temperature');
        expect(topics[hidden.ha.topics.state[0]].map((e) => e.id)).toContain(hidden._id);
        // a zigbee2mqtt device topic carries several entities
        expect(Object.values(topics).some((list) => list.length > 1)).toBe(true);
    });

    test('she/devices/by-adapter, unassigned, gone', () => {
        const byAdapter = run('she/devices/by-adapter');
        expect(byAdapter.Zigbee2MQTT.length).toBe(model.devices({ adapter: 'Zigbee2MQTT' }).length);
        expect(byAdapter.Zigbee2MQTT[0]).toMatchObject({ id: expect.stringMatching(/^she\/device\//), present: true, gone_since: null, entities: expect.any(Number) });

        const unassigned = run('she/devices/unassigned');
        expect(unassigned.devices.length).toBeGreaterThan(0);
        expect(unassigned.devices.every((d) => d.rooms.length === 0 && d.present)).toBe(true);
        // the light has its own rooms while its device has none: it is not "unassigned"
        expect(unassigned.entities.map((e) => e.id)).not.toContain(LIGHT);
        // an entity without a room on a device that has one is listed on its own
        const shelly = model.entities({ room: 'bedroom' })[0];
        model.assign(shelly._id, { rooms: [] });
        expect(run('she/devices/unassigned').entities.map((e) => e.id)).toContain(shelly._id);

        expect(run('she/devices/gone')).toEqual([]);
        const device = model.device('zigbee2mqtt_0x00124b0000000004');
        for (const t of device.ha.config_topics) retained.delete(t);
        model.reconcile();
        expect(run('she/devices/gone')).toEqual([expect.objectContaining({ id: device._id, present: false, gone_since: expect.any(Number) })]);
    });

    test('she/entities/battery: battery entities with their device, hidden ones too', () => {
        const battery = run('she/entities/battery');
        expect(battery.length).toBeGreaterThan(0);
        expect(battery.every((e) => e.device_class === 'battery')).toBe(true);
        const withDevice = battery.find((e) => e.device);
        expect(withDevice.device_name).toBe(model.device(withDevice.device).eff.name);
    });
});

describe('the scene views', () => {
    const A = 'she/entity/lamp_a';
    const B = 'she/entity/lamp_b';
    const scene = (name, extra, ...entities) => ({ schema: 1, kind: 'scene', name, deactivate: 'none', members: entities.map((entity) => ({ entity, attributes: {} })), ...extra });

    beforeEach(async () => {
        await newCore();
        core.set('she/scene/movie', scene('Movie', { area: 'living-room', icon: 'mdi:movie', deactivate: 'restore' }, A, B));
        core.set('she/scene/evening', scene('Evening', { area: 'living-room' }, A));
        core.set('she/scene/leave', scene('Leave', { sensitive: true }, B, 'she/entity/door'));
        // not scenes: a restore point, a group, something a script put there
        core.set('she/scene/movie/restore', { recalled: 1, members: [{ entity: A, before: {}, scene: {} }] });
        core.set('she/scenegroup/living', { kind: 'scenegroup', name: 'Living room', scenes: ['evening', 'movie'] });
        core.set('she/scene/notes', { text: 'not a scene' });
    });

    test('she/scenes/by-room: the scene summaries per room, by name; without a room under ""', () => {
        expect(run('she/scenes/by-room')).toEqual({
            '': [{ id: 'leave', name: 'Leave', area: null, icon: null, deactivate: 'none', sensitive: true, members: 2 }],
            'living-room': [
                { id: 'evening', name: 'Evening', area: 'living-room', icon: null, deactivate: 'none', sensitive: false, members: 1 },
                { id: 'movie', name: 'Movie', area: 'living-room', icon: 'mdi:movie', deactivate: 'restore', sensitive: false, members: 2 },
            ],
        });
    });

    test('she/scenes/by-entity: the scenes an entity takes part in', () => {
        expect(run('she/scenes/by-entity')).toEqual({
            [A]: ['evening', 'movie'],
            [B]: ['leave', 'movie'],
            'she/entity/door': ['leave'],
        });
    });

    test('no scenes: empty objects', () => {
        expect(run('she/scenes/by-room', {})).toEqual({});
        expect(run('she/scenes/by-entity', {})).toEqual({});
    });

    test('a room merge moves the scenes with it', async () => {
        const model = new HomeModel({ core, entries: () => new Map(), log: noop, goneDelay: 0 });
        model.enable({ language: 'en' });
        model.start({ authoritative: true });
        model.createRoom({ id: 'living-room', name: 'Living room' });
        model.createRoom({ id: 'lounge', name: 'Lounge' });
        model.mergeRooms('lounge', ['living-room']);
        expect(Object.keys(run('she/scenes/by-room')).sort()).toEqual(['', 'lounge']);
        model.stop();
    });
});

describe('installed into sheDB', () => {
    test('written while the model is on, computed by the worker, kept switches, removed when it goes off', async () => {
        corpusModel();
        home.syncViews(core, noop);
        expect(Object.keys(core.queries).filter((id) => id.startsWith('she/')).length).toBe(16);
        const computed = new Promise((resolve) => {
            const seen = (id, view) => {
                if (id === 'she/entities/by-room' && view && view.result) {
                    core.off('view', seen);
                    resolve(view);
                }
            };
            core.on('view', seen);
        });
        const view = await computed;
        expect(view.result.kueche.map((e) => e.id)).toContain(LIGHT);
        expect(view.length).toBe(Object.keys(view.result).length);

        // the user switched publishing on: a second install keeps it and writes nothing
        core.queries['she/rooms'] = { ...core.queries['she/rooms'], mqttpub: true, retain: true };
        expect(views.install(core)).toEqual({ written: [], removed: [] });
        // an older definition is written again; an obsolete one of she's goes
        core.queries['she/floors'] = { ...core.queries['she/floors'], version: 0 };
        core.queries['she/old'] = { map: '', system: 'home', version: 0 };
        expect(views.install(core)).toEqual({ written: ['she/floors'], removed: ['she/old'] });
        expect(core.queries['she/rooms']).toMatchObject({ mqttpub: true, retain: true, version: views.VERSION });

        model.disable();
        home.syncViews(core, noop);
        expect(Object.keys(core.queries).filter((id) => id.startsWith('she/'))).toEqual([]);
    });

    test('home.init installs them for a model that is on', () => {
        const store = new StateStore();
        core.set('she/home', { schema: 1, kind: 'home', enabled: true, language: 'en' });
        home.init({ core, store, log: noop });
        expect(views.isSystemView(core.queries['she/topics'])).toBe(true);
        home.getModel().disable();
        expect(core.queries['she/topics']).toBeUndefined();
    });
});

describe('read-only', () => {
    let server, port, shedb;

    function request(method, id, body) {
        return new Promise((resolve, reject) => {
            const payload = body !== undefined ? JSON.stringify(body) : undefined;
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/she/db/views/' + id.split('/').map(encodeURIComponent).join('/'),
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
        shedb = require('../../src/web/shedb');
        const dir = path.join(tmpDir, 'db2');
        const c = shedb.init({ dbPath: dir, log: noop, broadcast: () => {} });
        c.once('ready', () => {
            views.install(c);
            const app = express();
            app.use(express.json());
            app.use('/she/db', require('../../src/web/shedb-api').router);
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                done();
            });
        });
    });

    afterEach(async () => {
        await new Promise((r) => server.close(r));
        const c = shedb.getCore();
        clearTimeout(c._saveTimer);
        clearTimeout(c._saveViewsTimer);
        if (c._worker) await c._worker.terminate();
    });

    test('the views API changes only mqttpub and retain, and refuses a delete', async () => {
        const c = shedb.getCore();
        const before = c.queries['she/rooms'];
        expect(await request('PUT', 'she/rooms', { map: 'emit(1)', mqttpub: true })).toEqual({ status: 200, body: { ok: true, system: true } });
        expect(c.queries['she/rooms']).toEqual({ ...before, mqttpub: true });
        expect((await request('GET', 'she/rooms')).body.system).toBe('home');
        expect(await request('DELETE', 'she/rooms')).toMatchObject({ status: 403, body: { error: expect.stringMatching(/standard views/) } });
        expect(c.queries['she/rooms']).toBeDefined();
        // other views stay as they were
        expect((await request('PUT', 'mine', { map: 'emit(1)' })).status).toBe(200);
        expect((await request('DELETE', 'mine')).status).toBe(200);
    });

    test('she.db.setView refuses them', () => {
        const she = {};
        require('../../src/sandbox/shedb-sandbox')(she, { scriptDomain: { bind: (f) => f }, scriptName: 't', scriptFile: '/t.js' });
        expect(() => she.db.setView('she/rooms', { map: 'emit(1)' })).toThrow(/read-only/);
    });
});

describe('she.home', () => {
    let she, store, hooks;

    function sandbox() {
        store = new StateStore();
        hooks = [];
        she = {};
        homeSandbox(she, { scriptDomain: { bind: (f) => f }, store, onUnload: (fn) => hooks.push(fn), warn: () => {} });
        return she;
    }

    test('without sheDB every call says so', () => {
        sandbox();
        expect(() => she.home.rooms()).toThrow(/needs sheDB/);
    });

    test('floors(), rooms(), entities(): the shapes of the views, current at the call', () => {
        corpusModel();
        home.init({ core, store: new StateStore(), log: noop }); // takes over the corpus model's documents
        model.stop();
        model = home.getModel();
        sandbox();
        expect(she.home.floors()).toEqual(run('she/floors'));
        expect(she.home.rooms()).toEqual(run('she/rooms'));
        const kitchen = she.home.entities({ room: 'kueche' });
        expect(kitchen).toEqual(run('she/entities/by-room').kueche);
        // a name or an alias works too; '' is the unassigned ones; selections combine
        expect(she.home.entities({ room: 'Küche', function: 'lighting' }).map((e) => e.id)).toContain(LIGHT);
        expect(she.home.entities({ room: '' })).toEqual(run('she/entities/by-room')['']);
        expect(she.home.entities({ floor: 'upper' })).toEqual(run('she/entities/by-floor').upper);
        expect(she.home.entities({ component: 'light', label: 'evening' }).map((e) => e.id)).toEqual([LIGHT]);
        expect(she.home.entities({ room: 'nowhere' })).toEqual([]);
        expect(she.home.entities({ hidden: true }).length).toBeGreaterThan(she.home.entities().length);
        expect(() => she.home.entities({ rom: 'x' })).toThrow(/unknown selection key "rom"/);
        expect(() => she.home.entities('kitchen')).toThrow(/selection is an object/);

        // assign: the summary afterwards, by document id or unique_id
        const lamp = she.home.assign('0x00124b0000000001_light_zigbee2mqtt', { rooms: ['bedroom'] });
        expect(lamp).toMatchObject({ id: LIGHT, rooms: ['bedroom'], floors: ['upper'] });
        expect(she.home.entities({ room: 'bedroom' }).map((e) => e.id)).toContain(LIGHT);
        const device = she.home.assign(lamp.device, { name: 'Hallway lamp' });
        expect(device).toMatchObject({ id: lamp.device, name: 'Hallway lamp' });
        expect(() => she.home.assign('nothing', { rooms: [] })).toThrow(/no entity or device/);
        expect(() => she.home.assign(LIGHT, { colour: 'red' })).toThrow(/no "colour"/);
    });

    test('sub(): messages on the state topics of the selection, following moves, cancelled on unload', async () => {
        corpusModel();
        home.init({ core, store: new StateStore(), log: noop });
        model.stop();
        model = home.getModel();
        sandbox();
        const seen = [];
        const handle = she.home.sub({ room: 'kueche', function: 'lighting' }, (e, val, obj, prev, topic) => seen.push([e.id, val, topic]));
        const light = handle.entities().find((e) => e.id === LIGHT);
        expect(light).toBeDefined();
        store.setObject('mqtt::' + light.state_topic, { val: { state: 'ON' }, ts: 1 });
        store.setObject('mqtt::other/topic', { val: 1, ts: 1 });
        expect(seen).toEqual([[LIGHT, { state: 'ON' }, light.state_topic]]);

        // { change: true } leaves out a repeated value
        const changes = [];
        she.home.sub({ room: 'kueche' }, { change: true }, (e, val) => changes.push(val));
        store.setObject('mqtt::' + light.state_topic, { val: 'X', ts: 2 });
        store.setObject('mqtt::' + light.state_topic, { val: 'X', ts: 3 });
        expect(changes.filter((v) => v === 'X').length).toBe(1);

        // the light moves out of the kitchen: the subscription follows on the next turn
        model.assign(LIGHT, { rooms: ['bedroom'] });
        await new Promise((r) => setImmediate(r));
        expect(handle.entities().map((e) => e.id)).not.toContain(LIGHT);
        seen.length = 0;
        store.setObject('mqtt::' + light.state_topic, { val: 'Y', ts: 4 });
        expect(seen.filter(([id]) => id === LIGHT)).toEqual([]);

        // unload: the hooks cancel every subscription
        model.assign(LIGHT, { rooms: ['kueche'] });
        await new Promise((r) => setImmediate(r));
        hooks.forEach((fn) => fn());
        store.setObject('mqtt::' + light.state_topic, { val: 'Z', ts: 5 });
        expect(seen).toEqual([]);
        expect(() => she.home.sub({ room: 'kueche' })).toThrow(/callback/);
    });
});

describe('cost', () => {
    test('recomputing every view over ~700 entities', () => {
        corpusModel();
        // the corpus three times over, as different devices: ~800 entities, ~130 devices
        const docs = { ...core.docs };
        for (const copy of [2, 3]) {
            for (const [id, doc] of Object.entries(core.docs)) {
                if (doc.kind !== 'entity' && doc.kind !== 'device') continue;
                const c = structuredClone(doc);
                c._id = `${id}_${copy}`;
                if (c.ha.device) c.ha.device = `${c.ha.device}_${copy}`;
                docs[c._id] = c;
            }
        }
        const entities = Object.values(docs).filter((d) => d.kind === 'entity').length;
        expect(entities).toBeGreaterThan(700);
        const scripts = Object.entries(views.DEFINITIONS).map(([id, def]) => [id, compileView(id, def)]);
        for (const [, s] of scripts) runView(s, docs); // warm up
        const times = {};
        const t0 = process.hrtime.bigint();
        for (const [id, s] of scripts) {
            const t = process.hrtime.bigint();
            runView(s, docs);
            times[id] = Number(process.hrtime.bigint() - t) / 1e6;
        }
        const total = Number(process.hrtime.bigint() - t0) / 1e6;
        // printed for the record; the bound only catches something going badly wrong
        console.log(
            `home views over ${entities} entities, ${Object.keys(docs).length} documents: ${total.toFixed(1)} ms in all\n` +
                Object.entries(times)
                    .map(([id, ms]) => `  ${id}: ${ms.toFixed(1)} ms`)
                    .join('\n'),
        );
        expect(total).toBeLessThan(5000);
    });
});
