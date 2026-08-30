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
const npmRegistry = require('../../src/lib/npm-registry');
const nodeReleases = require('../../src/lib/node-releases');

// the hosts listing looks up the latest version of every installed adapter — no network in tests
beforeAll(() => {
    npmRegistry.setFetch(async (url) => (url.includes('/cul2mqtt/latest') ? { ok: true, json: async () => ({ version: '1.2.0' }) } : { ok: false, status: 404 }));
});
afterAll(() => npmRegistry.clearCache());

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
    let defaultDrivers; // so a test that swaps the driver factory can put it back
    let driverEnv; // the fake's env (log/state paths), for a test that needs to add to it

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
        driverEnv = env;
        defaultDrivers = (h) => (h.ssh ? null : host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }));
        api.setDriverFactory(defaultDrivers);
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
        expect(h).toMatchObject({ name: 'local', local: true, ok: true, hostname: 'zigbee', helper: host.HELPER_VERSION, helperOutdated: false, brokerEnv: true });
        expect(h.adapters[0]).toMatchObject({ name: 'cul2mqtt', version: '1.1.1', origin: 'registry' });
        expect(h.instances[0]).toMatchObject({ adapter: 'cul2mqtt', instance: 'cul', active: 'active', unitFile: 'enabled' });
    });

    test('a host on an older helper is reported outdated, so the UI can offer the update', async () => {
        /*
         * The whole point of the flag: it is what puts the "outdated" pill and the Update helper
         * button on the Hosts page. It went unnoticed when v12 shipped with HELPER_VERSION still
         * at 11 — every host looked current and no update was ever offered.
         */
        const older = String(host.HELPER_VERSION - 1);
        // the driver captures its env when it is built, so the version goes in through the factory
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env: { ...driverEnv, FAKE_HELPER_VERSION: older } }));
        try {
            // ?refresh=1: the listing is cached for a minute and an earlier test already filled it
            const r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
            expect(r.body.hosts[0]).toMatchObject({ ok: true, helper: Number(older), helperOutdated: true });
        } finally {
            api.setDriverFactory(defaultDrivers);
            // the listing above is now cached against the older driver: refill it with the real one
            await httpRequest('GET', port, '/she/services/hosts?refresh=1');
        }
    });

    test('node update runs n on the host and flags the pending restart', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/node/update', { channel: 'latest' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, spec: 'latest', before: 'v20.11.0', after: 'v24.2.0', n: '10.2.0', nInstalled: true, mismatch: false, restartRequired: true });
        expect(calls().some((c) => c.args.join(' ') === 'node update --latest')).toBe(true);
    });

    test("node update defaults to lts and hands n's own labels through", async () => {
        await httpRequest('POST', port, '/she/services/hosts/local/node/update', {});
        await httpRequest('POST', port, '/she/services/hosts/local/node/update', { channel: 'stable' });
        // stable and lts are the same release to n, but the label it is asked for is its own
        expect(calls().filter((c) => c.args.join(' ') === 'node update --lts')).toHaveLength(1);
        expect(calls().filter((c) => c.args.join(' ') === 'node update --stable')).toHaveLength(1);
    });

    test('node update reports a node that another install shadows', async () => {
        api.setDriverFactory((h) =>
            host.createLocalDriver({
                helper: FAKE,
                sudo: false,
                name: h.name,
                env: { ...driverEnv, FAKE_NODE_MISMATCH: '1', FAKE_NODE_AFTER: 'v20.11.0', FAKE_NODE_ACTIVE_PATH: '/opt/node20/bin/node' },
            }),
        );
        try {
            const r = await httpRequest('POST', port, '/she/services/hosts/local/node/update', {});
            // n installed a new node, but PATH still resolves the old one — nothing to restart yet
            expect(r.body).toMatchObject({ ok: true, mismatch: true, installed: 'v24.2.0', after: 'v20.11.0', activePath: '/opt/node20/bin/node', restartRequired: false });
        } finally {
            api.setDriverFactory(defaultDrivers);
        }
    });

    test('GET /node/releases reports what an update would install', async () => {
        nodeReleases.clearCache();
        nodeReleases.setFetch(async () => ({
            ok: true,
            json: async () => [
                { version: 'v26.8.1', lts: false },
                { version: 'v25.0.0', lts: false },
                { version: 'v24.20.0', lts: 'Krypton' },
                { version: 'v22.20.0', lts: 'Jod' },
            ],
        }));
        try {
            const r = await httpRequest('GET', port, '/she/services/node/releases');
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ latest: 'v26.8.1', lts: 'v24.20.0', ltsName: 'Krypton', stale: false });
        } finally {
            nodeReleases.clearCache();
        }
    });

    test('GET /node/releases resolves the newest build per architecture', async () => {
        // an old Pi has no build of the newest lines: offering it one promises an install that
        // cannot work — index.json lists the files of each release, so ask those
        nodeReleases.clearCache();
        nodeReleases.setFetch(async () => ({
            ok: true,
            json: async () => [
                { version: 'v26.8.1', lts: false, files: ['linux-x64', 'linux-arm64'] },
                { version: 'v24.20.0', lts: 'Krypton', files: ['linux-x64', 'linux-arm64'] },
                { version: 'v23.11.1', lts: false, files: ['linux-x64', 'linux-arm64', 'linux-armv7l'] },
                { version: 'v22.20.0', lts: 'Jod', files: ['linux-x64', 'linux-arm64', 'linux-armv7l'] },
            ],
        }));
        try {
            const r = await httpRequest('GET', port, '/she/services/node/releases');
            expect(r.body).toMatchObject({ latest: 'v26.8.1', lts: 'v24.20.0' });
            expect(r.body.byArch.x64).toEqual({ lts: 'v24.20.0', latest: 'v26.8.1' });
            expect(r.body.byArch.armv7l).toEqual({ lts: 'v22.20.0', latest: 'v23.11.1' });
            // a host reports what uname says, and that name finds the same entry
            expect(r.body.byArch.x86_64).toEqual(r.body.byArch.x64);
            expect(r.body.byArch.aarch64).toEqual(r.body.byArch.arm64);
            // nothing is built for it at all
            expect(r.body.byArch.armv6l).toBeUndefined();
        } finally {
            nodeReleases.clearCache();
        }
    });

    test('node update installs the exact version it was given', async () => {
        fs.writeFileSync(logFile, '');
        const r = await httpRequest('POST', port, '/she/services/hosts/local/node/update', { channel: 'lts', version: 'v22.20.0' });
        expect(r.status).toBe(200);
        expect(calls().find((c) => c.args[0] === 'node').args).toEqual(['node', 'update', '--version', 'v22.20.0']);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/node/update', { version: '22; rm -rf /' })).status).toBe(400);
    });

    test('GET /node/releases keeps the last answer when nodejs.org is unreachable', async () => {
        nodeReleases.clearCache();
        nodeReleases.setFetch(async () => {
            throw new Error('offline');
        });
        try {
            const r = await httpRequest('GET', port, '/she/services/node/releases');
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ latest: null, lts: null, stale: true });
        } finally {
            nodeReleases.clearCache();
        }
    });

    test('node update rejects an unknown channel', async () => {
        expect((await httpRequest('POST', port, '/she/services/hosts/local/node/update', { channel: 'nightly' })).status).toBe(400);
    });

    test('node update on an older helper answers HELPER_OUTDATED', async () => {
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env: { ...driverEnv, FAKE_OLD_HELPER: '1' } }));
        try {
            const r = await httpRequest('POST', port, '/she/services/hosts/local/node/update', {});
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('HELPER_OUTDATED');
        } finally {
            api.setDriverFactory(defaultDrivers);
        }
    });

    test('restart-all reports what it restarted', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/instances/restart-all');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, restarted: [{ adapter: 'cul2mqtt', instance: 'cul', ok: true, error: null }], failed: [] });
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

    test('discover: shapes the adapter scan, marks the stick an instance already runs on (I13)', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', {});
        expect(r.status).toBe(200);
        expect(r.body.property).toBe('serialport');
        expect(r.body.envName).toBe('CUL2MQTT_SERIALPORT');
        expect(r.body.kinds).toEqual(['serial']);
        expect(r.body.devices).toHaveLength(2);
        // the by-id path is what goes into the config — it survives a replug, /dev/ttyACM0 does not
        expect(r.body.devices[0].value).toBe('/dev/serial/by-id/usb-busware.de_CUL868-if00');
        // instance "cul" has CUL2MQTT_SERIALPORT=/dev/ttyACM0, which is this very stick
        expect(r.body.devices[0].usedBy).toBe('cul');
        expect(r.body.devices[1].usedBy).toBeNull();
        // neither stick has a name of its own, so both fall back to the schema default and are
        // made free against the instance "cul" that already exists — and against each other
        expect(r.body.devices.map((d) => d.suggestName)).toEqual(['cul-2', 'cul-3']);
        expect(calls().some((c) => c.args[0] === 'discover' && c.args[1] === 'cul2mqtt')).toBe(true);
    });

    test('discover: passes timeout and address through, rejects junk', async () => {
        await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', { timeout: 9, address: '172.16.20.0/24' });
        const call = calls()
            .filter((c) => c.args[0] === 'discover')
            .pop();
        expect(call.args).toEqual(['discover', 'cul2mqtt', '--timeout', '9', '--address', '172.16.20.0/24']);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', { timeout: 999 })).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', { address: '10.0.0.1; rm -rf /' })).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', { address: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] })).status).toBe(
            400,
        );
    });

    test('discover: a cloud adapter scans by logging in, with the credentials on stdin', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/ecoflow2mqtt/discover', {
            needs: { email: 'me@example.com', password: 'secret' },
        });
        expect(r.status).toBe(200);
        expect(r.body.kinds).toEqual(['cloud']);
        expect(r.body.property).toBe('sn');
        expect(r.body.needs).toEqual(['email', 'password']);
        expect(r.body.devices[0].address).toBe('BK01ZXXXXXXXXXXX');

        const call = calls().find((c) => c.args[0] === 'discover' && c.args[1] === 'ecoflow2mqtt');
        expect(call.args).toContain('--env');
        // the credentials go on stdin, never in argv where a process list would show them
        expect(call.args.join(' ')).not.toContain('secret');
        expect(call.stdin).toContain('ECOFLOW2MQTT_EMAIL=me@example.com');
        expect(call.stdin).toContain('ECOFLOW2MQTT_PASSWORD=secret');
    });

    test('discover: a cloud scan without its credentials is refused before the host is touched', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/ecoflow2mqtt/discover', {});
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('DISCOVERY_NEEDS');
        expect(r.body.needs).toEqual(['email', 'password']);

        const half = await httpRequest('POST', port, '/she/services/hosts/local/adapters/ecoflow2mqtt/discover', { needs: { email: 'me@example.com' } });
        expect(half.status).toBe(400);
        expect(half.body.error).toContain('password');
    });

    test('discover: only the options the schema named reach the scan environment', async () => {
        await httpRequest('POST', port, '/she/services/hosts/local/adapters/ecoflow2mqtt/discover', {
            needs: { email: 'me@example.com', password: 'secret', sn: 'SMUGGLED', PATH: '/evil' },
        });
        const call = calls()
            .filter((c) => c.args[0] === 'discover' && c.args[1] === 'ecoflow2mqtt')
            .pop();
        expect(call.stdin).not.toContain('SMUGGLED');
        expect(call.stdin).not.toContain('/evil');
        expect(call.stdin.split('\n').filter(Boolean).sort()).toEqual(['ECOFLOW2MQTT_EMAIL=me@example.com', 'ECOFLOW2MQTT_PASSWORD=secret']);
    });

    test('discover: an adapter without the x-discover marker is refused', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/homeconnect2mqtt/discover', {});
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('NO_DISCOVERY');
    });

    test('discover: a host that cannot be reached says so, not "no discovery"', async () => {
        // the schema is what carries the marker, so a failing schema call must not be read as
        // "this adapter has no marker" — that would send the user after the wrong problem
        api.setDriverFactory(() => host.createLocalDriver({ helper: '/nonexistent/she-servicectl', sudo: false }));
        try {
            const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/discover', {});
            expect(r.body.code).toBe('HELPER_MISSING');
            expect(r.status).toBe(503);
        } finally {
            api.setDriverFactory(defaultDrivers);
        }
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

    test('host listing is cached; refresh and mutations invalidate it', async () => {
        await httpRequest('GET', port, '/she/services/hosts'); // warm
        fs.writeFileSync(logFile, '');
        let r = await httpRequest('GET', port, '/she/services/hosts');
        expect(r.body.cached).toBe(true);
        expect(calls().filter((c) => c.args[0] === 'list')).toHaveLength(0);
        r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
        expect(r.body.cached).toBe(false);
        expect(calls().filter((c) => c.args[0] === 'list')).toHaveLength(1);
        await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/restart');
        r = await httpRequest('GET', port, '/she/services/hosts');
        expect(r.body.cached).toBe(false);
        expect(calls().filter((c) => c.args[0] === 'list')).toHaveLength(2);
        // a GET under /hosts/ does not invalidate
        await httpRequest('GET', port, '/she/services/hosts/local/adapters/cul2mqtt/schema');
        expect((await httpRequest('GET', port, '/she/services/hosts')).body.cached).toBe(true);
    });

    test('a refresh asks npm again for the latest versions', async () => {
        // the version published after the daemon's 24 h cache was filled must show up on a refresh
        let hits = 0;
        let published = '1.2.0';
        npmRegistry.setFetch(async (url) => {
            if (!url.includes('/cul2mqtt/latest')) return { ok: false, status: 404 };
            hits++;
            return { ok: true, json: async () => ({ version: published }) };
        });
        try {
            let r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
            const adapter = () => r.body.hosts[0].adapters.find((a) => a.name === 'cul2mqtt');
            expect(adapter().latestVersion).toBe('1.2.0');
            const afterFirst = hits;

            published = '1.3.0';
            r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
            expect(adapter().latestVersion).toBe('1.3.0');
            expect(hits).toBeGreaterThan(afterFirst);

            // without the refresh the cached answer is kept — no request per listing
            published = '1.4.0';
            const cached = hits;
            r = await httpRequest('GET', port, '/she/services/hosts');
            expect(adapter().latestVersion).toBe('1.3.0');
            expect(hits).toBe(cached);
        } finally {
            npmRegistry.setFetch(async (url) => (url.includes('/cul2mqtt/latest') ? { ok: true, json: async () => ({ version: '1.2.0' }) } : { ok: false, status: 404 }));
            npmRegistry.clearCache();
        }
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

    test('an ssh block without a host is reported as unsupported', async () => {
        const app = express();
        app.use(express.json());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-cfg-'));
        const cfgPath = path.join(dir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ services: { enabled: true, hosts: [{ name: 'local' }, { name: 'zigbee', ssh: {} }] } }));
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
            expect((await httpRequest('GET', s.address().port, '/she/services/hosts/zigbee/broker-env')).status).toBe(400);
        } finally {
            await new Promise((r) => s.close(r));
        }
    });
});

