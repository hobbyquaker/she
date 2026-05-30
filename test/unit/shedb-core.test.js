'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SheDBCore = require('../../src/lib/shedb-core');

const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let tmpDir, dbPath, db;

function makeDB(opts = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shedb-test-'));
    dbPath = path.join(tmpDir, 'she.db.json');
    return new SheDBCore({ dbPath, log: noop, ...opts });
}

function waitReady(instance) {
    return new Promise((resolve) => instance.once('ready', resolve));
}

beforeEach(async () => {
    db = makeDB();
    await waitReady(db);
});

afterEach(() => {
    clearTimeout(db._saveTimer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ready event', () => {
    it('emits ready asynchronously after construction', () => {
        // db was already awaited in beforeEach — just assert it exists
        expect(db).toBeInstanceOf(SheDBCore);
    });
});

describe('set() / get()', () => {
    it('stores a document and returns true', () => {
        const changed = db.set('test/doc', { value: 42 });
        expect(changed).toBe(true);
        expect(db.get('test/doc')).toMatchObject({ _id: 'test/doc', value: 42 });
    });

    it('returns false when the document has not changed', () => {
        db.set('test/doc', { value: 42 });
        const changed = db.set('test/doc', { value: 42 });
        expect(changed).toBe(false);
    });

    it('strips _rev and _id from incoming payload', () => {
        db.set('test/doc', { value: 1, _rev: 99, _id: 'wrong' });
        const doc = db.get('test/doc');
        expect(doc._id).toBe('test/doc');
        expect(doc.value).toBe(1);
    });

    it('empty-string payload deletes the document', () => {
        db.set('test/doc', { value: 1 });
        db.set('test/doc', '');
        expect(db.get('test/doc')).toBeUndefined();
    });

    it('rejects arrays, null, and primitives', () => {
        expect(db.set('test/doc', [1, 2])).toBe(false);
        expect(db.set('test/doc', null)).toBe(false);
        expect(db.set('test/doc', 'string')).toBe(false);
    });

    it('emits an update event when the document changes', (done) => {
        db.once('update', (id, doc) => {
            expect(id).toBe('test/doc');
            expect(doc.value).toBe(42);
            done();
        });
        db.set('test/doc', { value: 42 });
    });

    it('does not emit update when the document has not changed', () => {
        db.set('test/doc', { value: 42 });
        const listener = jest.fn();
        db.once('update', listener);
        db.set('test/doc', { value: 42 });
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('del()', () => {
    it('removes a document', () => {
        db.set('test/del', { x: 1 });
        db.del('test/del');
        expect(db.get('test/del')).toBeUndefined();
    });

    it("emits update with '' on delete", (done) => {
        db.set('test/del', { x: 1 });
        db.once('update', (id, doc) => {
            expect(id).toBe('test/del');
            expect(doc).toBe('');
            done();
        });
        db.del('test/del');
    });
});

describe('extend()', () => {
    it('merges new fields into an existing document', () => {
        db.set('test/ext', { a: 1 });
        const changed = db.extend('test/ext', { b: 2 });
        expect(changed).toBe(true);
        expect(db.get('test/ext')).toMatchObject({ a: 1, b: 2 });
    });

    it('returns false when no fields change', () => {
        db.set('test/ext', { a: 1 });
        const changed = db.extend('test/ext', { a: 1 });
        expect(changed).toBe(false);
    });

    it('creates the document if it does not exist', () => {
        const changed = db.extend('test/new', { x: 99 });
        expect(changed).toBe(true);
        expect(db.get('test/new')).toMatchObject({ x: 99 });
    });

    it('deep-merges nested objects', () => {
        db.set('test/nested', { a: { x: 1, y: 2 } });
        db.extend('test/nested', { a: { y: 3, z: 4 } });
        expect(db.get('test/nested')).toMatchObject({ a: { x: 1, y: 3, z: 4 } });
    });
});

describe('prop()', () => {
    it('set method updates a property', () => {
        db.set('test/prop', { a: 1 });
        const changed = db.prop('test/prop', { method: 'set', prop: 'a', val: 2 });
        expect(changed).toBe(true);
        expect(db.get('test/prop').a).toBe(2);
    });

    it('create method only sets a property when it does not exist', () => {
        db.set('test/prop', { a: 1 });
        db.prop('test/prop', { method: 'create', prop: 'a', val: 99 });
        expect(db.get('test/prop').a).toBe(1); // unchanged

        db.prop('test/prop', { method: 'create', prop: 'b', val: 99 });
        expect(db.get('test/prop').b).toBe(99); // created
    });

    it('del method removes a property', () => {
        db.set('test/prop', { a: 1, b: 2 });
        const changed = db.prop('test/prop', { method: 'del', prop: 'a' });
        expect(changed).toBe(true);
        expect(db.get('test/prop').a).toBeUndefined();
        expect(db.get('test/prop').b).toBe(2);
    });

    it('returns false for an unknown document id', () => {
        const changed = db.prop('test/missing', { method: 'set', prop: 'a', val: 1 });
        expect(changed).toBe(false);
    });
});

describe('query() / named views', () => {
    it('computes a named view and emits a view event with results', (done) => {
        db.set('item/a', { n: 1 });
        db.set('item/b', { n: 2 });

        db.once('view', (id, view) => {
            expect(id).toBe('testview');
            expect(view.result).toContain(1);
            expect(view.result).toContain(2);
            done();
        });

        db.query('testview', { filter: 'item/#', map: 'emit(this.n)' });
    }, 10000);

    it("emits view with '' when a view is deleted", (done) => {
        db.query('toDelete', { map: 'emit(this._id)' });
        db.on('view', (id, view) => {
            if (id === 'toDelete' && view === '') done();
        });
        // Allow initial view computation to complete before deleting
        setImmediate(() => db.query('toDelete', ''));
    }, 5000);

    it('reports a compile error when map code is syntactically invalid', (done) => {
        db.once('view', (id, view) => {
            if (id === 'broken') {
                expect(view.error).toMatch(/compile/);
                done();
            }
        });
        db.query('broken', { map: '!!this is not valid js!!!' });
    }, 5000);
});

describe('adhocQuery()', () => {
    beforeEach(() => {
        db.set('item/a', { n: 3 });
        db.set('item/b', { n: 7 });
        db.set('other/c', { n: 1 });
    });

    it('maps all documents when no filter is given', () => {
        const result = db.adhocQuery(null, (doc, emit) => emit(doc.n));
        expect(result).toContain(3);
        expect(result).toContain(7);
        expect(result).toContain(1);
    });

    it('filters documents by MQTT topic wildcard', () => {
        const result = db.adhocQuery('item/#', (doc, emit) => emit(doc.n));
        expect(result).toContain(3);
        expect(result).toContain(7);
        expect(result).not.toContain(1);
    });

    it('applies the reduce function when provided', () => {
        const sum = db.adhocQuery(
            'item/#',
            (doc, emit) => emit(doc.n),
            (arr) => arr.reduce((a, b) => a + b, 0),
        );
        expect(sum).toBe(10);
    });
});

describe('persistence', () => {
    it('saves and restores documents across instances', async () => {
        db.set('persist/x', { saved: true });
        // Wait for the 250 ms debounced save
        await new Promise((resolve) => setTimeout(resolve, 400));

        const db2 = new SheDBCore({ dbPath, log: noop });
        await waitReady(db2);
        clearTimeout(db2._saveTimer);

        expect(db2.get('persist/x')).toMatchObject({ saved: true });
    });
});
