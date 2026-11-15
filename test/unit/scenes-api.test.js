'use strict';

/**
 * The Scenes page's routes (src/web/scenes-api.js) over the scene engine and the entity layer:
 * lamps that answer, a lock that needs the confirmation, groups, the live state over the WebSocket.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const broadcasts = [];
jest.mock('../../src/web/log-ws', () => ({ broadcast: (msg) => broadcasts.push(msg) }));

const SheDBCore = require('../../src/lib/shedb-core');
const StateStore = require('../../src/lib/state-store');
const parsePayload = require('../../src/lib/parse-payload');
const { HomeModel } = require('../../src/lib/home-model');
const haEntities = require('../../src/lib/ha-entities');
const homeEntities = require('../../src/web/home-entities');
const scenesWeb = require('../../src/web/scenes');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const A = 'she/entity/lamp_a';
const B = 'she/entity/lamp_b';
const DOOR = 'she/entity/door';
const TEMP = 'she/entity/temp';

const lamp = (id, name) => ({ schema: 'json', name: null, uniq_id: `lamp_${id}`, stat_t: `z/${id}`, cmd_t: `z/${id}/set`, brightness: true, dev: { ids: `d_${id}`, name } });
const CONFIGS = {
    'homeassistant/light/a/config': lamp('a', 'Floor lamp'),
    'homeassistant/light/b/config': lamp('b', 'Ceiling lamp'),
    'homeassistant/lock/door/config': { name: null, uniq_id: 'door', stat_t: 'z/door', cmd_t: 'z/door/set', dev: { ids: 'd_door', name: 'Front door' } },
    'homeassistant/sensor/temp/config': { name: null, uniq_id: 'temp', stat_t: 'z/temp', unit_of_meas: '°C', dev: { ids: 'd_temp', name: 'Thermometer' } },
};

let tmpDir, core, store, model, server, port, published;

function feed(topic, payload) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const state = parsePayload(text);
    if (!state.ts) state.ts = Date.now();
    if (state.lc === undefined) state.lc = state.ts;
    store.setObject('mqtt::' + topic, state);
}

/** the lamps report what they are told */
function publish(topic, payload, options) {
    published.push([topic, payload, options]);
    if (topic === 'z/a/set' || topic === 'z/b/set') {
        const state = store.get('mqtt::' + topic.slice(0, -4)) || {};
        feed(topic.slice(0, -4), { ...state, ...JSON.parse(payload) });
    }
    return true;
}

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

beforeAll(async () => {
    await haEntities.load();
});

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-api-test-'));
    core = new SheDBCore({ dbPath: tmpDir, log: noop });
    await new Promise((resolve) => core.once('ready', resolve));
    store = new StateStore();
    published = [];
    broadcasts.length = 0;
    for (const [topic, config] of Object.entries(CONFIGS)) feed(topic, config);
    model = new HomeModel({ core, entries: () => store.mqttEntries(), log: noop, goneDelay: 0 });
    model.enable({ language: 'en' });
    model.start({ authoritative: true });
    feed('z/a', { state: 'OFF', brightness: 50 });
    feed('z/b', { state: 'OFF', brightness: 50 });
    feed('z/door', 'LOCKED');
    feed('z/temp', '21.5');
    const app = express();
    app.use(express.json());
    app.use('/she/scenes', require('../../src/web/scenes-api').router);
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve();
        });
    });
});

afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    scenesWeb.reset();
    homeEntities.reset();
    if (model) model.stop();
    clearTimeout(core._saveTimer);
    clearTimeout(core._saveViewsTimer);
    if (core._worker) await core._worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startEngine() {
    homeEntities.init({ core, store, log: noop, publish });
    scenesWeb.init({ core, publish, name: 'she', log: noop });
    scenesWeb.start();
}

test('without the engine: not available, changes refused', async () => {
    expect((await request('GET', '/she/scenes')).body).toMatchObject({ available: false, scenes: [], groups: [] });
    expect((await request('PUT', '/she/scenes/x', { doc: { name: 'x', members: [] } })).status).toBe(503);
});

