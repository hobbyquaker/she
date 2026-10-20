'use strict';

/**
 * Unit tests for src/matter/groups.js (roadmap M23): ids, key sets, the group key map edits, the
 * device limits, the derived state and the encrypted store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('../../src/matter/groups');

describe('matter groups: the pure parts', () => {
    test('ids come from the application ranges and skip what is used', () => {
        expect(g.nextGroupId([])).toBe(1);
        expect(g.nextGroupId([{ id: 1 }, { id: 2 }, { id: 4 }])).toBe(3);
        expect(g.nextKeySetId({})).toBe(1);
        expect(g.nextKeySetId({ 1: { id: 1 }, 2: { id: 2 } })).toBe(3);
        expect(g.validName('Wohnzimmer')).toBe(true);
        expect(g.validName('')).toBe(false);
        expect(g.validName('a name that is far too long for Matter')).toBe(false);
    });

    test('a new key set has a 16-byte key and a microsecond start time; the struct carries them, the public view not', () => {
        const ks = g.newKeySet(3, { name: 'own', shared: false });
        expect(ks.epochKey).toMatch(/^[0-9a-f]{32}$/);
        expect(BigInt(ks.epochStartTime) > 1700000000000000n).toBe(true);
        const struct = g.groupKeySetStruct(ks);
        expect(struct).toMatchObject({ groupKeySetId: 3, groupKeySecurityPolicy: 0, epochKey1: null, epochStartTime1: null, groupKeyMulticastPolicy: 0 });
        expect(Buffer.from(struct.epochKey0).toString('hex')).toBe(ks.epochKey);
        expect(typeof struct.epochStartTime0).toBe('bigint');
        expect(g.publicKeySet(ks)).toEqual({ id: 3, name: 'own', shared: false, created: ks.created });
        expect(JSON.stringify(g.publicKeySet(ks))).not.toContain(ks.epochKey);
    });

    test('groupKeyMap edits', () => {
        const map = [{ groupId: 1, groupKeySetId: 1, fabricIndex: 2 }];
        const added = g.groupKeyMapAdd(map, { groupId: 2, keySetId: 1, fabricIndex: 2 });
        expect(added).toEqual([
            { groupId: 1, groupKeySetId: 1, fabricIndex: 2 },
            { groupId: 2, groupKeySetId: 1, fabricIndex: 2 },
        ]);
        expect(g.groupKeyMapAdd(added, { groupId: 2, keySetId: 5 })[1].groupKeySetId).toBe(5);
        expect(g.groupKeyMapRemove(added, 1)).toEqual([{ groupId: 2, groupKeySetId: 1, fabricIndex: 2 }]);
        expect(g.keySetStillMapped(added, 1)).toBe(true);
        expect(g.keySetStillMapped(g.groupKeyMapRemove(g.groupKeyMapRemove(added, 1), 2), 1)).toBe(false);
    });

    test('the device limits refuse a new key set or group beyond what the device holds', () => {
        expect(() =>
            g.assertWithinLimits({ keySetsOnDevice: 3, keySetIsNew: true, groupsOnDevice: 0, groupIsNew: true, limits: { maxGroupKeysPerFabric: 3, maxGroupsPerFabric: 4 } }),
        ).toThrow('at most 3 group key sets');
        expect(() =>
            g.assertWithinLimits({ keySetsOnDevice: 3, keySetIsNew: false, groupsOnDevice: 4, groupIsNew: true, limits: { maxGroupKeysPerFabric: 3, maxGroupsPerFabric: 4 } }),
        ).toThrow('at most 4 groups');
        expect(() => g.assertWithinLimits({ keySetsOnDevice: 2, keySetIsNew: true, groupsOnDevice: 3, groupIsNew: true })).not.toThrow();
        expect(() => g.assertWithinLimits({ keySetsOnDevice: 9, keySetIsNew: false, groupsOnDevice: 9, groupIsNew: false, limits: {} })).not.toThrow();
    });

    test('derivedState', () => {
        expect(g.derivedState([])).toEqual({ on: null, onCount: 0, memberCount: 0, level: null });
        expect(
            g.derivedState([
                { onOff: true, level: 100 },
                { onOff: true, level: 200 },
            ]),
        ).toEqual({ on: 'all', onCount: 2, memberCount: 2, level: 150 });
        expect(g.derivedState([{ onOff: true }, { onOff: false }, { onOff: null }]).on).toBe('some');
        expect(g.derivedState([{ onOff: false }, { onOff: false }]).on).toBe('none');
    });
});

describe('matter groups: the store', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-groups-'));
        const secrets = require('../../src/lib/secrets');
        secrets.init({ file: path.join(dir, 'secrets.enc'), keyFile: path.join(dir, 'secrets.key'), env: {} });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('a missing file is an empty store; a written store round-trips and is not plaintext', () => {
        expect(g.readStore(dir)).toEqual({ v: 1, keySets: {}, groups: [] });
        const ks = g.newKeySet(1, { name: 'shared', shared: true });
        g.writeStore(dir, { keySets: { 1: ks }, groups: [{ id: 1, name: 'Wohnzimmer', keySetId: 1, members: [] }] });
        const raw = fs.readFileSync(g.fileFor(dir), 'utf8');
        expect(raw).not.toContain(ks.epochKey);
        expect(raw).not.toContain('Wohnzimmer');
        expect(g.readStore(dir)).toEqual({ v: 1, keySets: { 1: ks }, groups: [{ id: 1, name: 'Wohnzimmer', keySetId: 1, members: [] }] });
        expect((fs.statSync(g.fileFor(dir)).mode & 0o777).toString(8)).toBe('600');
    });
});