describe('ssh driver (fake ssh/scp)', () => {
    const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.sh');
    const FAKE_SCP = path.join(__dirname, 'fixtures', 'fake-scp.sh');
    let dir;
    let sshLog;
    let logFile;
    let stateFile;
    let env;
    const sshLines = () => fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean);
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ssh-'));
        sshLog = path.join(dir, 'ssh.log');
        logFile = path.join(dir, 'calls.log');
        stateFile = path.join(dir, 'state.json');
        fs.writeFileSync(stateFile, '{}');
        env = { ...process.env, FAKE_SSH_LOG: sshLog, FAKE_LOG: logFile, FAKE_STATE: stateFile, FAKE_HOME: dir, FAKE_HELPER_TARGET: path.join(dir, 'installed-helper') };
    });
    beforeEach(() => {
        fs.writeFileSync(sshLog, '');
        fs.writeFileSync(logFile, '');
    });

    const mk = (extra = {}) =>
        host.createSshDriver(
            { name: 'zigbee', ssh: { host: 'zigbee.lan', user: 'she', port: 2222, identityFile: '/k/id' } },
            { sshBin: FAKE_SSH, scpBin: FAKE_SCP, helper: FAKE, sudo: false, env: { ...env, ...extra } },
        );

    test('exec runs the quoted helper command on the target, stdin passes through', async () => {
        const d = mk();
        expect(d.target).toBe('she@zigbee.lan');
        const { stdout } = await d.exec(['list']);
        expect(JSON.parse(stdout).hostname).toBe('zigbee');
        await d.exec(['env', 'cul2mqtt', "it's", 'write'], { stdin: 'A=1\n' });
        const lines = sshLines();
        expect(lines[0]).toBe(`ssh she@zigbee.lan '${FAKE}' 'list'`);
        expect(lines[1]).toBe(`ssh she@zigbee.lan '${FAKE}' 'env' 'cul2mqtt' 'it'\\''s' 'write'`);
        expect(calls()[1]).toEqual({ args: ['env', 'cul2mqtt', "it's", 'write'], stdin: 'A=1\n' });
    });

    test('sudo prefix when enabled', async () => {
        const d = host.createSshDriver({ name: 'z', ssh: { host: 'h' } }, { sshBin: FAKE_SSH, helper: 'true', sudo: true, env });
        await d.exec(['x']).catch(() => {}); // `sudo -n true x` may fail (no rule), prompt, or succeed (CI runners) — only the command line matters here
        expect(sshLines()[0]).toMatch(/^ssh \S+@h 'sudo' '-n' 'true' 'x'$/);
    });

    test('connection failure → SSH_FAILED, helper missing → HELPER_MISSING', async () => {
        await expect(mk({ FAKE_SSH_FAIL: '1' }).exec(['list'])).rejects.toMatchObject({ code: 'SSH_FAILED' });
        const d = host.createSshDriver({ name: 'z', ssh: { host: 'h' } }, { sshBin: FAKE_SSH, helper: '/usr/local/bin/she-servicectl-nope', sudo: false, env });
        await expect(d.exec(['version'])).rejects.toMatchObject({ code: 'HELPER_MISSING' });
    });

    test('upload copies via scp', async () => {
        const d = mk();
        await d.upload(FAKE, 'she-servicectl.tmp');
        expect(fs.existsSync(path.join(dir, 'she-servicectl.tmp'))).toBe(true);
        expect(sshLines()[0]).toMatch(/^scp .*fake-servicectl\.js .*she-servicectl\.tmp$/);
    });

    describe('routes', () => {
        let server;
        let port;
        let cfgPath;
        const setup = async (extraEnv = {}, hosts = null) => {
            api.setDriverFactory((h) =>
                h.ssh
                    ? host.createSshDriver(h, { sshBin: FAKE_SSH, scpBin: FAKE_SCP, helper: FAKE, sudo: false, env: { ...env, ...extraEnv } })
                    : host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }),
            );
            const app = express();
            app.use(express.json());
            cfgPath = path.join(dir, 'config-' + Math.random().toString(36).slice(2) + '.json');
            fs.writeFileSync(
                cfgPath,
                JSON.stringify({ services: { enabled: true, hosts: hosts || [{ name: 'local' }, { name: 'zigbee', ssh: { host: 'zigbee.lan', user: 'she' } }] } }),
            );
            app.locals.configPath = cfgPath;
            app.use('/she/services', api.router);
            server = http.createServer(app);
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            port = server.address().port;
        };
        afterEach(async () => {
            if (server) await new Promise((r) => server.close(r));
            server = null;
        });

        test('GET /hosts drives the ssh host and captures its hostname', async () => {
            await setup();
            const r = await httpRequest('GET', port, '/she/services/hosts');
            const z = r.body.hosts.find((h) => h.name === 'zigbee');
            expect(z).toMatchObject({ ok: true, local: false, ssh: { host: 'zigbee.lan', user: 'she', port: 22 }, hostname: 'zigbee' });
            expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).services.hosts[1].hostname).toBe('zigbee');
            // update badge: installed 1.1.1, registry says 1.2.0
            expect(z.adapters[0]).toMatchObject({ name: 'cul2mqtt', version: '1.1.1', latestVersion: '1.2.0', updateAvailable: true });
        });

        test('POST /hosts/:host/test reports ok or code', async () => {
            await setup();
            expect((await httpRequest('POST', port, '/she/services/hosts/zigbee/test')).body).toEqual({ ok: true, helper: host.HELPER_VERSION });
            await new Promise((r) => server.close(r));
            server = null;
            await setup({ FAKE_SSH_FAIL: '1' });
            expect((await httpRequest('POST', port, '/she/services/hosts/zigbee/test')).body).toMatchObject({ ok: false, code: 'SSH_FAILED' });
        });

        test('helper deploy: an installed helper updates itself through the sudo rule (local and remote)', async () => {
            await setup();
            let r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/deploy');
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ ok: true, installed: true, sudoers: true, helper: host.HELPER_VERSION, method: 'self-update', user: 'she' });
            expect(fs.readFileSync(logFile + '.selfupdate', 'utf8')).toBe(fs.readFileSync(host.HELPER_SOURCE, 'utf8'));
            r = await httpRequest('POST', port, '/she/services/hosts/local/helper/deploy');
            expect(r.body).toMatchObject({ ok: true, method: 'self-update' });
        });

        test('helper deploy: upload + install for hosts without a helper, sudoers instructions when sudo refuses', async () => {
            await setup({ FAKE_NO_SELF_UPDATE: '1' });
            let r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/deploy');
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ ok: true, uploaded: true, installed: true, sudoers: true, helper: host.HELPER_VERSION, user: 'she', method: 'install' });
            expect(fs.readFileSync(path.join(dir, 'installed-helper'), 'utf8')).toBe(fs.readFileSync(host.HELPER_SOURCE, 'utf8'));
            await new Promise((res) => server.close(res));
            server = null;
            await setup({ FAKE_SUDO_FAIL: '1', FAKE_NO_SELF_UPDATE: '1' });
            r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/deploy');
            expect(r.body).toMatchObject({ ok: false, uploaded: true, installed: false, code: 'SUDO_DENIED', user: 'she' });
            expect(r.body.instructions[1]).toContain('she ALL=(root) NOPASSWD: /usr/local/bin/she-servicectl');
        });

        describe('helper remove (I11)', () => {
            const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests she-services';
            let idFile;
            const hostsWithKey = () => {
                idFile = path.join(dir, 'services_id');
                fs.writeFileSync(idFile, 'private');
                fs.writeFileSync(idFile + '.pub', PUB + '\n');
                return [
                    { name: 'local' },
                    { name: 'zigbee', ssh: { host: 'zigbee.lan', user: 'she-services', identityFile: idFile } },
                    { ssh: { host: 'other.lan', user: 'root' } },
                ];
            };
            const savedHosts = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).services.hosts.map((h) => h.name || h.ssh.host);

            test("key mode drops this she's key on the host and the host entry from config", async () => {
                await setup({}, hostsWithKey());
                const r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/remove', { mode: 'key' });
                expect(r.status).toBe(200);
                expect(r.body).toMatchObject({ ok: true, mode: 'key', removedHost: true });
                expect(r.body.output).toContain('removed 1 key(s)');
                const call = calls().find((c) => c.args[0] === 'remove-key');
                expect(call).toBeDefined();
                expect(call.stdin.trim()).toBe(PUB);
                expect(savedHosts()).toEqual(['local', 'other.lan']);
            });

            test('teardown refuses while other keys remain, force removes everything', async () => {
                await setup({ FAKE_OTHER_KEYS: '2' }, hostsWithKey());
                let r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/remove', { mode: 'all' });
                expect(r.status).toBe(200);
                expect(r.body).toMatchObject({ ok: false, code: 'OTHER_KEYS' });
                expect(r.body.error).toContain('2 other key(s)');
                expect(savedHosts()).toContain('zigbee');
                r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/remove', { mode: 'all', force: true });
                expect(r.body).toMatchObject({ ok: true, mode: 'all', removedHost: true });
                expect(r.body.output).toContain('removed user she-services');
                expect(
                    calls()
                        .filter((c) => c.args[0] === 'teardown')
                        .map((c) => c.args),
                ).toEqual([['teardown'], ['teardown', '--force']]);
                expect(savedHosts()).toEqual(['local', 'other.lan']);
            });

            test('the she host: no key to remove, teardown drops the local entry', async () => {
                await setup({}, hostsWithKey());
                let r = await httpRequest('POST', port, '/she/services/hosts/local/helper/remove', { mode: 'key' });
                expect(r.status).toBe(400);
                expect(r.body.code).toBe('LOCAL');
                r = await httpRequest('POST', port, '/she/services/hosts/local/helper/remove', { mode: 'all' });
                expect(r.body).toMatchObject({ ok: true, mode: 'all', removedHost: true });
                expect(savedHosts()).toEqual(['zigbee', 'other.lan']);
            });

            test('a host without a public key cannot be disconnected by key', async () => {
                await setup();
                const r = await httpRequest('POST', port, '/she/services/hosts/zigbee/helper/remove', { mode: 'key' });
                expect(r.status).toBe(400);
                expect(r.body.code).toBe('NO_KEY');
            });
        });

        test('adapter uninstall removes every instance first, then the package with --purge', async () => {
            await setup();
            const r = await httpRequest('POST', port, '/she/services/hosts/zigbee/adapters/cul2mqtt/uninstall');
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ ok: true, removedInstances: ['cul'] });
            expect(r.body.output).toContain('cul2mqtt uninstalled');
            const seq = calls().map((c) => c.args.join(' '));
            expect(seq).toContain('uninstall cul2mqtt cul');
            expect(seq).toContain('npm cul2mqtt uninstall --purge');
            expect(seq.indexOf('uninstall cul2mqtt cul')).toBeLessThan(seq.indexOf('npm cul2mqtt uninstall --purge'));
            // a legacy unit of the adapter blocks it
            const r2 = await httpRequest('POST', port, '/she/services/hosts/zigbee/adapters/alexa-remote-mqtt/uninstall');
            expect(r2.status).toBe(409);
            expect(r2.body.code).toBe('LEGACY');
        });

        test('ssh pubkey endpoint answers without a key', async () => {
            await setup();
            const r = await httpRequest('GET', port, '/she/services/ssh/pubkey');
            expect(r.status).toBe(200);
            expect(r.body).toHaveProperty('identityFile');
        });
    });
});