test('snapshot, list, one scene with its members live, recall, deactivate', async () => {
    startEngine();
    const snap = await request('POST', '/she/scenes/evening/snapshot', { entities: [A, B, TEMP], fields: { name: 'Evening', deactivate: 'off', area: 'living' } });
    expect(snap.status).toBe(200);
    expect(snap.body.members).toEqual([
        expect.objectContaining({ entity: A, attributes: { state: 'OFF', brightness: 50 }, role: 'recall+match' }),
        expect.objectContaining({ entity: B, role: 'recall+match' }),
        expect.objectContaining({ entity: TEMP, role: 'match' }),
    ]);
    // change it: lamp A at 120
    const doc = { ...snap.body, members: snap.body.members.map((m) => (m.entity === A ? { ...m, attributes: { state: 'ON', brightness: 120 } } : m)) };
    expect((await request('PUT', '/she/scenes/evening', { doc })).status).toBe(200);

    const list = (await request('GET', '/she/scenes')).body;
    expect(list).toMatchObject({ available: true, scenes: [{ id: 'evening', name: 'Evening', area: 'living', val: false, members: 3 }] });

    const one = (await request('GET', '/she/scenes/evening')).body;
    expect(one.state).toMatchObject({ val: false, mismatch: [expect.objectContaining({ entity: A, attribute: 'state', is: 'OFF', want: 'ON' }), expect.anything()] });
    expect(one.members[A]).toMatchObject({ component: 'light', state: { state: 'OFF', brightness: 50 }, attributes: { brightness: expect.objectContaining({ write: true }) } });

    const r = await request('POST', '/she/scenes/evening/recall', {});
    expect(r.body).toMatchObject({ ok: true, sent: 1, skipped: 1 });
    expect(published.filter(([t]) => t === 'z/a/set')).toHaveLength(1);
    expect((await request('GET', '/she/scenes/evening')).body.state.val).toBe(true);
    expect((await request('POST', '/she/scenes/evening/recall', { force: true })).body).toMatchObject({ sent: 2 });

    expect((await request('POST', '/she/scenes/evening/deactivate')).body).toMatchObject({ ok: true, mode: 'off' });
    expect(store.get('mqtt::z/a').state).toBe('OFF');
    expect((await request('POST', '/she/scenes/nope/recall')).status).toBe(404);
});

test('the live members of entities not in a scene yet', async () => {
    startEngine();
    const r = await request('POST', '/she/scenes/entities', { ids: [A, 'she/entity/nope'] });
    expect(r.body[A]).toMatchObject({ component: 'light', snapshot: { state: 'OFF', brightness: 50 }, available: true });
    expect(r.body['she/entity/nope']).toBeNull();
});

test('a lock needs the confirmation: 409 naming it, then saved with confirmed members', async () => {
    startEngine();
    const doc = { name: 'Leave', members: [{ entity: DOOR, attributes: { state: 'LOCKED' } }] };
    const r = await request('PUT', '/she/scenes/leave', { doc });
    expect(r).toMatchObject({ status: 409, body: { confirm: ['Front door'] } });
    const ok = await request('PUT', '/she/scenes/leave', { doc, confirmSensitive: true });
    expect(ok.body).toMatchObject({ sensitive: true, members: [expect.objectContaining({ confirmed: true })] });
    // a lock as a condition needs nothing
    expect((await request('PUT', '/she/scenes/home', { doc: { name: 'Home', members: [{ entity: DOOR, attributes: { state: 'UNLOCKED' }, role: 'match' }] } })).status).toBe(200);
});

test('validation and ids', async () => {
    startEngine();
    expect((await request('PUT', '/she/scenes/a%20b', { doc: { name: 'x', members: [] } })).status).toBe(400);
    expect((await request('PUT', '/she/scenes/x', { doc: { name: 'x', members: [{ entity: 'lamp' }] } })).body.error).toMatch(/entity document id/);
    expect((await request('DELETE', '/she/scenes/x')).status).toBe(404);
});

test('groups: save, set, the live events, delete', async () => {
    startEngine();
    await request('PUT', '/she/scenes/bright', { doc: { name: 'Bright', members: [{ entity: A, attributes: { state: 'ON', brightness: 250 } }] } });
    await request('PUT', '/she/scenes/dim', { doc: { name: 'Dim', members: [{ entity: A, attributes: { state: 'ON', brightness: 20 } }] } });
    expect((await request('PUT', '/she/scenes/groups/living', { doc: { name: 'Living', scenes: ['bright', 'dim', 'ghost'] } })).status).toBe(200);
    expect((await request('PUT', '/she/scenes/groups/bad', { doc: { name: 'Bad', scenes: ['dim'], default: 'bright' } })).status).toBe(400);
    expect((await request('GET', '/she/scenes')).body.groups).toEqual([expect.objectContaining({ id: 'living', scenes: ['bright', 'dim', 'ghost'], val: '' })]);

    expect((await request('POST', '/she/scenes/groups/living/set', { scene: 'dim' })).body).toMatchObject({ ok: true, sent: 1 });
    expect((await request('POST', '/she/scenes/groups/living/set', { scene: 'other' })).status).toBe(409);
    // the scene's state goes out after the debounce, the group's after the turn
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(broadcasts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'scenes:scene', id: 'dim', state: expect.objectContaining({ val: true }) })]));
    expect(broadcasts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'scenes:group', id: 'living', state: expect.objectContaining({ val: 'dim' }) })]));

    expect((await request('DELETE', '/she/scenes/groups/living')).body).toEqual({ ok: true });
    expect((await request('DELETE', '/she/scenes/groups/living')).status).toBe(404);
    expect((await request('DELETE', '/she/scenes/dim')).body).toEqual({ ok: true });
});
