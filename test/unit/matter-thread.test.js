'use strict';

/**
 * Unit tests for src/matter/thread.js (roadmap M15): the border agent state bitmap, the grouping
 * of border routers into networks, and the REST probe against a mocked thread-br-client.
 */

describe('matter thread', () => {
    let thread;
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const apple = {
        extAddressHex: 'AABBCCDDEEFF0011',
        extendedPanIdHex: '1122334455667788',
        networkName: 'Home',
        vendorName: 'Apple Inc.',
        modelName: 'AppleTV14,1',
        hostname: 'Wohnzimmer.local.',
        addresses: ['192.168.1.20', 'fe80::1'],
        meshcopPort: 49153,
        threadVersion: '1.3.0',
        stateBitmapHex: '00000731',
        partitionIdHex: '0a0b0c0d',
        sources: ['meshcop'],
        lastSeen: 1000,
    };
    const esp = {
        extAddressHex: '0011223344556677',
        extendedPanIdHex: '1122334455667788',
        networkName: 'Home',
        vendorName: 'Espressif',
        modelName: 'esp-thread-br',
        addresses: ['192.168.1.30'],
        stateBitmapHex: '00000531',
        sources: ['meshcop'],
        lastSeen: 2000,
    };
    const other = {
        extAddressHex: '9999999999999999',
        extendedPanIdHex: 'FFFFFFFFFFFFFFFF',
        networkName: 'Lab',
        vendorName: 'OpenThread',
        modelName: 'OTBR',
        addresses: ['10.0.0.5'],
        sources: ['meshcop'],
        lastSeen: 3000,
    };
    const nameless = { extAddressHex: '1234123412341234', vendorName: 'Google', modelName: 'Nest Hub', addresses: [], sources: ['trel'], lastSeen: 100 };

    beforeEach(() => {
        jest.resetModules();
        thread = require('../../src/matter/thread');
    });

    test('decodeStateBitmap', () => {
        // 0x0b31 = mode 1 (PSKc), interface 2 (active), availability 1 (high), BBR primary, role 1 (child), ePSKc
        expect(thread.decodeStateBitmap('00000b31')).toEqual({
            connectionMode: 'PSKc',
            interfaceStatus: 'active',
            availability: 'high',
            bbrActive: false,
            bbrPrimary: true,
            role: 'child',
            epskcSupported: true,
            threadActive: true,
        });
        // 0x0731 = the same with role 3 (leader) and no ePSKc
        expect(thread.decodeStateBitmap('00000731')).toEqual(expect.objectContaining({ bbrPrimary: true, role: 'leader', epskcSupported: false }));
        expect(thread.decodeStateBitmap('00000431')).toEqual(
            expect.objectContaining({ connectionMode: 'PSKc', interfaceStatus: 'active', bbrActive: false, bbrPrimary: false, role: 'router' }),
        );
        expect(thread.decodeStateBitmap('00000800')).toEqual(expect.objectContaining({ epskcSupported: true, role: 'disabled or detached', threadActive: false }));
        expect(thread.decodeStateBitmap(undefined)).toBeNull();
        expect(thread.decodeStateBitmap('zz')).toBeNull();
    });

    test('listNetworks groups by extended PAN ID and keeps the nameless apart', () => {
        const r = thread.listNetworks([apple, esp, other, nameless]);
        expect(r.running).toBe(false);
        expect(r.networks.map((n) => [n.networkName, n.extPanId, n.routerCount])).toEqual([
            ['Home', '1122334455667788', 2],
            ['Lab', 'FFFFFFFFFFFFFFFF', 1],
        ]);
        const home = r.networks[0];
        expect(home.borderRouters.map((b) => b.vendorName)).toEqual(['Apple Inc.', 'Espressif']);
        expect(home.borderRouters[0]).toMatchObject({
            extAddress: 'AABBCCDDEEFF0011',
            hostname: 'Wohnzimmer.local.',
            meshcopPort: 49153,
            threadVersion: '1.3.0',
            state: expect.objectContaining({ role: 'leader' }),
            rest: null,
        });
        expect(home.partitions).toEqual(['0a0b0c0d']);
        expect(home.datasetKnown).toBe(false);
        expect(r.unknown).toEqual([expect.objectContaining({ extAddress: '1234123412341234', vendorName: 'Google' })]);
    });

    test('probeRouter tries 8081 then 80, reads the node info, caches, and reports a router without REST', async () => {
        const probe = jest.fn(async (host, port) =>
            port === 80 && host === '192.168.1.30'
                ? { baseUrl: `http://${host}:80`, keyFormat: 'camel', probedAt: 1, networkName: 'Home', extPanId: new Uint8Array(8), diagnosticsApi: 'legacy' }
                : null,
        );
        const getNode = jest.fn().mockResolvedValue({
            state: 'leader',
            rloc16: 0x5400,
            rlocAddress: 'fd00::1',
            numOfRouter: 3,
            networkName: 'Home',
            extAddress: new Uint8Array([0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
            extPanId: new Uint8Array(8),
            leaderData: { partitionId: 7, weighting: 64, dataVersion: 1, stableDataVersion: 1, leaderRouterId: 21 },
        });
        jest.doMock('@matter/thread-br-client', () => ({
            OtbrRestProbe: { probe },
            OtbrRestClient: class {
                constructor(o) {
                    this.o = o;
                }
                getNode() {
                    return getNode();
                }
            },
        }));
        jest.resetModules();
        thread = require('../../src/matter/thread');
        const entries = [apple, esp];
        thread._inject({ registry: { list: () => entries, get: (x) => entries.find((e) => e.extAddressHex === x) } });
        const view = await thread.probeRouter('0011223344556677');
        expect(probe.mock.calls.map((c) => c[1])).toEqual([8081, 80]);
        expect(view.rest).toMatchObject({
            manageable: true,
            port: 80,
            node: { role: 'leader', rloc16: 0x5400, numOfRouter: 3, extAddress: '0011223344556677', leaderData: { leaderRouterId: 21 } },
        });
        await thread.probeRouter('0011223344556677');
        expect(probe).toHaveBeenCalledTimes(2); // cached
        const appleView = await thread.probeRouter('AABBCCDDEEFF0011');
        expect(appleView.rest).toMatchObject({ manageable: false, node: null });
        expect(thread.listNetworks().networks[0].borderRouters.find((b) => b.vendorName === 'Espressif').rest.manageable).toBe(true);
        await expect(thread.probeRouter('nope')).rejects.toThrow('not found');
    });
});
