'use strict';

const http = require('http');

function httpGet(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
    });
}

describe('web server registry', () => {
    let registerRoute;

    // Use a fresh module (and fresh registry Map) for every test
    beforeEach(() => {
        jest.resetModules();
        ({ registerRoute } = require('../../src/web/server'));
    });

    test('registers a new route without error', () => {
        expect(() => registerRoute('get', '/api/s/foo', () => {})).not.toThrow();
    });

    test('throws on duplicate method+path', () => {
        registerRoute('get', '/api/s/dup', () => {});
        expect(() => registerRoute('get', '/api/s/dup', () => {})).toThrow('Route already registered: GET /api/s/dup');
    });

    test('allows same path with a different HTTP method', () => {
        registerRoute('get', '/api/s/shared', () => {});
        expect(() => registerRoute('post', '/api/s/shared', () => {})).not.toThrow();
    });

    test('allows different paths to coexist', () => {
        registerRoute('get', '/api/s/a', () => {});
        expect(() => registerRoute('get', '/api/s/b', () => {})).not.toThrow();
    });
});

describe('API key authentication', () => {
    let startServer, stopServer, serverPort;

    beforeEach(() => {
        jest.resetModules();
        ({ startServer, stopServer } = require('../../src/web/server'));
    });

    afterEach(() => stopServer());

    test('passes /she/* and /api/* requests when no api-key is configured', async () => {
        serverPort = await startServer(0);
        const res = await httpGet(serverPort, '/she/config');
        expect(res.status).not.toBe(401);
    });

    test('rejects /she/* request with no Authorization header when api-key is set', async () => {
        serverPort = await startServer(0, { apiKey: 'secret' });
        const res = await httpGet(serverPort, '/she/config');
        expect(res.status).toBe(401);
    });

    test('rejects /she/* request with wrong Bearer token', async () => {
        serverPort = await startServer(0, { apiKey: 'secret' });
        const res = await httpGet(serverPort, '/she/config', { authorization: 'Bearer wrong' });
        expect(res.status).toBe(401);
    });

    test('accepts /she/* request with correct Bearer token', async () => {
        serverPort = await startServer(0, { apiKey: 'secret' });
        const res = await httpGet(serverPort, '/she/config', { authorization: 'Bearer secret' });
        expect(res.status).not.toBe(401);
    });

    test('rejects /api/* request with no Authorization header when api-key is set', async () => {
        serverPort = await startServer(0, { apiKey: 'secret' });
        const res = await httpGet(serverPort, '/api/anything');
        expect(res.status).toBe(401);
    });
});
