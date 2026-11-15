'use strict';

/**
 * Unit tests for the Home page's routes in src/web/home-api.js: the model in one read, the CRUD of
 * floors, rooms, functions and labels, merging and restoring rooms, bulk assignment and removing
 * what has gone — on a real sheDB core and home model.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const home = require('../../src/web/home');
const haEntities = require('../../src/lib/ha-entities');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const T_LIGHT = 'homeassistant/light/lamp1/light/config';
const T_LQ = 'homeassistant/sensor/lamp1/linkquality/config';
const T_CONTACT = 'homeassistant/binary_sensor/win1/contact/config';
const D_LAMP = 'she/device/z2m_lamp1';
const D_WIN = 'she/device/z2m_win1';
const E_LIGHT = 'she/entity/lamp1_light';
const E_LQ = 'she/entity/lamp1_linkquality';
const E_CONTACT = 'she/entity/win1_contact';

const lampLight = {
    name: null,
    unique_id: 'lamp1_light',
    state_topic: 'z2m/lamp',
    command_topic: 'z2m/lamp/set',
    device: { identifiers: ['z2m_lamp1'], name: 'Floor lamp', manufacturer: 'Signify', model: 'Hue', suggested_area: 'Living room' },
    origin: { name: 'Zigbee2MQTT' },
};
const lampLq = { name: 'Linkquality', unique_id: 'lamp1_linkquality', state_topic: 'z2m/lamp', entity_category: 'diagnostic', device: { identifiers: ['z2m_lamp1'] } };
const contact = {
    name: 'Contact',
    unique_id: 'win1_contact',
    state_topic: 'z2m/window',
    device_class: 'window',
    device: { identifiers: ['z2m_win1'], name: 'Window left', suggested_area: 'Bath' },
};

let tmpDir, core, store, server, port, model;

function request(method, url, body) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request(
            { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// the model expands discovery with mqtt-ha-entities, loaded before it starts
beforeAll(() => haEntities.load());

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-api-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    store = new StateStore();
    for (const [t, v] of [
        [T_LIGHT, lampLight],
        [T_LQ, lampLq],
        [T_CONTACT, contact],
    ])
        store.setObject('mqtt::' + t, { val: v, ts: 1 });
    const app = express();
    app.use(express.json());
    app.use('/she/home', require('../../src/web/home-api').router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve();
        });
    });
});

afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (model) model.stop();
    model = null;
    home.reset();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function enabled() {
    model = home.init({ core, store, log: noop, fresh: false });
    home.start({ authoritative: true });
    await request('PUT', '/she/home', { enabled: true, language: 'en' });
    model.flush?.();
    await settle();
    return model;
}

describe('/she/home/model', () => {
    test('without sheDB: only the status', async () => {
        expect((await request('GET', '/she/home/model')).body).toEqual({ status: expect.objectContaining({ available: false }) });
        expect((await request('POST', '/she/home/rooms', { name: 'x' })).status).toBe(503);
    });

    test('switched off: reads work, changes are refused', async () => {
        model = home.init({ core, store, log: noop, fresh: false });
        home.start({ authoritative: true });
        const r = await request('GET', '/she/home/model');
        expect(r.body.status).toMatchObject({ available: true, enabled: false, decided: false });
        expect((await request('POST', '/she/home/rooms', { name: 'x' })).status).toBe(409);
    });

    test('everything in one read, devices and entities without the config', async () => {
        await enabled();
        const { body } = await request('GET', '/she/home/model');
        expect(body.status).toMatchObject({ enabled: true, language: 'en' });
        expect(body.rooms.map((r) => r.id).sort()).toEqual(['bath', 'living-room']);
        expect(body.functions).toHaveLength(10);
        expect(body.devices.map((d) => d.id).sort()).toEqual([D_LAMP, D_WIN]);
        const light = body.entities.find((e) => e.id === E_LIGHT);
        expect(light).toMatchObject({
            ha: { component: 'light', device: D_LAMP, state_topic: 'z2m/lamp', present: true },
            eff: { rooms: ['living-room'], functions: ['lighting'] },
        });
        expect(light.ha).not.toHaveProperty('config');
        expect(body.entities.find((e) => e.id === E_LQ).eff.hidden).toBe(true);
    });
});

describe('floors, rooms, functions, labels', () => {
    test('create, update, delete a floor; a room on it', async () => {
        await enabled();
        const f = await request('POST', '/she/home/floors', { name: 'Ground floor', level: 0 });
        expect(f).toEqual({ status: 201, body: { id: 'ground-floor' } });
        expect((await request('POST', '/she/home/floors', { name: 'x', id: 'ground-floor' })).status).toBe(409);
        expect((await request('PATCH', '/she/home/rooms/bath', { floor: 'ground-floor', icon: 'mdi:shower', aliases: ['Bath', 'Bathroom'] })).body).toMatchObject({
            floor: 'ground-floor',
            icon: 'mdi:shower',
        });
        await settle();
        expect(core.get(E_CONTACT).eff.floors).toEqual(['ground-floor']);
        expect((await request('PATCH', '/she/home/rooms/bath', { floor: 'nowhere' })).status).toBe(400);
        expect((await request('PATCH', '/she/home/rooms/nope', { name: 'x' })).status).toBe(404);
        expect((await request('DELETE', '/she/home/floors/ground-floor')).body).toEqual({ ok: true });
        expect(core.get('she/room/bath').floor).toBeNull();
        expect((await request('POST', '/she/home/things', { name: 'x' })).status).toBe(404);
    });

    test('a deleted room is a rejected area, restore brings it back, purge forgets it', async () => {
        await enabled();
        await request('DELETE', '/she/home/rooms/bath');
        let m = (await request('GET', '/she/home/model')).body;
        expect(m.rooms.map((r) => r.id)).toEqual(['living-room']);
        expect(m.rejected.map((r) => r.id)).toEqual(['bath']);
        expect((await request('POST', '/she/home/rooms/restore', { id: 'bath' })).body).toEqual({ id: 'bath' });
        m = (await request('GET', '/she/home/model')).body;
        expect(m.rooms.map((r) => r.id).sort()).toEqual(['bath', 'living-room']);
        await request('DELETE', '/she/home/rooms/bath?purge=1');
        expect(core.get('she/room/bath')).toBeUndefined();
        expect((await request('POST', '/she/home/rooms/restore', { id: 'bath' })).status).toBe(404);
    });

    test('merge rooms', async () => {
        await enabled();
        await request('POST', '/she/home/rooms', { name: 'Wohnzimmer' });
        await request('POST', '/she/home/assign', { ids: [E_CONTACT], set: { rooms: ['wohnzimmer'] } });
        const r = await request('POST', '/she/home/rooms/merge', { keep: 'living-room', others: ['wohnzimmer'] });
        expect(r.body.aliases).toEqual(expect.arrayContaining(['Living room', 'Wohnzimmer']));
        expect(core.get(E_CONTACT).user.rooms).toEqual(['living-room']);
        expect((await request('POST', '/she/home/rooms/merge', { keep: 'living-room' })).status).toBe(400);
    });

    test('a function with its rules; labels', async () => {
        await enabled();
        const id = (await request('POST', '/she/home/functions', { name: 'Windows', rules: [{ component: 'binary_sensor', device_class: 'window' }] })).body.id;
        await settle();
        expect(core.get(E_CONTACT).eff.functions).toEqual(expect.arrayContaining(['openings', id]));
        expect((await request('PATCH', `/she/home/functions/${id}`, { rules: 'x' })).status).toBe(400);
        await request('DELETE', `/she/home/functions/${id}`);
        expect((await request('POST', '/she/home/labels', { name: 'Night light' })).body).toEqual({ id: 'night-light' });
    });
});

describe('/she/home/assign', () => {
    test('set several items at once; null inherits again', async () => {
        await enabled();
        const r = await request('POST', '/she/home/assign', { ids: [E_LIGHT, E_CONTACT], set: { rooms: ['Bath'], hidden: true } });
        expect(r.body).toEqual({ updated: 2, errors: [] });
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: ['bath'], hidden: true });
        await request('POST', '/she/home/assign', { ids: [E_LIGHT], set: { rooms: null, hidden: null } });
        expect(core.get(E_LIGHT).eff).toMatchObject({ rooms: ['living-room'], hidden: false });
    });

    test('add and remove start from the inherited list', async () => {
        await enabled();
        await request('POST', '/she/home/assign', { ids: [E_LIGHT], add: { rooms: ['bath'], labels: ['Evening'], functions: ['energy'] } });
        expect(core.get(E_LIGHT).user).toMatchObject({ rooms: ['living-room', 'bath'], labels: ['evening'], functions: ['lighting', 'energy'] });
        await request('POST', '/she/home/assign', { ids: [E_LIGHT], remove: { rooms: ['Living room'] } });
        expect(core.get(E_LIGHT).user.rooms).toEqual(['bath']);
        // a device has no functions: skipped, its rooms and labels still go
        expect((await request('POST', '/she/home/assign', { ids: [D_WIN], add: { functions: ['energy'], labels: ['evening'] } })).body).toEqual({ updated: 1, errors: [] });
        expect(core.get(D_WIN).user).toEqual({ labels: ['evening'] });
    });

    test('errors are per item', async () => {
        await enabled();
        const r = await request('POST', '/she/home/assign', { ids: [E_LIGHT, 'she/entity/nope'], set: { rooms: ['bath'] } });
        expect(r.body).toEqual({ updated: 1, errors: [{ id: 'she/entity/nope', error: expect.stringMatching(/unknown/) }] });
        expect((await request('POST', '/she/home/assign', { ids: [E_LIGHT], set: { rooms: ['nowhere'] } })).status).toBe(400);
        expect((await request('POST', '/she/home/assign', { ids: [E_LIGHT] })).status).toBe(400);
        expect((await request('POST', '/she/home/assign', { ids: [], set: {} })).status).toBe(400);
    });
});

describe('/she/home/remove', () => {
    test('only what has gone, a device with its entities', async () => {
        await enabled();
        expect((await request('POST', '/she/home/remove', { ids: [D_WIN] })).status).toBe(400);
        store.delete('mqtt::' + T_CONTACT);
        model.flush?.();
        await new Promise((resolve) => setTimeout(resolve, 600));
        model.flush?.();
        await settle();
        expect(core.get(D_WIN).ha.present).toBe(false);
        const r = await request('POST', '/she/home/remove', { ids: [D_WIN] });
        expect(r.body).toEqual({ removed: [D_WIN, E_CONTACT], errors: [] });
        expect(core.get(D_WIN)).toBeUndefined();
    });
});
