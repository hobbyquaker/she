'use strict';

/**
 * Unit tests for src/matter/bindings.js — the pure half of the bindings feature (roadmap M13):
 * the ACL merge and guard, the device limits, the binding-list edits and the endpoint classifier.
 */

const b = require('../../src/matter/bindings');

const SHE = 112233n;
const SWITCH = 2n;
const admin = { privilege: 5, authMode: 2, subjects: [SHE], targets: null, fabricIndex: 1 };

describe('matter bindings: the ACL guard', () => {
    test("finds she's Administer entry whatever the id type", () => {
        expect(b.findAdminEntry([admin], 112233)).toBe(admin);
        expect(b.findAdminEntry([admin], '112233')).toBe(admin);
        expect(b.findAdminEntry([{ ...admin, privilege: 3 }], SHE)).toBeNull();
        expect(b.findAdminEntry([{ ...admin, authMode: 1 }], SHE)).toBeNull();
    });

    test('refuses to write an ACL without it', () => {
        expect(() => b.assertSafeAcl([], SHE)).toThrow('lock itself out');
        expect(() => b.assertSafeAcl([{ privilege: 5, authMode: 2, subjects: [99n], targets: null }], SHE)).toThrow('Administer entry');
        expect(() => b.assertSafeAcl([admin], SHE)).not.toThrow();
        expect(() => b.grantOperate([], { subject: SWITCH, endpoint: 1, clusters: ['onOff'], sheNodeId: SHE })).toThrow('lock itself out');
        expect(() => b.revokeOperate([], { subject: SWITCH, endpoint: 1, clusters: ['onOff'], sheNodeId: SHE })).toThrow('lock itself out');
    });
});

describe('matter bindings: grantOperate', () => {
    test('adds an Operate entry for the source with the fabric index of the admin entry, without touching the input', () => {
        const acl = [admin];
        const out = b.grantOperate(acl, { subject: SWITCH, endpoint: 1, clusters: ['onOff', 8], sheNodeId: SHE });
        expect(acl).toEqual([admin]);
        expect(out).toEqual([
            admin,
            {
                privilege: 3,
                authMode: 2,
                subjects: [SWITCH],
                targets: [
                    { cluster: 6, endpoint: 1, deviceType: null },
                    { cluster: 8, endpoint: 1, deviceType: null },
                ],
                fabricIndex: 1,
            },
        ]);
    });

    test('extends an existing entry of that source and does nothing when the grant exists', () => {
        const acl = [admin, { privilege: 3, authMode: 2, subjects: [SWITCH], targets: [{ cluster: 6, endpoint: 1, deviceType: null }], fabricIndex: 1 }];
        const out = b.grantOperate(acl, { subject: '2', endpoint: 1, clusters: ['levelControl'], sheNodeId: SHE });
        expect(out[1].targets).toEqual([
            { cluster: 6, endpoint: 1, deviceType: null },
            { cluster: 8, endpoint: 1, deviceType: null },
        ]);
        expect(out.length).toBe(2);
        const again = b.grantOperate(out, { subject: SWITCH, endpoint: 1, clusters: ['onOff', 'levelControl'], sheNodeId: SHE });
        expect(again).toEqual(out);
    });

    test('respects targetsPerAccessControlEntry by opening another entry, and the entries-per-fabric limit', () => {
        const limits = { targetsPerAccessControlEntry: 2, accessControlEntriesPerFabric: 3 };
        const out = b.grantOperate([admin], { subject: SWITCH, endpoint: 1, clusters: ['onOff', 'levelControl', 'colorControl'], sheNodeId: SHE, limits });
        expect(out.length).toBe(3);
        expect(out[1].targets.length).toBe(2);
        expect(out[2].targets).toEqual([{ cluster: 0x300, endpoint: 1, deviceType: null }]);
        expect(() => b.grantOperate(out, { subject: SWITCH, endpoint: 2, clusters: ['onOff'], sheNodeId: SHE, limits: { ...limits, targetsPerAccessControlEntry: 1 } })).toThrow(
            'only 3 access control entries',
        );
    });

    test('leaves entries of other subjects and entries with all targets alone', () => {
        const other = { privilege: 3, authMode: 2, subjects: [7n], targets: [{ cluster: 6, endpoint: 1, deviceType: null }], fabricIndex: 1 };
        const wide = { privilege: 3, authMode: 2, subjects: [SWITCH], targets: null, fabricIndex: 1 };
        const out = b.grantOperate([admin, other, wide], { subject: SWITCH, endpoint: 1, clusters: ['onOff'], sheNodeId: SHE });
        expect(out.length).toBe(4);
        expect(out[1]).toEqual(other);
        expect(out[2]).toEqual(wide);
    });
});

