'use strict';

/**
 * Unit tests for src/matter/controller.js
 *
 * @matter/main is mocked entirely — no real Matter network I/O.
 */

// @matter/main is mocked via jest.doMock() inside beforeEach after resetModules()
// so we capture mock refs per-test instead of at the top level.

// Helper: build a minimal fake ClientNode for a given nodeId BigInt
function makeFakeClientNode(nodeIdBigInt, { online = true, endpoints = [] } = {}) {
    return {
        peerAddress: { nodeId: nodeIdBigInt },
        lifecycle: {
            isOnline: online,
            online: { on: jest.fn() },
            offline: { on: jest.fn() },
        },
        endpoints: {
            [Symbol.iterator]() {
                return endpoints[Symbol.iterator]();
            },
            for: jest.fn((epId) => {
                return endpoints.find((ep) => ep.number === epId) ?? null;
            }),
        },
        decommission: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        act: jest.fn(),
    };
}

// Helper: build a minimal fake ServerNode
function makeFakeServer(peers = []) {
    const peersIterable = {
        [Symbol.iterator]() {
            return peers[Symbol.iterator]();
        },
        commission: jest.fn(),
    };
    return {
        peers: peersIterable,
        start: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
    };
}

describe('matter controller', () => {
    let controller;
    let Environment, ServerNode;

    beforeEach(() => {
        jest.resetModules();

        // Set up @matter/main mock fresh after resetModules so refs are in sync
        jest.doMock('@matter/main', () => ({
            Environment: {
                default: {
                    vars: { set: jest.fn() },
                },
            },
            ServerNode: { create: jest.fn() },
        }));

        // Re-require with fresh modules so _server is reset to null
        controller = require('../../src/matter/controller');
        ({ Environment, ServerNode } = require('@matter/main'));
    });

    afterEach(() => jest.clearAllMocks());

    const fakeLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    // ── init / close ──────────────────────────────────────────────────────────

    test('init sets storage path and creates ServerNode', async () => {
        const fakeServer = makeFakeServer();
        ServerNode.create.mockResolvedValue(fakeServer);

        await controller.init('/tmp/matter', fakeLog);

        expect(Environment.default.vars.set).toHaveBeenCalledWith('storage.path', '/tmp/matter');
        expect(ServerNode.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'she-matter-controller' }));
        expect(fakeServer.start).toHaveBeenCalled();
    });

    test('init throws when called a second time', async () => {
        const fakeServer = makeFakeServer();
        ServerNode.create.mockResolvedValue(fakeServer);

        await controller.init('/tmp/matter', fakeLog);
        await expect(controller.init('/tmp/matter', fakeLog)).rejects.toThrow('already started');
    });

    test('close shuts the server down', async () => {
        const fakeServer = makeFakeServer();
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await controller.close();

        expect(fakeServer.close).toHaveBeenCalled();
    });

    test('close is a no-op when not started', async () => {
        await expect(controller.close()).resolves.toBeUndefined();
    });

    // ── listPaired ────────────────────────────────────────────────────────────

    test('listPaired returns empty array when not started', () => {
        expect(controller.listPaired()).toEqual([]);
    });

    test('listPaired serialises BigInt nodeIds as decimal strings', async () => {
        const node = makeFakeClientNode(BigInt('12345678901234'), { online: true });
        const fakeServer = makeFakeServer([node]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        const list = controller.listPaired();
        expect(list).toEqual([{ nodeId: '12345678901234', online: true }]);
    });

    // ── commission ────────────────────────────────────────────────────────────

    test('commission returns nodeId string', async () => {
        const nodeIdBigInt = BigInt('99999');
        const fakeClientNode = makeFakeClientNode(nodeIdBigInt);
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(fakeClientNode);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        const nodeId = await controller.commission({ passcode: 20202021 });
        expect(nodeId).toBe('99999');
    });

    test('commission throws when controller not started', async () => {
        await expect(controller.commission({ passcode: 1 })).rejects.toThrow('not started');
    });

    // ── unpair ────────────────────────────────────────────────────────────────

    test('unpair calls decommission on the found node', async () => {
        const nodeIdBigInt = BigInt('42');
        const fakeClientNode = makeFakeClientNode(nodeIdBigInt);
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await controller.unpair('42');
        expect(fakeClientNode.decommission).toHaveBeenCalled();
    });

    test('unpair falls back to delete when decommission throws', async () => {
        const nodeIdBigInt = BigInt('42');
        const fakeClientNode = makeFakeClientNode(nodeIdBigInt);
        fakeClientNode.decommission.mockRejectedValue(new Error('device unreachable'));
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await controller.unpair('42');
        expect(fakeClientNode.delete).toHaveBeenCalled();
    });

    test('unpair throws when node not found', async () => {
        const fakeServer = makeFakeServer([]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await expect(controller.unpair('999')).rejects.toThrow('not found');
    });

    // ── getEndpoints ──────────────────────────────────────────────────────────

    test('getEndpoints returns endpoint list with cluster names', async () => {
        const ep = { number: 1, state: { onOff: {}, levelControl: {} }, events: {} };
        const fakeClientNode = makeFakeClientNode(BigInt('7'), { endpoints: [ep] });
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        const endpoints = controller.getEndpoints('7');
        expect(endpoints).toEqual([{ endpointId: 1, clusters: expect.arrayContaining(['onOff', 'levelControl']) }]);
    });

    // ── subscribeAttribute / unsubscribe / cleanup ────────────────────────────

    test('subscribeAttribute registers a listener and returns a listenerId', async () => {
        const cancel = jest.fn();
        const changeEventEmitter = { on: jest.fn(() => cancel) };
        const ep = {
            number: 1,
            state: { onOff: {} },
            events: { onOff: { onOff$Changed: changeEventEmitter } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('5'), { endpoints: [ep] });
        fakeClientNode.endpoints.for.mockReturnValue(ep);
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        const cb = jest.fn();
        const listenerId = controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', cb);
        expect(typeof listenerId).toBe('number');
        expect(changeEventEmitter.on).toHaveBeenCalled();
    });

    test('cleanup cancels all listeners for a script', async () => {
        const cancel = jest.fn();
        const changeEventEmitter = { on: jest.fn(() => cancel) };
        const ep = {
            number: 1,
            state: { onOff: {} },
            events: { onOff: { onOff$Changed: changeEventEmitter } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('5'), { endpoints: [ep] });
        fakeClientNode.endpoints.for.mockReturnValue(ep);
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        controller.cleanup('/scripts/test.js');
        expect(cancel).toHaveBeenCalled();
    });

    test('unsubscribe cancels a single listener', async () => {
        const cancel = jest.fn();
        const changeEventEmitter = { on: jest.fn(() => cancel) };
        const ep = {
            number: 1,
            state: { onOff: {} },
            events: { onOff: { onOff$Changed: changeEventEmitter } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('5'), { endpoints: [ep] });
        fakeClientNode.endpoints.for.mockReturnValue(ep);
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        const id = controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        controller.unsubscribe('/scripts/test.js', id);
        expect(cancel).toHaveBeenCalled();
    });
});