describe("per-instance 'use she broker settings'", () => {
    let server;
    let port;
    let logFile;
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-sb-'));
        logFile = path.join(dir, 'calls.log');
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: path.join(dir, 'state.json') };
        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        api.setDriverFactory((h) => {
            const d = host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env });
            if (h.ssh) d.local = false;
            return d;
        });
        api.init(new StateStore(), () => null, { getMqttConfig: () => ({ url: 'mqtt://localhost:1883', username: 'she', password: 'pw' }) });
        const app = express();
        app.use(express.json());
        const cfgPath = path.join(dir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ services: { enabled: true, hosts: [{ name: 'local' }, { ssh: { host: 'zigbee.lan' } }] } }));
        app.locals.configPath = cfgPath;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        api.init(new StateStore(), () => null);
        await new Promise((r) => server.close(r));
    });
    beforeEach(() => fs.writeFileSync(logFile, ''));

    test('sheBrokerSettings rewrites loopback for remote hosts only; applySheBroker sets marker + prefixed vars', () => {
        expect(api.sheBrokerSettings(true).url).toBe('mqtt://localhost:1883');
        expect(api.sheBrokerSettings(false).url).toBe('mqtt://' + os.hostname() + ':1883');
        const on = api.applySheBroker({ X_SERIALPORT: '/dev/x', X_MQTT_URL: 'mqtt://old' }, 'X', true, true);
        expect(on).toEqual({ X_SERIALPORT: '/dev/x', X_MQTT_URL: 'mqtt://localhost:1883', X_MQTT_USERNAME: 'she', X_MQTT_PASSWORD: 'pw', SHE_USE_BROKER: '1' });
        expect(api.applySheBroker(on, 'X', false, true)).toEqual({ X_SERIALPORT: '/dev/x', X_MQTT_URL: 'mqtt://localhost:1883', X_MQTT_USERNAME: 'she', X_MQTT_PASSWORD: 'pw' });
    });

    test('GET /hosts no longer touches broker.env; a nameless ssh entry is named after its host', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
        expect(r.body.hosts.map((h) => [h.name, h.ok])).toEqual([
            ['local', true],
            ['zigbee.lan', true],
        ]);
        expect(calls().filter((c) => c.args[0] === 'broker-env')).toHaveLength(0);
    });

    test('GET env reports the switch and she broker info; PUT env applies it', async () => {
        let r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/env');
        expect(r.body).toMatchObject({ useSheBroker: false, envPrefix: 'CUL2MQTT', sheBroker: { url: 'mqtt://localhost:1883', username: 'she', hasPassword: true } });
        fs.writeFileSync(logFile, '');
        r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', {
            env: { CUL2MQTT_SERIALPORT: '/dev/ttyACM0', CUL2MQTT_MQTT_URL: 'mqtt://typed-by-user', CUL2MQTT_MQTT_PASSWORD: '***' },
            useSheBroker: true,
        });
        expect(r.status).toBe(200);
        const written = calls().find((c) => c.args[1] === 'cul2mqtt' && c.args[3] === 'write').stdin;
        expect(written).toContain('SHE_USE_BROKER=1\n');
        expect(written).toContain('CUL2MQTT_MQTT_URL=mqtt://localhost:1883\n');
        expect(written).toContain('CUL2MQTT_MQTT_USERNAME=she\n');
        expect(written).toContain('CUL2MQTT_MQTT_PASSWORD=pw\n');
        expect(written).not.toContain('typed-by-user');
    });

    test('install with useSheBroker passes she broker settings (remote → she hostname)', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/zigbee.lan/adapters/cul2mqtt/install', {
            instance: 'cul2',
            env: { CUL2MQTT_SERIALPORT: '/dev/ttyACM1' },
            useSheBroker: true,
        });
        expect(r.status).toBe(200);
        const inst = calls().find((c) => c.args[0] === 'install');
        expect(inst.stdin).toContain('CUL2MQTT_MQTT_URL=mqtt://' + os.hostname() + ':1883\n');
        expect(inst.stdin).toContain('SHE_USE_BROKER=1\n');
    });

    test('POST /ssh/test validates and answers ok/code', async () => {
        expect((await httpRequest('POST', port, '/she/services/ssh/test', { host: 'bad host' })).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/services/ssh/test', { host: 'h', port: 70000 })).status).toBe(400);
        const r = await httpRequest('POST', port, '/she/services/ssh/test', { host: 'zigbee.lan', port: '22', user: 'she' });
        expect(r.body).toEqual({ ok: true, helper: host.HELPER_VERSION });
    });
});

