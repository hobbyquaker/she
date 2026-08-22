'use strict';

/**
 * Unit tests for src/web/services-api.js (roadmap I4, Tier 0) — a fake state
 * store and a fake mqtt client, no network (npm registry lookups are stubbed).
 */

const http = require('http');
const express = require('express');
const StateStore = require('../../src/lib/state-store');
const npmRegistry = require('../../src/lib/npm-registry');
const { router, init } = require('../../src/web/services-api');

const T = 1700000000000;

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

const info = (name, extra = {}) => ({
    name,
    version: '1.0.0',
    spec: '2.0',
    node: 'v22.0.0',
    host: 'zigbee',
    pid: 1,
    started: new Date(T).toISOString(),
    maintenance: true,
    ...extra,
});

let server;
let port;
let store;
let published;
let mqtt;

beforeAll(async () => {
    npmRegistry.setFetch(async (url) => {
        if (url.includes('/cul2mqtt/latest')) return { ok: true, json: async () => ({ version: '1.2.0' }) };
        return { ok: false, status: 404 };
    });
    store = new StateStore();
    published = [];
    mqtt = {
        publish(topic, payload, opts, cb) {
            published.push({ topic, payload, retain: opts.retain });
            cb(null);
        },
    };
    init(store, () => mqtt);
    const app = express();
    app.use(express.json());
    app.locals.configPath = null;
    app.use('/she/services', router);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});

afterAll(async () => {
    npmRegistry.clearCache();
    await new Promise((r) => server.close(r));
});

beforeEach(() => {
    published.length = 0;
    for (const k of store.keys()) store.delete(k);
    store.setObject('mqtt::cul/info', { val: info('cul2mqtt'), ts: T, lc: T });
    store.setObject('mqtt::cul/connected', { val: 2, ts: T, lc: T });
    store.setObject('mqtt::cul/status/EM/01/power', { val: { val: 1 }, ts: T, lc: T });
    store.setObject('mqtt::old/info', { val: info('old2mqtt', { maintenance: false }), ts: T, lc: T });
    store.setObject('mqtt::old/connected', { val: 0, ts: T, lc: T });
    store.setObject('mqtt::old/status/x', { val: 1, ts: T, lc: T });
    store.setObject('mqtt::hm/connected', { val: 2, ts: T, lc: T });
});

describe('GET /she/services/instances', () => {
    test('inventory with update badge', async () => {
        const r = await httpRequest('GET', port, '/she/services/instances');
        expect(r.status).toBe(200);
        expect(r.body.enabled).toBe(false);
        expect(r.body.coreCount).toBe(2);
        expect(r.body.legacyCount).toBe(1);
        const cul = r.body.instances.find((i) => i.instance === 'cul');
        expect(cul).toMatchObject({ adapter: 'cul2mqtt', version: '1.0.0', latestVersion: '1.2.0', updateAvailable: true, connected: 2 });
        const old = r.body.instances.find((i) => i.instance === 'old');
        expect(old).toMatchObject({ adapter: 'old2mqtt', latestVersion: null, updateAvailable: null, connected: 0 });
        const hm = r.body.instances.find((i) => i.instance === 'hm');
        expect(hm).toMatchObject({ legacy: true, latestVersion: null });
    });
});

describe('maintenance actions', () => {
    test('restart publishes to the maintenance topic', async () => {
        const r = await httpRequest('POST', port, '/she/services/instances/cul/restart');
        expect(r.status).toBe(200);
        expect(published).toEqual([{ topic: 'cul/maintenance/set/restart', payload: '', retain: false }]);
    });
    test('loglevel validates the level', async () => {
        let r = await httpRequest('POST', port, '/she/services/instances/cul/loglevel', { level: 'debug' });
        expect(r.status).toBe(200);
        expect(published).toEqual([{ topic: 'cul/maintenance/set/loglevel', payload: 'debug', retain: false }]);
        r = await httpRequest('POST', port, '/she/services/instances/cul/loglevel', { level: 'trace' });
        expect(r.status).toBe(400);
    });
    test('refuses legacy, --no-maintenance and unknown instances', async () => {
        expect((await httpRequest('POST', port, '/she/services/instances/hm/restart')).status).toBe(409);
        expect((await httpRequest('POST', port, '/she/services/instances/old/restart')).status).toBe(409);
        expect((await httpRequest('POST', port, '/she/services/instances/nope/restart')).status).toBe(404);
        expect((await httpRequest('POST', port, '/she/services/instances/a%2Fb/restart')).status).toBe(400);
        expect(published).toEqual([]);
    });
    test('503 without mqtt', async () => {
        const saved = mqtt;
        mqtt = null;
        try {
            expect((await httpRequest('POST', port, '/she/services/instances/cul/restart')).status).toBe(503);
        } finally {
            mqtt = saved;
        }
    });
});

describe('retained topics', () => {
    test('GET lists what a wipe would clear', async () => {
        const r = await httpRequest('GET', port, '/she/services/instances/old/retained');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ own: ['old/connected', 'old/info', 'old/status/x'], discovery: [] });
    });
    test('DELETE clears a gone instance, refuses a connected one', async () => {
        let r = await httpRequest('DELETE', port, '/she/services/instances/cul/retained');
        expect(r.status).toBe(409);
        r = await httpRequest('DELETE', port, '/she/services/instances/old/retained');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, cleared: 3, errors: [] });
        expect(published.map((p) => p.topic).sort()).toEqual(['old/connected', 'old/info', 'old/status/x']);
        expect(published.every((p) => p.retain === true && p.payload === '')).toBe(true);
    });
});
