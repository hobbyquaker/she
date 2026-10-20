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
            Read: Object.assign(
                jest.fn((options, attr) => ({ options, attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            FabricManager: class FabricManager {},
        }));
        jest.doMock('@matter/main/clusters', () => ({
            BasicInformation: { Complete: { id: 40, attributes: { nodeLabel: { id: 5 } } } },
            AccessControl: { Complete: { id: 31, attributes: { acl: { id: 0 } } } },
            Binding: { Complete: { id: 30, attributes: { binding: { id: 0 } } } },
            GeneralCommissioning: { RegulatoryLocationType: { Indoor: 0, Outdoor: 1, IndoorOutdoor: 2 } },
        }));

        // Re-require with fresh modules so _server is reset to null
        jest.doMock('../../src/matter/dcl', () => ({
            start: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            deviceInfo: jest.fn().mockResolvedValue({ vendorName: null }),
            vendorName: () => null,
        }));
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

    // ── matter.js log bridge (B6) ─────────────────────────────────────────────

    test('log bridge enriches uninformative error lines from message values and rate-limits repeats (B6)', async () => {
        ServerNode.create.mockResolvedValue(makeFakeServer());
        await controller.init('/tmp/matter', fakeLog);
        const { Logger, LogLevel } = require('@matter/main');
        const write = Logger.destinations.default.write;

        const err = new Error('boom');
        write('2026-08-17 16:17:04.727 FATAL Unhandled Unhandled error detected: {}', { level: LogLevel.FATAL, values: ['Unhandled error detected:', err] });
        const call = fakeLog.error.mock.calls.find((c) => c[0] === 'matter.js:');
        expect(call).toBeDefined();
        expect(call[1]).toContain('boom'); // detail recovered from the Error value
        expect(call[1]).not.toMatch(/^\d{4}-/); // embedded matter.js timestamp stripped

        // identical repeat within the window → suppressed
        fakeLog.error.mockClear();
        write('2026-08-17 16:17:05.100 FATAL Unhandled Unhandled error detected: {}', { level: LogLevel.FATAL, values: ['Unhandled error detected:', err] });
        expect(fakeLog.error).not.toHaveBeenCalled();

        // a different error flushes the suppression summary and logs normally
        write('2026-08-17 16:17:06.000 ERROR Something else broke', { level: LogLevel.ERROR, values: ['Something else broke'] });
        expect(fakeLog.error).toHaveBeenCalledWith(expect.stringContaining('repeated 1 more time'));
        expect(fakeLog.error).toHaveBeenCalledWith('matter.js:', expect.stringContaining('Something else broke'));
    });

    test('reportUnhandledError logs full detail for non-Error throwables, neutrally labeled (B6)', async () => {
        ServerNode.create.mockResolvedValue(makeFakeServer());
        await controller.init('/tmp/matter', fakeLog);
        const { Logger } = require('@matter/main');
        Logger.reportUnhandledError({ code: 'timeout', peer: 42 });
        expect(fakeLog.error).toHaveBeenCalledWith('unhandled error:', expect.stringContaining('timeout'));
    });

    test('reportUnhandledError skips sandbox script errors (domain already attributes them)', async () => {
        ServerNode.create.mockResolvedValue(makeFakeServer());
        await controller.init('/tmp/matter', fakeLog);
        const { Logger } = require('@matter/main');
        const err = new Error('muh');
        err.stack = 'Error: muh\n    at /var/lib/she/scripts/test/error.js:4:7\n    at Script.runInContext (node:vm:149:12)';
        Logger.reportUnhandledError(err);
        expect(fakeLog.error).not.toHaveBeenCalled();
    });

    test('reportUnhandledError labels matter.js only when the stack contains matter frames', async () => {
        ServerNode.create.mockResolvedValue(makeFakeServer());
        await controller.init('/tmp/matter', fakeLog);
        const { Logger } = require('@matter/main');

        const matterErr = new Error('subscription lost');
        matterErr.stack = 'Error: subscription lost\n    at Object.x (/usr/local/lib/node_modules/smart-home-engine/node_modules/@matter/protocol/dist/cjs/x.js:1:1)';
        Logger.reportUnhandledError(matterErr);
        expect(fakeLog.error).toHaveBeenCalledWith('matter.js: unhandled error:', expect.stringContaining('subscription lost'));

        fakeLog.error.mockClear();
        const sheErr = new Error('she bug');
        sheErr.stack = 'Error: she bug\n    at foo (/usr/local/lib/node_modules/smart-home-engine/src/web/server.js:10:5)';
        Logger.reportUnhandledError(sheErr);
        expect(fakeLog.error).toHaveBeenCalledWith('unhandled error:', expect.stringContaining('she bug'));
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

    test('commission sends a regulatory location and country when the caller gives none (B-24)', async () => {
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(makeFakeClientNode(BigInt('7')));
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await controller.commission({ passcode: 20202021 });
        const opts = fakeServer.peers.commission.mock.calls[0][0];
        expect(opts.regulatoryCountryCode).toBe('XX');
        expect(opts.regulatoryLocation).toBe(2); // GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor
        expect(opts.passcode).toBe(20202021);
    });

    test("commission keeps the caller's regulatory settings", async () => {
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(makeFakeClientNode(BigInt('8')));
        ServerNode.create.mockResolvedValue(fakeServer);
        await controller.init('/tmp/matter', fakeLog);

        await controller.commission({ passcode: 1, regulatoryCountryCode: 'DE', regulatoryLocation: 0 });
        const opts = fakeServer.peers.commission.mock.calls[0][0];
        expect(opts.regulatoryCountryCode).toBe('DE');
        expect(opts.regulatoryLocation).toBe(0);
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

    test('cluster events are broadcast as matter:event, their names from the behavior model (M18)', async () => {
        const changeEvent = { on: jest.fn() };
        const pressEvent = { on: jest.fn() };
        const endpoint = {
            number: 1,
            state: { switch: { currentPosition: 0 } },
            events: { switch: { currentPosition$Changed: changeEvent, multiPressComplete: pressEvent } },
            behaviors: {
                supported: {
                    switch: {
                        schema: {
                            children: [
                                { tag: 'attribute', name: 'CurrentPosition' },
                                { tag: 'event', name: 'MultiPressComplete' },
                            ],
                        },
                    },
                },
            },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('7'), { endpoints: [endpoint] });
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(fakeClientNode);
        ServerNode.create.mockResolvedValue(fakeServer);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);
        await controller.commission({ passcode: 20202021 });

        expect(pressEvent.on).toHaveBeenCalledTimes(1);
        pressEvent.on.mock.calls[0][0]({ newPosition: 1, totalNumberOfPressesCounted: 2 });
        expect(broadcast).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'matter:event',
                nodeId: '7',
                endpointId: 1,
                clusterName: 'switch',
                eventName: 'multiPressComplete',
                value: { newPosition: 1, totalNumberOfPressesCounted: 2 },
            }),
        );
    });

    test('nodeLabel change rebroadcasts the device list (rename completion)', async () => {
        const changeEvent = { on: jest.fn() };
        const endpoint = {
            number: 0,
            state: { basicInformation: { nodeLabel: '' } },
            events: { basicInformation: { nodeLabel$Changed: changeEvent } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('7'), { endpoints: [endpoint] });
        const fakeServer = makeFakeServer();
        fakeServer.peers.commission.mockResolvedValue(fakeClientNode);
        ServerNode.create.mockResolvedValue(fakeServer);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);
        await controller.commission({ passcode: 20202021 });
        broadcast.mockClear();

        // Simulate the subscription report carrying the new label
        changeEvent.on.mock.calls[0][0]('Hexagon Panels');
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'matter:attr', attrName: 'nodeLabel', value: 'Hexagon Panels' }));
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'matter:deviceList' }));
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

    // The fake models the real @matter/general Observable: on() returns VOID,
    // detaching requires off() with the same observer reference. (The previous
    // fakes had on() return a cancel fn — encoding the exact wrong assumption
    // that made cleanup a silent no-op and leaked a listener per hot-reload.)
    function makeSubscriptionScenario() {
        const changeEventEmitter = { on: jest.fn(), off: jest.fn() };
        const ep = {
            number: 1,
            state: { onOff: {} },
            events: { onOff: { onOff$Changed: changeEventEmitter } },
        };
        const fakeClientNode = makeFakeClientNode(BigInt('5'), { endpoints: [ep] });
        fakeClientNode.endpoints.for.mockReturnValue(ep);
        return { changeEventEmitter, fakeClientNode };
    }

    test('subscribeAttribute registers a listener and returns a listenerId', async () => {
        const { changeEventEmitter, fakeClientNode } = makeSubscriptionScenario();
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        const listenerId = controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        expect(typeof listenerId).toBe('number');
        expect(changeEventEmitter.on).toHaveBeenCalledWith(expect.any(Function));
    });

    test('cleanup detaches all listeners of a script via off() with the registered observer', async () => {
        const { changeEventEmitter, fakeClientNode } = makeSubscriptionScenario();
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        const observer = changeEventEmitter.on.mock.calls[0][0];
        controller.cleanup('/scripts/test.js');
        expect(changeEventEmitter.off).toHaveBeenCalledWith(observer);
    });

    test('unsubscribe detaches a single listener via off() with the registered observer', async () => {
        const { changeEventEmitter, fakeClientNode } = makeSubscriptionScenario();
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        const id = controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        const observer = changeEventEmitter.on.mock.calls[0][0];
        controller.unsubscribe('/scripts/test.js', id);
        expect(changeEventEmitter.off).toHaveBeenCalledWith(observer);
    });

    test('subscribeAttribute falls back to the cluster event of that name and tags the callback (M18)', async () => {
        const pressEvent = { on: jest.fn(), off: jest.fn() };
        const ep = { number: 1, state: { switch: {} }, events: { switch: { currentPosition$Changed: { on: jest.fn(), off: jest.fn() }, multiPressComplete: pressEvent } } };
        const fakeClientNode = makeFakeClientNode(BigInt('5'), { endpoints: [ep] });
        fakeClientNode.endpoints.for.mockReturnValue(ep);
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        const cb = jest.fn();
        const id = controller.subscribeAttribute('/scripts/test.js', '5', 1, 'switch', 'multiPressComplete', cb);
        expect(typeof id).toBe('number');
        pressEvent.on.mock.calls[0][0]({ totalNumberOfPressesCounted: 2 });
        expect(cb).toHaveBeenCalledWith({ totalNumberOfPressesCounted: 2 }, expect.objectContaining({ event: true, cluster: 'switch', name: 'multiPressComplete' }));
        controller.unsubscribe('/scripts/test.js', id);
        expect(pressEvent.off).toHaveBeenCalledWith(pressEvent.on.mock.calls[0][0]);

        expect(() => controller.subscribeAttribute('/scripts/test.js', '5', 1, 'switch', 'nope', cb)).toThrow('neither an attribute');
    });

    test('hot-reload cycle does not accumulate listeners (sub → cleanup → sub)', async () => {
        const { changeEventEmitter, fakeClientNode } = makeSubscriptionScenario();
        ServerNode.create.mockResolvedValue(makeFakeServer([fakeClientNode]));
        await controller.init('/tmp/matter', fakeLog);

        controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        controller.cleanup('/scripts/test.js');
        controller.subscribeAttribute('/scripts/test.js', '5', 1, 'onOff', 'onOff', jest.fn());
        // one attach was detached again — net one active listener
        expect(changeEventEmitter.on).toHaveBeenCalledTimes(2);
        expect(changeEventEmitter.off).toHaveBeenCalledTimes(1);
    });
});

