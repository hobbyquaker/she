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

describe('matter-api: bindings (M13)', () => {
    let srv, port, mock;
    beforeAll(async () => {
        mock = {
            isStarted: () => true,
            listBindings: jest.fn().mockResolvedValue([{ sourceNodeId: '2', own: true }]),
            bindingCandidates: jest.fn().mockReturnValue({ sources: [1], targets: [2], notBindable: [] }),
            addBinding: jest.fn().mockResolvedValue({ ok: true, clusters: [6] }),
            removeBinding: jest.fn().mockResolvedValue({ ok: true, bindingsRemoved: [6] }),
        };
        srv = await startApp(await _makeApp(mock));
        port = srv.address().port;
    });
    afterAll(() => new Promise((r) => srv.close(r)));

    test('GET lists bindings and candidates', async () => {
        expect((await httpRequest('GET', port, '/she/matter/bindings')).body).toEqual([{ sourceNodeId: '2', own: true }]);
        expect((await httpRequest('GET', port, '/she/matter/bindings/candidates')).body).toEqual({ sources: [1], targets: [2], notBindable: [] });
    });

    test('POST validates the body and passes normalised ids on', async () => {
        expect((await httpRequest('POST', port, '/she/matter/bindings', { source: { nodeId: 2 } })).status).toBe(400);
        const r = await httpRequest('POST', port, '/she/matter/bindings', { source: { nodeId: 2, endpointId: '1' }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] });
        expect(r.status).toBe(201);
        expect(mock.addBinding).toHaveBeenCalledWith({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] });
    });

    test('errors map to 404 / 409 / 500', async () => {
        const body = { source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] };
        mock.addBinding.mockRejectedValueOnce(new Error('Matter node not found: 9'));
        expect((await httpRequest('POST', port, '/she/matter/bindings', body)).status).toBe(404);
        mock.addBinding.mockRejectedValueOnce(new Error('the target (Bulb) is offline'));
        expect((await httpRequest('POST', port, '/she/matter/bindings', body)).status).toBe(409);
        mock.removeBinding.mockRejectedValueOnce(new Error('boom'));
        expect((await httpRequest('DELETE', port, '/she/matter/bindings', body)).status).toBe(500);
        expect((await httpRequest('DELETE', port, '/she/matter/bindings', body)).body).toEqual({ ok: true, bindingsRemoved: [6] });
    });
});

describe('matter-api: fabrics and pairing windows (M20)', () => {
    let srv, port, mock;
    beforeAll(async () => {
        mock = {
            isStarted: () => true,
            listFabrics: jest.fn().mockResolvedValue({ nodeId: '4', fabrics: [] }),
            openCommissioningWindow: jest.fn().mockResolvedValue({ manualCode: '123' }),
            closeCommissioningWindow: jest.fn().mockResolvedValue(undefined),
            removeFabric: jest.fn().mockResolvedValue({ ok: true, fabricIndex: 1 }),
        };
        srv = await startApp(await _makeApp(mock));
        port = srv.address().port;
    });
    afterAll(() => new Promise((r) => srv.close(r)));

    test('the routes call through and map errors', async () => {
        expect((await httpRequest('GET', port, '/she/matter/devices/4/fabrics')).body).toEqual({ nodeId: '4', fabrics: [] });
        const r = await httpRequest('POST', port, '/she/matter/devices/4/commissioning-window', { timeoutSeconds: 300 });
        expect(r.status).toBe(201);
        expect(mock.openCommissioningWindow).toHaveBeenCalledWith('4', { timeoutSeconds: 300 });
        expect((await httpRequest('DELETE', port, '/she/matter/devices/4/commissioning-window')).body).toEqual({ ok: true });
        expect((await httpRequest('DELETE', port, '/she/matter/devices/4/fabrics/1')).body).toEqual({ ok: true, fabricIndex: 1 });
        expect(mock.removeFabric).toHaveBeenCalledWith('4', 1);
        mock.removeFabric.mockRejectedValueOnce(new Error("that is she's own fabric — unpair the device instead"));
        expect((await httpRequest('DELETE', port, '/she/matter/devices/4/fabrics/2')).status).toBe(409);
        mock.listFabrics.mockRejectedValueOnce(new Error('Matter node not found: 9'));
        expect((await httpRequest('GET', port, '/she/matter/devices/9/fabrics')).status).toBe(404);
    });
});

describe('matter-api: firmware updates (M22)', () => {
    let srv, port, mock;
    beforeAll(async () => {
        mock = {
            isStarted: () => true,
            listUpdates: jest.fn().mockResolvedValue({ available: true, nodes: [] }),
            checkUpdates: jest.fn().mockResolvedValue({ available: true, nodes: [1] }),
            startUpdate: jest.fn().mockResolvedValue({ ok: true, nodeId: '4', targetSoftwareVersion: 2 }),
            cancelUpdate: jest.fn().mockResolvedValue({ ok: true, nodeId: '4' }),
        };
        srv = await startApp(await _makeApp(mock));
        port = srv.address().port;
    });
    afterAll(() => new Promise((r) => srv.close(r)));

    test('the routes call through and map errors', async () => {
        expect((await httpRequest('GET', port, '/she/matter/updates')).body).toEqual({ available: true, nodes: [] });
        expect((await httpRequest('POST', port, '/she/matter/updates/check')).body).toEqual({ available: true, nodes: [1] });
        expect(mock.checkUpdates).toHaveBeenLastCalledWith();
        await httpRequest('POST', port, '/she/matter/devices/4/update/check');
        expect(mock.checkUpdates).toHaveBeenLastCalledWith('4');
        const r = await httpRequest('POST', port, '/she/matter/devices/4/update', { softwareVersion: 2 });
        expect(r.status).toBe(202);
        expect(mock.startUpdate).toHaveBeenCalledWith('4', { softwareVersion: 2 });
        expect((await httpRequest('DELETE', port, '/she/matter/devices/4/update')).body).toEqual({ ok: true, nodeId: '4' });
        mock.startUpdate.mockRejectedValueOnce(new Error('the device is busy (downloading) — wait until it is idle'));
        expect((await httpRequest('POST', port, '/she/matter/devices/4/update', {})).status).toBe(409);
        mock.startUpdate.mockRejectedValueOnce(new Error('Matter node not found: 9'));
        expect((await httpRequest('POST', port, '/she/matter/devices/9/update', {})).status).toBe(404);
    });
});
