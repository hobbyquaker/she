'use strict';

/**
 * Unit tests for src/matter/thread-mesh.js (roadmap M16): the graph from neighbour tables,
 * border routers joined by extended address, external nodes, bindings as arrows, the quality
 * scales, and the table refresh through a fake controller.
 */

const mesh = require('../../src/matter/thread-mesh');

describe('thread mesh: buildGraph', () => {
    const bulb = {
        nodeId: '4',
        name: 'Bulb',
        online: true,
        thread: {
            role: 5,
            rloc16: 0x5400,
            extAddress: '0011223344556677',
            channel: 25,
            partitionId: 7,
            networkName: 'Home',
            neighborTable: [
                { extAddress: 0xaabbccddeeff0011n, rloc16: 0x1000, lqi: 3, averageRssi: -60, isChild: false },
                { extAddress: 0x1111111111111111n, rloc16: 0x6000, lqi: 1, averageRssi: -88, isChild: false },
            ],
            routeTable: [{ routerId: 21 }],
            readAt: 5,
        },
    };
    const sw = {
        nodeId: '2',
        name: 'Switch',
        online: true,
        thread: {
            role: 2,
            rloc16: 0x5401,
            extAddress: '1111111111111111',
            channel: 25,
            partitionId: 7,
            networkName: 'Home',
            neighborTable: [{ extAddress: 0x0011223344556677n, rloc16: 0x5400, lqi: 2, averageRssi: -75, isChild: true }],
            routeTable: [],
        },
    };
    const govee = { nodeId: '9', name: 'Hexa', online: true, wifi: { rssi: -72, bssid: 'aabbcc' } };
    const bridge = { nodeId: '1', name: 'Bridge', online: false };
    const appleTv = { extAddress: 'AABBCCDDEEFF0011', vendorName: 'Apple', modelName: 'BorderRouter', networkName: 'Home', extPanId: '01', state: { role: 'leader' }, rest: null };

    test('nodes, roles, border routers joined by extended address, links merged with the better LQI', () => {
        const g = mesh.buildGraph([bulb, sw, govee, bridge], [appleTv], []);
        // Wi-Fi devices and devices without diagnostics are no part of a Thread mesh: counted, not drawn
        expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([
            ['node:4', 'thread'],
            ['node:2', 'thread'],
            ['br:AABBCCDDEEFF0011', 'border-router'],
        ]);
        expect(g.hidden).toEqual({ wifi: 1, other: 1 });
        expect(g.nodes[0]).toMatchObject({ role: 'router', rloc16: 0x5400, neighbours: 2, routes: 1, readAt: 5, networkName: 'Home' });
        expect(g.nodes[1].role).toBe('sleepy end device');
        const links = g.links.filter((l) => l.kind === 'neighbour');
        expect(links).toEqual([
            expect.objectContaining({ source: 'node:4', target: 'br:AABBCCDDEEFF0011', lqi: 3, quality: 'good', rssi: -60, bidirectional: false }),
            expect.objectContaining({ source: 'node:4', target: 'node:2', lqi: 2, lqiBack: 2, quality: 'fair', bidirectional: true, isChild: true }),
        ]);
        // one network, the border router in it; the devices took its extended PAN ID by the network name
        expect(g.networks).toEqual([{ key: '01', extPanId: '01', networkName: 'Home', partitions: ['7'], channel: 25, nodes: 3, borderRouters: 1 }]);
        expect(g.nodes.map((n) => n.network)).toEqual(['01', '01', '01']);
    });

    test('a neighbour nobody knows becomes an external node; a border router that is a fabric node is merged', () => {
        const strange = { ...bulb, thread: { ...bulb.thread, neighborTable: [{ extAddress: 0x9999999999999999n, rloc16: 0x7000, lqi: 2 }] } };
        const g = mesh.buildGraph([strange], [{ extAddress: '0011223344556677', vendorName: 'Espressif', modelName: 'esp-thread-br', networkName: 'Home' }], []);
        expect(g.nodes.find((n) => n.id === 'node:4').borderRouter).toEqual({ vendorName: 'Espressif', modelName: 'esp-thread-br', networkName: 'Home' });
        expect(g.nodes.filter((n) => n.kind === 'border-router')).toEqual([]);
        const ext = g.nodes.find((n) => n.kind === 'external');
        expect(ext).toMatchObject({ id: 'ext:9999999999999999', name: 'external 9999', rloc16: 0x7000 });
        expect(ext.explanation).toContain('not paired with she');
        expect(g.links[0]).toMatchObject({ source: 'node:4', target: 'ext:9999999999999999', quality: 'fair' });
    });

    test('bindings become arrows between fabric nodes, once per pair', () => {
        const bindings = [
            { own: true, sourceNodeId: '2', sourceEndpointId: 1, node: '4', endpoint: 1, clusterName: 'onOff' },
            { own: true, sourceNodeId: '2', sourceEndpointId: 1, node: '4', endpoint: 1, clusterName: 'levelControl' },
            { own: false, sourceNodeId: '2', node: '77', endpoint: 1, clusterName: 'onOff' },
            { own: true, sourceNodeId: '2', node: null, group: 1, clusterName: 'onOff' },
        ];
        const g = mesh.buildGraph([bulb, sw], [], bindings);
        const arrows = g.links.filter((l) => l.kind === 'binding');
        expect(arrows).toEqual([expect.objectContaining({ source: 'node:2', target: 'node:4', label: 'ep 1 → ep 1' })]);
    });

    test('quality scales and hex64', () => {
        expect(['unknown', 'poor', 'fair', 'good'].map((_, i) => mesh.lqiQuality(i))).toEqual(['unknown', 'poor', 'fair', 'good']);
        expect([mesh.rssiQuality(-50), mesh.rssiQuality(-80), mesh.rssiQuality(-90), mesh.rssiQuality(null)]).toEqual(['good', 'fair', 'poor', 'unknown']);
        expect(mesh.hex64(0x11n)).toBe('0000000000000011');
        expect(mesh.hex64({ $bytes: 'aabb' })).toBe('000000000000AABB');
        expect(mesh.hex64(new Uint8Array([1, 2]))).toBe('0000000000000102');
        expect(mesh.hex64(null)).toBeNull();
    });
});

