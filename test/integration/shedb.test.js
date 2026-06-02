#!/usr/bin/env node

'use strict';

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Aedes = require('aedes');
const Mqtt = require('mqtt');
const { WebSocket } = require('ws');

const msCmd = path.join(__dirname, '../mockdate.js');

let ms;
let broker;
let brokerServer;
let brokerPort;
let apiPort;
let mqtt;
let tmpDir;
let dbPath;
let scriptsDir;

const msSubscriptions = {};
const msBuffer = [];
let subIndex = 0;

function subscribe(rx, cb) {
    subIndex += 1;
    msSubscriptions[subIndex] = { rx, cb };
    matchSubscriptions();
    return subIndex;
}

function matchSubscriptions(data) {
    if (data) msBuffer.push(data);
    for (let i = msBuffer.length - 1; i >= 0; i--) {
        const line = msBuffer[i];
        for (const key of Object.keys(msSubscriptions)) {
            const sub = msSubscriptions[key];
            let m;
            if ((m = line.match(sub.rx))) {
                delete msSubscriptions[key];
                msBuffer.splice(i, 1);
                sub.cb(line, m);
                break;
            }
        }
    }
}

function httpRequest(method, portNum, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const options = {
            host: '127.0.0.1',
            port: portNum,
            path: urlPath,
            method,
            headers: {
                accept: 'application/json',
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            },
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

beforeAll((done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-shedb-test-'));
    dbPath = path.join(tmpDir, 'she.db.json');
    scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir);

    broker = new Aedes();
    brokerServer = net.createServer(broker.handle);
    brokerServer.listen(0, () => {
        brokerPort = brokerServer.address().port;

        mqtt = Mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`);
        mqtt.on('connect', () => {
            const configPath = path.join(tmpDir, 'config.json');
            fs.writeFileSync(configPath, JSON.stringify({ url: `mqtt://127.0.0.1:${brokerPort}`, verbosity: 'debug', port: 0, dbPath }));
            const msArgs = ['-d', scriptsDir, '--config', configPath];
            ms = cp.spawn(process.execPath, [msCmd, ...msArgs]);
            const rlOut = readline.createInterface({ input: ms.stdout, crlfDelay: Infinity });
            const rlErr = readline.createInterface({ input: ms.stderr, crlfDelay: Infinity });
            rlOut.on('line', (data) => {
                console.log('ms', data.toString());
                matchSubscriptions(data.toString());
            });
            rlErr.on('line', (data) => {
                console.log('ms', data.toString());
                matchSubscriptions(data.toString());
            });

            subscribe(/http server listening on :(\d+)/, (line, m) => {
                apiPort = parseInt(m[1], 10);
                subscribe(/shedb ready/, () => done());
            });
        });
    });
}, 30000);

afterAll((done) => {
    if (ms) ms.kill();
    mqtt.end(true, {}, () => {
        brokerServer.close(() => {
            broker.close(() => {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                done();
            });
        });
    });
});

// ---------------------------------------------------------------------------
// REST — document CRUD
// ---------------------------------------------------------------------------

