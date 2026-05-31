#!/usr/bin/env node

const cp = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Aedes = require('aedes');
const Mqtt = require('mqtt');

const msCmd = path.join(__dirname, '../../mockdate.js');
const testScriptsDir = path.join(__dirname, '../testscripts/api');

let ms;
let broker;
let brokerServer;
let brokerPort;
let apiPort;
let mqtt;
let tmpConfigFile;

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
    if (data) {
        msBuffer.push(data);
    }
    // Iterate in reverse so splicing doesn't shift upcoming indices.
    // Remove the subscription and buffer entry BEFORE calling the callback
    // to prevent infinite recursion when the callback calls subscribe() again.
    for (let i = msBuffer.length - 1; i >= 0; i--) {
        const line = msBuffer[i];
        for (const key of Object.keys(msSubscriptions)) {
            const sub = msSubscriptions[key];
            let m;
            if ((m = line.match(sub.rx))) {
                delete msSubscriptions[key];
                msBuffer.splice(i, 1);
                sub.cb(line, m);
                break; // one subscription match per buffer entry per pass
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

const get = (urlPath) => httpRequest('GET', apiPort, urlPath);
const post = (urlPath, body) => httpRequest('POST', apiPort, urlPath, body);
const put = (urlPath, body) => httpRequest('PUT', apiPort, urlPath, body);
const del = (urlPath) => httpRequest('DELETE', apiPort, urlPath);

beforeAll((done) => {
    broker = new Aedes();
    brokerServer = net.createServer(broker.handle);
    brokerServer.listen(0, () => {
        brokerPort = brokerServer.address().port;

        mqtt = Mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`);
        mqtt.on('connect', () => {
            tmpConfigFile = path.join(os.tmpdir(), `she-api-test-${Date.now()}-${process.pid}.json`);
            require('fs').writeFileSync(tmpConfigFile, JSON.stringify({ url: `mqtt://127.0.0.1:${brokerPort}`, verbosity: 'debug' }));
            const msArgs = ['-d', testScriptsDir, '--config', tmpConfigFile, '--port', '0'];
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

            // Wait for server port, then wait for the test script to finish loading
            subscribe(/http server listening on :(\d+)/, (line, m) => {
                apiPort = parseInt(m[1], 10);
                subscribe(/user::test-api\.js: loading/, () => done());
            });
        });
    });
});

afterAll((done) => {
    if (ms) ms.kill();
    mqtt.end(true, {}, () => {
        brokerServer.close(() => {
            broker.close(() => {
                if (tmpConfigFile) try { require('fs').unlinkSync(tmpConfigFile); } catch {}
                done();
            });
        });
    });
});

describe('HTTP API — she.api.get', () => {
    it('returns a JSON response for a simple GET', async () => {
        const res = await get('/api/test-api/hello');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'hello' });
    });

    it('injects URL parameters into the handler', async () => {
        const res = await get('/api/test-api/greet/World');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ greeting: 'Hello, World' });
    });

    it('returns 404 for an unregistered route', async () => {
        const res = await get('/api/test-api/nonexistent');
        expect(res.status).toBe(404);
    });
});

describe('HTTP API — she.api.post', () => {
    it('passes the request body to the handler and echoes it back', async () => {
        const res = await post('/api/test-api/echo', { text: 'ping' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ echo: { text: 'ping' } });
    });
});

describe('HTTP API — she.log inside handler', () => {
    it('produces a log line visible in daemon stdout', async () => {
        const logSeen = new Promise((resolve) => {
            subscribe(/log-endpoint-called.*hello-from-test/, resolve);
        });
        const res = await get('/api/test-api/log?msg=hello-from-test');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        await logSeen;
    });

    it('different query params produce different log messages', async () => {
        const logSeen = new Promise((resolve) => {
            subscribe(/log-endpoint-called.*world-42/, resolve);
        });
        const res = await get('/api/test-api/log?msg=world-42');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        await logSeen;
    });
});

describe('HTTP API — she.api.put', () => {
    it('updates a resource via PUT', async () => {
        const res = await put('/api/test-api/items/42', { name: 'thing' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ updated: '42', data: { name: 'thing' } });
    });
});

describe('HTTP API — she.api.delete', () => {
    it('deletes a resource via DELETE', async () => {
        const res = await del('/api/test-api/items/99');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deleted: '99' });
    });
});
