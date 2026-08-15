'use strict';

const StateStore = require('../../src/lib/state-store');

describe('StateStore — set() / get()', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('stores and retrieves a value', () => {
        store.set('mqtt::home/temp', 22);
        expect(store.get('mqtt::home/temp')).toBe(22);
    });

    it('returns undefined for an unknown key', () => {
        expect(store.get('mqtt::missing')).toBeUndefined();
    });

    it('overwrites the previous value', () => {
        store.set('mqtt::k', 1);
        store.set('mqtt::k', 2);
        expect(store.get('mqtt::k')).toBe(2);
    });

    it('stores ts and lc close to Date.now() on first set', () => {
        const before = Date.now();
        store.set('mqtt::k', 42);
        const after = Date.now();
        const obj = store.getObject('mqtt::k');
        expect(obj.ts).toBeGreaterThanOrEqual(before);
        expect(obj.ts).toBeLessThanOrEqual(after);
        expect(obj.lc).toBeGreaterThanOrEqual(before);
        expect(obj.lc).toBeLessThanOrEqual(after);
    });

    it('advances ts but keeps lc unchanged when value does not change', () => {
        store.set('mqtt::k', 42);
        const first = store.getObject('mqtt::k');
        store.set('mqtt::k', 42);
        const second = store.getObject('mqtt::k');
        expect(second.ts).toBeGreaterThanOrEqual(first.ts);
        expect(second.lc).toBe(first.lc);
    });

    it('updates lc when the value changes', () => {
        store.set('mqtt::k', 1);
        const { lc: lc1 } = store.getObject('mqtt::k');
        store.set('mqtt::k', 2);
        const { lc: lc2 } = store.getObject('mqtt::k');
        expect(lc2).toBeGreaterThanOrEqual(lc1);
    });
});

describe('StateStore — setObject()', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('stores a pre-built state object verbatim', () => {
        const obj = { val: 99, ts: 1000, lc: 900 };
        store.setObject('mqtt::k', obj);
        expect(store.getObject('mqtt::k')).toEqual(obj);
    });

    it('get() returns the val field of the stored object', () => {
        store.setObject('mqtt::k', { val: 55, ts: 1, lc: 1 });
        expect(store.get('mqtt::k')).toBe(55);
    });
});

describe('StateStore — change event', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('emits change with (key, val, obj, undefined) on first set', (done) => {
        store.once('change', (key, val, obj, prev) => {
            expect(key).toBe('mqtt::k');
            expect(val).toBe(7);
            expect(obj.val).toBe(7);
            expect(prev).toBeUndefined();
            done();
        });
        store.set('mqtt::k', 7);
    });

    it('emits change with previous obj on subsequent set', (done) => {
        store.set('mqtt::k', 1);
        const prevObj = store.getObject('mqtt::k');
        store.once('change', (key, val, obj, prev) => {
            expect(val).toBe(2);
            expect(prev).toEqual(prevObj);
            done();
        });
        store.set('mqtt::k', 2);
    });

    it('emits change on setObject', (done) => {
        store.once('change', (key, val) => {
            expect(key).toBe('mqtt::k');
            expect(val).toBe(42);
            done();
        });
        store.setObject('mqtt::k', { val: 42, ts: 1, lc: 1 });
    });

    it('emits change every call, even when value is unchanged', () => {
        const handler = jest.fn();
        store.on('change', handler);
        store.set('mqtt::k', 5);
        store.set('mqtt::k', 5);
        expect(handler).toHaveBeenCalledTimes(2);
    });
});

describe('StateStore — delete()', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('removes the key and returns true', () => {
        store.set('mqtt::k', 1);
        expect(store.delete('mqtt::k')).toBe(true);
        expect(store.has('mqtt::k')).toBe(false);
        expect(store.get('mqtt::k')).toBeUndefined();
    });

    it('returns false for an unknown key and emits nothing', () => {
        const handler = jest.fn();
        store.on('delete', handler);
        expect(store.delete('mqtt::nope')).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });

    it('emits delete with (key, prevObj)', (done) => {
        store.set('mqtt::k', 42);
        const prev = store.getObject('mqtt::k');
        store.on('delete', (key, prevObj) => {
            expect(key).toBe('mqtt::k');
            expect(prevObj).toBe(prev);
            done();
        });
        store.delete('mqtt::k');
    });
});

describe('StateStore — has() / keys()', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('has() returns false for an unknown key', () => {
        expect(store.has('mqtt::k')).toBe(false);
    });

    it('has() returns true after set', () => {
        store.set('mqtt::k', 1);
        expect(store.has('mqtt::k')).toBe(true);
    });

    it('keys() returns all stored keys', () => {
        store.set('mqtt::a', 1);
        store.set('var::b', 2);
        expect(store.keys()).toEqual(expect.arrayContaining(['mqtt::a', 'var::b']));
    });

    it('keys(prefix) filters by namespace prefix', () => {
        store.set('mqtt::a', 1);
        store.set('var::b', 2);
        expect(store.keys('mqtt::')).toEqual(['mqtt::a']);
        expect(store.keys('var::')).toEqual(['var::b']);
    });
});

describe('StateStore — mqttEntries()', () => {
    let store;
    beforeEach(() => {
        store = new StateStore();
    });

    it('yields [rawTopic, obj] pairs for mqtt:: keys with prefix stripped', () => {
        store.set('mqtt::home/temp', 22);
        store.set('var::x', 1);
        const entries = [...store.mqttEntries()];
        expect(entries).toHaveLength(1);
        expect(entries[0][0]).toBe('home/temp');
        expect(entries[0][1].val).toBe(22);
    });

    it('yields nothing when no mqtt:: keys exist', () => {
        store.set('var::x', 1);
        expect([...store.mqttEntries()]).toHaveLength(0);
    });
});