describe('thread mesh: refresh and getMesh through the controller', () => {
    test('re-reads the tables of online Thread nodes and the graph uses them', async () => {
        const root = {
            number: 0,
            state: {
                basicInformation: { nodeLabel: 'Bulb' },
                threadNetworkDiagnostics: {
                    routingRole: 5,
                    rloc16: 0x5400,
                    extAddress: 0x0011223344556677n,
                    channel: 25,
                    partitionId: 7,
                    networkName: 'Home',
                    neighborTable: [],
                    routeTable: [],
                },
                generalDiagnostics: { networkInterfaces: [{ type: 4, hardwareAddress: new Uint8Array(8) }] },
            },
        };
        const node = { peerAddress: { nodeId: 4n }, lifecycle: { isOnline: true }, endpoints: [root] };
        const offline = { peerAddress: { nodeId: 5n }, lifecycle: { isOnline: false }, endpoints: [{ number: 0, state: { threadNetworkDiagnostics: {} } }] };
        const reads = [];
        const controller = {
            _peers: () => [node, offline],
            _readAttribute: jest.fn(async (n, ep, cluster, attr) => {
                reads.push(attr);
                return attr === 'neighborTable' ? [{ extAddress: 0x9999999999999999n, rloc16: 1, lqi: 3 }] : [{ routerId: 1 }];
            }),
            listBindings: jest.fn().mockResolvedValue([]),
        };
        const thread = {
            listNetworks: () => ({ networks: [{ borderRouters: [{ extAddress: '9999999999999999', vendorName: 'Apple', modelName: 'TV', networkName: 'Home' }] }], unknown: [] }),
        };
        const broadcast = jest.fn();
        mesh.start({ log: { info: jest.fn(), debug: jest.fn() }, broadcast, controller, thread });
        const before = await mesh.getMesh();
        expect(before.nodes.find((n) => n.id === 'node:4').neighbours).toBe(0);
        const after = await mesh.refresh();
        expect(reads).toEqual(['neighborTable', 'routeTable']);
        expect(after.nodes.find((n) => n.id === 'node:4')).toMatchObject({ neighbours: 1, routes: 1, readAt: expect.any(Number) });
        expect(after.links).toEqual([expect.objectContaining({ source: 'node:4', target: 'br:9999999999999999', quality: 'good' })]);
        expect(after.lastRefresh).toBeGreaterThan(0);
        expect(broadcast).toHaveBeenCalledWith({ type: 'matter:thread' });
        mesh.stop();
    });
});

