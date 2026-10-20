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
        expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([
            ['node:4', 'thread'],
            ['node:2', 'thread'],
            ['node:9', 'wifi'],
            ['node:1', 'other'],
            ['br:AABBCCDDEEFF0011', 'border-router'],
        ]);
        expect(g.nodes[0]).toMatchObject({ role: 'router', rloc16: 0x5400, neighbours: 2, routes: 1, readAt: 5, networkName: 'Home' });
        expect(g.nodes[1].role).toBe('sleepy end device');
        expect(g.nodes[2]).toMatchObject({ rssi: -72, quality: 'fair' });
        const links = g.links.filter((l) => l.kind === 'neighbour');
        expect(links).toEqual([
            expect.objectContaining({ source: 'node:4', target: 'br:AABBCCDDEEFF0011', lqi: 3, quality: 'good', rssi: -60, bidirectional: false }),
            expect.objectContaining({ source: 'node:4', target: 'node:2', lqi: 2, lqiBack: 2, quality: 'fair', bidirectional: true, isChild: true }),
        ]);
        expect(g.networks).toEqual([{ networkName: 'Home', partitions: ['7'], channel: 25, nodes: 2 }]);
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
