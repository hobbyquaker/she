'use strict';

const installStdlib = require('../../src/sandbox/stdlib');

function makeShe(state = {}) {
    const she = {
        _state: { ...state },
        getValue: jest.fn((topic) => she._state[topic]?.val),
        setValue: jest.fn((topic, val) => {
            she._state[topic] = { val, lc: Date.now() };
        }),
        getProp: jest.fn((topic, prop) => she._state[topic]?.[prop]),
        mqttsub: jest.fn(),
    };
    installStdlib(she);
    return she;
}

describe('now()', () => {
    it('returns a number close to Date.now()', () => {
        const she = makeShe();
        const before = Date.now();
        const result = she.now();
        const after = Date.now();
        expect(result).toBeGreaterThanOrEqual(before);
        expect(result).toBeLessThanOrEqual(after);
    });
});

describe('age()', () => {
    it('returns seconds since last change', () => {
        const lc = Date.now() - 5000;
        const she = makeShe({ 'test/topic': { val: 1, lc } });
        const a = she.age('test/topic');
        expect(a).toBeGreaterThanOrEqual(4);
        expect(a).toBeLessThanOrEqual(6);
    });
});

describe('link()', () => {
    it('subscribes source and publishes its value to target', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic');
        expect(she.mqttsub).toHaveBeenCalledWith('src/topic', expect.any(Function));
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 42);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 42);
    });

    it('publishes a fixed value when value arg provided', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic', 99);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 1);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 99);
    });

    it('transforms value through function when function arg provided', () => {
        const she = makeShe();
        she.link('src/topic', 'dst/topic', (v) => v * 2);
        const cb = she.mqttsub.mock.calls[0][1];
        cb('src/topic', 5);
        expect(she.setValue).toHaveBeenCalledWith('dst/topic', 10);
    });
});

describe('combineBool()', () => {
    it('publishes 1 when any source is truthy', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 1 } });
        she.combineBool(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 1);
    });

    it('publishes 0 when all sources are falsy', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 0 } });
        she.combineBool(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });
});

describe('combineMax()', () => {
    it('publishes the maximum value across sources', () => {
        const she = makeShe({ a: { val: 3 }, b: { val: 7 }, c: { val: 2 } });
        she.combineMax(['a', 'b', 'c'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 7);
    });

    it('publishes 0 when all sources are 0', () => {
        const she = makeShe({ a: { val: 0 }, b: { val: 0 } });
        she.combineMax(['a', 'b'], 'result');
        expect(she.setValue).toHaveBeenCalledWith('result', 0);
    });
});