// ── bindings (M13) ────────────────────────────────────────────────────────────

describe('matter controller: bindings', () => {
    let controller;
    let ServerNode;
    const fakeLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const SHE = 112233n;
    const admin = { privilege: 5, authMode: 2, subjects: [SHE], targets: null, fabricIndex: 1 };

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('@matter/main', () => ({
            Environment: { default: { vars: { set: jest.fn() } } },
            ServerNode: { create: jest.fn() },
            Logger: { destinations: { default: {} } },
            LogLevel: { DEBUG: 0, INFO: 1, NOTICE: 2, WARN: 3, ERROR: 4, FATAL: 5 },
            LogFormat: { PLAIN: 'plain' },
        }));
        jest.doMock('@matter/protocol', () => ({
            Write: Object.assign(
                jest.fn((attr) => ({ kind: 'write', attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            WriteResult: { assertSuccess: jest.fn() },
            Read: Object.assign(
                jest.fn((options, attr) => ({ kind: 'read', options, attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            FabricManager: class FabricManager {},
        }));
        jest.doMock('@matter/main/clusters', () => ({
            AccessControl: { Complete: { id: 31, attributes: { acl: { id: 0 } } } },
            Binding: { Complete: { id: 30, attributes: { binding: { id: 0 } } } },
        }));
        jest.doMock('../../src/matter/dcl', () => ({
            start: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            deviceInfo: jest.fn().mockResolvedValue({ vendorName: null }),
            vendorName: () => null,
        }));
        controller = require('../../src/matter/controller');
        ({ ServerNode } = require('@matter/main'));
    });

    /**
     * A fake device: `store` holds attribute values by "endpoint/clusterId/attr"; reads yield one
     * attr-value chunk, writes replace the value (and may be made to fail or to drop entries).
     */
    function makeDevice(nodeId, { store, endpoints, online = true, fabricIndex = 1, writeHook } = {}) {
        const reads = [];
        const writes = [];
        const node = {
            peerAddress: { nodeId, fabricIndex },
            lifecycle: { isOnline: online, online: { on: jest.fn() }, offline: { on: jest.fn() } },
            endpoints: {
                [Symbol.iterator]: () => endpoints[Symbol.iterator](),
                for: (id) => endpoints.find((ep) => ep.number === id) ?? null,
            },
            interaction: {
                read: (req) => {
                    const key = `${req.attr.endpoint}/${req.attr.cluster.id}/${req.attr.attributes}`;
                    reads.push({ key, fabricFiltered: req.options.fabricFilter });
                    const value = store[key];
                    return (async function* () {
                        yield [{ kind: 'attr-value', value: value === undefined ? [] : value }];
                    })();
                },
                write: async (req) => {
                    const key = `${req.attr.endpoint}/${req.attr.cluster.id}/${req.attr.attributes}`;
                    writes.push({ key, value: req.attr.value });
                    if (writeHook) await writeHook(key, req.attr.value, store);
                    else store[key] = req.attr.value;
                    return {};
                },
            },
            reads,
            writes,
        };
        return node;
    }

    function rootEp(extra = {}) {
        return {
            number: 0,
            state: {
                descriptor: { deviceTypeList: [{ deviceType: 22 }], serverList: [29, 31, 40, 62], clientList: [] },
                operationalCredentials: { currentFabricIndex: 1 },
                accessControl: { targetsPerAccessControlEntry: 3, accessControlEntriesPerFabric: 4 },
                basicInformation: extra.name ? { nodeLabel: extra.name } : {},
            },
        };
    }

    async function setup({ switchOnline = true, bulbOnline = true, bulbWriteHook, switchWriteHook, bulbAcl, switchBindings } = {}) {
        const bulbStore = { '0/31/acl': bulbAcl ?? [admin] };
        const switchStore = { '1/30/binding': switchBindings ?? [] };
        const sw = makeDevice(2n, {
            store: switchStore,
            online: switchOnline,
            writeHook: switchWriteHook,
            endpoints: [
                rootEp({ name: 'H2 switch' }),
                {
                    number: 1,
                    state: {
                        descriptor: { deviceTypeList: [{ deviceType: 0x103 }], serverList: [29, 3, 30, 4], clientList: [6, 3, 4] },
                        binding: { binding: switchStore['1/30/binding'] },
                    },
                },
            ],
        });
        const bulb = makeDevice(4n, {
            store: bulbStore,
            online: bulbOnline,
            writeHook: bulbWriteHook,
            endpoints: [
                rootEp({ name: 'Bulb' }),
                { number: 1, state: { descriptor: { deviceTypeList: [{ deviceType: 0x101 }], serverList: [29, 3, 4, 6, 8], clientList: [] }, onOff: { onOff: false } } },
            ],
        });
        const peers = { [Symbol.iterator]: () => [sw, bulb][Symbol.iterator](), commission: jest.fn() };
        const server = { peers, start: jest.fn(), close: jest.fn(), env: { get: () => ({ for: (fi) => ({ rootNodeId: SHE, fabricIndex: fi }) }) } };
        ServerNode.create.mockResolvedValue(server);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);
        return { sw, bulb, bulbStore, switchStore, broadcast };
    }

    test('bindingCandidates classifies the switch as source and the bulb as target', async () => {
        await setup();
        const c = controller.bindingCandidates();
        expect(c.sources).toEqual([expect.objectContaining({ nodeId: '2', endpointId: 1, nodeName: 'H2 switch', clusters: [expect.objectContaining({ name: 'onOff' })] })]);
        expect(c.targets).toEqual([expect.objectContaining({ nodeId: '4', endpointId: 1, nodeName: 'Bulb' })]);
    });

    test('addBinding grants Operate on the bulb (read fresh, guarded, read back) and binds the switch', async () => {
        const { sw, bulb, bulbStore, switchStore, broadcast } = await setup();
        const r = await controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] });
        expect(r).toEqual({ ok: true, clusters: [6], aclChanged: true, bindingsAdded: [6] });
        expect(bulb.writes.map((w) => w.key)).toEqual(['0/31/acl']);
        expect(bulbStore['0/31/acl']).toEqual([admin, { privilege: 3, authMode: 2, subjects: [2n], targets: [{ cluster: 6, endpoint: 1, deviceType: null }], fabricIndex: 1 }]);
        expect(sw.writes.map((w) => w.key)).toEqual(['1/30/binding']);
        expect(switchStore['1/30/binding']).toEqual([{ node: 4n, endpoint: 1, cluster: 6, fabricIndex: 1 }]);
        // reads: fresh ACL, read-back, fresh bindings, read-back — all fabric-filtered
        expect(bulb.reads.map((x) => x.fabricFiltered)).toEqual([true, true]);
        expect(sw.reads.map((x) => x.fabricFiltered)).toEqual([true, true]);
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:bindings' });
    });

    test('addBinding refuses an offline target', async () => {
        await setup({ bulbOnline: false });
        await expect(controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] })).rejects.toThrow(
            'the target (Bulb) is offline',
        );
    });

    test('addBinding refuses to write an ACL without the admin entry and writes nothing', async () => {
        const { bulb } = await setup({ bulbAcl: [{ privilege: 5, authMode: 2, subjects: [999n], targets: null, fabricIndex: 1 }] });
        await expect(controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] })).rejects.toThrow(
            'lock itself out',
        );
        expect(bulb.writes).toEqual([]);
    });

    test('addBinding rolls the ACL back when the binding write fails', async () => {
        const { bulb, bulbStore } = await setup({
            switchWriteHook: async () => {
                throw new Error('device says no');
            },
        });
        await expect(controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] })).rejects.toThrow(
            'device says no',
        );
        expect(bulb.writes.length).toBe(2); // the grant and the rollback
        expect(bulbStore['0/31/acl']).toEqual([admin]);
        expect(fakeLog.warn).toHaveBeenCalledWith(expect.stringContaining('rolling the target'));
    });

    test('addBinding fails when the target drops the grant on read-back', async () => {
        await setup({
            bulbWriteHook: async (key, value, store) => {
                store[key] = [admin]; // the device silently keeps its old list
            },
        });
        await expect(controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] })).rejects.toThrow(
            'did not keep the access grant',
        );
    });

    test('listBindings resolves own entries to names and marks other fabrics', async () => {
        await setup({
            switchBindings: [
                { node: 4n, endpoint: 1, cluster: 6, fabricIndex: 1 },
                { node: 77n, endpoint: 2, cluster: 6, fabricIndex: 2 },
            ],
        });
        const list = await controller.listBindings();
        expect(list).toEqual([
            expect.objectContaining({
                sourceNodeId: '2',
                sourceName: 'H2 switch',
                sourceEndpointId: 1,
                own: true,
                node: '4',
                endpoint: 1,
                cluster: 6,
                clusterName: 'onOff',
                targetName: 'Bulb',
            }),
            expect.objectContaining({ sourceNodeId: '2', own: false, fabricIndex: 2, node: '77', endpoint: 2, cluster: 6, targetName: null }),
        ]);
    });

    test('removeBinding drops the entry and revokes the grant only when no other binding needs it', async () => {
        const { bulbStore, switchStore } = await setup({
            bulbAcl: [
                admin,
                {
                    privilege: 3,
                    authMode: 2,
                    subjects: [2n],
                    targets: [
                        { cluster: 6, endpoint: 1, deviceType: null },
                        { cluster: 8, endpoint: 1, deviceType: null },
                    ],
                    fabricIndex: 1,
                },
            ],
            switchBindings: [
                { node: 4n, endpoint: 1, cluster: 6, fabricIndex: 1 },
                { node: 4n, endpoint: 1, cluster: 8, fabricIndex: 1 },
            ],
        });
        let r = await controller.removeBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['levelControl'] });
        expect(r).toMatchObject({ ok: true, bindingsRemoved: [8], aclRevoked: true });
        expect(switchStore['1/30/binding']).toEqual([{ node: 4n, endpoint: 1, cluster: 6, fabricIndex: 1 }]);
        expect(bulbStore['0/31/acl'][1].targets).toEqual([{ cluster: 6, endpoint: 1, deviceType: null }]);
        r = await controller.removeBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] });
        expect(r).toMatchObject({ bindingsRemoved: [6], aclRevoked: true });
        expect(bulbStore['0/31/acl']).toEqual([admin]);
        expect(switchStore['1/30/binding']).toEqual([]);
    });

    test('removeBinding with the target offline removes the binding and reports the grant left behind', async () => {
        const { bulb } = await setup({ bulbOnline: false, switchBindings: [{ node: 4n, endpoint: 1, cluster: 6, fabricIndex: 1 }] });
        const r = await controller.removeBinding({ source: { nodeId: '2', endpointId: 1 }, target: { nodeId: '4', endpointId: 1 }, clusters: ['onOff'] });
        expect(r).toMatchObject({ bindingsRemoved: [6], aclRevoked: false, warning: expect.stringContaining('offline') });
        expect(bulb.writes).toEqual([]);
    });
});

