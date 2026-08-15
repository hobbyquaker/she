'use strict';

const EventEmitter = require('events');

// Build a minimal mock of ioredis before requiring the module under test
function makeRedisMock(hgetallResult = null) {
    const mock = new EventEmitter();
    mock.connect = jest.fn().mockResolvedValue(undefined);
    mock.hgetall = jest.fn().mockResolvedValue(hgetallResult);
    mock.hset = jest.fn().mockResolvedValue(1);
    mock.hdel = jest.fn().mockResolvedValue(1);
    return mock;
}

describe('src/lib/redis', () => {
    let redisModule;
    let MockRedis;
    let mockInstance;

    beforeEach(() => {
        jest.resetModules();
        mockInstance = makeRedisMock();
        MockRedis = jest.fn(() => mockInstance);
        jest.mock('ioredis', () => MockRedis, { virtual: true });
        redisModule = require('../../src/lib/redis');
    });

    afterEach(() => {
        jest.unmock('ioredis');
    });

    function makeStore() {
        const store = new EventEmitter();
        store._map = new Map();
        store.getObject = (key) => store._map.get(key);
        store.setObject = (key, obj) => {
            store._map.set(key, obj);
            store.emit('change', key, obj.val, obj, undefined);
        };
        return store;
    }

    function makeLog() {
        return {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    }

    it('connects to Redis and logs success', async () => {
        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });
        expect(MockRedis).toHaveBeenCalledWith('redis://localhost:6379', { lazyConnect: true });
        expect(mockInstance.connect).toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('redis: connected'), 'redis://localhost:6379');
    });

    it('seeds StateStore from Redis hash on startup', async () => {
        const stored = {
            'var::light': JSON.stringify({ val: true, ts: 1000, lc: 1000 }),
            'mqtt::sensor/temp': JSON.stringify({ val: 22.5, ts: 2000, lc: 2000 }),
        };
        mockInstance.hgetall = jest.fn().mockResolvedValue(stored);

        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });

        expect(store._map.get('var::light')).toEqual({ val: true, ts: 1000, lc: 1000 });
        expect(store._map.get('mqtt::sensor/temp')).toEqual({ val: 22.5, ts: 2000, lc: 2000 });
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('redis: seeded'), 2, expect.stringContaining('she:state'));
    });

    it('skips invalid JSON entries during seed', async () => {
        mockInstance.hgetall = jest.fn().mockResolvedValue({
            'var::good': JSON.stringify({ val: 1, ts: 1, lc: 1 }),
            'var::bad': 'not-json',
        });

        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });

        expect(store._map.has('var::bad')).toBe(false);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('redis: skipping'), 'var::bad');
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('redis: seeded'), 1, expect.any(String));
    });

    it('writes store changes to Redis hset', async () => {
        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });

        const obj = { val: 42, ts: 3000, lc: 3000 };
        store.setObject('var::counter', obj);

        // hset is async, wait a tick
        await Promise.resolve();
        expect(mockInstance.hset).toHaveBeenCalledWith('she:state', 'var::counter', JSON.stringify(obj));
    });

    it('removes deleted store keys from Redis via hdel', async () => {
        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });

        store.emit('delete', 'mqtt::cleared/topic', { val: 1, ts: 1, lc: 1 });

        await Promise.resolve();
        expect(mockInstance.hdel).toHaveBeenCalledWith('she:state', 'mqtt::cleared/topic');
    });

    it('logs error and returns when ioredis not available', async () => {
        jest.resetModules();
        jest.mock(
            'ioredis',
            () => {
                throw new Error('Cannot find module');
            },
            { virtual: true },
        );
        const mod = require('../../src/lib/redis');
        const store = makeStore();
        const log = makeLog();
        await mod.init({ url: 'redis://localhost', store, log });
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ioredis not installed'));
    });

    it('logs error when connect fails', async () => {
        mockInstance.connect = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('redis: connect failed:'), 'ECONNREFUSED');
        // no change listener registered
        store.setObject('var::x', { val: 1, ts: 1, lc: 1 });
        await Promise.resolve();
        expect(mockInstance.hset).not.toHaveBeenCalled();
    });

    it('getClient returns the active Redis instance', async () => {
        const store = makeStore();
        const log = makeLog();
        await redisModule.init({ url: 'redis://localhost:6379', store, log });
        expect(redisModule.getClient()).toBe(mockInstance);
    });
});