describe('matter bindings: revokeOperate and grantedClusters', () => {
    const acl = [
        admin,
        {
            privilege: 3,
            authMode: 2,
            subjects: [SWITCH],
            targets: [
                { cluster: 6, endpoint: 1, deviceType: null },
                { cluster: 8, endpoint: 1, deviceType: null },
                { cluster: 6, endpoint: 2, deviceType: null },
            ],
            fabricIndex: 1,
        },
        { privilege: 3, authMode: 2, subjects: [7n], targets: [{ cluster: 6, endpoint: 1, deviceType: null }], fabricIndex: 1 },
    ];

    test('removes only the named targets of that subject and drops an emptied entry', () => {
        const out = b.revokeOperate(acl, { subject: SWITCH, endpoint: 1, clusters: ['onOff'], sheNodeId: SHE });
        expect(out[1].targets).toEqual([
            { cluster: 8, endpoint: 1, deviceType: null },
            { cluster: 6, endpoint: 2, deviceType: null },
        ]);
        const all = b.revokeOperate(out, { subject: SWITCH, endpoint: 1, clusters: [8], sheNodeId: SHE });
        const none = b.revokeOperate(all, { subject: SWITCH, endpoint: 2, clusters: [6], sheNodeId: SHE });
        expect(none).toEqual([admin, acl[2]]);
    });

    test('grantedClusters lists what the source may operate on an endpoint', () => {
        expect(b.grantedClusters(acl, { subject: SWITCH, endpoint: 1 }).sort()).toEqual([6, 8]);
        expect(b.grantedClusters(acl, { subject: SWITCH, endpoint: 3 })).toEqual([]);
        expect(b.grantedClusters(acl, { subject: 7, endpoint: 1 })).toEqual([6]);
    });
});

describe('matter bindings: the binding list', () => {
    test('addBindingEntries appends what is missing', () => {
        const { bindings, added } = b.addBindingEntries([{ node: 5n, endpoint: 1, cluster: 6, fabricIndex: 1 }], {
            node: '5',
            endpoint: 1,
            clusters: ['onOff', 'levelControl'],
            fabricIndex: 1,
        });
        expect(added).toEqual([8]);
        expect(bindings).toEqual([
            { node: 5n, endpoint: 1, cluster: 6, fabricIndex: 1 },
            { node: 5n, endpoint: 1, cluster: 8, fabricIndex: 1 },
        ]);
    });

    test('removeBindingEntries removes the named ones and clustersStillBound reports the rest', () => {
        const list = [
            { node: 5n, endpoint: 1, cluster: 6 },
            { node: 5n, endpoint: 1, cluster: 8 },
            { node: 6n, endpoint: 1, cluster: 6 },
            { group: 1, cluster: 6 },
        ];
        const { bindings, removed } = b.removeBindingEntries(list, { node: 5, endpoint: 1, clusters: [6] });
        expect(removed).toEqual([6]);
        expect(bindings).toEqual([list[1], list[2], list[3]]);
        expect(b.clustersStillBound(bindings, { node: 5n, endpoint: 1 })).toEqual([8]);
        expect(b.clustersStillBound(bindings, { node: 6n, endpoint: 1 })).toEqual([6]);
    });
});

describe('matter bindings: classifyEndpoints', () => {
    const nodes = [
        {
            nodeId: '2',
            name: 'H2 switch',
            online: true,
            endpoints: [
                { endpointId: 0, name: null, deviceTypes: [0x16], serverList: [29, 31, 40], clientList: [] },
                { endpointId: 1, name: null, deviceTypes: [0x103], serverList: [29, 3, 30, 4], clientList: [3, 6, 4] },
            ],
        },
        {
            nodeId: '3',
            name: 'BILRESA',
            online: false,
            endpoints: [{ endpointId: 1, name: null, deviceTypes: [0x0f], serverList: [29, 59], clientList: [] }],
        },
        {
            nodeId: '4',
            name: 'Bulb',
            online: true,
            endpoints: [{ endpointId: 1, name: 'Licht', deviceTypes: [0x101], serverList: [29, 3, 4, 6, 8, 30], clientList: [] }],
        },
    ];

    test('sources need Binding plus a client cluster, targets the server cluster, Generic Switch is explained', () => {
        const { sources, targets, notBindable } = b.classifyEndpoints(nodes);
        expect(sources).toEqual([
            expect.objectContaining({ nodeId: '2', endpointId: 1, deviceTypeName: 'On/Off Light Switch', clusters: [{ name: 'onOff', id: 6, label: 'on/off' }] }),
        ]);
        expect(targets).toEqual([
            expect.objectContaining({
                nodeId: '4',
                endpointId: 1,
                name: 'Licht',
                clusters: expect.arrayContaining([expect.objectContaining({ name: 'onOff' }), expect.objectContaining({ name: 'levelControl' })]),
            }),
        ]);
        expect(notBindable).toEqual([expect.objectContaining({ nodeId: '3', reason: expect.stringContaining('Generic Switch') })]);
    });
});