describe('remote host bootstrap (I9)', () => {
    let server;
    let port;
    let cfgPath;
    let dir;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-setup-'));
        api.setIdentityPath(path.join(dir, 'services_id_ed25519'));
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name }));
        api.init(new StateStore(), () => null);
        const app = express();
        app.use(express.json());
        cfgPath = path.join(dir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ services: { enabled: true, hosts: [{ name: 'local' }] } }));
        app.locals.configPath = cfgPath;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        await new Promise((r) => server.close(r));
    });

    test('token → script (once) → callback adds the host → status done', async () => {
        expect((await httpRequest('POST', port, '/she/services/setup/token', { origin: 'not a url' })).status).toBe(400);
        let r = await httpRequest('POST', port, '/she/services/setup/token', { origin: 'http://she:8080' });
        expect(r.status).toBe(200);
        const { token, command, sha256, user } = r.body;
        expect(user).toBe('she-services');
        expect(command).toBe(`curl -fsSL 'http://she:8080/she/services/setup.sh?token=${token}' | sudo bash`);
        expect(fs.existsSync(path.join(dir, 'services_id_ed25519.pub'))).toBe(true); // key generated on demand
        expect((await httpRequest('GET', port, `/she/services/setup/token/${token}`)).body).toEqual({ status: 'pending' });

        r = await httpRequest('GET', port, `/she/services/setup.sh?token=${token}`);
        expect(r.status).toBe(200);
        const script = String(r.body);
        expect(require('crypto').createHash('sha256').update(script).digest('hex')).toBe(sha256);
        expect(script).toContain("USER_NAME='she-services'");
        expect(script).toContain(fs.readFileSync(path.join(dir, 'services_id_ed25519.pub'), 'utf8').trim());
        expect(script).toContain('SHE_HELPER_EOF');
        expect(script).toContain(`/she/services/setup/done?token=${token}`);
        expect((await httpRequest('GET', port, `/she/services/setup/token/${token}`)).body).toEqual({ status: 'fetched' });
        expect((await httpRequest('GET', port, `/she/services/setup.sh?token=${token}`)).status).toBe(410); // served once

        r = await httpRequest('POST', port, `/she/services/setup/done?token=${token}`, { hostname: 'nope.invalid', user: 'she-services' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, host: '127.0.0.1', hostname: 'nope.invalid', user: 'she-services', added: true }); // .invalid never resolves → address
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        expect(cfg.services.hosts).toEqual([{ name: 'local' }, { hostname: 'nope.invalid', ssh: { host: '127.0.0.1', user: 'she-services' } }]);
        expect((await httpRequest('GET', port, `/she/services/setup/token/${token}`)).body).toEqual({ status: 'done', host: '127.0.0.1' });
        expect((await httpRequest('POST', port, `/she/services/setup/done?token=${token}`, { hostname: 'nope.invalid' })).status).toBe(410); // single use

        // a second run for the same host updates instead of duplicating; a resolvable hostname becomes the ssh host
        const t2 = (await httpRequest('POST', port, '/she/services/setup/token', { origin: 'http://she:8080' })).body.token;
        r = await httpRequest('POST', port, `/she/services/setup/done?token=${t2}`, { hostname: 'localhost' });
        expect(r.body).toMatchObject({ added: false, host: 'localhost', hostname: 'localhost' });
        const hosts2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).services.hosts;
        expect(hosts2).toHaveLength(2);
        expect(hosts2[1]).toEqual({ hostname: 'localhost', ssh: { host: 'localhost', user: 'she-services' } });
    });

    test('unknown token → 410 / expired', async () => {
        expect((await httpRequest('GET', port, '/she/services/setup.sh?token=nope')).status).toBe(410);
        expect((await httpRequest('POST', port, '/she/services/setup/done?token=nope', {})).status).toBe(410);
        expect((await httpRequest('GET', port, '/she/services/setup/token/nope')).body).toEqual({ status: 'expired' });
    });

    test('generated script refuses a helper containing the heredoc delimiter', () => {
        expect(() => api.buildSetupScript({ publicKey: 'k', helper: 'x\nSHE_HELPER_EOF\ny', callbackUrl: 'http://x', token: 't', user: 'u' })).toThrow(/delimiter/);
    });
});

