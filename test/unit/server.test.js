'use strict';

describe('web server registry', () => {
    let registerRoute;

    // Use a fresh module (and fresh registry Map) for every test
    beforeEach(() => {
        jest.resetModules();
        ({ registerRoute } = require('../../src/web/server'));
    });

    test('registers a new route without error', () => {
        expect(() => registerRoute('get', '/api/s/foo', () => {})).not.toThrow();
    });

    test('throws on duplicate method+path', () => {
        registerRoute('get', '/api/s/dup', () => {});
        expect(() => registerRoute('get', '/api/s/dup', () => {})).toThrow('Route already registered: GET /api/s/dup');
    });

    test('allows same path with a different HTTP method', () => {
        registerRoute('get', '/api/s/shared', () => {});
        expect(() => registerRoute('post', '/api/s/shared', () => {})).not.toThrow();
    });

    test('allows different paths to coexist', () => {
        registerRoute('get', '/api/s/a', () => {});
        expect(() => registerRoute('get', '/api/s/b', () => {})).not.toThrow();
    });
});
