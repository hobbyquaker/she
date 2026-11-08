'use strict';

/**
 * The Bridges page end to end against real Mosquitto 2 brokers in throwaway docker containers:
 * she's daemon manages a "local" Mosquitto (its mosquitto.conf in a temp dir, reload = SIGHUP
 * into the container), a second Mosquitto is the remote. Checks the save path (write, reload,
 * probe), the live state from $SYS/broker/connection, that messages actually cross the bridge
 * in both directions, and the rollback when a bad option ends the broker on reload.
 *
 * Needs docker and the eclipse-mosquitto:2 image; skipped with a note otherwise.
 */

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Mqtt = require('mqtt');

const IMAGE = 'eclipse-mosquitto:2';

function dockerAvailable() {
    try {
        cp.execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}

const available = dockerAvailable();
if (!available) console.log(`bridges-mosquitto: docker or the ${IMAGE} image is not available — skipping`);
const describeIf = available ? describe : describe.skip;

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

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
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, everyMs = 500) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
        await sleep(everyMs);
    }
}

/** Connect an mqtt.js client and resolve once connected. */
function connect(port, opts = {}) {
    return new Promise((resolve, reject) => {
        const c = Mqtt.connect(`mqtt://127.0.0.1:${port}`, { connectTimeout: 5000, ...opts });
        c.once('connect', () => resolve(c));
        c.once('error', reject);
    });
}

