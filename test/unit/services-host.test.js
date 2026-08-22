'use strict';

/**
 * Unit tests for the Tier 1 part of services-api.js and src/lib/services-host.js:
 * a fake she-servicectl (node script) stands in for the real helper.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const StateStore = require('../../src/lib/state-store');
const host = require('../../src/lib/services-host');
const api = require('../../src/web/services-api');

const FAKE = path.join(__dirname, 'fixtures', 'fake-servicectl.js');

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

describe('services-host helpers', () => {
    test('parseJournal maps priorities and timestamps', () => {
        const lines = [
            JSON.stringify({ __REALTIME_TIMESTAMP: '1700000000000000', PRIORITY: '3', MESSAGE: 'boom', _PID: '7' }),
            JSON.stringify({ __REALTIME_TIMESTAMP: '1700000001000000', PRIORITY: '4', MESSAGE: 'meh' }),
            JSON.stringify({ __REALTIME_TIMESTAMP: '1700000002000000', PRIORITY: '6', MESSAGE: [104, 105] }),
            JSON.stringify({ PRIORITY: '7', MESSAGE: 'dbg' }),
            'garbage',
        ].join('\n');
        const r = host.parseJournal(lines);
        expect(r).toHaveLength(4);
        expect(r[0]).toEqual({ ts: 1700000000000, level: 'error', msg: 'boom', pid: 7 });
        expect(r[1]).toMatchObject({ level: 'warn', msg: 'meh', pid: null });
        expect(r[2]).toMatchObject({ level: 'info', msg: 'hi' });
        expect(r[3].level).toBe('debug');
    });

    test('parseEnvFile / formatEnvFile round trip', () => {
        const env = host.parseEnvFile('# c\nA=1\nB=two words\nbad line\nC=\n');
        expect(env).toEqual({ A: '1', B: 'two words', C: '' });
        expect(host.formatEnvFile({ A: '1', B: 'x\ny', C: '' }, ['hdr'])).toBe('# hdr\nA=1\nB=x y\n');
        expect(() => host.formatEnvFile({ 'bad-name': 'x' })).toThrow(/invalid env variable name/);
    });

    test('secretEnvVars: x-secret plus name heuristic', () => {
        const schema = {
            properties: {
                'mqtt-password': { 'x-env': 'X_MQTT_PASSWORD', 'x-secret': true },
                'api-token': { 'x-env': 'X_API_TOKEN' },
                'address': { 'x-env': 'X_ADDRESS' },
                'client-key': { 'x-env': 'X_CLIENT_KEY' },
            },
        };
        expect([...host.secretEnvVars(schema, ['MQTT_PASSWORD', 'MQTT_URL'])].sort()).toEqual(['MQTT_PASSWORD', 'X_API_TOKEN', 'X_MQTT_PASSWORD']);
        expect([...host.secretEnvVars(null, ['A_COOKIE', 'B'])]).toEqual(['A_COOKIE']);
    });

    test('mergeEnv keeps masked secrets, drops empties, validates names', () => {
        const cur = { A: '1', PW: 'secret' };
        expect(api.mergeEnv(cur, { A: '2', PW: '***', NEW: 'x', GONE: '' })).toEqual({ A: '2', PW: 'secret', NEW: 'x' });
        expect(api.mergeEnv({}, { PW: '***' })).toEqual({});
        expect(() => api.mergeEnv(cur, { 'x-y': '1' })).toThrow(/invalid env variable name/);
        expect(() => api.mergeEnv(cur, 'nope')).toThrow(/env object required/);
    });

    test('local driver: missing helper → HELPER_MISSING', async () => {
        const d = host.createLocalDriver({ helper: '/nonexistent/she-servicectl', sudo: false });
        await expect(d.exec(['list'])).rejects.toMatchObject({ code: 'HELPER_MISSING' });
    });

    test('local driver: helper errors → HELPER_FAILED with message', async () => {
        const d = host.createLocalDriver({ helper: FAKE, sudo: false });
        await expect(d.exec(['bogus'])).rejects.toMatchObject({ code: 'HELPER_FAILED', message: 'unknown command: bogus' });
    });
});

describe('services-api Tier 1 routes (fake helper)', () => {
    let server;
    let port;
    let logFile;
    let stateFile;

    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-svc-'));
        logFile = path.join(dir, 'calls.log');
        stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(stateFile, '{}');
        // jest sandboxes process.env — the fake needs the paths through the driver's env option
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: stateFile };
        api.setDriverFactory((h) => (h.ssh ? null : host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env })));
        api.init(new StateStore(), () => null);
        const app = express();
        app.use(express.json());
        app.locals.configPath = null; // → default host list [{name: 'local'}]
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });

    afterAll(async () => {
        api.stopAllFollowers();
        await new Promise((r) => server.close(r));
    });

    beforeEach(() => {
        fs.writeFileSync(logFile, '');
        fs.writeFileSync(stateFile, '{}');
    });

    test('GET /hosts lists adapters and instances of the local host', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts');
        expect(r.status).toBe(200);
        expect(r.body.hosts).toHaveLength(1);
        const h = r.body.hosts[0];
        expect(h).toMatchObject({ name: 'local', local: true, ok: true, hostname: 'zigbee', helper: 1, helperOutdated: false, brokerEnv: true });
        expect(h.adapters[0]).toMatchObject({ name: 'cul2mqtt', version: '1.1.1', origin: 'registry' });
        expect(h.instances[0]).toMatchObject({ adapter: 'cul2mqtt', instance: 'cul', active: 'active', unitFile: 'enabled' });
    });

    test('unknown host / bad names', async () => {
        expect((await httpRequest('GET', port, '/she/services/hosts/nope/adapters/cul2mqtt/schema')).status).toBe(404);
        expect((await httpRequest('GET', port, '/she/services/hosts/local/adapters/Bad%20Name/schema')).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/a%2Fb/restart')).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/explode')).status).toBe(400);
    });

    test('schema with secrets', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts/local/adapters/cul2mqtt/schema');
        expect(r.status).toBe(200);
        expect(r.body.schema['x-adapter'].name).toBe('cul2mqtt');
        expect(r.body.secrets.sort()).toEqual(['CUL2MQTT_API_TOKEN', 'CUL2MQTT_MQTT_PASSWORD']);
    });

    test('unit actions go through the helper', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/restart');
        expect(r.status).toBe(200);
        expect(calls()).toEqual([{ args: ['unit', 'cul2mqtt', 'cul', 'restart'], stdin: '' }]);
    });

    test('logs tail is parsed', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/logs?n=50');
        expect(r.status).toBe(200);
        expect(r.body.entries).toHaveLength(2);
        expect(r.body.entries[1]).toMatchObject({ level: 'warn', msg: 'device unreachable', pid: 42 });
        expect(calls()[0].args).toEqual(['logs', 'cul2mqtt', 'cul', '-n', '50']);
    });

    test('env read masks secrets; write keeps masked values and can restart', async () => {
        let r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/env');
        expect(r.status).toBe(200);
        expect(r.body.env).toEqual({ CUL2MQTT_SERIALPORT: '/dev/ttyACM0', CUL2MQTT_MQTT_PASSWORD: '***', CUL2MQTT_MQTT_URL: 'mqtt://broker' });
        expect(r.body.secrets).toContain('CUL2MQTT_MQTT_PASSWORD');
        expect(r.body.schema.title).toBe('cul2mqtt');

        fs.writeFileSync(logFile, '');
        r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', {
            env: { CUL2MQTT_SERIALPORT: '/dev/ttyUSB0', CUL2MQTT_MQTT_PASSWORD: '***', CUL2MQTT_MQTT_URL: '', CUL2MQTT_BAUDRATE: 38400 },
            restart: true,
        });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, restarted: true });
        const c = calls();
        expect(c.map((x) => x.args)).toEqual([
            ['env', 'cul2mqtt', 'cul', 'read'],
            ['env', 'cul2mqtt', 'cul', 'write'],
            ['unit', 'cul2mqtt', 'cul', 'restart'],
        ]);
        const written = c[1].stdin;
        expect(written).toMatch(/^# cul2mqtt instance "cul"/);
        expect(written).toContain('CUL2MQTT_SERIALPORT=/dev/ttyUSB0\n');
        expect(written).toContain('CUL2MQTT_MQTT_PASSWORD=hunter2\n'); // masked → kept
        expect(written).toContain('CUL2MQTT_BAUDRATE=38400\n');
        expect(written).not.toContain('CUL2MQTT_MQTT_URL'); // emptied → dropped
    });

    test('install passes options on stdin, uninstall stops followers first', async () => {
        let r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/install', {
            instance: 'cul2',
            env: { CUL2MQTT_SERIALPORT: '/dev/ttyACM1', CUL2MQTT_MQTT_PASSWORD: 'pw' },
        });
        expect(r.status).toBe(200);
        expect(r.body.output).toContain('cul2mqtt@cul2.service enabled');
        expect(calls()[0]).toEqual({ args: ['install', 'cul2mqtt', 'cul2'], stdin: 'CUL2MQTT_SERIALPORT=/dev/ttyACM1\nCUL2MQTT_MQTT_PASSWORD=pw\n' });
        expect((await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/install', { instance: 'x y' })).status).toBe(400);

        r = await httpRequest('DELETE', port, '/she/services/hosts/local/units/cul2mqtt/cul2');
        expect(r.status).toBe(200);
        expect(r.body.output).toContain('removed');
    });

    test('update: manual deploy needs force, then restarts active instances', async () => {
        fs.writeFileSync(stateFile, JSON.stringify({ origin: 'manual' }));
        let r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/update');
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MANUAL_DEPLOY');

        fs.writeFileSync(logFile, '');
        r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/update', { force: true });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, restarted: ['cul'], failed: [] });
        expect(calls().map((x) => x.args)).toEqual([['list'], ['npm', 'cul2mqtt', 'update'], ['unit', 'cul2mqtt', 'cul', 'restart']]);
    });

    test('broker-env read/write', async () => {
        let r = await httpRequest('GET', port, '/she/services/hosts/local/broker-env');
        expect(r.status).toBe(200);
        expect(r.body.env).toEqual({ MQTT_URL: 'mqtt://broker', MQTT_PASSWORD: '***' });
        fs.writeFileSync(logFile, '');
        r = await httpRequest('PUT', port, '/she/services/hosts/local/broker-env', { env: { MQTT_URL: 'mqtt://new', MQTT_PASSWORD: '***', MQTT_USERNAME: 'u' } });
        expect(r.status).toBe(200);
        expect(calls()[1].stdin).toBe(
            '# Shared broker settings for all mqtt-interfaces adapters on this host (edited via she).\nMQTT_URL=mqtt://new\nMQTT_PASSWORD=pw\nMQTT_USERNAME=u\n',
        );
    });

    test('follow: start, renew, stop', async () => {
        let r = await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/logs/follow');
        expect(r.body).toEqual({ ok: true, following: true, renewed: false });
        // the fake exits immediately after printing → follower is gone again; a renew starts a new one
        await new Promise((res) => setTimeout(res, 300));
        r = await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/logs/follow');
        expect(r.body.ok).toBe(true);
        r = await httpRequest('DELETE', port, '/she/services/hosts/local/units/cul2mqtt/cul/logs/follow');
        expect(r.body).toEqual({ ok: true, following: false });
        expect(calls()[0].args).toEqual(['logs', 'cul2mqtt', 'cul', '-n', '0', '--follow']);
    });

    test('remote host entries are reported as unsupported (I5)', async () => {
        const app = express();
        app.use(express.json());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-cfg-'));
        const cfgPath = path.join(dir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ services: { enabled: true, hosts: [{ name: 'local' }, { name: 'zigbee', ssh: { host: 'zigbee.lan' } }] } }));
        app.locals.configPath = cfgPath;
        app.use('/she/services', api.router);
        const s = http.createServer(app);
        await new Promise((r) => s.listen(0, '127.0.0.1', r));
        try {
            const r = await httpRequest('GET', s.address().port, '/she/services/hosts');
            expect(r.body.hosts.map((h) => [h.name, h.ok, h.code || null])).toEqual([
                ['local', true, null],
                ['zigbee', false, 'UNSUPPORTED'],
            ]);
            expect((await httpRequest('GET', s.address().port, '/she/services/hosts/zigbee/broker-env')).status).toBe(501);
        } finally {
            await new Promise((r) => s.close(r));
        }
    });
});