describe('thread mesh: MeshCoP through a border router (M17)', () => {
    test('_meshcopNode derives role, neighbours and children; meshcopQuery runs the query and the graph shows the nodes', async () => {
        const m = require('../../src/matter/thread-mesh');
        const leader = m._meshcopNode({
            extMacAddress: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11]),
            rloc16: 0x5400,
            leaderData: { leaderRouterId: 21 },
            mode: { rxOnWhenIdle: true },
            routerNeighbors: [{ rloc16: 0x6000, extAddress: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]), averageRssi: -60, linkMargin: 30 }],
            childTable: [{ childId: 3, incomingLinkQuality: 2, timeoutSeconds: 240 }],
            vendorName: 'Apple',
            vendorModel: 'TV',
        });
        expect(leader).toMatchObject({ extAddress: 'AABBCCDDEEFF0011', rloc16: 0x5400, role: 'leader', vendorName: 'Apple', children: [3] });
        expect(leader.neighbours).toEqual([
            { extAddress: '0101010101010101', rloc16: 0x6000, averageRssi: -60, linkMargin: 30 },
            { rloc16: 0x5403, lqi: 2, isChild: true, timeout: 240 },
        ]);
        expect(m._meshcopNode({ rloc16: 0x5403, mode: { rxOnWhenIdle: false } }).role).toBe('sleepy end device');

        const onNode = { on: jest.fn() };
        const handle = {
            source: { queryMulticast: jest.fn(() => ({ onNode, onError: { on: jest.fn() }, done: Promise.resolve() })) },
            close: jest.fn().mockResolvedValue(undefined),
        };
        jest.resetModules();
        jest.doMock('@matter/thread-br-client', () => ({ connectMeshcop: jest.fn().mockResolvedValue(handle), DefaultTlvSet: [0, 1] }));
        jest.doMock('../../src/matter/thread-datasets', () => ({
            credentialsFor: (pan) => (pan === 'DEAD00BEEF00CAFE' ? { pskc: new Uint8Array(16), networkName: 'Lab', extPanId: new Uint8Array(8) } : null),
        }));
        const mesh = require('../../src/matter/thread-mesh');
        const thread = {
            listNetworks: () => ({
                networks: [
                    {
                        extPanId: 'DEAD00BEEF00CAFE',
                        networkName: 'Lab',
                        datasetKnown: true,
                        borderRouters: [
                            {
                                extAddress: 'AABBCCDDEEFF0011',
                                vendorName: 'Apple',
                                modelName: 'TV',
                                networkName: 'Lab',
                                extPanId: 'DEAD00BEEF00CAFE',
                                meshcopPort: 49153,
                                addresses: ['192.168.1.20'],
                            },
                        ],
                    },
                ],
                unknown: [],
            }),
            _registryEntry: () => null,
            _env: () => ({}),
        };
        const controller = { _peers: () => [], _readAttribute: jest.fn(), listBindings: jest.fn().mockResolvedValue([]) };
        mesh.start({ log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() }, broadcast: jest.fn(), controller, thread });
        const p = mesh.meshcopQuery('DEAD00BEEF00CAFE');
        await new Promise((r) => setTimeout(r, 5));
        // two responses arrive during the window
        onNode.on.mock.calls[0][0]({
            extMacAddress: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11]),
            rloc16: 0x5400,
            leaderData: { leaderRouterId: 21 },
            routerNeighbors: [{ rloc16: 0x6000, extAddress: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]), averageRssi: -60, linkMargin: 30 }],
            vendorName: 'Apple',
        });
        onNode.on.mock.calls[0][0]({
            extMacAddress: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]),
            rloc16: 0x6000,
            mode: { rxOnWhenIdle: true },
            vendorName: 'Rademacher',
            vendorModel: 'Gurtwickler',
        });
        const seen = await p;
        expect(seen.length).toBe(2);
        expect(handle.source.queryMulticast).toHaveBeenCalledWith('ff03::2', expect.objectContaining({ tlvTypes: [0, 1] }));
        expect(handle.close).toHaveBeenCalled();
        const g = await mesh.getMesh();
        // the Apple TV is the border router node (merged by ext address), the Rademacher a meshcop node, one link between them
        const tv = g.nodes.find((n) => n.id === 'br:AABBCCDDEEFF0011');
        expect(tv).toMatchObject({ kind: 'border-router', role: 'leader', rloc16: 0x5400, meshcop: { vendorName: 'Apple' } });
        expect(g.nodes.find((n) => n.kind === 'meshcop')).toMatchObject({ name: 'Rademacher Gurtwickler', role: 'router', rloc16: 0x6000 });
        expect(g.links).toEqual([expect.objectContaining({ source: 'br:AABBCCDDEEFF0011', target: 'mc:0101010101010101', quality: 'good', via: 'meshcop' })]);
        expect(g.meshcop).toMatchObject({
            nodes: 2,
            enabled: ['DEAD00BEEF00CAFE'],
            networks: [expect.objectContaining({ extPanId: 'DEAD00BEEF00CAFE', nodes: 2, via: 'AABBCCDDEEFF0011' })],
        });
        await expect(mesh.meshcopQuery('0000000000000000')).rejects.toThrow('MeshCoP is off');
        mesh.stop();
    });
});