describeIf('bridges against real Mosquitto brokers (docker)', () => {
    const uid = String(os.userInfo().uid);
    const tag = `${Date.now()}-${process.pid}`;
    const localName = `she-test-local-${tag}`;
    const remoteName = `she-test-remote-${tag}`;
    let tmp, localDir, remoteDir, confFile, localPort, remotePort, apiPort, she, tmpConfig, tmpData;

    const docker = (...args) => cp.execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString();

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'she-bridges-it-'));
        localDir = path.join(tmp, 'local');
        remoteDir = path.join(tmp, 'remote');
        fs.mkdirSync(localDir);
        fs.mkdirSync(remoteDir);
        localPort = await freePort();
        remotePort = await freePort();
        confFile = path.join(localDir, 'mosquitto.conf');
        fs.writeFileSync(
            path.join(remoteDir, 'mosquitto.conf'),
            `listener ${remotePort}\nallow_anonymous true\nlog_dest stdout\nlog_type error\nlog_type warning\nlog_type notice\n`,
        );
        fs.writeFileSync(confFile, `listener ${localPort}\nallow_anonymous true\nlog_dest stdout\nlog_dest topic\nlog_type error\nlog_type warning\nlog_type notice\n`);
        for (const [name, dir] of [
            [remoteName, remoteDir],
            [localName, localDir],
        ]) {
            docker('run', '-d', '--name', name, '--user', uid, '--network', 'host', '-v', `${dir}:/mosquitto/config`, IMAGE, 'mosquitto', '-c', '/mosquitto/config/mosquitto.conf');
        }
        // both brokers up
        await until(
            async () =>
                (await connect(localPort)
                    .then((c) => (c.end(true), true))
                    .catch(() => false)) &&
                (await connect(remotePort)
                    .then((c) => (c.end(true), true))
                    .catch(() => false)),
            15000,
        );

        // she's daemon, managing the local broker; reload = SIGHUP into the container, restart = docker restart
        tmpConfig = path.join(tmp, 'config.json');
        tmpData = path.join(tmp, 'data');
        fs.writeFileSync(
            tmpConfig,
            JSON.stringify({
                url: `mqtt://127.0.0.1:${localPort}`,
                verbosity: 'info',
                broker: { configDir: localDir, reloadCmd: `docker kill -s HUP ${localName}`, restartCmd: `docker restart ${localName}`, probeTimeout: 6000 },
            }),
        );
        const scriptsDir = path.join(tmp, 'scripts');
        fs.mkdirSync(scriptsDir);
        she = cp.spawn(process.execPath, [path.join(__dirname, '../mockdate.js'), '-d', scriptsDir, '--config', tmpConfig, '--port', '0', '--data-dir', tmpData]);
        apiPort = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('she did not start')), 30000);
            const rl = readline.createInterface({ input: she.stdout, crlfDelay: Infinity });
            rl.on('line', (line) => {
                const m = line.match(/http server listening on :(\d+)/);
                if (m) {
                    clearTimeout(timer);
                    resolve(parseInt(m[1], 10));
                }
            });
            she.stderr.on('data', (d) => process.stderr.write(`she: ${d}`));
        });
        // wait for she's MQTT client, so the store sees $SYS
        await until(async () => (await httpRequest('GET', apiPort, '/she/status')).body.mqtt?.connected !== false, 15000).catch(() => {});
    }, 120000);

    afterAll(async () => {
        if (she) she.kill();
        for (const n of [localName, remoteName]) {
            try {
                docker('rm', '-f', n);
            } catch {
                /* already gone */
            }
        }
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    const bridge = () => ({
        name: 'lab',
        addresses: [`127.0.0.1:${remotePort}`],
        topics: [
            { pattern: 'lab/#', direction: 'in', qos: 0, localPrefix: 'remote/', remotePrefix: '' },
            { pattern: 'back/#', direction: 'out', qos: 0, localPrefix: '', remotePrefix: '' },
        ],
        options: { remote_clientid: 'she-lab', notifications: 'true' },
    });

    test('the empty list knows the broker version and the local mode', async () => {
        const r = await until(async () => {
            const g = await httpRequest('GET', apiPort, '/she/broker/bridges');
            return g.body.brokerVersion ? g : null;
        }, 20000);
        expect(r.body.bridges).toEqual([]);
        expect(r.body.mode).toBe('local');
        expect(r.body.brokerVersion).toMatch(/^2\./);
    });

    test('test connection reaches the remote broker', async () => {
        const r = await httpRequest('POST', apiPort, '/she/broker/bridges/test', { addresses: [`127.0.0.1:${remotePort}`], options: {} });
        expect(r.body.ok).toBe(true);
    });

    test('saving a bridge writes, reloads, probes — and the bridge comes up and carries messages both ways', async () => {
        const g = await httpRequest('GET', apiPort, '/she/broker/bridges');
        const r = await httpRequest('PUT', apiPort, '/she/broker/bridges', { bridges: [bridge()], checksum: g.body.checksum });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.rolledBack).toBe(false);
        expect(r.body.probe.ok).toBe(true);
        expect(fs.readFileSync(confFile, 'utf8')).toContain(
            `connection lab\naddress 127.0.0.1:${remotePort}\ntopic lab/# in 0 remote/ ""\ntopic back/# out 0\nremote_clientid she-lab\nnotifications true`,
        );

        // live state from $SYS/broker/connection/she-lab/state, as she's main client saw it
        const state = await until(async () => {
            const s = (await httpRequest('GET', apiPort, '/she/broker/bridges')).body.states.lab;
            return s && s.connected === true ? s : null;
        }, 30000);
        expect(state.topic).toBe('$SYS/broker/connection/she-lab/state');

        // in: remote lab/hello -> local remote/lab/hello
        const local = await connect(localPort);
        const remote = await connect(remotePort);
        try {
            const gotLocal = new Promise((resolve) => local.on('message', (t, p) => resolve({ t, p: p.toString() })));
            await new Promise((res) => local.subscribe('remote/lab/#', res));
            await sleep(300);
            remote.publish('lab/hello', 'from-remote');
            expect(await gotLocal).toEqual({ t: 'remote/lab/hello', p: 'from-remote' });
            // out: local back/x -> remote back/x
            const gotRemote = new Promise((resolve) => remote.on('message', (t, p) => resolve({ t, p: p.toString() })));
            await new Promise((res) => remote.subscribe('back/#', res));
            await sleep(300);
            local.publish('back/x', 'from-local');
            expect(await gotRemote).toEqual({ t: 'back/x', p: 'from-local' });
        } finally {
            local.end(true);
            remote.end(true);
        }
    }, 90000);

    test('an option the broker does not know ends it on reload: she restores the file, restarts the broker, it comes back', async () => {
        const before = fs.readFileSync(confFile, 'utf8');
        const g = await httpRequest('GET', apiPort, '/she/broker/bridges');
        const bad = { ...bridge(), options: { ...bridge().options, bridge_definitely_unknown: '1' } };
        const pv = await httpRequest('POST', apiPort, '/she/broker/bridges/preview', { bridges: [bad] });
        expect(pv.body.errors).toEqual([]);
        expect(pv.body.warnings.some((w) => /Unknown option "bridge_definitely_unknown"/.test(w))).toBe(true);

        const r = await httpRequest('PUT', apiPort, '/she/broker/bridges', { bridges: [bad], checksum: g.body.checksum });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(false);
        expect(r.body.rolledBack).toBe(true);
        expect(r.body.restarted).toBe(true);
        expect(r.body.probe.ok).toBe(false);
        expect(r.body.recovered).toBe(true);
        expect(fs.readFileSync(confFile, 'utf8')).toBe(before);
        // the broker runs again on the previous config and the bridge reconnects
        const c = await connect(localPort);
        c.end(true);
        await until(async () => (await httpRequest('GET', apiPort, '/she/broker/bridges')).body.states.lab?.connected === true, 40000);
    }, 120000);

    test('removing the bridge disconnects it', async () => {
        const g = await httpRequest('GET', apiPort, '/she/broker/bridges');
        const r = await httpRequest('PUT', apiPort, '/she/broker/bridges', { bridges: [], checksum: g.body.checksum });
        expect(r.body.ok).toBe(true);
        expect(fs.readFileSync(confFile, 'utf8')).not.toMatch(/connection lab/);
        await until(async () => (await httpRequest('GET', apiPort, '/she/broker/bridges')).body.states.lab === undefined, 10000);
        const logs = docker('logs', remoteName);
        expect(logs).toMatch(/she-lab/); // the remote saw the bridge come and go
    }, 60000);
});
