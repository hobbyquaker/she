'use strict';

jest.mock('../../src/web/server');
const { registerRoute } = require('../../src/web/server');

const apiModule = require('../../src/sandbox/api');

describe('api sandbox module', () => {
    let she;
    const scriptName = 'myscript';

    beforeEach(() => {
        jest.clearAllMocks();
        she = {};
        apiModule(she, { scriptName });
    });

    test('installs she.api with get/post/put/delete', () => {
        expect(typeof she.api.get).toBe('function');
        expect(typeof she.api.post).toBe('function');
        expect(typeof she.api.put).toBe('function');
        expect(typeof she.api.delete).toBe('function');
    });

    test('she.api.get registers under /api/<scriptName>/path', () => {
        she.api.get('/items', () => []);
        expect(registerRoute).toHaveBeenCalledWith('get', '/api/myscript/items', expect.any(Function));
    });

    test('she.api.post registers under /api/<scriptName>/path', () => {
        she.api.post('/items', () => {});
        expect(registerRoute).toHaveBeenCalledWith('post', '/api/myscript/items', expect.any(Function));
    });

    test('she.api.put registers under /api/<scriptName>/path', () => {
        she.api.put('/items/:id', () => {});
        expect(registerRoute).toHaveBeenCalledWith('put', '/api/myscript/items/:id', expect.any(Function));
    });

    test('she.api.delete registers under /api/<scriptName>/path', () => {
        she.api.delete('/items/:id', () => {});
        expect(registerRoute).toHaveBeenCalledWith('delete', '/api/myscript/items/:id', expect.any(Function));
    });

    test('throws TypeError when path is not a string', () => {
        expect(() => she.api.get(42, () => {})).toThrow(TypeError);
    });

    test('throws TypeError when handler is not a function', () => {
        expect(() => she.api.get('/foo', 'not-a-fn')).toThrow(TypeError);
    });

    describe('express handler produced by she.api.get', () => {
        function getExpressHandler(routePath, userFn) {
            she.api.get(routePath, userFn);
            return registerRoute.mock.calls.at(-1)[2];
        }

        function mockRes() {
            const res = {};
            res.status = jest.fn(() => res);
            res.json = jest.fn(() => res);
            return res;
        }

        test('calls user handler with {params, query, headers} and sends JSON', async () => {
            const handler = jest.fn(() => ({ ok: true }));
            const expressHandler = getExpressHandler('/test', handler);
            const req = { params: { id: '1' }, query: { q: 'x' }, headers: { accept: '*/*' } };
            const res = mockRes();

            expressHandler(req, res);
            await Promise.resolve(); // flush microtasks

            expect(handler).toHaveBeenCalledWith({ params: { id: '1' }, query: { q: 'x' }, headers: { accept: '*/*' } });
            expect(res.json).toHaveBeenCalledWith({ ok: true });
        });

        test('sends 500 when user handler throws synchronously', async () => {
            const expressHandler = getExpressHandler('/err', () => {
                throw new Error('boom');
            });
            const res = mockRes();

            expressHandler({ params: {}, query: {}, headers: {} }, res);
            await Promise.resolve();

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: 'boom' });
        });

        test('sends 500 when user handler returns a rejected promise', async () => {
            const expressHandler = getExpressHandler('/async-err', () => Promise.reject(new Error('async boom')));
            const res = mockRes();

            expressHandler({ params: {}, query: {}, headers: {} }, res);
            await new Promise(setImmediate); // flush promise chain

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: 'async boom' });
        });
    });

    describe('express handler produced by she.api.post', () => {
        function getExpressHandler(routePath, userFn) {
            she.api.post(routePath, userFn);
            return registerRoute.mock.calls.at(-1)[2];
        }

        function mockRes() {
            const res = {};
            res.status = jest.fn(() => res);
            res.json = jest.fn(() => res);
            return res;
        }

        test('passes parsed body as second argument to user handler', async () => {
            const handler = jest.fn((req, body) => ({ received: body }));
            const expressHandler = getExpressHandler('/data', handler);
            const req = { params: {}, query: {}, headers: {}, body: { x: 1 } };
            const res = mockRes();

            expressHandler(req, res);
            await Promise.resolve();

            expect(handler).toHaveBeenCalledWith({ params: {}, query: {}, headers: {} }, { x: 1 });
            expect(res.json).toHaveBeenCalledWith({ received: { x: 1 } });
        });
    });
});