describe('thread mesh: networks and addresses', () => {
    const mesh = require('../../src/matter/thread-mesh');

    test("border routers of two networks stay apart; an external neighbour joins its finder's network", () => {
        const node = {
            nodeId: '2',
            name: 'Switch',
            online: true,
            thread: {
                role: 5,
                rloc16: 0x400,
                extAddress: 'CAD3848A722FD46D',
                networkName: 'MyHome',
                extPanId: '0DAB60AA62634026',
                partitionId: 1,
                neighborTable: [{ extAddress: 0x1111111111111111n, rloc16: 0x800, lqi: 3 }],
                routeTable: [],
            },
        };
        const apple = {
            extAddress: 'DE424E634C3B559B',
            vendorName: 'Apple',
            modelName: 'BorderRouter',
            networkName: 'MyHome',
            extPanId: '0DAB60AA62634026',
            partitionId: '4AD1BF4F',
            state: { role: 'leader' },
        };
        const otbr = {
            extAddress: '82A562321CA4E52B',
            vendorName: 'OpenThread',
            modelName: 'BorderRouter',
            networkName: 'MyHome',
            extPanId: '0DAB60AA62634026',
            partitionId: '4AD1BF4F',
            state: { role: 'router' },
        };
        const echo = {
            extAddress: '3E3743EE2E64CF8C',
            vendorName: 'amazon',
            modelName: 'echo',
            networkName: 'AMZN-Thread-124d',
            extPanId: 'EFA4890BFFE9E2D6',
            state: { role: 'leader' },
        };
        const g = mesh.buildGraph([node], [apple, otbr, echo], []);
        const byKey = Object.fromEntries(g.networks.map((n) => [n.key, n]));
        expect(byKey['0DAB60AA62634026']).toMatchObject({ networkName: 'MyHome', nodes: 4, borderRouters: 2 });
        expect(byKey.EFA4890BFFE9E2D6).toMatchObject({ networkName: 'AMZN-Thread-124d', nodes: 1, borderRouters: 1 });
        const ext = g.nodes.find((n) => n.kind === 'external');
        expect(ext.network).toBe('0DAB60AA62634026');
        expect(g.nodes.find((n) => n.name === 'Apple BorderRouter').partitionId).toBe('4AD1BF4F');
    });

    test('IPv6 addresses in the short form', () => {
        const hex = (s) => ({ $bytes: s });
        expect(mesh._ipv6(hex('fe80000000000000c8d3848a722fd46d'))).toBe('fe80::c8d3:848a:722f:d46d');
        expect(mesh._ipv6(hex('fdd84f888a2f0000526ac5311b8cbbc5'))).toBe('fdd8:4f88:8a2f:0:526a:c531:1b8c:bbc5');
        expect(mesh._ipv6(Uint8Array.from(Buffer.from('00000000000000000000000000000001', 'hex')))).toBe('::1');
        expect(mesh._ipv6(hex('0102'))).toBeNull();
    });
});