// ── multi-admin (M20) ────────────────────────────────────────────────────────

describe('matter controller: fabrics and pairing windows', () => {
    let controller;
    let ServerNode;
    const fakeLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let invokes;

    beforeEach(() => {
        jest.resetModules();
        invokes = [];
        jest.doMock('@matter/main', () => ({
            Environment: { default: { vars: { set: jest.fn() } } },
            ServerNode: { create: jest.fn() },
            Logger: { destinations: { default: {} } },
            LogLevel: { DEBUG: 0, INFO: 1, NOTICE: 2, WARN: 3, ERROR: 4, FATAL: 5 },
            LogFormat: { PLAIN: 'plain' },
        }));
        jest.doMock('@matter/protocol', () => ({
            Read: Object.assign(
                jest.fn((options, attr) => ({ kind: 'read', options, attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            Invoke: Object.assign(
                jest.fn((def) => ({ kind: 'invoke', ...def })),
                { ConcreteCommandRequest: jest.fn((d) => d) },
            ),
            PaseClient: {
                generateRandomPasscode: () => 20202021,
                generateRandomDiscriminator: () => 3840,
                generatePakePasscodeVerifier: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
            },
            FabricManager: class FabricManager {},
        }));
        jest.doMock('@matter/general', () => ({ Crypto: class Crypto {} }));
        jest.doMock('@matter/types', () => ({
            Status: { Success: 0 },
            StatusResponseError: {
                create: (status, msg, clusterStatus) =>
                    Object.assign(new Error(`${msg}: status ${status}${clusterStatus !== undefined ? ' cluster status ' + clusterStatus : ''}`), { status, clusterStatus }),
            },
            QrPairingCodeCodec: { encode: (d) => `MT:QR-${d[0].discriminator}-${d[0].passcode}` },
            ManualPairingCodeCodec: { encode: (d) => `MANUAL-${d.discriminator}-${d.passcode}` },
            DiscoveryCapabilitiesSchema: { encode: () => 4 },
        }));
        jest.doMock('@matter/main/clusters', () => ({
            AdministratorCommissioning: { Complete: { id: 60, commands: { openCommissioningWindow: {}, revokeCommissioning: {} } } },
            OperationalCredentials: { Complete: { id: 62, attributes: { fabrics: { id: 1 } } } },
        }));
        jest.doMock('../../src/matter/dcl', () => ({
            start: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            deviceInfo: jest.fn(),
            vendorName: (id) => (id === 4937 ? 'Apple' : null),
        }));
        controller = require('../../src/matter/controller');
        ({ ServerNode } = require('@matter/main'));
    });

    async function setup({ online = true, fabrics, removeStatus = 0 } = {}) {
        const list = fabrics ?? [
            { rootPublicKey: new Uint8Array(1), vendorId: 4937, fabricId: 1n, nodeId: 100n, label: 'Apple Home', fabricIndex: 1 },
            { rootPublicKey: new Uint8Array(1), vendorId: 0xfff1, fabricId: 2n, nodeId: 2n, label: '', fabricIndex: 2 },
            { rootPublicKey: new Uint8Array(1), vendorId: 0x1234, fabricId: 3n, nodeId: 7n, label: '', fabricIndex: 3 },
        ];
        const root = {
            number: 0,
            state: {
                basicInformation: { nodeLabel: 'Bulb', vendorId: 4874, productId: 7 },
                operationalCredentials: { currentFabricIndex: 2, fabrics: list, supportedFabrics: 5, commissionedFabrics: list.length },
                administratorCommissioning: { windowStatus: 0, adminFabricIndex: null, adminVendorId: null },
            },
        };
        const agent = {
            operationalCredentials: {
                removeFabric: jest.fn().mockResolvedValue({ statusCode: removeStatus, fabricIndex: 1, debugText: removeStatus ? 'nope' : '' }),
                cluster: { commands: { removeFabric: { requestSchema: { fieldDefinitions: { fabricIndex: {} } } } } },
            },
        };
        const node = {
            peerAddress: { nodeId: 4n, fabricIndex: 1 },
            lifecycle: { isOnline: online, online: { on: jest.fn() }, offline: { on: jest.fn() } },
            endpoints: { [Symbol.iterator]: () => [root][Symbol.iterator](), for: (id) => (id === 0 ? root : null) },
            interaction: {
                read: () =>
                    (async function* () {
                        yield [{ kind: 'attr-value', value: list }];
                    })(),
                invoke: (req) => {
                    invokes.push(req);
                    return (async function* () {
                        yield [{ kind: 'cmd-status', status: 0 }];
                    })();
                },
            },
            act: jest.fn((label, fn) => fn(agent)),
        };
        root.act = node.act;
        const server = {
            peers: { [Symbol.iterator]: () => [node][Symbol.iterator](), commission: jest.fn() },
            start: jest.fn(),
            close: jest.fn(),
            env: { get: () => ({ randomBytes: () => new Uint8Array(32) }) },
        };
        ServerNode.create.mockResolvedValue(server);
        const broadcast = jest.fn();
        await controller.init('/tmp/matter', fakeLog, broadcast);
        return { node, agent, broadcast };
    }

    test("listFabrics names fabrics by label, ledger vendor or vendor id and marks she's own", async () => {
        await setup();
        const r = await controller.listFabrics('4');
        expect(r.fresh).toBe(true);
        expect(r.supportedFabrics).toBe(5);
        expect(r.fabrics).toEqual([
            expect.objectContaining({ fabricIndex: 1, name: 'Apple Home', vendorName: 'Apple', own: false, nodeId: '100', fabricId: '1' }),
            expect.objectContaining({ fabricIndex: 2, name: 'she', own: true, vendorName: 'matter.js (test vendor)' }),
            expect.objectContaining({ fabricIndex: 3, name: 'vendor 0x1234', vendorName: null, own: false }),
        ]);
        expect(r.window).toEqual({ status: 0, adminFabricIndex: null, adminVendorId: null, codes: null });
    });

    test('openCommissioningWindow sends the timed command with a PAKE verifier and returns the codes', async () => {
        const { broadcast } = await setup();
        const win = await controller.openCommissioningWindow('4', { timeoutSeconds: 60 });
        expect(win).toMatchObject({ passcode: 20202021, discriminator: 3840, qrCode: 'MT:QR-3840-20202021', manualCode: 'MANUAL-3840-20202021', timeoutSeconds: 180 });
        expect(invokes.length).toBe(1);
        expect(invokes[0].timed).toBe(true);
        expect(invokes[0].commands[0]).toMatchObject({
            endpoint: 0,
            command: 'openCommissioningWindow',
            fields: expect.objectContaining({ commissioningTimeout: 180, discriminator: 3840, iterations: 1000 }),
        });
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:fabrics', nodeId: '4' });
        // the codes show in listFabrics until they expire
        expect((await controller.listFabrics('4')).window.codes).toMatchObject({ manualCode: 'MANUAL-3840-20202021' });
        await controller.closeCommissioningWindow('4');
        expect(invokes[1].commands[0].command).toBe('revokeCommissioning');
        expect((await controller.listFabrics('4')).window.codes).toBeNull();
    });

    test('openCommissioningWindow refuses an offline device', async () => {
        await setup({ online: false });
        await expect(controller.openCommissioningWindow('4')).rejects.toThrow('offline');
        expect(invokes).toEqual([]);
    });

    test("removeFabric refuses she's own fabric and reports a refusal, removes another one", async () => {
        const { agent, broadcast } = await setup();
        await expect(controller.removeFabric('4', 2)).rejects.toThrow("she's own fabric");
        await expect(controller.removeFabric('4', 0)).rejects.toThrow('positive integer');
        expect(await controller.removeFabric('4', 1)).toEqual({ ok: true, fabricIndex: 1 });
        expect(agent.operationalCredentials.removeFabric).toHaveBeenCalledWith({ fabricIndex: 1 });
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:fabrics', nodeId: '4' });
    });

    test('removeFabric surfaces the device status', async () => {
        await setup({ removeStatus: 11 });
        await expect(controller.removeFabric('4', 1)).rejects.toThrow('status 11 (nope)');
    });
});

// ── firmware updates (M22) ───────────────────────────────────────────────────

describe('matter controller: firmware updates', () => {
    let controller;
    let ServerNode;
    const fakeLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let manager;
    let otaEvents;

    beforeEach(() => {
        jest.resetModules();
        otaEvents = { updateAvailable: { on: jest.fn() }, updateDone: { on: jest.fn() }, updateFailed: { on: jest.fn() } };
        manager = {
            queuedUpdates: [],
            queryUpdates: jest.fn().mockResolvedValue([]),
            forceUpdate: jest.fn().mockResolvedValue(undefined),
            removeConsent: jest.fn().mockResolvedValue(undefined),
        };
        class Endpoint {
            constructor(type, options) {
                this.type = type;
                this.options = options;
                this.events = { softwareupdates: otaEvents };
            }
            act(label, fn) {
                return fn({ softwareupdates: manager });
            }
        }
        jest.doMock('@matter/main', () => ({
            Environment: { default: { vars: { set: jest.fn() } } },
            ServerNode: { create: jest.fn() },
            Endpoint,
            Logger: { destinations: { default: {} } },
            LogLevel: { DEBUG: 0, INFO: 1, NOTICE: 2, WARN: 3, ERROR: 4, FATAL: 5 },
            LogFormat: { PLAIN: 'plain' },
        }));
        jest.doMock('@matter/main/endpoints', () => ({ OtaProviderEndpoint: { with: (b) => ({ ota: true, b }) } }));
        jest.doMock('@matter/node', () => ({ SoftwareUpdateManager: class SoftwareUpdateManager {} }));
        jest.doMock('../../src/matter/dcl', () => ({
            start: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            deviceInfo: jest.fn(),
            vendorName: () => null,
        }));
        controller = require('../../src/matter/controller');
        ({ ServerNode } = require('@matter/main'));
    });

    const tmp = () => require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'she-ota-'));

    async function setup({ online = true, updateState = 1, requestor = true, dclOffline = false } = {}) {
        const root = {
            number: 0,
            state: {
                basicInformation: { nodeLabel: 'Bulb', vendorId: 4874, productId: 7, softwareVersion: 10021, softwareVersionString: '1.0.21' },
                ...(requestor ? { otaSoftwareUpdateRequestor: { updateState, updateStateProgress: null } } : {}),
            },
        };
        const node = {
            peerAddress: { nodeId: 4n, fabricIndex: 1 },
            lifecycle: { isOnline: online, online: { on: jest.fn() }, offline: { on: jest.fn() } },
            endpoints: { [Symbol.iterator]: () => [root][Symbol.iterator](), for: (id) => (id === 0 ? root : null) },
        };
        const added = [];
        const server = {
            peers: { [Symbol.iterator]: () => [node][Symbol.iterator](), commission: jest.fn() },
            start: jest.fn(),
            close: jest.fn(),
            add: jest.fn(async (ep) => added.push(ep)),
            env: { get: () => ({}) },
        };
        ServerNode.create.mockResolvedValue(server);
        const broadcast = jest.fn();
        const dir = tmp();
        await controller.init(dir, fakeLog, broadcast, { dclOffline });
        await new Promise((r) => setTimeout(r, 5)); // _setupOta is not awaited by init
        return { node, server, added, broadcast, dir };
    }

    test('init adds the OTA provider endpoint without announcing she as default provider, not with DCL off', async () => {
        const { added } = await setup();
        expect(added.length).toBe(1);
        expect(added[0].options).toEqual({ id: 'ota-provider', softwareupdates: { announceAsDefaultProvider: false } });
        expect(otaEvents.updateAvailable.on).toHaveBeenCalled();
        await controller.close();
        const { added: none } = await setup({ dclOffline: true });
        expect(none.length).toBe(0);
        expect((await controller.listUpdates()).available).toBe(false);
    });

    test('checkUpdates stores what the ledger offers, persists it and listUpdates shows it against the installed version', async () => {
        const { node, broadcast, dir } = await setup();
        manager.queryUpdates.mockResolvedValueOnce([
            {
                peerAddress: node.peerAddress,
                info: { vendorId: 4874, productId: 7, softwareVersion: 10030, softwareVersionString: '1.0.30', releaseNotesUrl: 'https://x', source: 'ProductionDcl' },
            },
        ]);
        const r = await controller.checkUpdates('4');
        expect(manager.queryUpdates).toHaveBeenCalledWith({ peerToCheck: node });
        expect(r.nodes[0]).toMatchObject({
            nodeId: '4',
            softwareVersionString: '1.0.21',
            available: { softwareVersion: 10030, softwareVersionString: '1.0.30', releaseNotesUrl: 'https://x' },
            updateState: 1,
            updateStateName: 'idle',
            hasRequestor: true,
        });
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:update' });
        const onDisk = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'ota-updates.json'), 'utf8'));
        expect(onDisk['4'].info.softwareVersion).toBe(10030);
        // the ledger answers nothing the next time → no update
        const r2 = await controller.checkUpdates('4');
        expect(r2.nodes[0].available).toBeNull();
        expect(r2.nodes[0].checkedAt).toBeGreaterThan(0);
    });

    test('an offered version that is not newer than the installed one is not shown as available', async () => {
        const { node } = await setup();
        manager.queryUpdates.mockResolvedValueOnce([
            { peerAddress: node.peerAddress, info: { vendorId: 4874, productId: 7, softwareVersion: 10021, softwareVersionString: '1.0.21' } },
        ]);
        const r = await controller.checkUpdates();
        expect(r.nodes[0].available).toBeNull();
    });

    test('startUpdate guards: known update, idle device, online, requestor; then forceUpdate', async () => {
        const { node, broadcast } = await setup();
        await expect(controller.startUpdate('4')).rejects.toThrow('no update is known');
        manager.queryUpdates.mockResolvedValueOnce([
            { peerAddress: node.peerAddress, info: { vendorId: 4874, productId: 7, softwareVersion: 10030, softwareVersionString: '1.0.30' } },
        ]);
        await controller.checkUpdates('4');
        await expect(controller.startUpdate('4', { softwareVersion: 10000 })).rejects.toThrow('not newer');
        expect(await controller.startUpdate('4')).toEqual({ ok: true, nodeId: '4', targetSoftwareVersion: 10030 });
        expect(manager.forceUpdate).toHaveBeenCalledWith(node.peerAddress, 4874, 7, 10030);
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:update', nodeId: '4', started: 10030 });
        manager.queuedUpdates = [{ peerAddress: node.peerAddress, status: 'in-progress', targetSoftwareVersion: 10030, bdxTransferredBytes: 10, bdxDataLength: 100 }];
        await expect(controller.startUpdate('4')).rejects.toThrow('already in-progress');
        expect((await controller.listUpdates()).nodes[0].pending).toEqual({ status: 'in-progress', targetSoftwareVersion: 10030, bdxTransferredBytes: 10, bdxDataLength: 100 });
        expect(await controller.cancelUpdate('4')).toEqual({ ok: true, nodeId: '4' });
        expect(manager.removeConsent).toHaveBeenCalledWith(node.peerAddress);
    });

    test('startUpdate refuses a busy device, one without requestor and an offline one', async () => {
        await setup({ updateState: 4 });
        await expect(controller.startUpdate('4', { softwareVersion: 10030 })).rejects.toThrow('busy (downloading)');
        await controller.close();
        await setup({ requestor: false });
        await expect(controller.startUpdate('4', { softwareVersion: 10030 })).rejects.toThrow('no OTA requestor');
        await controller.close();
        await setup({ online: false });
        await expect(controller.startUpdate('4', { softwareVersion: 10030 })).rejects.toThrow('offline');
    });

    test('the manager events keep the stored updates and the outcome in step', async () => {
        const { node, broadcast } = await setup();
        const onAvailable = otaEvents.updateAvailable.on.mock.calls[0][0];
        onAvailable(node.peerAddress, { vendorId: 4874, productId: 7, softwareVersion: 10030, softwareVersionString: '1.0.30' });
        expect((await controller.listUpdates()).nodes[0].available.softwareVersion).toBe(10030);
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'matter:update', nodeId: '4', available: expect.objectContaining({ softwareVersion: 10030 }) }));
        otaEvents.updateDone.on.mock.calls[0][0](node.peerAddress);
        const after = (await controller.listUpdates()).nodes[0];
        expect(after.available).toBeNull();
        expect(after.outcome).toBe('done');
        otaEvents.updateFailed.on.mock.calls[0][0](node.peerAddress);
        expect((await controller.listUpdates()).nodes[0].outcome).toBe('failed');
    });
});

