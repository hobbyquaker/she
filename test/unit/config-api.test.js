'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function httpRequest(method, port, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const opts = {
            host: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: {
                accept: 'application/json',
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('GET /api/config', () => {
    let tmpDir, configPath, startServer, stopServer, port;

    beforeEach(async () => {
        jest.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-config-test-'));
        configPath = path.join(tmpDir, 'config.json');
        ({ startServer, stopServer } = require('../../src/web/server'));
        port = await startServer(0, { configPath });
    });

    afterEach(async () => {
        await stopServer();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns {} when config file does not exist', async () => {
        const res = await httpRequest('GET', port, '/api/config');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    test('returns file content when config file exists', async () => {
        fs.writeFileSync(configPath, JSON.stringify({ url: 'mqtt://test', port: 8080 }));
        const res = await httpRequest('GET', port, '/api/config');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ url: 'mqtt://test', port: 8080 });
    });
});

describe('PUT /api/config', () => {
    let tmpDir, configPath, startServer, stopServer, port;

    beforeEach(async () => {
        jest.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-config-test-'));
        configPath = path.join(tmpDir, 'config.json');
        ({ startServer, stopServer } = require('../../src/web/server'));
        port = await startServer(0, { configPath });
    });

    afterEach(async () => {
        await stopServer();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('writes config to file and responds { ok: true, restartRequired: true }', async () => {
        const newConfig = { url: 'mqtt://mybroker', verbosity: 'debug' };
        const res = await httpRequest('PUT', port, '/api/config', newConfig);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.restartRequired).toBe(true);
        expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(newConfig);
    });

    test('returns the saved config on subsequent GET', async () => {
        const newConfig = { url: 'mqtt://roundtrip', name: 'test' };
        await httpRequest('PUT', port, '/api/config', newConfig);
        const res = await httpRequest('GET', port, '/api/config');
        expect(res.body).toEqual(newConfig);
    });

    test('creates parent directories if they do not exist', async () => {
        jest.resetModules();
        const deepConfigPath = path.join(tmpDir, 'a', 'b', 'config.json');
        ({ startServer, stopServer } = require('../../src/web/server'));
        const deepPort = await startServer(0, { configPath: deepConfigPath });
        try {
            const res = await httpRequest('PUT', deepPort, '/api/config', { name: 'deep' });
            expect(res.status).toBe(200);
            expect(JSON.parse(fs.readFileSync(deepConfigPath, 'utf8'))).toEqual({ name: 'deep' });
        } finally {
            await stopServer();
        }
    });
});