describe('per-instance dynsec identity (I6)', () => {
    let server;
    let port;
    let logFile;
    let dyn;
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
    const lastWrite = () =>
        calls()
            .filter((c) => c.args[0] === 'env' && c.args[3] === 'write')
            .pop().stdin;

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-dyn-'));
        logFile = path.join(dir, 'calls.log');
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: path.join(dir, 'state.json') };
        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }));
        api.init(new StateStore(), () => null, { getMqttConfig: () => ({ url: 'mqtt://localhost:1883', username: 'she', password: 'pw' }) });
        dyn = { ready: true, log: [], clients: new Set(), roles: new Set() };
        const rec =
            (name) =>
            (...args) => {
                dyn.log.push([name, ...args]);
                return Promise.resolve({});
            };
        api.setDynsec({
            getStatus: () => ({ connected: dyn.ready, configured: dyn.ready, dynsecReady: dyn.ready }),
            createRole: (r) => {
                dyn.log.push(['createRole', r]);
                if (dyn.roles.has(r)) return Promise.reject(new Error('Role already exists'));
                dyn.roles.add(r);
                return Promise.resolve({});
            },
            addRoleACL: rec('addRoleACL'),
            createClient: (u, p) => {
                dyn.log.push(['createClient', u, p]);
                if (dyn.clients.has(u)) return Promise.reject(new Error('Client already exists'));
                dyn.clients.add(u);
                return Promise.resolve({});
            },
            setClientPassword: rec('setClientPassword'),
            addClientRole: rec('addClientRole'),
            deleteClient: (u) => {
                dyn.log.push(['deleteClient', u]);
                dyn.clients.delete(u);
                return Promise.resolve({});
            },
            deleteRole: (r) => {
                dyn.log.push(['deleteRole', r]);
                dyn.roles.delete(r);
                return Promise.resolve({});
            },
        });
        const app = express();
        app.use(express.json());
        app.locals.configPath = null;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        api.setDynsec(require('../../src/lib/dynsec'));
        api.init(new StateStore(), () => null);
        await new Promise((r) => server.close(r));
    });
    beforeEach(() => {
        fs.writeFileSync(logFile, '');
        dyn.log = [];
    });

    test('GET env reports mode own, dynsec availability and the default ACL', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/env');
        expect(r.body.brokerMode).toBe('own');
        expect(r.body.dynsec).toEqual({ available: true, client: 'svc-cul', acl: api.defaultAcl('cul') });
        expect(api.defaultAcl('cul').map((a) => a.acltype + ' ' + a.topic)).toEqual([
            'publishClientSend cul/#',
            'publishClientReceive cul/#',
            'subscribePattern cul/#',
            'unsubscribePattern cul/#',
            'publishClientSend homeassistant/#',
        ]);
    });

    test('PUT brokerMode dynsec creates role + client and writes the credentials', async () => {
        const r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', { env: { CUL2MQTT_SERIALPORT: '/dev/ttyACM0' }, brokerMode: 'dynsec' });
        expect(r.status).toBe(200);
        const createClient = dyn.log.find((l) => l[0] === 'createClient');
        expect(createClient[1]).toBe('svc-cul');
        expect(dyn.log.filter((l) => l[0] === 'addRoleACL')).toHaveLength(5);
        expect(dyn.log.find((l) => l[0] === 'addClientRole')).toEqual(['addClientRole', 'svc-cul', 'svc-cul']);
        const w = lastWrite();
        expect(w).toContain('SHE_DYNSEC_CLIENT=svc-cul\n');
        expect(w).toContain('CUL2MQTT_MQTT_USERNAME=svc-cul\n');
        expect(w).toContain('CUL2MQTT_MQTT_PASSWORD=' + createClient[2] + '\n');
        expect(w).toContain('CUL2MQTT_MQTT_URL=mqtt://localhost:1883\n');
        expect(w).not.toContain('SHE_USE_BROKER');
    });

    test('custom ACL is validated; unavailable dynsec → 400', async () => {
        let r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', { env: {}, brokerMode: 'dynsec', acl: [{ acltype: 'bogus', topic: 'x' }] });
        expect(r.status).toBe(400);
        dyn.ready = false;
        r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', { env: {}, brokerMode: 'dynsec' });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/dynamic security/);
        dyn.ready = true;
    });

    test('switching away from dynsec deletes client + role and drops the credentials', async () => {
        // simulate an env that currently uses a dynsec identity: the fake helper's env read has no marker,
        // so exercise applyBrokerMode via the API's own path: first dynsec, then she
        await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', { env: {}, brokerMode: 'dynsec' });
        dyn.log = [];
        // the fake helper always returns the same env (no marker), so send the marker in env to emulate the stored state
        const r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/env', { env: { SHE_DYNSEC_CLIENT: 'svc-cul' }, brokerMode: 'she' });
        expect(r.status).toBe(200);
        const w = lastWrite();
        expect(w).toContain('SHE_USE_BROKER=1\n');
        expect(w).not.toContain('SHE_DYNSEC_CLIENT');
        expect(w).toContain('CUL2MQTT_MQTT_USERNAME=she\n');
    });

    test('install with brokerMode dynsec passes fresh credentials', async () => {
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/cul2mqtt/install', { instance: 'cul9', env: {}, brokerMode: 'dynsec' });
        expect(r.status).toBe(200);
        const inst = calls().find((c) => c.args[0] === 'install');
        expect(inst.stdin).toContain('SHE_DYNSEC_CLIENT=svc-cul9\n');
        expect(inst.stdin).toContain('CUL2MQTT_MQTT_USERNAME=svc-cul9\n');
        expect(dyn.clients.has('svc-cul9')).toBe(true);
    });
});

