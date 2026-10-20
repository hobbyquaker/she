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