// ── groups (M23) ─────────────────────────────────────────────────────────────

describe('matter controller: groups', () => {
    let controller;
    let ServerNode;
    const fakeLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const SHE = 112233n;
    const admin = { privilege: 5, authMode: 2, subjects: [SHE], targets: null, fabricIndex: 1 };
    let dir;
    let fabric;
    let groupInvokes;

    beforeEach(() => {
        jest.resetModules();
        dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'she-grp-'));
        const secrets = require('../../src/lib/secrets');
        secrets.init({ file: require('path').join(dir, 'secrets.enc'), keyFile: require('path').join(dir, 'secrets.key'), env: {} });
        groupInvokes = [];
        fabric = { fabricIndex: 1, rootNodeId: SHE, groups: { setFromGroupKeySet: jest.fn().mockResolvedValue(undefined), groupKeyIdMap: new Map() } };
        jest.doMock('@matter/main', () => ({
            Environment: { default: { vars: { set: jest.fn() } } },
            ServerNode: { create: jest.fn() },
            Logger: { destinations: { default: {} } },
            LogLevel: { DEBUG: 0, INFO: 1, NOTICE: 2, WARN: 3, ERROR: 4, FATAL: 5 },
            LogFormat: { PLAIN: 'plain' },
        }));
        jest.doMock('@matter/protocol', () => ({
            Write: Object.assign(
                jest.fn((attr) => ({ kind: 'write', attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            WriteResult: { assertSuccess: jest.fn() },
            Read: Object.assign(
                jest.fn((options, attr) => ({ kind: 'read', options, attr })),
                { Attribute: jest.fn((d) => d) },
            ),
            Invoke: jest.fn((def) => ({ kind: 'invoke', ...def })),
            FabricManager: class FabricManager {},
        }));
        jest.doMock('@matter/types', () => ({ GroupId: (n) => n, NodeId: { fromGroupId: (n) => BigInt(0xffffffffffff0000n) | BigInt(n) } }));
        jest.doMock('@matter/main/clusters', () => ({
            AccessControl: { Complete: { id: 31, attributes: { acl: { id: 0 } } } },
            Binding: { Complete: { id: 30, attributes: { binding: { id: 0 } } } },
            GroupKeyManagement: { Complete: { id: 63, attributes: { groupKeyMap: { id: 0 }, groupTable: { id: 1 } } } },
            OnOff: { Complete: { id: 6, commands: { on: {}, off: {}, toggle: {} } } },
            LevelControl: {
                Complete: { id: 8, commands: { moveToLevel: { requestSchema: { fieldDefinitions: { level: {}, transitionTime: {}, optionsMask: {}, optionsOverride: {} } } } } },
            },
        }));
        jest.doMock('../../src/matter/dcl', () => ({
            start: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            deviceInfo: jest.fn(),
            vendorName: () => null,
        }));
        controller = require('../../src/matter/controller');
        ({ ServerNode } = require('@matter/main'));
    });
    afterEach(() => require('fs').rmSync(dir, { recursive: true, force: true }));

    /** A bulb-like device: endpoint 1 serves On/Off and Level Control; commands and attribute I/O recorded. */
    function makeBulb(nodeId, { online = true, keySetIds = [0], limits = { maxGroupKeysPerFabric: 3, maxGroupsPerFabric: 4 } } = {}) {
        const store = { '0/31/acl': [admin], '0/63/groupKeyMap': [], '0/63/groupTable': [], '1/30/binding': [] };
        const commands = [];
        const agent = {
            groupKeyManagement: {
                keySetReadAllIndices: jest.fn(async () => ({ groupKeySetIDs: [...keySetIds] })),
                keySetWrite: jest.fn(async (a) => {
                    keySetIds.push(a.groupKeySet.groupKeySetId);
                }),
                keySetRemove: jest.fn(async (a) => {
                    keySetIds.splice(keySetIds.indexOf(a.groupKeySetId), 1);
                }),
            },
            groups: { addGroup: jest.fn(async (a) => ({ status: 0, groupId: a.groupId })), removeGroup: jest.fn(async (a) => ({ status: 0, groupId: a.groupId })) },
        };
        const root = {
            number: 0,
            state: {
                basicInformation: { nodeLabel: `Bulb ${nodeId}` },
                operationalCredentials: { currentFabricIndex: 1 },
                accessControl: {},
                groupKeyManagement: limits,
                descriptor: { deviceTypeList: [{ deviceType: 22 }], serverList: [29, 31, 63], clientList: [] },
            },
        };
        const ep1 = {
            number: 1,
            state: {
                descriptor: { deviceTypeList: [{ deviceType: 0x101 }], serverList: [29, 3, 4, 6, 8, 30], clientList: [] },
                onOff: { onOff: true },
                levelControl: { currentLevel: 100 },
                binding: { binding: [] },
            },
        };
        const act = jest.fn((label, fn) => {
            commands.push(label);
            return fn(agent);
        });
        root.act = act;
        ep1.act = act;
        const node = {
            peerAddress: { nodeId, fabricIndex: 1 },
            lifecycle: { isOnline: online, online: { on: jest.fn() }, offline: { on: jest.fn() } },
            endpoints: { [Symbol.iterator]: () => [root, ep1][Symbol.iterator](), for: (id) => (id === 0 ? root : id === 1 ? ep1 : null) },
            interaction: {
                read: (req) =>
                    (async function* () {
                        yield [{ kind: 'attr-value', value: store[`${req.attr.endpoint}/${req.attr.cluster.id}/${req.attr.attributes}`] ?? [] }];
                    })(),
                write: async (req) => {
                    store[`${req.attr.endpoint}/${req.attr.cluster.id}/${req.attr.attributes}`] = req.attr.value;
                    return {};
                },
            },
            act,
            store,
            agent,
            keySetIds,
        };
        return node;
    }

    async function setup(nodes) {
        const group = {
            interaction: {
                invoke: (req) => {
                    groupInvokes.push(req);
                    return (async function* () {})();
                },
            },
        };
        const server = {
            peers: { [Symbol.iterator]: () => nodes[Symbol.iterator](), commission: jest.fn(), get: () => undefined, forAddress: jest.fn(async () => group) },
            start: jest.fn(),
            close: jest.fn(),
            env: { get: () => ({ for: () => fabric, fabrics: [fabric] }) },
        };
        ServerNode.create.mockResolvedValue(server);
        const broadcast = jest.fn();
        await controller.init(dir, fakeLog, broadcast);
        return { server, broadcast };
    }

    test('createGroup uses the shared key set by default, an own one on request, and registers both in the fabric', async () => {
        await setup([]);
        const a = await controller.createGroup({ name: 'Wohnzimmer' });
        expect(a).toMatchObject({ id: 1, name: 'Wohnzimmer', keySetId: 1, keySet: { id: 1, shared: true }, members: [], state: { on: null } });
        const b = await controller.createGroup({ name: 'Küche', keySet: 'own' });
        expect(b).toMatchObject({ id: 2, keySetId: 2, keySet: { id: 2, shared: false } });
        expect(fabric.groups.setFromGroupKeySet).toHaveBeenCalled();
        expect([...fabric.groups.groupKeyIdMap.entries()]).toEqual([
            [1, 1],
            [2, 2],
        ]);
        await expect(controller.createGroup({ name: 'Wohnzimmer' })).rejects.toThrow('exists');
        const list = controller.listGroups();
        expect(list.groups.length).toBe(2);
        expect(JSON.stringify(list)).not.toMatch(/epochKey/);
        // the store survives a restart
        await controller.close();
        await setup([]);
        expect(controller.listGroups().groups.map((g) => g.name)).toEqual(['Wohnzimmer', 'Küche']);
    });

    test('addGroupMember writes the key set, the map entry, AddGroup and the group ACL entry; removal cleans up', async () => {
        const bulb = makeBulb(4n);
        const { broadcast } = await setup([bulb]);
        await controller.createGroup({ name: 'Wohnzimmer' });
        const g = await controller.addGroupMember('Wohnzimmer', { nodeId: '4', endpointId: 1 });
        expect(g.members).toEqual([
            expect.objectContaining({
                nodeId: '4',
                endpointId: 1,
                name: 'Bulb 4',
                status: 'ok',
                clusters: [6, 8],
                clusterNames: ['onOff', 'levelControl'],
                state: { onOff: true, level: 100 },
            }),
        ]);
        expect(g.state).toEqual({ on: 'all', onCount: 1, memberCount: 1, level: 100 });
        expect(bulb.agent.groupKeyManagement.keySetWrite).toHaveBeenCalledWith({ groupKeySet: expect.objectContaining({ groupKeySetId: 1 }) });
        expect(bulb.store['0/63/groupKeyMap']).toEqual([{ groupId: 1, groupKeySetId: 1, fabricIndex: 1 }]);
        expect(bulb.agent.groups.addGroup).toHaveBeenCalledWith({ groupId: 1, groupName: 'Wohnzimmer' });
        expect(bulb.store['0/31/acl']).toEqual([
            admin,
            {
                privilege: 3,
                authMode: 3,
                subjects: [1n],
                targets: [
                    { cluster: 6, endpoint: 1, deviceType: null },
                    { cluster: 8, endpoint: 1, deviceType: null },
                ],
                fabricIndex: 1,
            },
        ]);
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:groups' });

        const r = await controller.removeGroupMember(1, '4', 1);
        expect(r.problems).toEqual([]);
        expect(bulb.agent.groups.removeGroup).toHaveBeenCalledWith({ groupId: 1 });
        expect(bulb.store['0/31/acl']).toEqual([admin]);
        expect(bulb.store['0/63/groupKeyMap']).toEqual([]);
        expect(bulb.agent.groupKeyManagement.keySetRemove).toHaveBeenCalledWith({ groupKeySetId: 1 });
        expect(controller.listGroups().groups[0].members).toEqual([]);
    });

    test('a device at its key-set limit is refused with a message and the member records the error', async () => {
        const bulb = makeBulb(4n, { keySetIds: [0, 7, 8], limits: { maxGroupKeysPerFabric: 3, maxGroupsPerFabric: 4 } });
        await setup([bulb]);
        await controller.createGroup({ name: 'Wohnzimmer' });
        await expect(controller.addGroupMember(1, { nodeId: '4', endpointId: 1 })).rejects.toThrow('at most 3 group key sets');
        expect(bulb.agent.groupKeyManagement.keySetWrite).not.toHaveBeenCalled();
        expect(controller.listGroups().groups[0].members[0]).toMatchObject({ status: 'error', error: expect.stringContaining('key sets') });
    });

    test('an offline member is refused; the key set is written once per device', async () => {
        const off = makeBulb(5n, { online: false });
        const bulb = makeBulb(4n);
        await setup([bulb, off]);
        await controller.createGroup({ name: 'A' });
        await controller.createGroup({ name: 'B' });
        await expect(controller.addGroupMember(1, { nodeId: '5', endpointId: 1 })).rejects.toThrow('offline');
        await controller.addGroupMember(1, { nodeId: '4', endpointId: 1 });
        await controller.addGroupMember(2, { nodeId: '4', endpointId: 1 });
        expect(bulb.agent.groupKeyManagement.keySetWrite).toHaveBeenCalledTimes(1);
        expect(bulb.store['0/63/groupKeyMap'].map((e) => e.groupId)).toEqual([1, 2]);
        // leaving group 1 keeps the shared key set while group 2 maps it
        await controller.removeGroupMember(1, '4', 1);
        expect(bulb.agent.groupKeyManagement.keySetRemove).not.toHaveBeenCalled();
        expect(bulb.store['0/63/groupKeyMap'].map((e) => e.groupId)).toEqual([2]);
    });

    test('sendCommand with group: sends one invoke to the group address with neutral defaults filled', async () => {
        const { server } = await setup([]);
        await controller.createGroup({ name: 'Wohnzimmer' });
        await controller.sendCommand('group:Wohnzimmer', null, 'onOff', 'on');
        expect(server.peers.forAddress).toHaveBeenCalledWith({ fabricIndex: 1, nodeId: BigInt(0xffffffffffff0000n) | 1n });
        expect(groupInvokes[0].commands[0]).toMatchObject({ command: 'on', fields: {} });
        await controller.sendGroupCommand(1, 'levelControl', 'moveToLevel', { level: 128 });
        expect(groupInvokes[1].commands[0].fields).toEqual({ level: 128, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
        await expect(controller.sendCommand('group:Nope', null, 'onOff', 'on')).rejects.toThrow('not found');
    });

    test('a group binding gives the source the key set and a { group, cluster } entry; removal drops both', async () => {
        const sw = makeBulb(2n);
        await setup([sw]);
        await controller.createGroup({ name: 'Wohnzimmer' });
        const r = await controller.addBinding({ source: { nodeId: '2', endpointId: 1 }, target: { group: 1 }, clusters: ['onOff'] });
        expect(r).toMatchObject({ ok: true, clusters: [6], aclChanged: false, bindingsAdded: [6], group: 1 });
        expect(sw.agent.groupKeyManagement.keySetWrite).toHaveBeenCalledTimes(1);
        expect(sw.store['1/30/binding']).toEqual([{ group: 1, cluster: 6, fabricIndex: 1 }]);
        const list = await controller.listBindings();
        expect(list).toEqual([expect.objectContaining({ sourceNodeId: '2', own: true, group: 1, node: null, targetName: 'group Wohnzimmer', clusterName: 'onOff' })]);
        const rm = await controller.removeBinding({ source: { nodeId: '2', endpointId: 1 }, target: { group: 1 }, clusters: ['onOff'] });
        expect(rm).toMatchObject({ bindingsRemoved: [6], warning: null });
        expect(sw.store['1/30/binding']).toEqual([]);
        expect(sw.agent.groupKeyManagement.keySetRemove).toHaveBeenCalledWith({ groupKeySetId: 1 });
    });

    test('deleteGroup deprovisions online members, reports offline ones and drops an own key set', async () => {
        const bulb = makeBulb(4n);
        const off = makeBulb(5n);
        await setup([bulb, off]);
        await controller.createGroup({ name: 'Own', keySet: 'own' });
        await controller.addGroupMember(1, { nodeId: '4', endpointId: 1 });
        await controller.addGroupMember(1, { nodeId: '5', endpointId: 1 });
        off.lifecycle.isOnline = false;
        const r = await controller.deleteGroup(1);
        expect(r.problems).toEqual([expect.stringContaining('Bulb 5/1: offline')]);
        expect(bulb.agent.groups.removeGroup).toHaveBeenCalled();
        expect(controller.listGroups()).toMatchObject({ groups: [], keySets: [] });
    });
});