describe('adapter files (I10)', () => {
    let server;
    let port;
    let logFile;
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-files-'));
        logFile = path.join(dir, 'calls.log');
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: path.join(dir, 'state.json') };
        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }));
        api.init(new StateStore(), () => null);
        const app = express();
        app.use(express.json());
        app.locals.configPath = null;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        await new Promise((r) => server.close(r));
    });
    beforeEach(() => fs.writeFileSync(logFile, ''));

    test('fileOptions: declared x-file and name heuristic, managed vs outside', () => {
        const schema = {
            properties: {
                'map-file': { 'x-env': 'X_MAP_FILE', 'x-file': { format: 'json', example: 'ex.json' } },
                'names-path': { 'type': 'string', 'x-env': 'X_NAMES_PATH' },
                'key-file': { 'type': 'string', 'x-env': 'X_KEY_FILE' },
                'address': { 'type': 'string', 'x-env': 'X_ADDRESS' },
                'mqtt-tls-ca': { 'type': 'string', 'x-env': 'X_MQTT_TLS_CA' },
            },
        };
        const opts = api.fileOptions(
            schema,
            { X_MAP_FILE: '/etc/foo/a.map.json', X_NAMES_PATH: '/home/u/names.yaml', X_KEY_FILE: '/var/lib/foo/a/key.bin', X_MQTT_TLS_CA: '/etc/ssl/ca.pem' },
            'foo',
            'a',
        );
        expect(opts.map((o) => [o.key, o.format, o.declared, o.managed])).toEqual([
            ['map-file', 'json', true, true],
            ['names-path', 'yaml', false, false],
        ]);
        expect(api.defaultFilePath('cul2mqtt', 'cul', 'map-file', 'json')).toBe('/etc/cul2mqtt/cul.map.json');
    });

    test('GET files lists options (a declared one without a value too), existence and the managed dirs', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/files');
        expect(r.status).toBe(200);
        expect(r.body.dirs).toEqual(['/etc/cul2mqtt/', '/var/lib/cul2mqtt/cul/']);
        expect(r.body.options).toEqual([
            {
                key: 'map-file',
                envName: 'CUL2MQTT_MAP_FILE',
                path: null,
                managed: false,
                editable: true,
                declared: true,
                format: 'json',
                example: 'example-map.json',
                schema: 'map.schema.json',
                describe: '',
                exists: false,
            },
        ]);
        expect(r.body.files.find((f) => f.path === '/etc/cul2mqtt/cul.map.json')).toMatchObject({ format: 'json', editable: true });
        expect(r.body.files.find((f) => f.path === '/etc/cul2mqtt/cul.env')).toMatchObject({ editable: false });
    });

    test('read / write a managed file, refuse paths outside and the env file', async () => {
        let r = await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/file?path=/etc/cul2mqtt/cul.map.json');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ content: '{"EM/0205": "power"}\n', format: 'json' });
        expect((await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/file?path=/etc/passwd')).status).toBe(400);
        expect((await httpRequest('GET', port, '/she/services/hosts/local/units/cul2mqtt/cul/file?path=/etc/cul2mqtt/../passwd')).status).toBe(400);
        fs.writeFileSync(logFile, '');
        r = await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/file', { path: '/etc/cul2mqtt/cul.map.json', content: '{"a":"b"}\n', restart: true });
        expect(r.body).toEqual({ ok: true, path: '/etc/cul2mqtt/cul.map.json', restarted: true });
        const c = calls();
        expect(c[0]).toEqual({ args: ['file', 'cul2mqtt', 'cul', 'write', '/etc/cul2mqtt/cul.map.json'], stdin: '{"a":"b"}\n' });
        expect(c[1].args).toEqual(['unit', 'cul2mqtt', 'cul', 'restart']);
        expect((await httpRequest('PUT', port, '/she/services/hosts/local/units/cul2mqtt/cul/file', { path: '/etc/cul2mqtt/cul.env', content: 'x' })).status).toBe(400);
    });

    test('asset and create-from-example', async () => {
        let r = await httpRequest('GET', port, '/she/services/hosts/local/adapters/cul2mqtt/asset?path=map.schema.json');
        expect(r.body).toMatchObject({ content: '{"type":"object"}\n', format: 'json' });
        expect((await httpRequest('GET', port, '/she/services/hosts/local/adapters/cul2mqtt/asset?path=../x')).status).toBe(400);
        fs.writeFileSync(logFile, '');
        r = await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/file/create', { option: 'map-file' });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, path: '/etc/cul2mqtt/cul.map.json', envName: 'CUL2MQTT_MAP_FILE' });
        const c = calls();
        const write = c.find((x) => x.args[0] === 'file' && x.args[3] === 'write');
        expect(write.args[4]).toBe('/etc/cul2mqtt/cul.map.json');
        expect(write.stdin).toBe('{"EM/0205": "example"}\n');
        const envWrite = c.find((x) => x.args[0] === 'env' && x.args[3] === 'write');
        expect(envWrite.stdin).toContain('CUL2MQTT_MAP_FILE=/etc/cul2mqtt/cul.map.json\n');
        expect((await httpRequest('POST', port, '/she/services/hosts/local/units/cul2mqtt/cul/file/create', { option: 'serialport' })).status).toBe(404);
    });
});

