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
            Logger: { destinations: { default: {} } },
            LogLevel: { DEBUG: 0, INFO: 1, NOTICE: 2, WARN: 3, ERROR: 4, FATAL: 5 },
            LogFormat: { PLAIN: 'plain' },
        }));

        // Lazily required by setAttribute() — mock so jest doesn't load the real
        // packages (their exports resolve to TypeScript sources under jest).
        jest.doMock('@matter/protocol', () => ({
            Write: Object.assign(
                jest.fn((attr) => ({ writeRequests: [attr] })),
                { Attribute: jest.fn((d) => d) },
            ),
            WriteResult: { assertSuccess: jest.fn() },
        }));
        jest.doMock('@matter/main/clusters', () => ({
            BasicInformation: { Complete: { id: 40, attributes: { nodeLabel: { id: 5 } } } },
        }));

        // Re-require with fresh modules so _server is reset to null
        controller = require('../../src/matter/controller');
        ({ Environment, ServerNode } = require('@matter/main'));
    });

    afterEach(() => jest.clearAllMocks());

    const fakeLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

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
        expect(list).toEqual([{ nodeId: '12345678901234', online: true, name: null }]);
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

    test('commission attaches attribute watchers and broadcasts changes (B3)', async () => {
        const changeEvent = { on: jest.fn() };
        const endpoint = {
            number: 1,
            state: { onOff: { onOff: false } },
            events: { onOff: { onOff$Changed: changeEvent } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('7'), { endpoints: [endpoint] });
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(fakeClientNode);
        ServerNode.create.mockResolvedValue(fakeServer);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);

        await controller.commission({ passcode: 20202021 });
        expect(changeEvent.on).toHaveBeenCalledTimes(1);

        // Simulate the device-side change (e.g. physical button press)
        changeEvent.on.mock.calls[0][0](true);
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'matter:attr', nodeId: '7', endpointId: 1, clusterName: 'onOff', attrName: 'onOff', value: true }));
    });

    // ── rename ────────────────────────────────────────────────────────────────

    test('rename writes basicInformation.nodeLabel via an interaction write and broadcasts the device list', async () => {
        const write = jest.fn().mockResolvedValue([]);
        const fakeClientNode = makeFakeClientNode(BigInt('42'));
        fakeClientNode.interaction = { write };
        const fakeServer = makeFakeServer([fakeClientNode]);
        ServerNode.create.mockResolvedValue(fakeServer);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);
        broadcast.mockClear();

        await controller.rename('42', 'Hexagon Panels');
        expect(write).toHaveBeenCalledTimes(1);
        const { Write, WriteResult } = require('@matter/protocol');
        expect(Write.Attribute).toHaveBeenCalledWith({ endpoint: 0, cluster: expect.objectContaining({ id: 40 }), attributes: 'nodeLabel', value: 'Hexagon Panels' });
        expect(WriteResult.assertSuccess).toHaveBeenCalled();
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'matter:deviceList' }));
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

    // ── sendCommand ───────────────────────────────────────────────────────────

    function makeCommandEndpoint(agent) {
        return { number: 1, act: jest.fn((_label, fn) => fn(agent)) };
    }

    test('sendCommand fills neutral defaults for mandatory boilerplate fields (ObjectSchema shape)', async () => {
        const moveToLevel = jest.fn().mockResolvedValue(undefined);
        const behavior = {
            moveToLevel,
            cluster: {
                commands: {
                    moveToLevel: {
                        requestSchema: {
                            fieldDefinitions: {
                                level: { id: 0 },
                                transitionTime: { id: 1 },
                                optionsMask: { id: 4 },
                                optionsOverride: { id: 5 },
                            },
                        },
                    },
                },
            },
        };
        const endpoint = makeCommandEndpoint({ levelControl: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'levelControl', 'moveToLevel', { level: 128 });
        expect(moveToLevel).toHaveBeenCalledWith({ level: 128, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
    });

    test('sendCommand fills defaults from a CommandModel shape and keeps caller values', async () => {
        const stop = jest.fn().mockResolvedValue(undefined);
        const behavior = {
            stop,
            cluster: {
                commands: {
                    stop: {
                        schema: {
                            children: [
                                { name: 'OptionsMask', effectiveConformance: { isMandatory: true } },
                                { name: 'OptionsOverride', effectiveConformance: { isMandatory: true } },
                            ],
                        },
                    },
                },
            },
        };
        const endpoint = makeCommandEndpoint({ levelControl: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'levelControl', 'stop', { optionsMask: { executeIfOff: true } });
        expect(stop).toHaveBeenCalledWith({ optionsMask: { executeIfOff: true }, optionsOverride: {} });
    });

    test('sendCommand unwraps a .cluster-wrapped specifier (Specifier.clusterFor semantics)', async () => {
        const moveToLevel = jest.fn().mockResolvedValue(undefined);
        const behavior = {
            moveToLevel,
            cluster: {
                cluster: {
                    commands: {
                        moveToLevel: {
                            requestSchema: {
                                fieldDefinitions: { level: { id: 0 }, optionsMask: { id: 4 }, optionsOverride: { id: 5 } },
                            },
                        },
                    },
                },
            },
        };
        const endpoint = makeCommandEndpoint({ levelControl: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'levelControl', 'moveToLevel', { level: 128 });
        expect(moveToLevel).toHaveBeenCalledWith({ level: 128, optionsMask: {}, optionsOverride: {} });
    });

    test('sendCommand falls back to the ClusterModel schema of discovered client clusters', async () => {
        const stepWithOnOff = jest.fn().mockResolvedValue(undefined);
        const behavior = {
            stepWithOnOff,
            // no usable .cluster — command models live on the behavior schema
            schema: {
                children: [
                    { tag: 'attribute', name: 'CurrentLevel' },
                    {
                        tag: 'command',
                        name: 'StepWithOnOff',
                        direction: 'request',
                        children: [
                            { name: 'StepMode', effectiveConformance: { isMandatory: true } },
                            { name: 'StepSize', effectiveConformance: { isMandatory: true } },
                            { name: 'TransitionTime', effectiveConformance: { isMandatory: true } },
                            { name: 'OptionsMask', effectiveConformance: { isMandatory: true } },
                            { name: 'OptionsOverride', effectiveConformance: { isMandatory: true } },
                        ],
                    },
                    { tag: 'command', name: 'StepWithOnOff', direction: 'response', children: [] },
                ],
            },
        };
        const endpoint = makeCommandEndpoint({ levelControl: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'levelControl', 'stepWithOnOff', { stepMode: 1, stepSize: 25 });
        expect(stepWithOnOff).toHaveBeenCalledWith({ stepMode: 1, stepSize: 25, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
    });

    test('sendCommand injects options bitmaps for levelControl even when the schema is unresolvable', async () => {
        const stop = jest.fn().mockResolvedValue(undefined);
        const behavior = { stop }; // no .cluster, no .schema — nothing to introspect
        const endpoint = makeCommandEndpoint({ levelControl: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'levelControl', 'stop');
        expect(stop).toHaveBeenCalledWith({ optionsMask: {}, optionsOverride: {} });
    });

    test('sendCommand invokes void commands without an argument object', async () => {
        const toggle = jest.fn().mockResolvedValue(undefined);
        const behavior = { toggle, cluster: { commands: { toggle: {} } } };
        const endpoint = makeCommandEndpoint({ onOff: behavior });
        const fakeClientNode = makeFakeClientNode(BigInt('42'), { endpoints: [endpoint] });
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        await controller.sendCommand('42', 1, 'onOff', 'toggle');
        expect(toggle).toHaveBeenCalledWith();
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
        expect(endpoints).toEqual([
            {
                endpointId: 1,
                name: null,
                clusters: expect.arrayContaining([expect.objectContaining({ name: 'onOff' }), expect.objectContaining({ name: 'levelControl' })]),
            },
        ]);
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