describe('sheDB REST — documents', () => {
    it('GET /she/db/docs returns an empty list initially', async () => {
        const res = await httpRequest('GET', apiPort, '/she/db/docs');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('PUT /she/db/docs/<id> creates a document', async () => {
        const res = await httpRequest('PUT', apiPort, '/she/db/docs/rest/doc', { value: 1 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('GET /she/db/docs/<id> returns the stored document', async () => {
        await httpRequest('PUT', apiPort, '/she/db/docs/rest/get', { name: 'hello' });
        const res = await httpRequest('GET', apiPort, '/she/db/docs/rest/get');
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('hello');
        expect(res.body._id).toBe('rest/get');
    });

    it('PATCH /she/db/docs/<id> deep-merges fields', async () => {
        await httpRequest('PUT', apiPort, '/she/db/docs/rest/patch', { a: 1 });
        await httpRequest('PATCH', apiPort, '/she/db/docs/rest/patch', { b: 2 });
        const res = await httpRequest('GET', apiPort, '/she/db/docs/rest/patch');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ a: 1, b: 2 });
    });

    it('DELETE /she/db/docs/<id> removes the document', async () => {
        await httpRequest('PUT', apiPort, '/she/db/docs/rest/del', { x: 9 });
        const del = await httpRequest('DELETE', apiPort, '/she/db/docs/rest/del');
        expect(del.status).toBe(200);
        const get = await httpRequest('GET', apiPort, '/she/db/docs/rest/del');
        expect(get.status).toBe(404);
    });

    it('GET /she/db/docs returns a sorted list of all IDs', async () => {
        await httpRequest('PUT', apiPort, '/she/db/docs/list/b', { v: 1 });
        await httpRequest('PUT', apiPort, '/she/db/docs/list/a', { v: 1 });
        const res = await httpRequest('GET', apiPort, '/she/db/docs');
        expect(res.status).toBe(200);
        const idx = res.body.indexOf('list/a');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(res.body.indexOf('list/b')).toBeGreaterThan(idx);
    });
});

// ---------------------------------------------------------------------------
// REST — views
// ---------------------------------------------------------------------------

describe('sheDB REST — views', () => {
    it('PUT /she/db/views/<id> creates a view', async () => {
        const res = await httpRequest('PUT', apiPort, '/she/db/views/myview', { map: 'emit(this._id)' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('GET /she/db/views/<id>/result returns computed results', async () => {
        await httpRequest('PUT', apiPort, '/she/db/docs/view/seed', { n: 42 });
        await httpRequest('PUT', apiPort, '/she/db/views/seedview', { filter: 'view/#', map: 'emit(this.n)' });
        // Allow the view to compute
        await new Promise((resolve) => setTimeout(resolve, 300));
        const res = await httpRequest('GET', apiPort, '/she/db/views/seedview/result');
        expect(res.status).toBe(200);
        expect(res.body.result).toContain(42);
    });

    it('DELETE /she/db/views/<id> removes the view', async () => {
        await httpRequest('PUT', apiPort, '/she/db/views/tmpview', { map: 'emit(this._id)' });
        const del = await httpRequest('DELETE', apiPort, '/she/db/views/tmpview');
        expect(del.status).toBe(200);
        const res = await httpRequest('GET', apiPort, '/she/db/views');
        expect(res.body).not.toContain('tmpview');
    });
});

// ---------------------------------------------------------------------------
// MQTT interface
// ---------------------------------------------------------------------------

describe('sheDB MQTT interface', () => {
    it('set via MQTT creates a document visible in REST', (done) => {
        const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/she/ws`);
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'db:change' && msg.id === 'mqtt/doc') {
                ws.close();
                httpRequest('GET', apiPort, '/she/db/docs/mqtt/doc').then((res) => {
                    expect(res.status).toBe(200);
                    expect(res.body.value).toBe(42);
                    done();
                });
            }
        });
        ws.on('open', () => {
            mqtt.publish('she/db/set/mqtt/doc', JSON.stringify({ value: 42 }));
        });
    }, 10000);
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

describe('sheDB WebSocket events', () => {
    it('broadcasts db:change when a document is set via REST', (done) => {
        const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/she/ws`);
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'db:change' && msg.id === 'ws/test') {
                ws.close();
                expect(msg.doc).toMatchObject({ value: 'hello' });
                done();
            }
        });
        ws.on('open', () => {
            httpRequest('PUT', apiPort, '/she/db/docs/ws/test', { value: 'hello' });
        });
    }, 10000);

    it('broadcasts db:ids listing all IDs on any change', (done) => {
        const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/she/ws`);
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'db:ids') {
                ws.close();
                expect(Array.isArray(msg.ids)).toBe(true);
                done();
            }
        });
        ws.on('open', () => {
            httpRequest('PUT', apiPort, '/she/db/docs/ws/ids-check', { v: 1 });
        });
    }, 10000);
});