describe('catalog routes (I7)', () => {
    const catalog = require('../../src/lib/services-catalog');
    let server;
    let port;
    let logFile;
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-cat-'));
        logFile = path.join(dir, 'calls.log');
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: path.join(dir, 'state.json') };
        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }));
        api.init(new StateStore(), () => null);
        catalog.clearCache();
        catalog.setFetch(async (url, opts) => {
            const u = new URL(url);
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (u.pathname === '/-/v1/search')
                return ok({ objects: [{ package: { name: 'wiim2mqtt', version: '0.1.1', description: 'WiiM', publisher: { username: 'hobbyquaker' } } }] });
            if (((opts && opts.headers && opts.headers.accept) || '').includes('install-v1'))
                return ok({ 'dist-tags': { latest: '0.1.1' }, 'versions': { '0.1.1': { dependencies: { 'mqtt-interfaces-core': '^0.6.0' } } } });
            return ok({ name: 'wiim2mqtt', description: 'WiiM', maintainers: [{ name: 'hobbyquaker' }], time: {}, versions: { '0.1.1': {} } });
        });
        const app = express();
        app.use(express.json());
        app.locals.configPath = null;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        catalog.clearCache();
        await new Promise((r) => server.close(r));
    });
    beforeEach(() => fs.writeFileSync(logFile, ''));

    test('GET catalog lists members for the default trusted publisher', async () => {
        const r = await httpRequest('GET', port, '/she/services/catalog');
        expect(r.status).toBe(200);
        expect(r.body.publishers).toEqual(['hobbyquaker']);
        expect(r.body.packages.map((p) => p.name)).toEqual(['wiim2mqtt']);
    });

    test('install-package only for catalog members', async () => {
        expect((await httpRequest('POST', port, '/she/services/hosts/local/adapters/evil2mqtt/install-package')).status).toBe(403);
        const r = await httpRequest('POST', port, '/she/services/hosts/local/adapters/wiim2mqtt/install-package');
        expect(r.status).toBe(200);
        expect(calls()[0].args).toEqual(['npm', 'wiim2mqtt', 'install']);
    });
});

