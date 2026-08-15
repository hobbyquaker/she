'use strict';

/**
 * Unit tests for src/web/matter-api.js
 *
 * src/matter/controller is mocked — no real Matter I/O.
 */

const http = require('http');
const express = require('express');

function httpRequest(method, port, urlPath, body) {
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
            },
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let body;
                try {
                    body = JSON.parse(data);
                } catch {
                    body = data;
                }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// Build a minimal Express app that mounts the router for each test group
async function _makeApp(controllerMock) {
    // Reset module registry and inject the mock (doMock avoids Babel hoist restrictions)
    jest.resetModules();
    jest.doMock('../../src/matter/controller', () => controllerMock);

    const { router } = require('../../src/web/matter-api');
    const app = express();
    app.use(express.json());
    app.use('/she/matter', router);
    return app;
}

function startApp(app) {
    return new Promise((resolve) => {
        const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

describe('GET /she/matter/devices — controller not ready', () => {
    let srv, port;

    beforeEach(async () => {
        jest.resetModules();
        // controller with no isStarted function → isReady() returns false
        jest.doMock('../../src/matter/controller', () => ({}));
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns 503 when controller not started', async () => {
        const res = await httpRequest('GET', port, '/she/matter/devices');
        expect(res.status).toBe(503);
    });
});

describe('GET /she/matter/devices — controller ready', () => {
    let srv, port;

    const mockController = {
        isStarted: jest.fn(() => true),
        listPaired: jest.fn(() => [{ nodeId: '42', online: true }]),
        commission: jest.fn(),
        getEndpoints: jest.fn(),
        unpair: jest.fn(),
        sendCommand: jest.fn(),
    };

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock('../../src/matter/controller', () => mockController);
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns device list', async () => {
        const res = await httpRequest('GET', port, '/she/matter/devices');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ nodeId: '42', online: true }]);
    });
});

describe('POST /she/matter/commission', () => {
    let srv, port;

    const mockController = {
        isStarted: jest.fn(() => true),
        listPaired: jest.fn(() => []),
        commission: jest.fn().mockResolvedValue('123'),
    };

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock('../../src/matter/controller', () => mockController);
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns 201 with nodeId on success', async () => {
        const res = await httpRequest('POST', port, '/she/matter/commission', { passcode: 20202021 });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ nodeId: '123' });
        expect(mockController.commission).toHaveBeenCalledWith({ passcode: 20202021 });
    });

    test('returns 400 when body has neither passcode nor pairingCode', async () => {
        const res = await httpRequest('POST', port, '/she/matter/commission', {});
        expect(res.status).toBe(400);
    });
});

describe('DELETE /she/matter/devices/:nodeId', () => {
    let srv, port;

    const mockController = {
        isStarted: jest.fn(() => true),
        listPaired: jest.fn(() => []),
        unpair: jest.fn().mockResolvedValue(undefined),
    };

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock('../../src/matter/controller', () => mockController);
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns 200 ok on success', async () => {
        const res = await httpRequest('DELETE', port, '/she/matter/devices/42');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mockController.unpair).toHaveBeenCalledWith('42');
    });

    test('returns 404 when node not found', async () => {
        mockController.unpair.mockRejectedValueOnce(new Error('Matter node not found: 999'));
        const res = await httpRequest('DELETE', port, '/she/matter/devices/999');
        expect(res.status).toBe(404);
    });
});

describe('POST /she/matter/devices/:nodeId/command', () => {
    let srv, port;

    const mockController = {
        isStarted: jest.fn(() => true),
        listPaired: jest.fn(() => []),
        sendCommand: jest.fn().mockResolvedValue(null),
    };

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock('../../src/matter/controller', () => mockController);
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns 200 and calls sendCommand', async () => {
        const res = await httpRequest('POST', port, '/she/matter/devices/7/command', {
            endpointId: 1,
            clusterName: 'onOff',
            command: 'on',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, result: null });
        expect(mockController.sendCommand).toHaveBeenCalledWith('7', 1, 'onOff', 'on', {});
    });

    test('returns 400 when required fields are missing', async () => {
        const res = await httpRequest('POST', port, '/she/matter/devices/7/command', { endpointId: 1 });
        expect(res.status).toBe(400);
    });
});

describe('POST /she/matter/devices/:nodeId/rename', () => {
    let srv, port;

    const mockController = {
        isStarted: jest.fn(() => true),
        rename: jest.fn().mockResolvedValue(undefined),
    };

    beforeEach(async () => {
        jest.resetModules();
        jest.doMock('../../src/matter/controller', () => mockController);
        const { router } = require('../../src/web/matter-api');
        const app = express();
        app.use(express.json());
        app.use('/she/matter', router);
        srv = await startApp(app);
        port = srv.address().port;
    });

    afterEach(() => new Promise((resolve) => srv.close(resolve)));

    test('returns 200 and calls rename with the trimmed name', async () => {
        const res = await httpRequest('POST', port, '/she/matter/devices/7/rename', { name: '  Hexagon Panels  ' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mockController.rename).toHaveBeenCalledWith('7', 'Hexagon Panels');
    });

    test('returns 400 when name is missing or empty', async () => {
        expect((await httpRequest('POST', port, '/she/matter/devices/7/rename', {})).status).toBe(400);
        expect((await httpRequest('POST', port, '/she/matter/devices/7/rename', { name: '   ' })).status).toBe(400);
    });

    test('returns 400 when name exceeds 32 characters', async () => {
        const res = await httpRequest('POST', port, '/she/matter/devices/7/rename', { name: 'x'.repeat(33) });
        expect(res.status).toBe(400);
    });

    test('returns 404 when the node is not found', async () => {
        mockController.rename.mockRejectedValueOnce(new Error('Matter node not found: 7'));
        const res = await httpRequest('POST', port, '/she/matter/devices/7/rename', { name: 'Panels' });
        expect(res.status).toBe(404);
    });
});
