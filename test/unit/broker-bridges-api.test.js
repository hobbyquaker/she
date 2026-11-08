'use strict';

/**
 * The Bridges routes of the broker API against a temp mosquitto.conf. An Aedes broker stands
 * in for the managed broker: she's probe after a reload connects to it, and "Test connection"
 * is pointed at it. Reload and restart are `true`/`false` shell commands, so the rollback
 * decision can be driven from both sides (a failing reload, a broker that does not answer).
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const Aedes = require('aedes');

function httpRequest(method, port, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: {
                    accept: 'application/json',
                    ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                },
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

const BASE_CONF = [
    'allow_anonymous true',
    '',
    'listener 1883',
    '',
    'connection existing',
    'address remote.example.net:8883',
    'topic tele/# in 0 remote/ ""',
    'remote_username bridge',
    'remote_password keepme',
    'bridge_cafile /etc/mosquitto/certs/ca.crt',
    '',
    '# tail comment',
    '',
].join('\n');

describe('broker bridges API', () => {
    let tmpDir, configPath, confDir, confFile, startServer, stopServer, port;
    let aedes, aedesServer, brokerPort;

    function listenAedes() {
        return new Promise((resolve) => {
            aedesServer = net.createServer(aedes.handle);
            aedesServer.listen(brokerPort || 0, '127.0.0.1', () => {
                brokerPort = aedesServer.address().port;
                resolve();
            });
        });
    }

    function writeBrokerConfig(extra = {}) {
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                url: `mqtt://127.0.0.1:${brokerPort}`,
                broker: { configDir: confDir, reloadCmd: 'true', restartCmd: 'true', probeTimeout: 1500, ...extra },
            }),
        );
    }

    beforeAll(async () => {
        aedes = new Aedes();
        aedes.authenticate = (client, username, password, cb) => {
            if (!username || (username === 'ok' && String(password) === 'pw')) return cb(null, true);
            const e = new Error('Auth error');
            e.returnCode = 5;
            cb(e, null);
        };
        await listenAedes();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-bridges-test-'));
        configPath = path.join(tmpDir, 'config.json');
        confDir = path.join(tmpDir, 'mosquitto');
        confFile = path.join(confDir, 'mosquitto.conf');
        fs.mkdirSync(confDir);
        writeBrokerConfig();
        jest.resetModules();
        process.env.SHE_URL = `mqtt://127.0.0.1:${brokerPort}`;
        process.env.SHE_DATA_DIR = tmpDir;
        ({ startServer, stopServer } = require('../../src/web/server'));
        port = await startServer(0, { configPath });
    });

    afterAll(async () => {
        await stopServer();
        await new Promise((r) => aedesServer.close(() => aedes.close(r)));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.SHE_URL;
        delete process.env.SHE_DATA_DIR;
    });

    beforeEach(() => {
        fs.writeFileSync(confFile, BASE_CONF);
        writeBrokerConfig();
    });

    const existing = () => ({
        name: 'existing',
        addresses: ['remote.example.net:8883'],
        topics: [{ pattern: 'tele/#', direction: 'in', qos: 0, localPrefix: 'remote/', remotePrefix: '' }],
        options: { remote_username: 'bridge', remote_password: null, bridge_cafile: '/etc/mosquitto/certs/ca.crt' },
    });

    test('GET lists the bridges without their secrets, with state slots and the mode', async () => {
        const r = await httpRequest('GET', port, '/she/broker/bridges');
        expect(r.status).toBe(200);
        expect(r.body.mode).toBe('local');
        expect(r.body.bridges).toHaveLength(1);
        const b = r.body.bridges[0];
        expect(b.name).toBe('existing');
        expect(b.options.remote_password).toBeUndefined();
        expect(b.secrets).toEqual({ remote_password: true });
        expect(b.options.remote_username).toBe('bridge');
        expect(r.body.states.existing).toEqual({ connected: null, ts: null, topic: null });
        expect(typeof r.body.checksum).toBe('string');
        expect(Array.isArray(r.body.presets)).toBe(true);
        expect(r.body.options.remote_password.secret).toBe(true);
    });

    test('preview: validation errors, warnings, a masked diff and the remote requirements', async () => {
        const loop = {
            name: 'loop',
            addresses: ['other.example.net'],
            topics: [
                { pattern: 'a/#', direction: 'in', qos: 0, localPrefix: 'x/', remotePrefix: '' },
                { pattern: 'a/#', direction: 'out', qos: 0, localPrefix: 'x/', remotePrefix: '' },
            ],
            options: { remote_username: 'u', remote_password: 'p', bridge_future_thing: '1' },
        };
        const r = await httpRequest('POST', port, '/she/broker/bridges/preview', { bridges: [existing(), loop] });
        expect(r.status).toBe(200);
        expect(r.body.errors.some((e) => /^Loop:/.test(e))).toBe(true);
        expect(r.body.warnings.some((w) => /Unknown option "bridge_future_thing"/.test(w))).toBe(true);
        expect(r.body.warnings.some((w) => /clear text/.test(w))).toBe(true);
        expect(r.body.changed).toBe(true);
        expect(r.body.diff).toMatch(/^\+connection loop$/m);
        expect(r.body.diff).toMatch(/^\+remote_password \*{8}$/m);
        expect(r.body.diff).not.toMatch(/keepme|^\+remote_password p$/m);
        expect(r.body.remote.loop.acls.map((a) => a.topic)).toContain('a/#');
        expect(r.body.remote.existing.managedHere).toBe(false);
    });

    test('preview of an unchanged list is a no-op', async () => {
        const r = await httpRequest('POST', port, '/she/broker/bridges/preview', { bridges: [existing()] });
        expect(r.body.errors).toEqual([]);
        expect(r.body.changed).toBe(false);
        expect(r.body.diff).toBe('');
    });

    test('PUT writes the block, keeps the stored secret, reloads and probes; the previous file is backed up', async () => {
        const get = await httpRequest('GET', port, '/she/broker/bridges');
        const added = {
            name: 'second',
            addresses: ['127.0.0.1:1884'],
            topics: [{ pattern: 'cmnd/#', direction: 'out', qos: 1, localPrefix: '', remotePrefix: 'site/' }],
            options: { remote_clientid: 'she-second', keepalive_interval: '30' },
        };
        const r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [existing(), added], checksum: get.body.checksum });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.rolledBack).toBe(false);
        expect(r.body.probe.ok).toBe(true);
        expect(r.body.backupPath).toMatch(/^mosquitto\.conf\.bak-/);
        const text = fs.readFileSync(confFile, 'utf8');
        expect(text).toContain('connection second\naddress 127.0.0.1:1884\ntopic cmnd/# out 1 "" site/\nremote_clientid she-second\nkeepalive_interval 30');
        expect(text).toContain('remote_password keepme'); // null = keep
        expect(text).toContain('# tail comment');
        expect(text).toContain('listener 1883');
        expect(fs.existsSync(path.join(confDir, r.body.backupPath))).toBe(true);
        const again = await httpRequest('GET', port, '/she/broker/bridges');
        expect(again.body.bridges.map((b) => b.name)).toEqual(['existing', 'second']);
        expect(again.body.checksum).toBe(r.body.checksum);
    });

    test('PUT with a new password sets it, with an empty one clears it; a rename keeps the secret via originalName', async () => {
        const renamed = { ...existing(), name: 'renamed', originalName: 'existing' };
        let r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [renamed] });
        expect(r.body.ok).toBe(true);
        expect(fs.readFileSync(confFile, 'utf8')).toMatch(/connection renamed\n[^]*remote_password keepme/);
        r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [{ ...existing(), name: 'renamed', options: { ...existing().options, remote_password: 'newpw' } }] });
        expect(fs.readFileSync(confFile, 'utf8')).toContain('remote_password newpw');
        r = await httpRequest('PUT', port, '/she/broker/bridges', {
            bridges: [{ ...existing(), name: 'renamed', options: { bridge_cafile: '/ca', remote_username: '', remote_password: '' } }],
        });
        expect(r.body.ok).toBe(true);
        expect(fs.readFileSync(confFile, 'utf8')).not.toMatch(/remote_password/);
    });

    test('PUT refuses invalid bridges (400) and a stale checksum (409)', async () => {
        const bad = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [{ name: 'x y', addresses: [], topics: [] }] });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('invalid');
        expect(bad.body.errors.length).toBeGreaterThanOrEqual(2);
        expect(fs.readFileSync(confFile, 'utf8')).toBe(BASE_CONF);
        const stale = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [], checksum: 'deadbeef' });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe('external_modify');
    });

    test('PUT removing every bridge leaves the rest of the file alone', async () => {
        const r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [] });
        expect(r.body.ok).toBe(true);
        const text = fs.readFileSync(confFile, 'utf8');
        expect(text).not.toMatch(/connection|remote_|bridge_/);
        expect(text).toContain('listener 1883');
        expect(text).toContain('# tail comment');
    });

    test('a failing reload command rolls the file back without a restart', async () => {
        writeBrokerConfig({ reloadCmd: 'false' });
        const r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [] });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(false);
        expect(r.body.rolledBack).toBe(true);
        expect(r.body.restarted).toBe(false);
        expect(r.body.recovered).toBe(true);
        expect(r.body.reloadError).toBeTruthy();
        expect(r.body.reason).toMatch(/reload command failed/);
        expect(fs.readFileSync(confFile, 'utf8')).toBe(BASE_CONF);
    });

    test('a broker that does not answer after the reload gets the previous config back and a restart', async () => {
        await new Promise((r) => aedesServer.close(r)); // the managed broker is gone
        try {
            const r = await httpRequest('PUT', port, '/she/broker/bridges', { bridges: [] });
            expect(r.body.ok).toBe(false);
            expect(r.body.rolledBack).toBe(true);
            expect(r.body.restarted).toBe(true);
            expect(r.body.recovered).toBe(false); // still down: nothing listens
            expect(r.body.probe.ok).toBe(false);
            expect(r.body.reason).toMatch(/did not answer/);
            expect(fs.readFileSync(confFile, 'utf8')).toBe(BASE_CONF);
        } finally {
            await listenAedes();
        }
    });

    test('test connection: success, refused credentials, nothing listening', async () => {
        const ok = await httpRequest('POST', port, '/she/broker/bridges/test', {
            addresses: [`127.0.0.1:${brokerPort}`],
            options: { remote_username: 'ok', remote_password: 'pw' },
        });
        expect(ok.body.ok).toBe(true);
        expect(ok.body.url).toBe(`mqtt://127.0.0.1:${brokerPort}`);
        const refused = await httpRequest('POST', port, '/she/broker/bridges/test', {
            address: `127.0.0.1:${brokerPort}`,
            options: { remote_username: 'ok', remote_password: 'wrong' },
        });
        expect(refused.body.ok).toBe(false);
        expect(refused.body.error).toMatch(/refused|authori/i);
        // a port that was just released refuses (a low port like 1 only times out under WSL)
        const freePort = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
                const p = srv.address().port;
                srv.close(() => resolve(p));
            });
        });
        const dead = await httpRequest('POST', port, '/she/broker/bridges/test', { address: `127.0.0.1:${freePort}`, options: {} });
        expect(dead.body.ok).toBe(false);
        expect(dead.body.error).toMatch(/refused/);
        const noaddr = await httpRequest('POST', port, '/she/broker/bridges/test', { options: {} });
        expect(noaddr.status).toBe(400);
    });

    test('test connection uses the stored password when the client sends null', async () => {
        fs.writeFileSync(confFile, BASE_CONF.replace('remote_password keepme', 'remote_password pw'));
        const r = await httpRequest('POST', port, '/she/broker/bridges/test', {
            name: 'existing',
            address: `127.0.0.1:${brokerPort}`,
            options: { remote_username: 'ok', remote_password: null },
        });
        expect(r.body.ok).toBe(true);
    });

    test('test connection reports an unreadable TLS file instead of connecting', async () => {
        const r = await httpRequest('POST', port, '/she/broker/bridges/test', { address: `127.0.0.1:${brokerPort}`, options: { bridge_cafile: path.join(tmpDir, 'missing.crt') } });
        expect(r.body.ok).toBe(false);
        expect(r.body.stage).toBe('files');
        expect(r.body.url).toBe(`mqtts://127.0.0.1:${brokerPort}`);
    });

    test('remote requirements say whether the remote is the managed broker; creating the user needs dynsec', async () => {
        const away = await httpRequest('POST', port, '/she/broker/bridges/remote-requirements', { bridge: existing() });
        expect(away.body.managedHere).toBe(false);
        expect(away.body.canCreate).toBe(false);
        expect(away.body.dynsec[0]).toBe('mosquitto_ctrl dynsec createClient bridge');
        const here = await httpRequest('POST', port, '/she/broker/bridges/remote-requirements', { bridge: { ...existing(), addresses: ['127.0.0.1:1883'] } });
        expect(here.body.managedHere).toBe(true);
        expect(here.body.canCreate).toBe(false); // no dynsec configured in this test
        const refused = await httpRequest('POST', port, '/she/broker/bridges/remote-user', { bridge: existing(), password: 'x' });
        expect(refused.status).toBe(409);
    });

    test('the Listeners page writing PUT /config without bridges keeps the connection blocks', async () => {
        const conf = await httpRequest('GET', port, '/she/broker/config');
        expect(conf.body.bridges).toHaveLength(1);
        const r = await httpRequest('PUT', port, '/she/broker/config', {
            listeners: [...conf.body.listeners, { port: 8883, bindAddress: '', protocol: 'mqtt', tls: {} }],
            managed: conf.body.managed,
            passthrough: conf.body.passthrough,
            checksum: conf.body.checksum,
        });
        expect(r.body.ok).toBe(true);
        const text = fs.readFileSync(confFile, 'utf8');
        expect(text).toContain('listener 8883');
        expect(text).toContain('connection existing\naddress remote.example.net:8883\ntopic tele/# in 0 remote/ ""\nremote_username bridge\nremote_password keepme');
    });
});