describe('legacy single-instance units', () => {
    let server;
    let port;
    let logFile;
    const calls = () =>
        fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-legacy-'));
        logFile = path.join(dir, 'calls.log');
        const env = { ...process.env, FAKE_LOG: logFile, FAKE_STATE: path.join(dir, 'state.json') };
        fs.writeFileSync(path.join(dir, 'state.json'), '{}');
        api.setDriverFactory((h) => host.createLocalDriver({ helper: FAKE, sudo: false, name: h.name, env }));
        api.init(new StateStore(), () => null);
        const app = express();
        app.use(express.json());
        app.locals.configPath = null;
        app.use('/she/services', api.router);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(async () => {
        await new Promise((r) => server.close(r));
    });
    beforeEach(() => fs.writeFileSync(logFile, ''));

    test('GET /hosts reports legacy units', async () => {
        const r = await httpRequest('GET', port, '/she/services/hosts?refresh=1');
        expect(r.body.hosts[0].legacy).toEqual([
            {
                adapter: 'alexa-remote-mqtt',
                unit: 'alexa-remote-mqtt.service',
                active: 'active',
                sub: 'running',
                unitFile: 'enabled',
                since: 'Sat 2026-08-22 08:20:00 CEST',
                restarts: 0,
                envFile: '/etc/default/alexa-remote-mqtt',
            },
        ]);
    });

    test('unit actions, logs and env work with the "-" instance; files/uninstall refused', async () => {
        expect((await httpRequest('POST', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/restart')).status).toBe(200);
        expect(calls()[0].args).toEqual(['unit', 'alexa-remote-mqtt', '-', 'restart']);
        expect((await httpRequest('GET', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/logs')).status).toBe(200);
        const env = await httpRequest('GET', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/env');
        expect(env.body.env).toEqual({ ALEXA_REMOTE_MQTT_MQTT_URL: 'mqtt://broker', ALEXA_REMOTE_MQTT_TOPIC_PREFIX: 'alexa' });
        expect((await httpRequest('GET', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/files')).status).toBe(400);
        expect((await httpRequest('DELETE', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-')).status).toBe(400);
    });

    test('migrate runs the helper and validates the name', async () => {
        expect((await httpRequest('POST', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/migrate', { name: 'bad name' })).status).toBe(400);
        const r = await httpRequest('POST', port, '/she/services/hosts/local/units/alexa-remote-mqtt/-/migrate', { name: 'alexa' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, instance: 'alexa' });
        expect(calls()[0].args).toEqual(['migrate', 'alexa-remote-mqtt', 'alexa']);
    });
});
